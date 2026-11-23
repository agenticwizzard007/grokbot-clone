import { db, now } from './db.js';
import { setupOnboarding } from './setup-state.js';
import { hub } from './lib/hub.js';
import { afterCommit } from './lib/commit-effects.js';
import type { Bot, LiveState, Row, RowBody, RowKind, Routine, Task } from './types.js';
import { currentJobId, executionAudience } from './usage-context.js';
import { Cron } from 'croner';
import { recordHumanSource } from './coordination/sources.js';
import { applyExplicitPreferenceCorrections } from './knowledge/memory.js';
import { isHumanUserMessage } from './knowledge/sessions.js';

// ---------- bots ----------

/** Plain text for one-line previews: drop markdown emphasis, links, code fences and headings. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sidebar preview for the latest user-facing row. Only pending cards say they are waiting. */
export function previewFor(b: RowBody): string | null {
  if (b.type === 'message') return stripMarkdown(b.text);
  if (b.type === 'event') return b.text;
  if (b.type !== 'card') return null;
  if (b.card === 'approval') {
    const label = b.status === 'pending' ? 'Waiting for you' : b.status === 'denied' ? 'Not allowed' : b.status === 'expired' ? 'Expired' : 'Allowed';
    return `${label}: ${b.title}`;
  }
  if (b.card === 'question') return b.question;
  if (b.card === 'connect') return b.status === 'pending' ? `Connect ${b.toolkitName}` : b.status === 'connected' ? `Connected ${b.toolkitName}` : b.status === 'skipped' ? `Skipped: Connect ${b.toolkitName}` : `Expired: Connect ${b.toolkitName}`;
  return 'Draft';
}

export function toBot(r: any): Bot {
  const last = db
    .prepare(`SELECT body, created_at FROM rows WHERE bot_id=? AND generation=? AND kind IN ('message','card','event')
      AND COALESCE(json_extract(body,'$.audience'),'user')!='internal'
      AND (json_extract(body,'$.audience')='user' OR COALESCE(json_extract(body,'$.from.kind'),'')!='bot')
      ORDER BY seq DESC LIMIT 1`)
    .get(r.id, r.generation) as any;
  const lastPreview = last ? previewFor(JSON.parse(last.body) as RowBody) : null;
  // Order by the user's own activity so the sidebar does not reshuffle while Bots stream rows.
  const lastUser = db.prepare(`SELECT created_at FROM rows WHERE bot_id=? AND kind='message' AND json_extract(body,'$.role')='user'
    ORDER BY generation DESC, seq DESC LIMIT 1`).get(r.id) as { created_at: number } | undefined;
  const setup = setupOnboarding(r.id);
  return {
    id: r.id,
    name: r.name,
    label: r.label,
    description: r.description,
    instructions: r.instructions,
    avatarShape: r.avatar_shape,
    avatarColor: r.avatar_color,
    mode: r.mode,
    isPrimary: !!r.is_primary,
    kind: r.kind === 'room' ? 'room' : 'agent',
    pinned: !!r.pinned,
    effort: r.effort,
    fast: !!r.fast,
    model: r.model ?? null,
    voice: r.voice ?? 'luna',
    voiceSpeed: r.voice_speed ?? 1,
    voiceLanguage: r.voice_language ?? 'auto',
    generation: r.generation,
    unread: r.unread,
    lastPreview: lastPreview ? lastPreview.slice(0, 140) : null,
    lastActivityAt: Math.max(lastUser?.created_at ?? 0, r.created_at ?? 0),
    createdAt: r.created_at,
    onboarding: { status: setup?.status ?? 'active', revision: setup?.revision ?? 0 },
  };
}

export const getBotRow = (id: string) => db.prepare('SELECT * FROM bots WHERE id=?').get(id) as any;
export const getBot = (id: string) => {
  const r = getBotRow(id);
  return r ? toBot(r) : null;
};
export const listBots = (userId: string) =>
  (db.prepare('SELECT * FROM bots WHERE user_id=? AND COALESCE(hidden,0)=0 ORDER BY is_primary DESC, created_at ASC').all(userId) as any[]).map(toBot);

export function emitBot(botId: string) {
  const r = getBotRow(botId);
  if (r) hub.emit(r.user_id, { type: 'bot', bot: toBot(r) });
}

// ---------- rows ----------

/** Server-side observers of transcript changes (e.g. the messaging bridge). Called after the SSE fan-out. */
type RowListener = (userId: string, row: Row, isNew: boolean) => void;
const rowListeners = new Set<RowListener>();
export function onRowChange(fn: RowListener): () => void {
  rowListeners.add(fn);
  return () => rowListeners.delete(fn);
}
function notifyRow(userId: string, row: Row, isNew: boolean) {
  afterCommit(() => {
    for (const fn of rowListeners) {
      try { fn(userId, row, isNew); } catch (e) { console.warn('[rows] listener failed', (e as Error).message); }
    }
  });
}

function toRow(r: any): Row {
  return { botId: r.bot_id, generation: r.generation, seq: r.seq, updatedSeq: r.updated_seq, kind: r.kind, audience: JSON.parse(r.body).audience, body: JSON.parse(r.body), createdAt: r.created_at };
}

function bumpRev(botId: string): number {
  db.prepare('UPDATE bots SET rev = rev + 1, updated_at=? WHERE id=?').run(now(), botId);
  return (db.prepare('SELECT rev FROM bots WHERE id=?').get(botId) as any).rev;
}

/** Source and correction share the row transaction, before observers can start work. */
function recordMessageSource(userId: string, botId: string, generation: number, seq: number, revision: number, body: RowBody) {
  recordHumanSource(userId, botId, generation, seq, revision, body);
  if (body.type === 'message' && body.audience === 'user' && isHumanUserMessage(body) && !body.streaming && body.text.trim()) {
    return applyExplicitPreferenceCorrections(userId, botId, [{ botId, generation, seq }]).length > 0;
  }
  return false;
}

/** Thrown instead of writing a card for a group chat turn (R2F-001). */
export class RoomCardRefused extends Error {
  constructor() { super('Group chat turns cannot show cards in a member chat. Nothing was done.'); this.name = 'RoomCardRefused'; }
}

/** The durable job a card belongs to was triggered by a group chat message. */
function roomTriggeredJob(botId: string, jobId: unknown): boolean {
  if (typeof jobId !== 'string' || !jobId) return false;
  try {
    const job = db.prepare("SELECT json_extract(trigger,'$.roomId') room FROM agent_jobs WHERE id=? AND bot_id=?").get(jobId, botId) as { room: string | null } | undefined;
    return !!job?.room;
  } catch { return false; } // agent_jobs may not exist in a partial schema.
}

/** Append a new row. Returns its seq. */
export function appendRow(botId: string, kind: RowKind, body: RowBody): Row {
  // Last line of defence: a group turn never writes an approval, question, connect or draft card into a
  // member's own chat, whichever code path tries. The runtime already avoids this; log if it ever happens.
  if ((kind === 'card' || body.type === 'card') && roomTriggeredJob(botId, (body as { jobId?: unknown }).jobId ?? currentJobId())) {
    console.warn('[rows] refused a card row for a group chat turn', { botId, card: (body as { card?: string }).card });
    throw new RoomCardRefused();
  }
  const jobId = body.jobId ?? (body.type === 'message' || body.type === 'tool-call' ? currentJobId() ?? undefined : undefined);
  body = { ...body, jobId, audience: body.type === 'card' ? 'user' : body.audience ?? executionAudience(botId) };
  const tx = db.transaction(() => {
    const b = db.prepare('SELECT user_id, generation, next_seq FROM bots WHERE id=?').get(botId) as any;
    const seq = b.next_seq;
    db.prepare('UPDATE bots SET next_seq = next_seq + 1 WHERE id=?').run(botId);
    const rev = bumpRev(botId);
    const t = now();
    db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)').run(botId, b.generation, seq, rev, kind, JSON.stringify(body), t);
    const memoryChanged = kind === 'message' && recordMessageSource(b.user_id, botId, b.generation, seq, rev, body);
    return { userId: b.user_id as string, memoryChanged, row: { botId, generation: b.generation, seq, updatedSeq: rev, kind, audience: body.audience, body, createdAt: t } as Row };
  });
  const { userId, row, memoryChanged } = tx();
  if (memoryChanged) hub.emit(userId, { type: 'memories', botId });
  hub.emit(userId, { type: 'rows', botId, generation: row.generation, rows: [row] });
  notifyRow(userId, row, true);
  return row;
}

/** Rewrite an existing row's body (e.g. streaming text, card status). */
export function updateRow(botId: string, seq: number, body: RowBody): Row | null {
  const tx = db.transaction(() => {
    const b = db.prepare('SELECT user_id, generation FROM bots WHERE id=?').get(botId) as any;
    const existing = db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq=?').get(botId, b.generation, seq) as any;
    if (!existing) return null;
    const prior = JSON.parse(existing.body) as RowBody;
    const jobId = body.jobId ?? prior.jobId ?? (body.type === 'message' || body.type === 'tool-call' ? currentJobId() ?? undefined : undefined);
    body = { ...body, jobId, audience: body.type === 'card' ? 'user' : body.audience ?? prior.audience ?? executionAudience(botId) };
    const rev = bumpRev(botId);
    db.prepare('UPDATE rows SET body=?, updated_seq=? WHERE bot_id=? AND generation=? AND seq=?').run(JSON.stringify(body), rev, botId, b.generation, seq);
    const memoryChanged = existing.kind === 'message' && recordMessageSource(b.user_id, botId, b.generation, seq, rev, body);
    return { userId: b.user_id as string, memoryChanged, row: { ...toRow(existing), body, audience: body.audience, updatedSeq: rev } as Row };
  });
  const res = tx();
  if (!res) return null;
  if (res.memoryChanged) hub.emit(res.userId, { type: 'memories', botId });
  hub.emit(res.userId, { type: 'rows', botId, generation: res.row.generation, rows: [res.row] });
  notifyRow(res.userId, res.row, false);
  return res.row;
}

export function getRow(botId: string, seq: number): Row | null {
  const b = getBotRow(botId);
  const r = db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq=?').get(botId, b.generation, seq);
  return r ? toRow(r) : null;
}

export function listRows(botId: string, opts: { beforeSeq?: number; limit?: number; afterRev?: number } = {}): Row[] {
  const b = getBotRow(botId);
  if (!b) return [];
  if (opts.afterRev !== undefined) {
    return (db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? AND updated_seq>? ORDER BY seq ASC').all(botId, b.generation, opts.afterRev) as any[]).map(toRow);
  }
  const limit = Math.min(opts.limit ?? 200, 500);
  const rows = (opts.beforeSeq
    ? db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq<? ORDER BY seq DESC LIMIT ?').all(botId, b.generation, opts.beforeSeq, limit)
    : db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? ORDER BY seq DESC LIMIT ?').all(botId, b.generation, limit)) as any[];
  return rows.reverse().map(toRow);
}

export function clearConversation(botId: string) {
  const b = getBotRow(botId);
  db.prepare('UPDATE bots SET generation = generation + 1, next_seq = 1 WHERE id=?').run(botId);
  db.prepare('DELETE FROM pending_turns WHERE bot_id=?').run(botId);
  hub.emit(b.user_id, { type: 'cleared', botId, generation: b.generation + 1 });
}

// ---------- LLM history (Responses API input items) ----------

export function loadHistory(botId: string): any[] {
  const b = getBotRow(botId);
  return (db.prepare('SELECT item FROM llm_items WHERE bot_id=? AND generation=? ORDER BY idx ASC').all(botId, b.generation) as any[]).map((r) => JSON.parse(r.item));
}

export function appendHistory(botId: string, items: any[]) {
  if (!items.length) return;
  const b = getBotRow(botId);
  const start = ((db.prepare('SELECT MAX(idx) m FROM llm_items WHERE bot_id=? AND generation=?').get(botId, b.generation) as any).m ?? -1) + 1;
  const ins = db.prepare('INSERT INTO llm_items(bot_id,generation,idx,item) VALUES (?,?,?,?)');
  db.transaction(() => items.forEach((it, i) => ins.run(botId, b.generation, start + i, JSON.stringify(it))))();
}

// ---------- live state ----------

const live = new Map<string, LiveState>();

export function getLive(botId: string): LiveState {
  return live.get(botId) ?? { botId, isRunning: false, activity: null, awaiting: null, startedAt: null };
}

export function setLive(botId: string, patch: Partial<LiveState>) {
  afterCommit(() => {
    const next = { ...getLive(botId), ...patch, botId, audience: patch.awaiting || patch.activity?.kind === 'waiting_for_you' ? 'user' as const : patch.audience ?? executionAudience(botId) };
    live.set(botId, next);
    const b = getBotRow(botId);
    if (b) hub.emit(b.user_id, { type: 'live', state: next });
  });
}

export const allLive = (userId: string) => listBots(userId).map((b) => getLive(b.id));

// ---------- routines / tasks ----------

export function describeCron(expr: string): string {
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5) return expr;
  const [m, h, dom, mon, dow] = p;
  const time = /^\d+$/.test(m) && /^\d+$/.test(h) ? new Date(2000, 0, 1, +h, +m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null;
  if (time && dom === '*' && mon === '*' && dow === '*') return `Every day at ${time}`;
  if (time && dom === '*' && mon === '*' && dow === '1-5') return `Weekdays at ${time}`;
  if (time && dom === '*' && mon === '*' && /^[0-6]$/.test(dow)) return `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][+dow]} at ${time}`;
  if (m === '0' && h === '*') return 'Every hour';
  if (/^\*\/\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${m.slice(2)} minutes`;
  if (m === '0' && /^\*\/\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') return `Every ${h.slice(2)} hours`;
  return expr;
}

function describeEventSlug(schedule: string) {
  const words = schedule.slice(6).split('_');
  const app = words.shift() ?? '';
  return `When ${app.charAt(0) + app.slice(1).toLowerCase()}: ${words.join(' ').toLowerCase()}`;
}

export function toRoutine(r: any): Routine {
  let nextRunAt: number | null = null;
  try {
    nextRunAt = r.enabled ? new Cron(r.schedule, { timezone: r.timezone, paused: true }).nextRun()?.getTime() ?? null : null;
  } catch { /* invalid cron */ }
  return {
    id: r.id, botId: r.bot_id, name: r.name, prompt: r.prompt, schedule: r.schedule, timezone: r.timezone,
    enabled: !!r.enabled, nextRunAt, lastRunAt: r.last_run_at, description: r.schedule.startsWith('event:') ? describeEventSlug(r.schedule) : describeCron(r.schedule),
    activationTarget: r.activation_target == null ? null : !!r.activation_target,
    activationPending: r.activation_target != null && !r.activation_error, activationError: r.activation_error ?? null,
  };
}

export const listRoutines = (botId: string) => (db.prepare('SELECT * FROM routines WHERE bot_id=? ORDER BY created_at').all(botId) as any[]).map(toRoutine);

export const toTask = (r: any): Task => ({ id: r.id, botId: r.bot_id, title: r.title, state: r.state, note: r.note, updatedAt: r.updated_at });
export const listTasks = (botId: string) => (db.prepare('SELECT * FROM tasks WHERE bot_id=? ORDER BY updated_at DESC').all(botId) as any[]).map(toTask);
