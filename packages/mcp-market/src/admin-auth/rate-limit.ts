/**
 * In-memory login throttle for the single Admin account.
 *
 * A fixed window per `client+username` pair is enough here: there is no user
 * table to protect and no distributed deployment to coordinate. The limiter
 * deliberately fails closed on the *count* only — it never blocks a correct
 * credential permanently, because the window always expires.
 */

export type RateLimitDecision = {
  allowed: boolean;
  /** Seconds until the caller may try again. Only set when blocked. */
  retryAfterSeconds: number;
};

export type RateLimiterOptions = {
  maxAttempts: number;
  windowMs: number;
  /** Injectable clock so tests do not sleep. */
  now?: () => number;
};

type Bucket = { count: number; resetAt: number };

export class LoginRateLimiter {
  readonly #maxAttempts: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(options: RateLimiterOptions) {
    this.#maxAttempts = options.maxAttempts;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? (() => Date.now());
  }

  check(key: string): RateLimitDecision {
    const bucket = this.#read(key);
    if (!bucket || bucket.count < this.#maxAttempts)
      return { allowed: true, retryAfterSeconds: 0 };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((bucket.resetAt - this.#now()) / 1000),
      ),
    };
  }

  /** Records a failed attempt and returns the updated decision. */
  recordFailure(key: string): RateLimitDecision {
    const timestamp = this.#now();
    const existing = this.#buckets.get(key);
    const bucket: Bucket =
      !existing || existing.resetAt <= timestamp
        ? { count: 1, resetAt: timestamp + this.#windowMs }
        : { count: existing.count + 1, resetAt: existing.resetAt };
    this.#buckets.set(key, bucket);
    this.#prune(timestamp);
    if (bucket.count < this.#maxAttempts)
      return { allowed: true, retryAfterSeconds: 0 };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((bucket.resetAt - timestamp) / 1000),
      ),
    };
  }

  /** Clears the window after a successful login. */
  reset(key: string): void {
    this.#buckets.delete(key);
  }

  #read(key: string): Bucket | null {
    const bucket = this.#buckets.get(key);
    if (!bucket) return null;
    if (bucket.resetAt <= this.#now()) {
      this.#buckets.delete(key);
      return null;
    }
    return bucket;
  }

  /** Bounds memory without a background timer. */
  #prune(timestamp: number): void {
    if (this.#buckets.size < 512) return;
    for (const [key, bucket] of this.#buckets)
      if (bucket.resetAt <= timestamp) this.#buckets.delete(key);
  }
}
