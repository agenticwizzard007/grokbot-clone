/** A bounded, process-local cache for read-only provider metadata. */
export class MetadataCache<T> {
  private entries = new Map<string, { value?: T; at: number; retryAt: number; pending?: Promise<T> }>();
  constructor(private ttl = 30_000, private timeout = 3500) {}
  async read(key: string, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 100) this.entries.delete(this.entries.keys().next().value!);
      entry = { at: 0, retryAt: 0 };
      this.entries.set(key, entry);
    }
    const cached = entry;
    if (cached.value !== undefined && Date.now() - cached.at < this.ttl) return cached.value;
    if (Date.now() < cached.retryAt) {
      if (cached.value !== undefined) return cached.value;
      throw new Error('Provider details unavailable. Please retry.');
    }
    if (!cached.pending) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      cached.pending = Promise.race([load(controller.signal), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Provider details unavailable. Please retry.')); }, this.timeout);
      })]).then(value => { cached.value = value; cached.at = Date.now(); return value; }).catch(error => {
        cached.retryAt = Date.now() + 5000;
        throw error;
      }).finally(() => { clearTimeout(timer); cached.pending = undefined; });
    }
    if (cached.value !== undefined) { void cached.pending.catch(() => {}); return cached.value; }
    return cached.pending;
  }
}
