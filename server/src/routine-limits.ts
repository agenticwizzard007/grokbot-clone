import { Cron } from 'croner';
import { db, now } from './db.js';
import { appendRow } from './store.js';

/**
 * Guardrails for routines. Every run is a full Bot turn (a model call, and computer time if the
 * Bot uses its computer), so how often, how many and for whom they run is limited. All limits are
 * environment settings; 0 turns a limit off.
 *
 *   ROUTINE_MIN_INTERVAL_MIN          15   timed routines run at most this often (checked at creation and at run time)
 *   ROUTINE_MAX_PER_BOT               10   active routines per Bot
 *   ROUTINE_MAX_PER_USER              25   active routines per account
 *   ROUTINE_MAX_RUNS_PER_DAY          100  runs per account in any 24 hours (timed, event and "run now" together)
 *   ROUTINE_EVENT_MIN_GAP_SEC         60   an event routine runs at most once per this many seconds (bursts are coalesced)
 *   ROUTINE_PAUSE_IF_USER_IDLE_DAYS   30   routines of accounts with no message from their user for this long are paused
 *                                          (they resume on their own when the user is back)
 * A run is also skipped while the same routine's previous run is still queued or running.
 */

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export const routineLimits = {
  minIntervalMin: num(process.env.ROUTINE_MIN_INTERVAL_MIN, 15),
  maxPerBot: num(process.env.ROUTINE_MAX_PER_BOT, 10),
  maxPerUser: num(process.env.ROUTINE_MAX_PER_USER, 25),
  maxRunsPerDay: num(process.env.ROUTINE_MAX_RUNS_PER_DAY, 100),
  eventGapSec: num(process.env.ROUTINE_EVENT_MIN_GAP_SEC, 60),
  pauseIfIdleDays: num(process.env.ROUTINE_PAUSE_IF_USER_IDLE_DAYS, 30),
};

db.exec(`
CREATE TABLE IF NOT EXISTS routine_runs (
  user_id TEXT NOT NULL,
  routine_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS routine_runs_user_at ON routine_runs(user_id, at);`);

const DAY = 24 * 3600_000;

/** The shortest gap, in minutes, between upcoming runs of a cron schedule. */
export function minGapMinutes(schedule: string, timezone = 'UTC'): number {
  const c = new Cron(schedule, { paused: true, timezone });
  const runs = c.nextRuns(24).map((d) => d.getTime());
  c.stop();
  let gap = Infinity;
  for (let i = 1; i < runs.length; i++) gap = Math.min(gap, runs[i] - runs[i - 1]);
  return gap / 60_000;
}

const userOfBot = (botId: string) => (db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as { user_id: string } | undefined)?.user_id ?? null;

/** Can this Bot get another active routine (with this schedule)? Returns a message for the Bot if not. */
export function checkRoutineCreate(botId: string, schedule: string | null, opts: { timezone?: string; excludeRoutineId?: string } = {}): string | null {
  const userId = userOfBot(botId);
  if (!userId) return 'Unknown Bot.';
  const ex = opts.excludeRoutineId ?? '';
  const L = routineLimits;
  if (L.maxPerBot) {
    const n = (db.prepare('SELECT COUNT(*) n FROM routines WHERE bot_id=? AND enabled=1 AND id<>?').get(botId, ex) as { n: number }).n;
    if (n >= L.maxPerBot) return `This Bot already has ${n} active routines (the limit is ${L.maxPerBot}). Pause or delete one first, or combine them into one routine.`;
  }
  if (L.maxPerUser) {
    const n = (db.prepare('SELECT COUNT(*) n FROM routines r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? AND r.enabled=1 AND r.id<>?').get(userId, ex) as { n: number }).n;
    if (n >= L.maxPerUser) return `This account already has ${n} active routines (the limit is ${L.maxPerUser}). Pause or delete one first.`;
  }
  if (schedule && !schedule.startsWith('event:') && L.minIntervalMin) {
    let gap: number;
    try { gap = minGapMinutes(schedule, opts.timezone || 'UTC'); } catch (e: any) { return `Invalid schedule: ${e?.message ?? e}`; }
    if (gap < L.minIntervalMin) {
      return `Routines can run at most every ${L.minIntervalMin} minutes, and this schedule runs every ${Math.max(1, Math.round(gap))}. Pick a slower schedule, or for things that need a quick reaction (a new email, a Slack message…) create an event routine instead: it runs only when the event happens.`;
    }
  }
  return null;
}

// ---------- at run time ----------

export type RunKind = 'schedule' | 'event' | 'manual';
export type RunCheck = { ok: true } | { ok: false; reason: string };

/** Routines whose previous run is still queued or running (cleared when that turn finishes). */
const inflight = new Map<string, number>();
const INFLIGHT_MAX_MS = 30 * 60_000;

function lastUserActivity(userId: string): number {
  const msg = db.prepare(`SELECT MAX(r.created_at) t FROM rows r JOIN bots b ON b.id=r.bot_id
    WHERE b.user_id=? AND r.kind='message' AND json_extract(r.body,'$.role')='user'`).get(userId) as { t: number | null };
  const created = (db.prepare('SELECT created_at FROM users WHERE id=?').get(userId) as { created_at: number } | undefined)?.created_at ?? 0;
  return Math.max(msg?.t ?? 0, created);
}

/** May this routine run now? Records the run when it may. */
export function checkRoutineRun(r: { id: string; bot_id: string; last_run_at: number | null }, kind: RunKind): RunCheck {
  const userId = userOfBot(r.bot_id);
  if (!userId) return { ok: false, reason: 'its Bot no longer exists' };
  const L = routineLimits;
  const t = now();
  const started = inflight.get(r.id);
  if (started && t - started < INFLIGHT_MAX_MS) return { ok: false, reason: 'its previous run is still going' };
  if (kind === 'schedule' && L.minIntervalMin && r.last_run_at && t - r.last_run_at < L.minIntervalMin * 60_000 - 60_000) {
    return { ok: false, reason: `routines run at most every ${L.minIntervalMin} minutes` };
  }
  if (kind === 'event' && L.eventGapSec && r.last_run_at && t - r.last_run_at < L.eventGapSec * 1000) {
    return { ok: false, reason: `events within ${L.eventGapSec} seconds of the last run are combined into it` };
  }
  if (kind !== 'manual' && L.pauseIfIdleDays && t - lastUserActivity(userId) > L.pauseIfIdleDays * DAY) {
    return { ok: false, reason: `paused: no message from you in ${L.pauseIfIdleDays} days (send any message to resume)` };
  }
  if (L.maxRunsPerDay) {
    const n = (db.prepare('SELECT COUNT(*) n FROM routine_runs WHERE user_id=? AND at>?').get(userId, t - DAY) as { n: number }).n;
    if (n >= L.maxRunsPerDay) return { ok: false, reason: `this account reached its limit of ${L.maxRunsPerDay} routine runs in 24 hours` };
  }
  db.prepare('INSERT INTO routine_runs(user_id,routine_id,kind,at) VALUES (?,?,?,?)').run(userId, r.id, kind, t);
  if (Math.random() < 0.02) db.prepare('DELETE FROM routine_runs WHERE at<?').run(t - 2 * DAY);
  return { ok: true };
}

/** After queuing a routine's turn: it counts as running until that turn (and anything ahead of it) finishes. */
export function trackRun(routineId: string, botId: string) {
  inflight.set(routineId, now());
  // Lazy: the agent loop imports modules that import this one.
  void import('./agent/loop.js').then(({ runInBotQueue }) => runInBotQueue(botId, async () => { inflight.delete(routineId); })).catch(() => inflight.delete(routineId));
}

const told = new Set<string>();

/** Tell the user (in the Bot's chat) why a run was skipped, at most once per routine and reason per day. */
export function noteSkipped(r: { id: string; bot_id: string; name: string }, reason: string) {
  console.log(`[routines] skipped "${r.name}" (${r.id}): ${reason}`);
  const key = `${r.id}:${reason}:${Math.floor(now() / DAY)}`;
  if (told.has(key)) return;
  told.add(key);
  if (told.size > 5000) told.clear();
  appendRow(r.bot_id, 'event', { type: 'event', event: 'routine-run', text: `Routine "${r.name}" skipped: ${reason}.`, ref: r.id });
}
