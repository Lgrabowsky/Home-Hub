import type { DoorBirdDeviceSettings } from '@home-hub/shared';
import { DeviceHttp, sleep, type DeviceResponse, type DeviceStream } from '../../util/http.ts';
import { Mutex } from '../../util/poller.ts';
import { AuthGate } from './auth-gate.ts';
import { DoorBirdError, fromTransport, isStaleConnection } from './errors.ts';
import {
  DOORBIRD_PATHS,
  looksLikeImage,
  parseHttpDate,
  parseInfo,
  parseTimestampHeader,
  returnCode,
  type DoorBirdInfo,
  type HistoryEvent,
} from './protocol.ts';
import type { DoorBirdTimings } from './timings.ts';

/**
 * The HTTP side of one door station.
 *
 * - The device accepts only about one new API connection per second (LAN API
 *   notes), so all calls of a device run one after the other over one kept-alive
 *   connection, and bulk downloads (history) keep a distance to the previous request.
 * - Every answer is classified once here: refused logins go to the `AuthGate`,
 *   so that a wrong password is never tried over and over.
 */

type Endpoint = 'info' | 'image' | 'history' | 'open' | 'light';

interface CallOptions {
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  /** Start only when the previous request to this device is at least this old. */
  gapMs?: number;
  /** Use a connection of its own instead of the shared kept-alive one. */
  fresh?: boolean;
  /** May be sent a second time when a reused connection turns out to be closed. Never set for the door opener. */
  repeatable?: boolean;
  /** Whether a failure says something about the device being reachable. */
  probe?: boolean;
}

export interface HistoryPicture {
  image: Buffer;
  /** `X-Timestamp` in milliseconds, null when the device did not send a usable one. */
  timestamp: number | null;
  /** `Last-Modified` in milliseconds, as a fall-back hint for the time of the picture. */
  lastModified: number | null;
}

const MAX_JSON_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function cancelled(): DoorBirdError {
  return new DoorBirdError('aborted', 'request cancelled', { executed: 'unknown' });
}

export class DoorBirdClient {
  readonly gate: AuthGate;

  /** Reports contacts that say something about the device being reachable: any answer, or a failed attempt. */
  onContact: (reached: boolean) => void = () => {};

  private readonly mutex = new Mutex();
  private readonly baseUrl: string;
  private api: DeviceHttp;
  private events: DeviceHttp;
  private lastRequestAt = 0;
  private closed = false;
  private readonly deniedUntil = new Map<Endpoint, number>();

  constructor(
    private readonly device: Pick<DoorBirdDeviceSettings, 'host' | 'username' | 'password'>,
    private readonly timings: DoorBirdTimings,
  ) {
    this.baseUrl = `http://${device.host.trim()}`;
    this.gate = new AuthGate(timings.authRetryMinMs, timings.authRetryMaxMs);
    this.api = this.connect();
    this.events = this.connect();
  }

  private connect(): DeviceHttp {
    return new DeviceHttp({
      baseUrl: this.baseUrl,
      auth: { username: this.device.username, password: this.device.password },
      // The device asks for Basic (realm "DoorBird") or Digest; answer whatever it asks for.
      authMode: 'auto',
      timeoutMs: this.timings.requestTimeoutMs,
      // One connection only: the answer to the device's login challenge must travel
      // over the same connection instead of opening a second one right away.
      maxSockets: 1,
    });
  }

  // --- Calls -------------------------------------------------------------------------

  async info(signal?: AbortSignal): Promise<DoorBirdInfo> {
    const response = await this.call('info', DOORBIRD_PATHS.info, {
      timeoutMs: this.timings.requestTimeoutMs,
      maxBytes: MAX_JSON_BYTES,
      signal,
      repeatable: true,
    });
    if (response.status !== 200) throw this.unexpected(response.status);
    try {
      return parseInfo(response.body);
    } catch (err) {
      throw new DoorBirdError('protocol', `info.cgi: ${err instanceof Error ? err.message : 'unreadable answer'}`, { status: 200, cause: err });
    }
  }

  /** The current camera picture. */
  async image(signal?: AbortSignal): Promise<Buffer> {
    const response = await this.call('image', DOORBIRD_PATHS.image, {
      timeoutMs: this.timings.imageTimeoutMs,
      maxBytes: MAX_IMAGE_BYTES,
      signal,
      repeatable: true,
    });
    if (response.status !== 200) throw this.unexpected(response.status);
    if (!looksLikeImage(response.body)) throw new DoorBirdError('protocol', 'image.cgi did not return a picture', { status: 200 });
    return response.body;
  }

  /** One picture of the device's own history, or null when there is none at this index (HTTP 404). */
  async history(index: number, event: HistoryEvent, signal?: AbortSignal): Promise<HistoryPicture | null> {
    const response = await this.call('history', DOORBIRD_PATHS.history(index, event), {
      timeoutMs: this.timings.historyTimeoutMs,
      maxBytes: MAX_IMAGE_BYTES,
      signal,
      gapMs: this.timings.historyGapMs,
      repeatable: true,
      // The device loads history pictures from DoorBird's cloud (doorbirdpy: "stored in the cloud"):
      // a failure here says nothing about the door station itself.
      probe: false,
    });
    if (response.status === 404) return null;
    if (response.status !== 200) throw this.unexpected(response.status);
    if (!looksLikeImage(response.body)) throw new DoorBirdError('protocol', 'history.cgi did not return a picture', { status: 200 });
    return {
      image: response.body,
      timestamp: parseTimestampHeader(response.headers['x-timestamp']),
      lastModified: parseHttpDate(response.headers['last-modified']),
    };
  }

  /**
   * Energises a relay.
   *
   * Sent exactly once and over a connection of its own: a kept-alive connection
   * can be dead without anyone knowing, and repeating a door command blindly is
   * not an option (a second impulse may close a gate again). The one exception
   * is HTTP 503 — the device states that it did not carry the command out.
   */
  async openDoor(relayId: string): Promise<void> {
    const response = await this.call('open', DOORBIRD_PATHS.openDoor(relayId), {
      timeoutMs: this.timings.requestTimeoutMs,
      maxBytes: MAX_JSON_BYTES,
      fresh: true,
    });
    this.checkCommand(response);
  }

  /** Switches the infrared light on (the device switches it off again by itself). */
  async lightOn(signal?: AbortSignal): Promise<void> {
    const response = await this.call('light', DOORBIRD_PATHS.lightOn, {
      timeoutMs: this.timings.requestTimeoutMs,
      maxBytes: MAX_JSON_BYTES,
      signal,
      repeatable: true,
    });
    this.checkCommand(response);
  }

  /**
   * Opens the event stream. The caller owns the stream and must destroy it.
   * Rejects only when no answer arrived; HTTP error statuses are returned.
   */
  openMonitor(signal: AbortSignal): Promise<DeviceStream> {
    return this.queued(this.timings.historyGapMs, signal, async () => {
      if (this.closed) throw new DoorBirdError('stopped', 'integration is stopping');
      // A new stream always starts on a new connection with a new login handshake.
      this.events.destroy();
      this.events = this.connect();
      try {
        return await this.events.stream(DOORBIRD_PATHS.monitor, { timeoutMs: this.timings.requestTimeoutMs, signal });
      } catch (err) {
        throw fromTransport(err);
      } finally {
        this.lastRequestAt = Date.now();
      }
    });
  }

  /**
   * Drops the shared API connection so that the next call starts on a new one —
   * used after an outage, when an idle connection may be dead without the
   * operating system having noticed yet.
   */
  recycle(): void {
    void this.mutex.run(async () => {
      if (this.closed) return;
      this.api.destroy();
      this.api = this.connect();
    });
  }

  /** Lets a request that is already on the wire finish, then closes all connections. */
  async close(): Promise<void> {
    this.closed = true;
    await this.mutex.run(async () => {});
    this.api.destroy();
    this.events.destroy();
  }

  // --- Internals ---------------------------------------------------------------------

  /**
   * Runs `task` in the device's queue. With a gap it first waits — outside the
   * queue, so that a door opening never has to wait for a bulk download's pause.
   */
  private async queued<T>(gapMs: number, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    const remaining = (): number => {
      const since = Date.now() - this.lastRequestAt;
      return since >= 0 && since < gapMs ? gapMs - since : 0;
    };
    for (;;) {
      const wait = remaining();
      if (wait > 0) {
        await sleep(wait, signal);
        if (signal?.aborted) throw cancelled();
        continue;
      }
      const result = await this.mutex.run(async (): Promise<{ value: T } | null> => {
        // Another request may have slipped in while this one waited for its turn.
        if (remaining() > 0) return null;
        return { value: await task() };
      });
      if (result) return result.value;
    }
  }

  private call(endpoint: Endpoint, path: string, options: CallOptions): Promise<DeviceResponse> {
    return this.queued(options.gapMs ?? 0, options.signal, () => {
      this.check(endpoint);
      return this.send(endpoint, path, options);
    });
  }

  /** Refuses requests that must not be sent right now. */
  private check(endpoint: Endpoint): void {
    if (this.closed) throw new DoorBirdError('stopped', 'integration is stopping');
    const gate = this.gate;
    if (gate.refused && (endpoint !== 'info' || gate.blockedFor() > 0)) {
      throw new DoorBirdError(gate.state === 'locked' ? 'locked' : 'auth', 'waiting after a refused login');
    }
    if (gate.state === 'suspect' && endpoint !== 'info') {
      throw new DoorBirdError('denied', 'the login is being checked again');
    }
    if ((this.deniedUntil.get(endpoint) ?? 0) > Date.now()) {
      throw new DoorBirdError('denied', `${endpoint} was refused a moment ago`, { status: 401 });
    }
  }

  private async send(endpoint: Endpoint, path: string, options: CallOptions): Promise<DeviceResponse> {
    const http = options.fresh ? this.connect() : this.api;
    let repeated = false;
    let busyRetried = false;
    try {
      for (;;) {
        let response: DeviceResponse;
        try {
          response = await http.request(path, { timeoutMs: options.timeoutMs, maxBytes: options.maxBytes, signal: options.signal });
        } catch (err) {
          this.lastRequestAt = Date.now();
          if (options.repeatable && !repeated && !options.signal?.aborted && isStaleConnection(err)) {
            // The device closed the idle connection just as it was reused; nothing was processed.
            repeated = true;
            continue;
          }
          const error = fromTransport(err);
          if (options.probe !== false && (error.kind === 'timeout' || error.kind === 'network')) this.onContact(false);
          throw error;
        }
        this.lastRequestAt = Date.now();
        this.onContact(true);
        if (response.status === 503 && !busyRetried) {
          // "Busy": the request was not processed. One more try after a pause, then give up.
          busyRetried = true;
          await sleep(this.timings.busyRetryMs, options.signal);
          if (options.signal?.aborted) throw cancelled();
          continue;
        }
        this.settle(endpoint, response.status);
        return response;
      }
    } finally {
      if (options.fresh) http.destroy();
    }
  }

  /** Feeds the login outcome of an answer to the gate; throws for refused logins. */
  private settle(endpoint: Endpoint, status: number): void {
    if (status === 423) {
      this.gate.reject(true);
      throw new DoorBirdError('locked', 'the device has locked the account', { status });
    }
    if (status === 401) {
      if (endpoint === 'info' || !this.gate.verified) {
        this.gate.reject(false);
        throw new DoorBirdError('auth', 'login refused', { status });
      }
      // The login worked a moment ago: this function is refused for this user, or the
      // password has just been changed. Do not ask for it again and let info.cgi decide.
      this.deniedUntil.set(endpoint, Date.now() + this.timings.deniedCooldownMs);
      this.gate.suspect();
      throw new DoorBirdError('denied', `${endpoint} refused although the login works`, { status });
    }
    // Everything else below 500 was answered behind the login check.
    if (status < 500) this.gate.accept();
  }

  private unexpected(status: number): DoorBirdError {
    if (status === 204) return new DoorBirdError('permission', 'HTTP 204: no permission', { status });
    if (status === 404) return new DoorBirdError('not_found', 'HTTP 404', { status });
    if (status === 503) return new DoorBirdError('busy', 'HTTP 503: busy', { status });
    return new DoorBirdError('status', `HTTP ${status}`, { status });
  }

  /**
   * A command is only done when the device says so: `{"BHA":{"RETURNCODE":"1"}}`.
   * Missing permission shows up as HTTP 204 (ioBroker adapter) or as RETURNCODE "204" (FHEM).
   */
  private checkCommand(response: DeviceResponse): void {
    if (response.status !== 200) throw this.unexpected(response.status);
    const code = returnCode(response.body);
    if (code === '1') return;
    if (code === '204') throw new DoorBirdError('permission', 'RETURNCODE 204: no permission', { status: 200 });
    if (code === null) throw new DoorBirdError('protocol', 'command answer without RETURNCODE', { status: 200, executed: 'unknown' });
    throw new DoorBirdError('status', `RETURNCODE ${code}`, { status: 200 });
  }
}
