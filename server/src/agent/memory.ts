import { withUsage } from '../usage-context.js';
import { defaultModel, llmClient, llmProvider } from '../lib/llm.js';
import { recordModelUsage } from '../usage.js';
import { db, now } from '../db.js';
import '../db-config.js';
import { env } from '../env.js';
import { listMemories, learnMemory } from '../knowledge/memory.js';
import { assertWritable } from '../knowledge/access.js';
import { inferUserEvidence, isHumanUserMessage, type MessageRef } from '../knowledge/sessions.js';
import { hub } from '../lib/hub.js';
import { getBotRow, getLive } from '../store.js';

/**
 * Memory over time:
 *  (a) compaction of a bot's stored Responses API history (llm_items) when it gets large,
 *  (b) consolidation of durable facts into `memories` after a conversation goes idle,
 *  (c) a bounded, relevance-ranked memory section for the system prompt.
 */

const llm = () => llmClient(300_000);
/** Low-effort reasoning for housekeeping calls, where the provider supports the parameter. */
const lowEffort = () => (llmProvider() === 'direct' ? { reasoning: { effort: 'low' } } : {});

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export const memoryConfig = {
  /** Compact when the history estimate passes this many characters (~4 chars/token). SWARM_COMPACT_TOKENS overrides. */
  compactChars: process.env.SWARM_COMPACT_TOKENS ? num(process.env.SWARM_COMPACT_TOKENS, 75_000) * 4 : num(process.env.SWARM_COMPACT_CHARS, 300_000),
  /** User turns kept verbatim after a compaction. */
  keepTurns: num(process.env.SWARM_COMPACT_KEEP_TURNS, 4),
  /** Minutes without a message before consolidation runs. */
  consolidateIdleMin: num(process.env.SWARM_CONSOLIDATE_IDLE_MIN, 10),
  consolidateSweepSec: num(process.env.SWARM_CONSOLIDATE_SWEEP_SEC, 60),
  /** 'auto' tries direct provider /responses/compact then falls back to a summary; 'summary' skips direct provider compaction. */
  compactMethod: process.env.SWARM_COMPACT_METHOD === 'summary' ? 'summary' : 'auto',
  /** Character budget for the memory section of the system prompt. */
  promptMemoryChars: num(process.env.SWARM_PROMPT_MEMORY_CHARS, 4000),
};

// ---------------------------------------------------------------------------
// (a) compaction
// ---------------------------------------------------------------------------

/** Screenshots count as a fixed cost (~1.5k tokens), not their base64 length. Only the last 3 are sent inline. */
const IMAGE_CHARS = 6000;
const KEEP_IMAGES = 3;

function imageCount(it: any): number {
  const content = it?.type === 'function_call_output' ? it.output : it?.role === 'user' ? it.content : null;
  return Array.isArray(content) ? content.filter((c: any) => c?.type === 'input_image').length : 0;
}

/**
 * direct provider compaction items hold a large encrypted blob that is much cheaper than its length.
 * Measured on a real bot: a 1.61M-char blob cost ~18k input tokens (~72k chars), so ~22:1.
 */
const COMPACTION_BLOB_RATIO = 22;

/** Character estimate of what the model would actually be sent for these items (~4 chars per token). */
export function estimateChars(items: any[]): number {
  let images = 0;
  let total = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.type === 'compaction') { total += Math.ceil(String(it.encrypted_content ?? '').length / COMPACTION_BLOB_RATIO); continue; }
    const n = imageCount(it);
    total += JSON.stringify(it, (k, v) => (k === 'image_url' && typeof v === 'string' ? '' : v)).length;
    for (let j = 0; j < n; j++) total += images++ < KEEP_IMAGES ? IMAGE_CHARS : 30;
  }
  return total;
}

/** Real input size from the last model call: `items` history items cost `inputTokens` (system prompt included). */
const usage = new Map<string, { generation: number; items: number; inputTokens: number }>();
/** History length right after the last compaction, to require real growth before compacting again. */
const lastCompaction = new Map<string, { generation: number; items: number }>();

export function noteUsage(botId: string, inputTokens: number, items: number) {
  const bot = getBotRow(botId);
  if (bot) usage.set(botId, { generation: bot.generation, items, inputTokens });
}

/** Best estimate (in chars) of the history's size: last measured usage plus an estimate for items added since. */
export function historySize(botId: string, items: any[]): number {
  const bot = getBotRow(botId);
  const u = usage.get(botId);
  if (u && bot && u.generation === bot.generation && u.items <= items.length) return u.inputTokens * 4 + estimateChars(items.slice(u.items));
  return estimateChars(items);
}

const isUserMsg = (it: any) => it?.role === 'user' && it?.type !== 'function_call_output';

/**
 * Indices where history can be cut without separating a function_call from its output.
 * `turns` are the starts of user turns; `any` also includes the start of each model response mid-turn.
 */
function boundaries(items: any[]): { turns: number[]; any: number[] } {
  const open = new Set<string>();
  const turns: number[] = [];
  const any: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (i > 0 && open.size === 0) {
      if (isUserMsg(it)) turns.push(i);
      if (it?.type !== 'function_call_output' && items[i - 1]?.type !== 'reasoning' && items[i - 1]?.type !== 'compaction') any.push(i);
    }
    if (it?.type === 'function_call') open.add(it.call_id);
    if (it?.type === 'function_call_output') open.delete(it.call_id);
  }
  return { turns, any };
}

/** Pick where to cut: keep the last `keepTurns` user turns, fewer if they alone are too big. */
export function pickSplit(items: any[], limit: number, keepTurns: number): number {
  const keepBudget = Math.floor(limit * 0.35);
  const tail = (i: number) => estimateChars(items.slice(i));
  const { turns, any } = boundaries(items);
  let split = turns.length ? turns[Math.max(0, turns.length - keepTurns)] : -1;
  if (split > 0) {
    let k = turns.indexOf(split);
    while (k < turns.length - 1 && tail(split) > keepBudget) split = turns[++k];
  }
  // One giant turn (e.g. a long computer-use run): cut mid-turn at a response boundary.
  if (split <= 0 || tail(split) > keepBudget) {
    const fit = any.find((i) => i > Math.max(split, 0) && tail(i) <= keepBudget);
    if (fit) split = fit;
  }
  return split;
}

const SUMMARY_PROMPT = `You compress a long-running AI assistant conversation so it can continue with less context.
Write a dense summary for the assistant itself (not for the user). Keep:
- who the user is, their goals, preferences and standing instructions
- decisions made, facts learned, names, numbers, URLs, file paths, IDs and account details (never passwords or secrets)
- what was done with which tools and the outcomes, including failures and what not to retry
- open tasks, promises made, and anything the assistant is waiting on
Drop pleasantries and step-by-step narration. Use short bullet points grouped under a few headings. Stay under 1,500 words.`;

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === 'input_image' ? '[screenshot]' : c?.text ?? c?.refusal ?? '')).filter(Boolean).join(' ');
  return '';
}

/** Plain-text rendering of history for the fallback summarizer. */
export function renderTranscript(items: any[], maxChars = 200_000): string {
  const lines: string[] = [];
  for (const it of items) {
    if (it?.type === 'reasoning' || it?.type === 'compaction') continue;
    if (it?.type === 'function_call') lines.push(`[tool call] ${it.name}(${String(it.arguments ?? '').slice(0, 400)})`);
    else if (it?.type === 'function_call_output') lines.push(`[tool result] ${textOf(it.output).slice(0, 600)}`);
    else if (it?.type === 'message' || it?.role === 'assistant') lines.push(`Assistant: ${textOf(it.content)}`);
    else if (it?.role === 'user') lines.push(`User: ${textOf(it.content)}`);
    else if (it?.type === 'web_search_call' || it?.type === 'x_search_call') lines.push(`[${it.type}]`);
  }
  let out = lines.join('\n');
  if (out.length > maxChars) out = `[…earliest part cut…]\n${out.slice(-maxChars)}`;
  return out;
}

type BeforeCompactionModel = () => number | undefined;
class CompactionGuardError extends Error {
  constructor(readonly rejection: unknown) { super('Compaction model guard rejected the request.'); }
}

/** Recheck immediately before each provider invocation, including summary fallback. */
function compactionOutputLimit(beforeModel?: BeforeCompactionModel): { max_output_tokens?: number } {
  if (!beforeModel) return {};
  try {
    const remaining = beforeModel();
    if (remaining === undefined) return {};
    if (!Number.isSafeInteger(remaining) || remaining < 1) throw new Error('Compaction output token budget must be a positive safe integer.');
    return { max_output_tokens: remaining };
  } catch (error) { throw new CompactionGuardError(error); }
}

async function compactWithDirect(botId: string, old: any[], beforeModel?: BeforeCompactionModel): Promise<any[]> {
  // /responses/compact has no max_output_tokens parameter; guard admission only.
  compactionOutputLimit(beforeModel);
  const res: any = await llm().post('/responses/compact', { body: { model: defaultModel(), input: old } });
  await recordModelUsage({ botId, kind: 'compaction', model: defaultModel(), response: res });
  const out = (res?.output ?? []) as any[];
  if (!out.length || !out.some((o) => o?.type === 'compaction' || o?.encrypted_content || o?.role)) throw new Error('compact returned no items');
  return out;
}

async function compactWithSummary(botId: string, old: any[], beforeModel?: BeforeCompactionModel): Promise<any[]> {
  const transcript = renderTranscript(old);
  const res: any = await llm().responses.create({
    model: defaultModel(),
    input: [{ role: 'system', content: SUMMARY_PROMPT }, { role: 'user', content: transcript }],
    store: false,
    ...lowEffort(),
    ...compactionOutputLimit(beforeModel),
  } as any);
  await recordModelUsage({ botId, kind: 'compaction', model: defaultModel(), response: res });
  const text = String(res.output_text ?? '').trim();
  if (!text) throw new Error('summary was empty');
  // Earlier direct provider compaction items can't be read back as text, so carry them over unchanged.
  const carried = old.filter((it) => it?.type === 'compaction');
  return [...carried, { role: 'user', content: `[Automatic summary of the earlier conversation, made to save space. Treat it as your own notes.]\n${text}` }];
}

const compactCooldown = new Map<string, number>();

/**
 * Compact a bot's history if it is over budget. Must run inside the bot's serial queue
 * (it is called from the agent loop before each model call), so it never races a turn.
 * Returns the history to send.
 */
export async function maybeCompact(botId: string, items: any[], opts: { force?: boolean; beforeModel?: BeforeCompactionModel } = {}): Promise<any[]> {
  const limit = memoryConfig.compactChars;
  const before = historySize(botId, items);
  if (!opts.force && before <= limit) return items;
  if (!opts.force && (compactCooldown.get(botId) ?? 0) > now()) return items;
  if (db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(botId)) return items; // unpaired calls; wait
  // Don't compact again until a meaningful amount was added since the last compaction (prevents loops
  // if the compacted form itself stays over budget).
  const prev = lastCompaction.get(botId);
  const gen = getBotRow(botId)?.generation;
  if (!opts.force && prev && prev.generation === gen && prev.items <= items.length && estimateChars(items.slice(prev.items)) < limit * 0.25) return items;

  const split = pickSplit(items, limit, memoryConfig.keepTurns);
  if (split <= 0) return items;
  const old = items.slice(0, split);
  const keep = items.slice(split);
  if (!opts.force && estimateChars(old) < limit * 0.15) return items; // not worth it

  const bot = getBotRow(botId);
  const t0 = Date.now();
  let method = 'direct-compact';
  let replaced: any[];
  try {
    if (memoryConfig.compactMethod === 'summary') throw new Error('direct provider compaction disabled by SWARM_COMPACT_METHOD=summary');
    if (llmProvider() !== 'direct') throw new Error('compaction endpoint is direct provider-only; using a summary');
    replaced = await compactWithDirect(botId, old, opts.beforeModel);
  } catch (e: any) {
    // Budget/abort rejection is control flow, not a provider failure to work around.
    if (e instanceof CompactionGuardError) throw e.rejection;
    console.warn(`[memory] compact via /responses/compact failed for ${botId}: ${e?.message ?? e}; falling back to a summary`);
    method = 'summary';
    try {
      replaced = await compactWithSummary(botId, old, opts.beforeModel);
    } catch (e2: any) {
      if (e2 instanceof CompactionGuardError) throw e2.rejection;
      console.error(`[memory] summary fallback failed for ${botId}: ${e2?.message ?? e2}`);
      compactCooldown.set(botId, now() + 10 * 60_000);
      return items;
    }
  }

  const next = [...replaced, ...keep];
  const ok = db.transaction(() => {
    // Guard: history must be exactly what we compacted (nothing appended meanwhile).
    const cur = db.prepare('SELECT COUNT(*) n FROM llm_items WHERE bot_id=? AND generation=?').get(botId, bot.generation) as any;
    if (cur.n !== items.length) return false;
    db.prepare('DELETE FROM llm_items WHERE bot_id=? AND generation=?').run(botId, bot.generation);
    const ins = db.prepare('INSERT INTO llm_items(bot_id,generation,idx,item) VALUES (?,?,?,?)');
    next.forEach((it, i) => ins.run(botId, bot.generation, i, JSON.stringify(it)));
    db.prepare('INSERT INTO compactions(bot_id,generation,method,items_before,items_after,chars_before,chars_after,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(botId, bot.generation, method, items.length, next.length, before, estimateChars(next), now());
    return true;
  })();
  if (!ok) return items;
  usage.delete(botId); // indices changed; the next model call measures the compacted history
  lastCompaction.set(botId, { generation: bot.generation, items: next.length });
  console.log(`[memory] compacted ${bot.name} (${botId}) via ${method}: ${items.length} items/${before} chars -> ${next.length} items/${estimateChars(next)} chars, kept ${keep.length} recent, ${Date.now() - t0}ms`);
  return next;
}

// ---------------------------------------------------------------------------
// (b) consolidation
// ---------------------------------------------------------------------------

const STOP = new Set('a an the and or but of to in on at for with from by is are was were be been it its this that these those i me my you your user users they them their we our he she his her as about into than then so if not no do does did have has had will would can could should just also very really more most some any all prefers likes wants'.split(' '));

export function words(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));
}

export function similar(a: string, b: string): boolean {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter) >= 0.7 || (inter / Math.min(A.size, B.size) >= 0.9 && Math.min(A.size, B.size) >= 3);
}

const CONSOLIDATE_PROMPT = `You maintain the long-term memory of an AI assistant ("Bot") that works for one user.
Read the recent conversation and extract only durable facts worth remembering for weeks:
- facts about the user (role, company, team, location, time zone, important people, accounts and tools they use)
- preferences and standing instructions (tone, formats, schedules, what to always or never do)
- lasting facts about ongoing projects
Skip: one-off requests, small talk, temporary states, anything the Bot said about itself, passwords or secrets, and exact facts already covered by EXISTING MEMORIES. If the user corrects an existing fact, return the corrected fact with its new sources; do not discard a correction as a duplicate.
Write each memory as one short standalone sentence in the third person (e.g. "Prefers bullet-point summaries."), under 200 characters. Return at most 8. Return an empty list when nothing qualifies. Every fact MUST cite one or more sourceIds printed before actual user messages, in generation:seq form. Never cite assistant or bot/routine messages as evidence for a user fact.`;

const SCHEMA = {
  type: 'object',
  properties: { memories: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, sourceIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 } }, required: ['text', 'sourceIds'], additionalProperties: false } } },
  required: ['memories'],
  additionalProperties: false,
};

export interface ConsolidateResult { added: string[]; skipped: number; considered: number }

/** Extract durable facts from messages newer than the bot's last consolidation. */
export function consolidateBot(botId: string, opts: { upTo?: number } = {}): Promise<ConsolidateResult> {
  return withUsage({ botId, kind: 'memory' }, () => consolidateBotInContext(botId, opts));
}

async function consolidateBotInContext(botId: string, opts: { upTo?: number }): Promise<ConsolidateResult> {
  const bot = getBotRow(botId);
  if (!bot) return { added: [], skipped: 0, considered: 0 };
  const job = db.prepare('SELECT * FROM memory_jobs WHERE bot_id=?').get(botId) as any;
  const since = job?.last_consolidated_at ?? 0;
  const upTo = opts.upTo ?? now();
  assertWritable(bot.user_id,botId);
  const candidates = db.prepare(`SELECT body,generation,seq,created_at FROM rows WHERE bot_id=? AND kind='message'
    AND (created_at>? OR (created_at=? AND (generation>? OR generation=? AND seq>?))) AND created_at<=?
    ORDER BY created_at,generation,seq LIMIT 60`).all(botId,since,since,job?.cursor_generation??0,job?.cursor_generation??0,job?.cursor_seq??0,upTo) as any[];
  // Consume a contiguous prefix. Never trim the head and then checkpoint a tail.
  // An oversized individual source is included whole rather than silently lost.
  const rows:any[]=[];let chars=0;
  for(const r of candidates){let b:any;try{b=JSON.parse(r.body);}catch{rows.push(r);continue;}
    if(b.streaming)break;
    const len=String(b.text??'').length+100;if(rows.length&&chars+len>24000)break;
    rows.push(r);chars+=len;
  }
  if(!rows.length)return {added:[],skipped:0,considered:0};
  const last=rows[rows.length-1];const lastAt=last.created_at;
  const mark=(result:unknown,_at:number)=>db.prepare(`INSERT INTO memory_jobs(bot_id,last_consolidated_at,cursor_generation,cursor_seq,last_result) VALUES(?,?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET last_consolidated_at=excluded.last_consolidated_at,cursor_generation=excluded.cursor_generation,cursor_seq=excluded.cursor_seq,last_result=excluded.last_result`).run(botId,lastAt,last.generation,last.seq,JSON.stringify(result));
  const msgs = rows.map((r) => {try{return {...JSON.parse(r.body),sourceId:`${r.generation}:${r.seq}`};}catch{return null;}}).filter((b) => b?.type === 'message' && b.text && !b.streaming);
  const sourceRows = new Map(rows.map(r => [`${r.generation}:${r.seq}`, r]));
  if (!msgs.some(isHumanUserMessage)) {
    mark({ added: 0, at: now(), note: 'no user messages' }, lastAt);
    return { added: [], skipped: 0, considered: msgs.length };
  }
  const transcript = msgs.map((m) => `[source ${m.sourceId}] ` + (m.role === 'user' ? (m.from && !isHumanUserMessage(m) ? `${m.from.kind === 'bot' ? `Bot ${m.from.name}` : `Routine ${m.from.name}`}: ` : 'User: ') : `${bot.name} (Bot): `) + String(m.text)).join('\n');

  const existing = listMemories(bot.user_id, botId).map(m => m.text);
  const res: any = await llm().responses.create({
    model: defaultModel(),
    input: [
      { role: 'system', content: CONSOLIDATE_PROMPT },
      { role: 'user', content: `EXISTING MEMORIES:\n${existing.length ? existing.map((t) => `- ${t}`).join('\n') : '(none)'}\n\nRECENT CONVERSATION:\n${transcript}` },
    ],
    text: { format: { type: 'json_schema', name: 'memories', schema: SCHEMA, strict: true } },
    ...lowEffort(),
    store: false,
  } as any);
  await recordModelUsage({ botId, kind: 'memory', model: defaultModel(), response: res });
  let parsedOk=false;let proposed: { text: string; sourceIds?: string[] }[] = [];
  try {
    const parsed = JSON.parse(String(res.output_text ?? '{}')).memories;
    if (Array.isArray(parsed)) {parsedOk=true;proposed = parsed.filter(m => typeof m?.text === 'string' && (m.sourceIds === undefined || Array.isArray(m.sourceIds)));}
  } catch { /* bad model output publishes nothing */ }

  if(!parsedOk)throw new Error('Memory extraction returned invalid JSON; coverage retained for retry');
  const added: string[] = [];
  let skipped = 0;
  // The model call runs outside a transaction. Revalidate conversation generation
  // and source contents under the same transaction as publication; deleted bots,
  // resets, edited sources and owner changes cannot publish stale learning.
  db.transaction(() => {
    assertWritable(bot.user_id,botId);
    const latestCursor=db.prepare('SELECT * FROM memory_jobs WHERE bot_id=?').get(botId) as any;
    if((latestCursor?.last_consolidated_at??0)!==since||(latestCursor?.cursor_generation??0)!==(job?.cursor_generation??0)||(latestCursor?.cursor_seq??0)!==(job?.cursor_seq??0)){skipped=proposed.length;return;}
    const current = getBotRow(botId);
    if (!current || current.user_id !== bot.user_id || current.generation !== bot.generation) { skipped = proposed.length; return; }
    for (const row of rows) {
      const latest = db.prepare('SELECT body FROM rows WHERE bot_id=? AND generation=? AND seq=?').get(botId, row.generation, row.seq) as any;
      if (!latest || latest.body !== row.body) { skipped = proposed.length; return; }
    }
    for (const candidate of proposed.slice(0, 8)) {
      const text = candidate.text.trim();
      const legacyRefs = candidate.sourceIds === undefined ? inferUserEvidence(text, rows.filter(r => { const m = JSON.parse(r.body); return isHumanUserMessage(m) && !m.streaming; }).map(r => ({ ref: { botId, generation: r.generation, seq: r.seq }, text: JSON.parse(r.body).text }))) : [];
      const sourceIds = candidate.sourceIds ?? legacyRefs.map(r => `${r.generation}:${r.seq}`);
      if (!text || text.length > 300 || sourceIds.length < 1 || sourceIds.length > 12) { skipped++; continue; }
      const refs: MessageRef[] = [];
      for (const id of sourceIds) {
        const row = sourceRows.get(id); const message = row && JSON.parse(row.body);
        if (!row || !isHumanUserMessage(message)) { refs.length = 0; break; }
        refs.push({ botId, generation: row.generation, seq: row.seq });
      }
      if (!refs.length || added.some(e => e===text)) { skipped++; continue; }
      const result = learnMemory(bot.user_id, botId, { text, evidence: refs });
      if (result.skipped) skipped++; else added.push(text);
    }
    mark({ added: added.length, skipped, at: now() }, lastAt);
  })();
  if (added.length) {
    console.log(`[memory] consolidated ${bot.name} (${botId}): +${added.length} (skipped ${skipped} duplicates)`);
    hub.emit(bot.user_id, { type: 'memories', botId });
  }
  return { added, skipped, considered: msgs.length };
}

const consolidating = new Set<string>();

/** Bots whose newest message is older than the idle window and newer than their last consolidation. */
export function botsDueForConsolidation(idleMs: number, at = now()): { botId: string; lastAt: number }[] {
  const rows = db.prepare(`
    SELECT r.bot_id, MAX(r.created_at) AS last_at, COALESCE(j.last_consolidated_at, 0) AS done_at
    FROM rows r LEFT JOIN memory_jobs j ON j.bot_id = r.bot_id
    WHERE r.kind = 'message'
    GROUP BY r.bot_id
  `).all() as any[];
  return rows.filter((r) => db.prepare(`SELECT 1 FROM rows x LEFT JOIN memory_jobs j ON j.bot_id=x.bot_id WHERE x.bot_id=? AND x.kind='message' AND (x.created_at>coalesce(j.last_consolidated_at,0) OR x.created_at=coalesce(j.last_consolidated_at,0) AND (x.generation>coalesce(j.cursor_generation,0) OR x.generation=coalesce(j.cursor_generation,0) AND x.seq>coalesce(j.cursor_seq,0))) LIMIT 1`).get(r.bot_id) && at - r.last_at >= idleMs).map((r) => ({ botId: r.bot_id, lastAt: r.last_at }));
}

export function startMemoryConsolidation() {
  const idleMs = memoryConfig.consolidateIdleMin * 60_000;
  const sweep = async () => {
    for (const { botId, lastAt } of botsDueForConsolidation(idleMs)) {
      if (consolidating.has(botId) || getLive(botId).isRunning) continue;
      if (db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(botId)) continue;
      consolidating.add(botId);
      try { await consolidateBot(botId, { upTo: lastAt }); }
      catch (e: any) { console.warn(`[memory] consolidation failed for ${botId}: ${e?.message ?? e}`); }
      finally { consolidating.delete(botId); }
    }
  };
  const timer = setInterval(() => { sweep().catch(() => {}); }, memoryConfig.consolidateSweepSec * 1000);
  timer.unref?.();
  console.log(`[memory] consolidation after ${memoryConfig.consolidateIdleMin} min idle; compaction over ${memoryConfig.compactChars} chars`);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// (c) bounded memory section for the system prompt
// ---------------------------------------------------------------------------

/** Most relevant (keyword overlap with recent user messages) and most recent memories, within a character budget. */
export function memoriesForPrompt(botId: string, budget = memoryConfig.promptMemoryChars): { lines: string[]; omitted: number } {
  const bot = getBotRow(botId);
  if (!bot) return { lines: [], omitted: 0 };
  const all = listMemories(bot.user_id, botId).slice(0, 500).map(m => ({ text: m.text, created_at: m.createdAt, id: m.id }));
  if (!all.length) return { lines: [], omitted: 0 };
  const recent = (db.prepare("SELECT body FROM rows WHERE bot_id=? AND generation=? AND kind='message' ORDER BY seq DESC LIMIT 12").all(botId, bot.generation) as any[])
    .map((r) => JSON.parse(r.body))
    .filter((b) => b.role === 'user')
    .slice(0, 3)
    .map((b) => String(b.text ?? ''))
    .join(' ');
  const ctx = words(recent);
  const scored = all.map((m, i) => {
    let overlap = 0;
    for (const w of words(m.text)) if (ctx.has(w)) overlap++;
    return { m, score: overlap * 2 + (1 - i / all.length) };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked: typeof all = [];
  let used = 0;
  for (const { m } of scored) {
    const len = m.text.length + 3;
    if (used + len > budget) continue;
    picked.push(m);
    used += len;
  }
  picked.sort((a, b) => a.created_at - b.created_at);
  return { lines: picked.map((m) => `- [${m.id}] ${m.text}`), omitted: all.length - picked.length };
}
