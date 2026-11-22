/**
 * MF-011: the server pings every 20 s. If nothing (not even a ping) arrives for 45 s the stream is
 * stuck behind a proxy or a dropped subscriber; force a reconnect and resync.
 */
export const SSE_STALE_MS = 45_000;
export const ROWS_FALLBACK_MS = 10_000;

export interface WatchdogClock {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
const realClock: WatchdogClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function createSseWatchdog(onStale: () => void, opts: { staleMs?: number; checkMs?: number; clock?: WatchdogClock } = {}) {
  const staleMs = opts.staleMs ?? SSE_STALE_MS;
  const clock = opts.clock ?? realClock;
  let last = clock.now();
  let handle: unknown;
  const check = () => {
    if (clock.now() - last < staleMs) return;
    last = clock.now(); // one reconnect per stale window
    onStale();
  };
  return {
    /** Call on open and on every message, including pings. */
    beat() { last = clock.now(); },
    start() { if (handle === undefined) { last = clock.now(); handle = clock.setInterval(check, opts.checkMs ?? 5_000); } },
    stop() { if (handle !== undefined) { clock.clearInterval(handle); handle = undefined; } },
    check,
  };
}

/** Last time a `rows` event arrived per Bot, so a send can fall back to one reload if the stream is silent. */
const lastRowsAt = new Map<string, number>();
export function noteRowsEvent(botId: string, at = Date.now()) { lastRowsAt.set(botId, at); }
export function rowsSince(botId: string, since: number) { return (lastRowsAt.get(botId) ?? -Infinity) >= since; }

/** After a send: if no `rows` event for that Bot arrives within 10 s, reload its rows once. */
export function expectRowsAfterSend(botId: string, reload: () => void, opts: { since?: number; timeoutMs?: number; now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown } = {}) {
  const now = opts.now ?? Date.now;
  const sentAt = opts.since ?? now();
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  return setTimer(() => { if (!rowsSince(botId, sentAt)) reload(); }, opts.timeoutMs ?? ROWS_FALLBACK_MS);
}
