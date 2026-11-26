/** Status only: generations and login sessions keep their own lifetimes. */
export function createStatusReader<T extends { connected: boolean }>(
  snapshot: (key: string) => T,
  probe: (key: string, signal: AbortSignal) => Promise<unknown>,
) {
  const entries = new Map<string, { checkedAt: number; unavailable: boolean; error?: unknown; pending?: Promise<void> }>();
  return async (key: string, force = false): Promise<T & { statusUnavailable?: boolean; statusChecking?: boolean }> => {
    let entry = entries.get(key);
    const cached = !!entry || snapshot(key).connected;
    if (!entry) { entry = { checkedAt: -Infinity, unavailable: false }; entries.set(key, entry); }
    const state = entry;
    if (!state.pending && (force || Date.now() - state.checkedAt >= 5000)) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      state.pending = Promise.race([
        Promise.resolve().then(() => probe(key, controller.signal)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('Status probe timed out')); }, 3000);
        }),
      ]).then(() => { state.unavailable = false; state.error = undefined; }, error => { state.unavailable = true; state.error = error; })
        .finally(() => { clearTimeout(timer); state.checkedAt = Date.now(); state.pending = undefined; });
    }
    // The underlying provider snapshot is account-scoped and updated by the probe.
    // It also reflects selection/reset mutations immediately, without a second copy.
    if ((!cached || force) && state.pending) {
      // A cold CLI may need seconds to load. Return Checking quickly and let the
      // account-scoped probe finish in the background; callers poll the snapshot.
      let wait: ReturnType<typeof setTimeout>;
      try { await Promise.race([state.pending, new Promise<void>(resolve => { wait = setTimeout(resolve, 200); })]); }
      finally { clearTimeout(wait!); }
    }
    if (force && !state.pending && state.error) throw state.error;
    // Keep the snapshot visible during revalidation, with an explicit Checking
    // hint so display consumers never mistake an empty snapshot for sign-out.
    return { ...snapshot(key), ...(state.pending ? { statusChecking: true } : state.unavailable ? { statusChecking: false, statusUnavailable: true } : {}) };
  };
}
