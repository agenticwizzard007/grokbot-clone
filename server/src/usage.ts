import { attribution } from './usage-context.js';
export { withUsage } from './usage-context.js';
import { db, now } from './db.js';
import { llmProvider, openrouterModels } from './lib/llm.js';
import { computerByDay, computerByUser, computerCsvRows, computerTotals, type ComputerTotals } from './usage-vm.js';

/**
 * AI usage monitor: one row per billable AI request (model calls, transcription, speech, voice
 * minutes), attributed to the account and Bot it was for. Costs come from the provider when it
 * reports them (OpenRouter `usage.cost` in USD, xAI `usage.cost_in_usd_ticks`), otherwise they're
 * estimated from OpenRouter's public price list and marked as estimates; unknown stays unknown.
 *
 * Attribution: callers pass userId/botId explicitly where they know them; otherwise the ambient
 * context (withUsage) set around each Bot turn and each signed-in API request fills them in.
 */

export type UsageKind = 'chat' | 'compaction' | 'memory' | 'voice' | 'voice_summary' | 'transcription' | 'speech' | 'other';

db.exec(`
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  bot_id TEXT,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  units REAL,
  unit TEXT,
  cost_usd REAL,
  cost_source TEXT,
  byok INTEGER,
  request_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_user_time ON usage_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS usage_time ON usage_events(created_at);
`);

// ---------- recording ----------

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/** Server-side tool calls (web/X search) in a Responses API output, for providers that don't count them. */
const countSearchItems = (output: unknown) => (Array.isArray(output) ? output.filter((o: any) => /search/.test(String(o?.type ?? '')) && o?.type !== 'function_call').length : 0);

/** Price per million tokens for a model, from OpenRouter's catalog (exact id, or "vendor/<model>"). */
async function priceFor(model: string): Promise<{ input: number; output: number } | null> {
  const list = await openrouterModels().catch(() => []);
  model = model.replace(/:nitro$/, '');
  const m = list.find((x) => x.id === model) ?? list.find((x) => x.id.endsWith(`/${model}`));
  return m?.price ?? null;
}

export interface RecordOpts {
  userId?: string | null;
  botId?: string | null;
  kind?: UsageKind;
  model: string;
  provider?: string;
}

/**
 * Record a Responses API (or Chat Completions) result. Never throws: usage tracking must not
 * break the request it describes.
 */
export async function recordModelUsage(opts: RecordOpts & { response: any }): Promise<void> {
  try {
    const u = opts.response?.usage;
    if (!u) return;
    const who = attribution(opts);
    const input = num(u.input_tokens ?? u.prompt_tokens);
    const cached = num(u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens);
    const output = num(u.output_tokens ?? u.completion_tokens);
    const reasoning = num(u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens);
    const tools = num(u.num_server_side_tools_used) || countSearchItems(opts.response?.output);
    let cost: number | null = null;
    let source: 'provider' | 'estimate' | 'subscription' | null = null;
    if (opts.response?.billing === 'subscription') { cost = 0; source = 'subscription'; }
    else if (typeof u.cost === 'number' && Number.isFinite(u.cost)) { cost = u.cost; source = 'provider'; }
    else if (u.cost_in_usd_ticks != null && Number.isFinite(Number(u.cost_in_usd_ticks))) { cost = Number(u.cost_in_usd_ticks) / 1e10; source = 'provider'; }
    else {
      const p = await priceFor(opts.model);
      if (p && (input || output)) { cost = (input * p.input + output * p.output) / 1e6; source = 'estimate'; }
    }
    insert({
      userId: who.userId, botId: who.botId, kind: who.kind, provider: opts.provider ?? opts.response?.provider ?? llmProvider(), model: opts.model,
      input, cached, output, reasoning, tools, units: null, unit: null, cost, source,
      byok: typeof u.is_byok === 'boolean' ? (u.is_byok ? 1 : 0) : null, requestId: typeof opts.response?.id === 'string' ? opts.response.id : null,
    });
  } catch (e) {
    console.warn('[usage] could not record', (e as Error)?.message);
  }
}

/** Record a non-token request (audio seconds, characters, voice minutes), with a cost if the provider reported one. */
export function recordUnits(opts: RecordOpts & { units: number; unit: string; costUsd?: number | null; requestId?: string | null }) {
  try {
    const who = attribution(opts);
    insert({
      userId: who.userId, botId: who.botId, kind: who.kind, provider: opts.provider ?? llmProvider(), model: opts.model,
      input: 0, cached: 0, output: 0, reasoning: 0, tools: 0, units: opts.units, unit: opts.unit,
      cost: opts.costUsd ?? null, source: opts.costUsd != null ? 'provider' : null, byok: null, requestId: opts.requestId ?? null,
    });
  } catch (e) {
    console.warn('[usage] could not record', (e as Error)?.message);
  }
}

function insert(r: {
  userId: string | null; botId: string | null; kind: string; provider: string; model: string;
  input: number; cached: number; output: number; reasoning: number; tools: number;
  units: number | null; unit: string | null; cost: number | null; source: string | null; byok: number | null; requestId: string | null;
}) {
  db.prepare(`INSERT INTO usage_events(user_id,bot_id,kind,provider,model,input_tokens,cached_tokens,output_tokens,reasoning_tokens,tool_calls,units,unit,cost_usd,cost_source,byok,request_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(r.userId, r.botId, r.kind, r.provider, r.model, r.input, r.cached, r.output, r.reasoning, r.tools, r.units, r.unit, r.cost, r.source, r.byok, r.requestId, now());
}

// ---------- reporting ----------

export type UsageRange = 'today' | '7d' | '30d' | 'month';

/** UTC day windows, matching OpenRouter's daily/monthly windows and the free plan's midnight-UTC reset. */
export function rangeBounds(range: UsageRange, at = Date.now()): { from: number; to: number; days: number } {
  const d = new Date(at);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const day = 86_400_000;
  if (range === 'today') return { from: today, to: at, days: 1 };
  if (range === '7d') return { from: today - 6 * day, to: at, days: 7 };
  if (range === 'month') {
    const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    return { from: first, to: at, days: Math.round((today - first) / day) + 1 };
  }
  return { from: today - 29 * day, to: at, days: 30 };
}

const KIND_LABEL: Record<string, string> = {
  chat: 'Bot conversations', compaction: 'Memory: compacting history', memory: 'Memory: learning facts', voice: 'Voice calls',
  voice_summary: 'Voice call summaries', transcription: 'Voice notes & dictation', speech: 'Spoken replies', other: 'Other',
};

interface Totals { costUsd: number; estimatedUsd: number; unpricedRequests: number; unpricedVoice: number; inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number; requests: number; toolCalls: number; voiceMinutes: number }

export interface UsageRow { key: string; label: string; costUsd: number; tokens: number; requests: number; unpriced: number; minutes: number; recordings: number; characters: number; computerUsd?: number; computerHours?: number }

export interface UsageReport {
  range: { key: UsageRange; from: number; to: number };
  totals: Totals;
  /** costUsd is AI only; computerUsd is the estimated computer (VM) cost that day. */
  days: { day: string; costUsd: number; computerUsd: number; tokens: number; requests: number }[];
  computer: ComputerTotals;
  byBot: UsageRow[];
  byModel: UsageRow[];
  byKind: UsageRow[];
  byUser?: UsageRow[];
}

/** Usage for one account (userId) or for the whole server (userId null). */
export function usageReport(userId: string | null, range: UsageRange): UsageReport {
  const { from, to, days } = rangeBounds(range);
  const where = userId ? 'user_id=? AND created_at>=? AND created_at<=?' : 'created_at>=? AND created_at<=?';
  const args = userId ? [userId, from, to] : [from, to];
  const SUMS = `COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(CASE WHEN cost_source='estimate' THEN cost_usd END),0) est,
    SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) unpriced, COALESCE(SUM(input_tokens),0) inp, COALESCE(SUM(cached_tokens),0) cached,
    COALESCE(SUM(output_tokens),0) outp, COALESCE(SUM(reasoning_tokens),0) reas, COUNT(*) n, COALESCE(SUM(tool_calls),0) tools,
    COALESCE(SUM(CASE WHEN unit='minutes' THEN units END),0) mins, SUM(CASE WHEN cost_usd IS NULL AND kind='voice' THEN 1 ELSE 0 END) unpriced_voice`;
  const t = db.prepare(`SELECT ${SUMS} FROM usage_events WHERE ${where}`).get(...args) as any;
  const totals: Totals = {
    costUsd: t.cost, estimatedUsd: t.est, unpricedRequests: t.unpriced ?? 0, unpricedVoice: t.unpriced_voice ?? 0, inputTokens: t.inp, cachedTokens: t.cached,
    outputTokens: t.outp, reasoningTokens: t.reas, requests: t.n, toolCalls: t.tools, voiceMinutes: t.mins,
  };

  const fromDay = new Date(from).toISOString().slice(0, 10);
  const toDay = new Date(to).toISOString().slice(0, 10);
  const vmDays = computerByDay(userId, fromDay, toDay);
  const dayRows = db.prepare(`SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') day, COALESCE(SUM(cost_usd),0) cost,
      COALESCE(SUM(input_tokens+output_tokens),0) tokens, COUNT(*) n FROM usage_events WHERE ${where} GROUP BY day`).all(...args) as any[];
  const byDay = new Map(dayRows.map((r) => [r.day, r]));
  const dayList = Array.from({ length: days }, (_, i) => {
    const day = new Date(from + i * 86_400_000).toISOString().slice(0, 10);
    const r = byDay.get(day);
    return { day, costUsd: r?.cost ?? 0, computerUsd: vmDays.get(day) ?? 0, tokens: r?.tokens ?? 0, requests: r?.n ?? 0 };
  });

  const group = (col: string) =>
    (db.prepare(`SELECT ${col} k, COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(input_tokens+output_tokens),0) tokens, COUNT(*) n,
        SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) unpriced,
        COALESCE(SUM(CASE WHEN unit='minutes' THEN units END),0) mins, COALESCE(SUM(CASE WHEN unit='recordings' THEN units END),0) recs,
        COALESCE(SUM(CASE WHEN unit='characters' THEN units END),0) chars
      FROM usage_events WHERE ${where} GROUP BY ${col} ORDER BY cost DESC, tokens DESC`).all(...args) as any[]);
  const extra = (r: any) => ({ unpriced: r.unpriced ?? 0, minutes: r.mins, recordings: r.recs, characters: r.chars });

  // Across accounts several Bots share a name (everyone starts with Quinn), so name the owner too.
  const botNames = new Map((db.prepare(`SELECT b.id, b.name, COALESCE(u.name, u.email, '') owner FROM bots b LEFT JOIN users u ON u.id=b.user_id`).all() as { id: string; name: string; owner: string }[])
    .map((b) => [b.id, userId || !b.owner ? b.name : `${b.name} · ${b.owner}`]));
  const byBot = group('bot_id').map((r) => ({ key: r.k ?? '', label: r.k ? botNames.get(r.k) ?? 'Removed Bot' : 'Not tied to a Bot', costUsd: r.cost, tokens: r.tokens, requests: r.n, ...extra(r) }));
  const byModel = group('model').map((r) => ({ key: r.k, label: r.k, costUsd: r.cost, tokens: r.tokens, requests: r.n, ...extra(r) }));
  const byKind = group('kind').map((r) => ({ key: r.k, label: KIND_LABEL[r.k] ?? r.k, costUsd: r.cost, tokens: r.tokens, requests: r.n, ...extra(r) }));

  const report: UsageReport = { range: { key: range, from, to }, totals, days: dayList, computer: computerTotals(userId, fromDay, toDay), byBot, byModel, byKind };
  if (!userId) {
    const users = new Map((db.prepare('SELECT id, name, email, phone FROM users').all() as any[]).map((u) => [u.id, u]));
    const vmUsers = computerByUser(fromDay, toDay);
    const nameOf = (id: string) => {
      const u = id ? users.get(id) : null;
      return u ? (u.name || u.email || (u.phone ? `+${u.phone}` : id)) : id ? 'Deleted account' : 'Not tied to an account';
    };
    const rows: UsageRow[] = group('user_id').map((r) => {
      const vm = vmUsers.get(r.k ?? '');
      return { key: r.k ?? '', label: nameOf(r.k ?? ''), costUsd: r.cost, tokens: r.tokens, requests: r.n, ...extra(r), computerUsd: vm?.costUsd ?? 0, computerHours: vm?.runningHours ?? 0 };
    });
    // Accounts whose only cost is their computer.
    for (const [id, vm] of vmUsers) {
      if (!rows.some((r) => r.key === id)) rows.push({ key: id, label: nameOf(id), costUsd: 0, tokens: 0, requests: 0, unpriced: 0, minutes: 0, recordings: 0, characters: 0, computerUsd: vm.costUsd, computerHours: vm.runningHours });
    }
    report.byUser = rows;
  }
  return report;
}

/** CSV of raw events (no message content is ever stored here). */
export function usageCsv(userId: string | null, range: UsageRange): string {
  const { from, to } = rangeBounds(range);
  const rows = (userId
    ? db.prepare('SELECT * FROM usage_events WHERE user_id=? AND created_at>=? AND created_at<=? ORDER BY created_at').all(userId, from, to)
    : db.prepare('SELECT * FROM usage_events WHERE created_at>=? AND created_at<=? ORDER BY created_at').all(from, to)) as any[];
  const cols = ['time_utc', 'account', 'bot', 'activity', 'provider', 'model', 'input_tokens', 'cached_tokens', 'output_tokens', 'reasoning_tokens', 'tool_calls', 'units', 'unit', 'cost_usd', 'cost_source'];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s;
  };
  const lines = rows.map((r) => [new Date(r.created_at).toISOString(), r.user_id, r.bot_id, r.kind, r.provider, r.model, r.input_tokens, r.cached_tokens, r.output_tokens, r.reasoning_tokens, r.tool_calls, r.units, r.unit, r.cost_usd, r.cost_source].map(esc).join(','));
  const fromDay = new Date(from).toISOString().slice(0, 10);
  const toDay = new Date(to).toISOString().slice(0, 10);
  // Computer time: one row per day, computer and state (hours, estimated cost).
  for (const v of computerCsvRows(userId, fromDay, toDay)) {
    const size = v.cpus ? `${v.cpus} vCPU${v.memory_mb ? ` / ${v.memory_mb} MB` : ''}${v.disk_gb ? ` / ${v.disk_gb} GB disk` : ''}` : '';
    lines.push([`${v.day}T00:00:00.000Z`, v.user_id, '', `computer_${v.state}`, v.provider, size, 0, 0, 0, 0, 0, Math.round((v.seconds / 3600) * 1000) / 1000, 'hours', v.cost_usd, 'estimate'].map(esc).join(','));
  }
  return [cols.join(','), ...lines].join('\n') + '\n';
}
