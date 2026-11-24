/** Bounded Settings reads, including body decoding and account verification. */
export async function settingsRead<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, timeoutMs = 4000): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new DOMException('Status unavailable. Please retry.', 'TimeoutError')), timeoutMs);
  try {
    return await Promise.race([work(controller.signal), new Promise<never>((_, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason);
      else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    })]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

/** Memory only, scoped to the signed-in account; clear on account changes/logout. */
export function createSettingsCache<T>() {
  let owner: string | undefined;
  const values = new Map<string, T>();
  const pending = new Map<string, Promise<T>>();
  let epoch = 0;
  return {
    scope(accountId: string | undefined) {
      if (owner !== accountId) { owner = accountId; values.clear(); pending.clear(); epoch++; }
    },
    peek(key: string) { return values.get(key); },
    remove(key: string) { values.delete(key); },
    async refresh(key: string, read: () => Promise<T>) {
      const running = pending.get(key);
      if (running) return running;
      const generation = epoch;
      const next = read().then(value => { if (epoch === generation) { values.set(key, value); if (values.size > 80) values.delete(values.keys().next().value!); } return value; })
        .finally(() => { if (pending.get(key) === next) pending.delete(key); });
      pending.set(key, next);
      return next;
    },
  };
}
