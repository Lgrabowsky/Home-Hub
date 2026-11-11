/**
 * Brute-force protection for the login endpoints.
 *
 * Failures are counted per key (IP, user, user+IP). Once a key crosses its
 * threshold it is locked, and every further failure doubles the lock time up
 * to a ceiling. A successful login clears the user-specific keys.
 */

interface Entry {
  failures: number;
  windowStart: number;
  lockedUntil: number;
  lockLevel: number;
}

export interface ThrottleRule {
  /** Failures allowed inside `windowMs` before the key is locked. */
  threshold: number;
  windowMs: number;
  baseLockMs: number;
  maxLockMs: number;
}

export const LOGIN_RULES = {
  /** One client hammering one account. */
  pair: { threshold: 5, windowMs: 15 * 60_000, baseLockMs: 60_000, maxLockMs: 15 * 60_000 },
  /** One address trying many accounts. */
  ip: { threshold: 20, windowMs: 15 * 60_000, baseLockMs: 5 * 60_000, maxLockMs: 60 * 60_000 },
  /** Distributed guessing against one account (kept high so outsiders cannot lock a user out cheaply). */
  user: { threshold: 50, windowMs: 60 * 60_000, baseLockMs: 5 * 60_000, maxLockMs: 30 * 60_000 },
  /**
   * Wrong codes after a CORRECT password. Only somebody who knows the password gets here, so this
   * can be strict: without it, slow guessing (a few codes per hour from changing addresses) finds a
   * valid six-digit code within weeks.
   */
  secondFactor: { threshold: 8, windowMs: 60 * 60_000, baseLockMs: 30 * 60_000, maxLockMs: 24 * 60 * 60_000 },
} satisfies Record<string, ThrottleRule>;

export class Throttle {
  private readonly entries = new Map<string, Entry>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Seconds the caller still has to wait, 0 when the attempt may proceed. */
  retryAfter(keys: string[]): number {
    const now = this.now();
    let wait = 0;
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry && entry.lockedUntil > now) wait = Math.max(wait, entry.lockedUntil - now);
    }
    return Math.ceil(wait / 1000);
  }

  fail(key: string, rule: ThrottleRule): void {
    const now = this.now();
    this.sweep(now);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { failures: 0, windowStart: now, lockedUntil: 0, lockLevel: 0 };
      this.entries.set(key, entry);
    } else if (entry.lockedUntil <= now && now - entry.windowStart > rule.windowMs) {
      // The window expired: count afresh, and forget the escalation after a long quiet period.
      if (now - Math.max(entry.lockedUntil, entry.windowStart) > rule.maxLockMs * 4) entry.lockLevel = 0;
      entry.failures = 0;
      entry.windowStart = now;
    }
    entry.failures++;
    if (entry.failures >= rule.threshold) {
      const lock = Math.min(rule.maxLockMs, rule.baseLockMs * 2 ** entry.lockLevel);
      entry.lockedUntil = now + lock;
      entry.lockLevel++;
      // Next window: a single further failure re-locks (with a longer delay).
      entry.failures = rule.threshold - 1;
      entry.windowStart = now;
    }
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil <= now && now - entry.windowStart > 6 * 60 * 60_000) this.entries.delete(key);
    }
    // Hard cap as a memory safety net against address-spraying.
    if (this.entries.size > 50_000) {
      const excess = this.entries.size - 40_000;
      let i = 0;
      for (const key of this.entries.keys()) {
        if (i++ >= excess) break;
        this.entries.delete(key);
      }
    }
  }
}

/**
 * Runs credential checks one after the other per key (address, account).
 * Without it, requests sent in parallel would all pass the "locked?" check
 * before the first failure is recorded — the password hash takes a moment.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    // A fixed order of acquisition: two requests can never wait for each other in a circle.
    const ordered = [...new Set(keys)].sort();
    const releases: (() => void)[] = [];
    try {
      for (const key of ordered) {
        const previous = this.tails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => (release = resolve));
        const tail = previous.then(() => current);
        this.tails.set(key, tail);
        releases.push(() => {
          release();
          if (this.tails.get(key) === tail) this.tails.delete(key);
        });
        await previous;
      }
      return await fn();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }
}

/** Simple fixed-window counter for general request limiting. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns 0 when allowed, otherwise the seconds until the window resets. */
  hit(key: string): number {
    const now = this.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
      if (this.hits.size > 20_000) {
        for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
      }
    }
    entry.count++;
    return entry.count > this.limit ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }
}
