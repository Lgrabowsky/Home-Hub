/**
 * Keeps the hub from locking the owner's account on the door station.
 *
 * A DoorBird answers repeated wrong logins with HTTP 423 (locked). So after a
 * refused login nothing at all is sent for a while (5 minutes, doubling up to
 * 30), and then exactly one request — `info.cgi` — checks whether the login
 * works again.
 *
 *   unverified  nothing known yet (start-up); requests are allowed
 *   verified    the device accepted the login
 *   suspect     a single function answered 401 although the login worked a moment
 *               ago: either a permission is missing for it or the password was
 *               just changed. Only `info.cgi` may be sent until that is settled.
 *   rejected    `info.cgi` answered 401: nothing is sent until `retryAt`
 *   locked      the device answered 423: same waiting rule
 */
export type AuthState = 'unverified' | 'verified' | 'suspect' | 'rejected' | 'locked';

export class AuthGate {
  private current: AuthState = 'unverified';
  private retryAt = 0;
  private strikes = 0;
  private readonly waiters = new Set<() => void>();

  /** Called after every change (also when a refusal is renewed with a later `retryAt`). */
  onChange: (state: AuthState) => void = () => {};

  constructor(
    private readonly minWaitMs: number,
    private readonly maxWaitMs: number,
  ) {}

  get state(): AuthState {
    return this.current;
  }

  /** The device refused the login; the door station cannot be used. */
  get refused(): boolean {
    return this.current === 'rejected' || this.current === 'locked';
  }

  get verified(): boolean {
    return this.current === 'verified';
  }

  /** Requests other than the login check may be sent. */
  get usable(): boolean {
    return this.current === 'unverified' || this.current === 'verified';
  }

  /** Milliseconds during which nothing may be sent because the device refused the login. */
  blockedFor(now = Date.now()): number {
    return this.refused ? Math.max(0, this.retryAt - now) : 0;
  }

  /** The device accepted the credentials. */
  accept(): void {
    this.strikes = 0;
    this.retryAt = 0;
    if (this.current === 'verified') return;
    this.current = 'verified';
    for (const wake of [...this.waiters]) wake();
    this.onChange(this.current);
  }

  /** The device refused the credentials (401) or reports the account as locked (423). */
  reject(locked: boolean): void {
    this.strikes++;
    this.retryAt = Date.now() + Math.min(this.maxWaitMs, this.minWaitMs * 2 ** Math.min(this.strikes - 1, 10));
    this.current = locked ? 'locked' : 'rejected';
    this.onChange(this.current);
  }

  /** A single function was refused with 401 while the login was known to work. */
  suspect(): void {
    if (this.current !== 'verified') return;
    this.current = 'suspect';
    this.onChange(this.current);
  }

  /** Resolves as soon as normal requests are allowed again — or when the signal aborts. */
  whenUsable(signal: AbortSignal): Promise<void> {
    if (this.usable || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.waiters.delete(done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      this.waiters.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
