import { AsyncLocalStorage } from 'node:async_hooks';

export interface NativeToolCall {
  id: string; name: string; arguments: Record<string, unknown>;
  /** Local admission guard, never sent over the runner protocol. */
  signal?: AbortSignal;
}
export interface NativeToolResult { output: unknown; isError?: boolean; stop?: boolean }
export type NativeToolHandler = (call: NativeToolCall) => Promise<NativeToolResult>;
interface Context { userId: string; call: NativeToolHandler; drain: () => Promise<void>; close: () => void }
const nativeTools = new AsyncLocalStorage<Context>();

/** Bind callbacks to one Bot turn. Independent Bots retain independent queues. */
export async function withNativeTools<T>(userId: string, handler: NativeToolHandler, work: () => Promise<T>): Promise<T> {
  let tail = Promise.resolve(), closed = false;
  // WebSocket/HTTP callbacks arrive outside the Bot's async chain. Preserve its
  // usage, account and computer scope instead of inheriting the transport's.
  const inTurn = AsyncLocalStorage.snapshot();
  const context: Context = {
    userId,
    call: call => {
      if (closed) return Promise.reject(new Error('This tool session has ended.'));
      const pending = tail.then(() => {
        if (closed || call.signal?.aborted) throw new Error('This tool session has ended.');
        return inTurn(handler, call);
      });
      tail = pending.then(() => {}, () => {});
      return pending;
    },
    drain: () => tail,
    close: () => { closed = true; },
  };
  try { return await nativeTools.run(context, work); }
  finally {
    context.close();
    // A cancelled model must not release the Bot queue while an external action
    // is still running. Its outcome is recorded before another turn can start.
    await context.drain();
  }
}

export function nativeToolHandler(userId: string): NativeToolHandler | undefined {
  const context = nativeTools.getStore();
  return context?.userId === userId ? context.call : undefined;
}

/** Validate/deduplicate against this generation's manifest before any execution. */
export function nativeToolSession(names: Iterable<string>, handler: NativeToolHandler, signal?: AbortSignal) {
  const allowed = new Set(names);
  const admission = new AbortController();
  const abort = () => admission.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const seen = new Map<string, { payload: string; pending: Promise<NativeToolResult> }>();
  let stopped = false, closed = false;
  const call: NativeToolHandler = async input => {
    if (closed || signal?.aborted) throw new Error('This tool session has ended.');
    if (!input || typeof input.id !== 'string' || !input.id || input.id.length > 1024
      || typeof input.name !== 'string' || !allowed.has(input.name)) throw new Error('CLI requested an unavailable tool.');
    if (!input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) throw new Error('CLI tool arguments must be an object.');
    const payload = JSON.stringify({ name: input.name, arguments: input.arguments });
    if (payload.length > 1_000_000) throw new Error('CLI tool arguments are too large.');
    const prior = seen.get(input.id);
    if (prior) {
      if (prior.payload !== payload) throw new Error('CLI reused a tool request ID with different arguments.');
      return prior.pending;
    }
    if (seen.size >= 512) throw new Error('Too many native tool requests in one generation.');
    if (stopped) return { output: 'This turn is paused. No further actions were executed.', stop: true };
    // Include queued callbacks in the same manifest and replay guard. Tool order
    // is owned by withNativeTools, which also drains in-flight work on cancellation.
    const pending = handler({ id: input.id, ...JSON.parse(payload), signal: admission.signal }).then(result => { if (result.stop) stopped = true; return result; });
    seen.set(input.id, { payload, pending });
    return pending;
  };
  return { call, get stopped() { return stopped; }, close: () => { closed = true; admission.abort(); signal?.removeEventListener('abort', abort); },
    drain: async () => { await Promise.allSettled([...seen.values()].map(value => value.pending)); } };
}
