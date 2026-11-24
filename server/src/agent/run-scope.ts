import { AsyncLocalStorage } from 'node:async_hooks';

/** Captured by asynchronous work, so an old callback never borrows a new turn's signal. */
export interface RunScope {
  id: string;
  botId: string;
  signal: AbortSignal;
  closed: boolean;
  /** Only the loop's terminal bookkeeping may write after cancellation. */
  control?: boolean;
}
const runs = new AsyncLocalStorage<RunScope | undefined>();
export const currentRun = () => runs.getStore();
export const withRun = <T>(run: RunScope | undefined, work: () => T): T => runs.run(run, work);
export const canPublishRun = (run = currentRun()) => !run || run.control || !run.closed && !run.signal.aborted;
export function assertRunWritable() {
  if (!canPublishRun()) throw currentRun()!.signal.reason ?? new Error('This run has ended.');
}
export function runSignal(timeoutMs?: number): AbortSignal | undefined {
  assertRunWritable();
  const signal = currentRun()?.signal;
  return timeoutMs === undefined ? signal : signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

/** Stop waiting immediately even if an SDK ignores abort. Its callbacks remain fenced by RunScope. */
export async function abortable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([work(), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}
