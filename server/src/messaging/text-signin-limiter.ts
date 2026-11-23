export const TEXT_SIGNIN_WINDOW_MS = 10 * 60_000;
export const TEXT_SIGNIN_SOURCE_LIMIT = 10;
export const TEXT_SIGNIN_RECIPIENT_LIMIT = 3;
export const TEXT_SIGNIN_MAX_BUCKETS = 10_000;

/** Process-local rolling quotas. Active buckets are never evicted to admit new identities. */
export class TextSigninLimiter {
  // Insertion order follows the last accepted hit, so expiry only walks stale buckets.
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly clock: () => number = () => Date.now(),
    private readonly maxBuckets = TEXT_SIGNIN_MAX_BUCKETS,
  ) {}

  get size() { return this.buckets.size; }

  allow(source: string, recipient: string): boolean {
    const now = this.clock();
    const cutoff = now - TEXT_SIGNIN_WINDOW_MS;
    for (const [key, hits] of this.buckets) {
      if (hits[hits.length - 1] > cutoff) break;
      this.buckets.delete(key);
    }
    // Count source attempts even when the recipient has already reached its quota.
    return this.take(`source:${source}`, TEXT_SIGNIN_SOURCE_LIMIT, now, cutoff)
      && this.take(`recipient:${recipient}`, TEXT_SIGNIN_RECIPIENT_LIMIT, now, cutoff);
  }

  private take(key: string, limit: number, now: number, cutoff: number): boolean {
    const hits = (this.buckets.get(key) ?? []).filter((t) => t > cutoff);
    if (hits.length >= limit || (!this.buckets.has(key) && this.buckets.size >= this.maxBuckets)) return false;
    this.buckets.delete(key);
    this.buckets.set(key, [...hits, now]);
    return true;
  }
}
