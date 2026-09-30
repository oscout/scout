/** Process-local burst control for interactive Chat writes, not a distributed quota. */
export class ChatSendLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly now = Date.now, private readonly burst = 20, private readonly refillMs = 1000, private readonly maxKeys = 10000) {}
  /** Zero permits the attempt; otherwise return Retry-After seconds. */
  take(key: string): number {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      // Only prune on allocation; active identities cannot evict one another.
      if (this.buckets.size >= this.maxKeys) {
        for (const [id, value] of this.buckets) if (now - value.at >= this.burst * this.refillMs) this.buckets.delete(id);
        if (this.buckets.size >= this.maxKeys) return Math.ceil(this.burst * this.refillMs / 1000);
      }
      bucket = { tokens: this.burst, at: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, now - bucket.at);
    bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed / this.refillMs);
    bucket.at = Math.max(now, bucket.at);
    if (bucket.tokens < 1) return Math.max(1, Math.ceil((1 - bucket.tokens) * this.refillMs / 1000));
    bucket.tokens -= 1;
    return 0;
  }
}
