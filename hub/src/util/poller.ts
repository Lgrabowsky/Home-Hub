/**
 * Runs an async task over and over with a pause in between.
 *
 * - The pause is re-read on every round, so callers can poll fast while an
 *   app is open and slowly otherwise.
 * - Errors never stop the loop; they stretch the pause (exponential backoff).
 * - `kick()` requests an early run, e.g. right after a command was sent.
 */
export class Poller {
  private running = false;
  private stopped = true;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private kicked = false;
  private controller = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(
    private readonly task: (signal: AbortSignal) => Promise<void>,
    private readonly interval: () => number,
    private readonly onError: (err: unknown, failures: number) => void = () => {},
    private readonly maxBackoffMs = 60_000,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.controller = new AbortController();
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
    this.wakeUp();
    await this.loop?.catch(() => {});
    this.loop = null;
  }

  /** Runs the task again after `delayMs` (sooner than the regular pause). */
  kick(delayMs = 0): void {
    if (this.stopped) return;
    if (delayMs <= 0) {
      this.kicked = true;
      this.wakeUp();
      return;
    }
    const timer = setTimeout(() => {
      this.kicked = true;
      this.wakeUp();
    }, delayMs);
    timer.unref();
  }

  get isRunning(): boolean {
    return this.running;
  }

  private wakeUp(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private pause(ms: number): Promise<void> {
    if (this.kicked) {
      this.kicked = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.wake = null;
        resolve();
      }, ms);
    }).then(() => {
      this.kicked = false;
    });
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      this.running = true;
      try {
        await this.task(this.controller.signal);
        this.failures = 0;
      } catch (err) {
        if (this.stopped) break;
        this.failures++;
        try {
          this.onError(err, this.failures);
        } catch {
          /* an error handler must never break the loop */
        }
      } finally {
        this.running = false;
      }
      if (this.stopped) break;
      const base = Math.max(50, this.interval());
      const delay = this.failures === 0 ? base : Math.min(this.maxBackoffMs, Math.max(base, 1000) * 2 ** Math.min(this.failures - 1, 6));
      await this.pause(delay);
    }
  }
}

/** Serialises async work per key: at most one task at a time, in call order. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}
