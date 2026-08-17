import { Injectable, Logger } from '@nestjs/common';

type Bucket = { count: number; resetAt: number };

export type RateRule = { name: string; limit: number; windowMs: number };

export type RateVerdict = { allowed: boolean; retryAfterMs: number; rule: string };

/**
 * Fixed-window rate-limit counter store (in-memory, per process).
 * Sufficient for the single-instance deployment; swap the Map for Redis
 * when the API is scaled horizontally.
 */
@Injectable()
export class RateLimitService {
  private logger = new Logger('RateLimit');
  private buckets = new Map<string, Bucket>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Cheap periodic cleanup so unused keys never accumulate.
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  /**
   * Evaluate one rule. Counters only increment when the request is allowed
   * (denied requests do not extend their own block).
   */
  hit(key: string, rule: RateRule): RateVerdict {
    const now = Date.now();
    const fullKey = `${rule.name}:${key}`;
    let bucket = this.buckets.get(fullKey);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + rule.windowMs };
      this.buckets.set(fullKey, bucket);
    }

    if (bucket.count >= rule.limit) {
      return {
        allowed: false,
        retryAfterMs: bucket.resetAt - now,
        rule: rule.name,
      };
    }

    bucket.count += 1;
    return { allowed: true, retryAfterMs: 0, rule: rule.name };
  }

  /** Evaluate every rule; if all pass, all counters are (already) incremented.
   *  If any denies, return the longest wait so the client sees the truth. */
  hitAll(entries: Array<{ key: string; rule: RateRule }>): RateVerdict {
    // Pre-check deny state without incrementing, so a denied request does not
    // burn budget in the other rules.
    const verdicts = entries.map(({ key, rule }) => this.peek(key, rule));
    const denied = verdicts.filter((v) => !v.allowed);
    if (denied.length) {
      return denied.reduce((worst, v) => (v.retryAfterMs > worst.retryAfterMs ? v : worst));
    }
    let last: RateVerdict = { allowed: true, retryAfterMs: 0, rule: '' };
    for (const { key, rule } of entries) last = this.hit(key, rule);
    return last;
  }

  private peek(key: string, rule: RateRule): RateVerdict {
    const now = Date.now();
    const bucket = this.buckets.get(`${rule.name}:${key}`);
    if (!bucket || bucket.resetAt <= now) {
      return { allowed: true, retryAfterMs: 0, rule: rule.name };
    }
    if (bucket.count >= rule.limit) {
      return { allowed: false, retryAfterMs: bucket.resetAt - now, rule: rule.name };
    }
    return { allowed: true, retryAfterMs: 0, rule: rule.name };
  }

  private sweep() {
    const now = Date.now();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
        removed++;
      }
    }
    if (this.buckets.size > 5000) {
      this.logger.warn(`rate-limit bucket count high: ${this.buckets.size}`);
    }
    void removed;
  }

  dispose() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.buckets.clear();
  }
}
