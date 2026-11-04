import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * A small in-memory limit: at most `limit` hits per key in `windowMs`. It resets when the API restarts
 * and is per server; that is enough to stop casual abuse. Put a shared limiter (Redis) in front if you run several servers.
 */
export class RateLimit {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly message: string,
  ) {}

  /** Records a hit, or throws 429 once the key is over its limit. */
  take(key: string) {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((time) => now - time < this.windowMs);
    if (recent.length >= this.limit) throw new HttpException(this.message, HttpStatus.TOO_MANY_REQUESTS);
    this.hits.set(key, [...recent, now]);
    if (this.hits.size > 10000) this.evict(now);
  }

  // Drops keys with no hits left in the window; live limits are kept.
  private evict(now: number) {
    for (const [key, times] of this.hits) {
      if (times.every((time) => now - time >= this.windowMs)) this.hits.delete(key);
    }
  }
}
