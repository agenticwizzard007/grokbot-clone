/** Public toolkit metadata only. Never cache private connection status here. */
export function createCatalogCache<T>(ttlMs = 60 * 60_000) {
  let scope = '', generation = 0;
  let saved: { value: T; at: number } | undefined;
  let pending: Promise<T> | undefined;
  return {
    clear() { generation++; saved = undefined; pending = undefined; },
    async get(key: string, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (key !== scope) { this.clear(); scope = key; }
      if (saved && Date.now() - saved.at < ttlMs) return saved.value;
      if (!pending) {
        const epoch = generation;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new DOMException('Catalog unavailable', 'TimeoutError')), 8000);
        const loading = Promise.race([load(controller.signal), new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        })]);
        const request = loading.then(value => { if (generation === epoch) saved = { value, at: Date.now() }; return value; })
          .finally(() => { clearTimeout(timer); if (pending === request) pending = undefined; });
        pending = request;
      }
      if (saved) { void pending.catch(() => {}); return saved.value; }
      return pending;
    },
  };
}
