import type { DoorBirdDeviceSettings, DoorEntity } from '@home-hub/shared';
import { HttpError } from '../../http/errors.ts';
import type { Logger } from '../../log.ts';
import { randomId, sha256Hex } from '../../security/crypto.ts';
import type { DeviceStream } from '../../util/http.ts';
import { Poller } from '../../util/poller.ts';
import type { Actor, IntegrationDeps } from '../types.ts';
import type { AuthState } from './auth-gate.ts';
import { DoorBirdClient } from './client.ts';
import { DoorBirdError, fromTransport, toHttpError, userMessage, type DoorAction } from './errors.ts';
import type { DoorHistoryStore } from './history-store.ts';
import { EdgeDetector, MonitorParser, visibleRelays, type DoorBirdInfo, type HistoryEvent, type MonitorReport } from './protocol.ts';
import type { DoorBirdTimings } from './timings.ts';

/**
 * Everything the hub does with ONE door station: keeping in touch (info.cgi),
 * listening for rings and motion (monitor.cgi), recording them with a picture,
 * importing the device's own history, and carrying out commands.
 *
 * Door stations are independent of each other — each has its own connections,
 * queue, timers and health.
 */

/** What a station needs from the integration it belongs to. */
export interface StationHost {
  readonly deps: IntegrationDeps;
  readonly timings: DoorBirdTimings;
  readonly store: DoorHistoryStore;
  /** An app is open right now. */
  isActive(): boolean;
  /** Events older than this timestamp are not kept. */
  retentionCutoff(): number;
  /** Something that shows in the entity or in the service health changed. */
  changed(): void;
  /** The device answered just now. */
  contacted(): void;
}

export interface StationHealth {
  /** `pending`: no verdict yet. `limited`: usable, but something does not work. */
  state: 'pending' | 'ok' | 'limited' | 'down';
  /** German, names the door station. Null when everything is fine. */
  message: string | null;
}

/** The two event types the device reports and keeps pictures of. */
type LiveType = 'doorbell' | 'motion';
const LIVE_TYPES: readonly LiveType[] = ['doorbell', 'motion'];
const HISTORY_EVENT: Record<LiveType, HistoryEvent> = { doorbell: 'doorbell', motion: 'motionsensor' };

type MonitorProblem = 'too_many' | 'denied' | 'unsupported' | 'failing';

type MonitorOutcome =
  | { kind: 'stopped' }
  /** No answer at all. */
  | { kind: 'failed' }
  /** The device answered, but not with a stream. */
  | { kind: 'status'; status: number }
  /** The stream ran for `lasted` ms and then ended. */
  | { kind: 'ended'; lasted: number };

interface SyncMark {
  /** `X-Timestamp` (ms) of the newest history picture that was processed. */
  ts: number;
  /** SHA-256 of processed pictures that came without a timestamp, newest first. */
  hashes: string[];
}
type SyncMarks = Record<LiveType, SyncMark>;

const DAY_MS = 24 * 60 * 60_000;
const MAX_REMEMBERED_HASHES = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export class DoorStation {
  readonly id: string;
  readonly name: string;

  private readonly log: Logger;
  private readonly client: DoorBirdClient;
  private readonly abort = new AbortController();
  /** Aborted (and replaced) when a door command needs the line: bulk downloads give way. */
  private bulk = new AbortController();
  private readonly infoPoller: Poller;
  private readonly syncPoller: Poller;
  private readonly background = new Set<Promise<void>>();
  private monitorLoop: Promise<void> | null = null;
  private started = false;
  private stopped = false;

  // --- What is known about the device
  private info: DoorBirdInfo | null = null;
  /** German reason why `info.cgi` gives nothing usable. */
  private infoProblem: string | null = null;
  private lastInfoAt: number | null = null;
  private refreshingInfo = false;
  private readonly firstInfo: Promise<void>;
  private firstInfoDone: () => void = () => {};

  // --- Reachability
  private reach: 'pending' | 'up' | 'down' = 'pending';
  private failures = 0;
  private firstFailureAt = 0;
  private lastContactAt: number | null = null;
  private lastError: { at: number; text: string } | null = null;
  private wasAvailable = false;

  // --- Event stream
  private readonly edges: EdgeDetector;
  private readonly monitor = {
    state: 'idle' as 'idle' | 'connecting' | 'connected' | 'waiting',
    connectedAt: null as number | null,
    lastDataAt: null as number | null,
    connects: 0,
    retryAt: null as number | null,
    problem: null as MonitorProblem | null,
  };
  private monitorWake: (() => void) | null = null;
  private ringFiredAt = 0;
  private motionFiredAt = 0;

  // --- Camera picture
  private picture: { at: number; image: Buffer } | null = null;
  private pictureFailure: { at: number; error: DoorBirdError } | null = null;
  private pictureRequest: Promise<Buffer> | null = null;

  // --- Door opener
  private readonly opening = new Set<string>();
  private readonly lastOpened = new Map<string, number>();

  // --- History sync
  private readonly syncWanted = new Set<LiveType>();
  private lastFullSyncAt = 0;
  private historyDeniedUntil = 0;
  private lastSync: { at: number; imported: number; attached: number; complete: boolean; error: string | null } | null = null;

  /**
   * @param previous the entity a former instance left in the state store: its model and
   *   relays are shown (greyed out) until this instance has reached the device itself.
   */
  constructor(
    private readonly host: StationHost,
    private readonly settings: DoorBirdDeviceSettings,
    private readonly previous: Pick<DoorEntity, 'model' | 'relays'> | null,
  ) {
    const t = host.timings;
    this.id = settings.id;
    this.name = settings.name;
    this.log = host.deps.log;
    this.client = new DoorBirdClient(settings, t);
    this.client.onContact = (reached) => this.contact(reached);
    this.client.gate.onChange = (state) => this.onLoginState(state);
    this.edges = new EdgeDetector(t.monitorGraceMs);
    this.firstInfo = new Promise((resolve) => {
      this.firstInfoDone = resolve;
    });
    // Failures are recorded where they happen; the pollers only provide the rhythm and the back-off.
    this.infoPoller = new Poller(() => this.refreshInfo(), () => this.infoInterval(), undefined, 60_000);
    this.syncPoller = new Poller(() => this.syncHistory(), () => t.historyIntervalMs, undefined, t.historyRetryMs);
  }

  // --- Life cycle --------------------------------------------------------------------

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.infoPoller.start();
    this.syncPoller.start();
    this.monitorLoop = this.runMonitor().catch((err: unknown) => {
      this.log.error({ err, door: this.id }, 'door event loop ended unexpectedly');
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    this.bulk.abort();
    this.firstInfoDone();
    await Promise.all([this.infoPoller.stop(), this.syncPoller.stop(), this.monitorLoop]);
    await Promise.allSettled([...this.background]);
    await this.client.close();
  }

  setActive(active: boolean): void {
    if (!active || !this.started || this.stopped) return;
    // Somebody opened an app: do not make them wait for the end of a reconnect pause …
    if (this.reach !== 'up') this.monitorWake?.();
    // … and switch to the faster refresh rhythm right away.
    if (this.lastInfoAt !== null && Date.now() - this.lastInfoAt > this.host.timings.infoRefreshActiveMs) this.infoPoller.kick();
  }

  // --- What the rest of the hub sees --------------------------------------------------

  private get available(): boolean {
    return this.reach === 'up' && this.info !== null && !this.client.gate.refused;
  }

  entity(): DoorEntity {
    const { store } = this.host;
    return {
      id: `door:${this.id}`,
      kind: 'door',
      name: this.name,
      room: this.settings.room.trim() || null,
      available: this.available,
      service: 'doorbird',
      model: this.info ? this.info.model : (this.previous?.model ?? null),
      relays: this.info ? visibleRelays(this.info.relays, this.settings) : visibleRelays((this.previous?.relays ?? []).map((relay) => relay.id), this.settings),
      features: { talk: true, audio: true, light: true },
      lastRingAt: store.newest(this.id, 'doorbell'),
      lastMotionAt: store.newest(this.id, 'motion'),
    };
  }

  health(): StationHealth {
    const down = (message: string): StationHealth => ({ state: 'down', message });
    const gate = this.client.gate.state;
    if (gate === 'rejected') {
      return down(`${this.name}: Anmeldung abgelehnt – bitte Benutzername, Passwort und die Berechtigung „API-Operator“ in der DoorBird-App prüfen.`);
    }
    if (gate === 'locked') return down(`${this.name}: Die Türstation hat den Zugang nach Fehlversuchen vorübergehend gesperrt.`);
    if (this.reach === 'down') return down(`${this.name} ist nicht erreichbar.`);
    if (this.reach === 'pending') return { state: 'pending', message: null };
    if (!this.info) return this.infoProblem ? down(this.infoProblem) : { state: 'pending', message: null };
    switch (this.monitor.problem) {
      case 'too_many':
        return { state: 'limited', message: `${this.name}: Klingeln und Bewegung werden gerade nicht gemeldet (zu viele Verbindungen zur Türstation).` };
      case 'denied':
        return { state: 'limited', message: `${this.name}: Klingeln und Bewegung werden nicht gemeldet – dem Benutzer fehlt in der DoorBird-App die Berechtigung „API-Operator“.` };
      case 'unsupported':
        return { state: 'limited', message: `${this.name}: Diese Türstation meldet Klingeln und Bewegung nicht über das Netzwerk (Firmware zu alt?).` };
      case 'failing':
        return { state: 'limited', message: `${this.name}: Klingeln und Bewegung werden gerade nicht gemeldet.` };
      default:
        return { state: 'ok', message: null };
    }
  }

  diagnostics(): Record<string, unknown> {
    let lastEvent: { type: string; at: string | null; source: string } | null = null;
    try {
      const latest = this.host.store.latest(this.id);
      if (latest) lastEvent = { type: latest.type, at: iso(latest.ts), source: latest.source };
    } catch {
      /* the database may already be closed while the hub shuts down */
    }
    return {
      id: this.id,
      name: this.name,
      host: this.settings.host,
      reachable: this.reach === 'up',
      available: this.available,
      login: this.client.gate.state,
      model: this.info?.model ?? null,
      firmware: this.info?.firmware ?? null,
      build: this.info?.build ?? null,
      relays: this.info?.relays ?? [],
      hiddenRelays: this.settings.hiddenRelays,
      infoCheckedAt: iso(this.lastInfoAt),
      lastContactAt: iso(this.lastContactAt),
      monitor: {
        state: this.monitor.state,
        connectedSince: this.monitor.state === 'connected' ? iso(this.monitor.connectedAt) : null,
        lastHeartbeatAt: iso(this.monitor.lastDataAt),
        connects: this.monitor.connects,
        nextAttemptAt: this.monitor.state === 'waiting' ? iso(this.monitor.retryAt) : null,
        problem: this.monitor.problem,
      },
      lastEvent,
      historySync: this.lastSync ? { ...this.lastSync, at: iso(this.lastSync.at) } : null,
      historyAllowed: Date.now() >= this.historyDeniedUntil,
      lastError: this.lastError ? { at: iso(this.lastError.at), message: this.lastError.text } : null,
    };
  }

  /** Tells the integration that entity or health changed, and starts what a device needs once it is usable. */
  private notify(): void {
    if (this.stopped) return;
    const available = this.available;
    if (available && !this.wasAvailable) this.wantSync(LIVE_TYPES, this.host.timings.historyStartDelayMs);
    this.wasAvailable = available;
    this.host.changed();
  }

  private noteError(what: string, error: DoorBirdError): void {
    this.lastError = { at: Date.now(), text: `${what}: ${error.message}` };
    this.log.debug({ door: this.id, what, reason: error.kind, status: error.status }, 'door station request failed');
  }

  private run(task: Promise<void>): void {
    const tracked: Promise<void> = task
      .catch((err: unknown) => {
        this.log.error({ err, door: this.id }, 'door station background task failed');
      })
      .finally(() => {
        this.background.delete(tracked);
      });
    this.background.add(tracked);
  }

  // --- Reachability ------------------------------------------------------------------

  /**
   * Every answer proves the device is there. It only counts as gone after two
   * failed contacts that lie a moment apart — a single hiccup (or two requests
   * failing in the same instant) must not grey out the door in the apps.
   */
  private contact(reached: boolean): void {
    if (this.stopped) return;
    const now = Date.now();
    if (reached) {
      this.failures = 0;
      this.lastContactAt = now;
      if (this.reach !== 'up') {
        if (this.reach === 'down') this.log.info({ door: this.id }, 'door station is reachable again');
        this.reach = 'up';
        if (!this.refreshingInfo) this.infoPoller.kick();
        this.notify();
      }
      this.host.contacted();
      return;
    }
    if (this.failures === 0) this.firstFailureAt = now;
    this.failures++;
    if (this.reach !== 'down' && this.failures >= 2 && now - this.firstFailureAt >= this.host.timings.offlineAfterMs) {
      this.reach = 'down';
      this.log.warn({ door: this.id }, 'door station is not reachable');
      this.notify();
    }
  }

  private onLoginState(state: AuthState): void {
    if (this.stopped) return;
    if (state === 'rejected' || state === 'locked') {
      this.log.warn({ door: this.id, state }, 'door station refused the login; nothing is sent until the waiting time is over');
      // When the waiting time is over, exactly one info.cgi checks whether the login works again.
      this.infoPoller.kick(this.client.gate.blockedFor() + 250);
    } else if (state === 'suspect') {
      this.infoPoller.kick();
    }
    this.notify();
  }

  // --- info.cgi ----------------------------------------------------------------------

  private infoInterval(): number {
    const t = this.host.timings;
    const blocked = this.client.gate.blockedFor();
    if (blocked > 0) return blocked + 250;
    if (!this.info) return t.infoRetryMs;
    // Without the event stream nothing else notices when the device goes away or comes back.
    if (this.monitor.state !== 'connected') return t.probeMs;
    return this.host.isActive() ? t.infoRefreshActiveMs : t.infoRefreshIdleMs;
  }

  private async refreshInfo(): Promise<void> {
    const signal = this.abort.signal;
    if (signal.aborted || this.client.gate.blockedFor() > 0) return;
    this.refreshingInfo = true;
    try {
      const info = await this.client.info(signal);
      if (this.stopped) return;
      const first = this.info === null;
      const changed = first || JSON.stringify(info) !== JSON.stringify(this.info);
      this.info = info;
      this.infoProblem = null;
      this.lastInfoAt = Date.now();
      if (changed) {
        this.log.info(
          { door: this.id, model: info.model, firmware: info.firmware, relays: info.relays },
          first ? 'door station connected' : 'door station reports new information',
        );
      }
      this.notify();
    } catch (err) {
      if (this.stopped || signal.aborted) return;
      const error = fromTransport(err);
      this.noteError('info', error);
      switch (error.kind) {
        case 'auth':
        case 'locked':
          break; // the gate decides when the login is tried again
        case 'timeout':
        case 'network':
          this.infoProblem = `${this.name} antwortet nicht.`;
          break;
        case 'busy':
          this.infoProblem = `${this.name} ist gerade beschäftigt.`;
          break;
        default:
          this.infoProblem = `${this.name} antwortet nicht wie eine DoorBird-Türstation – bitte die Adresse prüfen.`;
      }
      this.notify();
      // While the device has never answered, let the poller back off and try again.
      if (this.info === null && error.kind !== 'auth' && error.kind !== 'locked') throw error;
    } finally {
      this.refreshingInfo = false;
      this.firstInfoDone();
    }
  }

  // --- monitor.cgi -------------------------------------------------------------------

  private async runMonitor(): Promise<void> {
    const signal = this.abort.signal;
    const t = this.host.timings;
    // The login is checked once, by info.cgi, before a second connection tries the same credentials.
    await this.firstInfo;
    let backoff = t.monitorBackoffMinMs;
    let refusals = 0;
    let oddAnswers = 0;
    const nextBackoff = (): number => {
      const wait = backoff;
      backoff = Math.min(backoff * 2, t.monitorBackoffMaxMs);
      return wait;
    };

    while (!signal.aborted) {
      if (!this.client.gate.usable) {
        this.monitor.state = 'waiting';
        this.monitor.retryAt = null;
        await this.client.gate.whenUsable(signal);
        continue;
      }
      const outcome = await this.monitorOnce(signal);
      if (signal.aborted || outcome.kind === 'stopped') break;

      let wait: number;
      // A wait the device imposed (lock-out protection, all streams in use) is never cut short.
      let fixed = false;
      let problem: MonitorProblem | null = this.monitor.problem;
      if (outcome.kind === 'ended') {
        refusals = 0;
        oddAnswers = 0;
        problem = null;
        if (outcome.lasted >= t.monitorStableMs) backoff = t.monitorBackoffMinMs;
        wait = nextBackoff();
      } else if (outcome.kind === 'failed') {
        wait = nextBackoff();
      } else if (outcome.status === 423) {
        this.client.gate.reject(true);
        continue;
      } else if (outcome.status === 401 && !this.client.gate.verified) {
        // The login has never worked: this is a wrong password, not a missing permission.
        this.client.gate.reject(false);
        continue;
      } else if (outcome.status === 401 || outcome.status === 403 || outcome.status === 204) {
        // The login itself works (info.cgi): the user may not use the event stream.
        // Ask rarely — repeated 401s can lock the account — and let info.cgi re-check the password.
        refusals++;
        wait = Math.min(t.authRetryMaxMs, t.authRetryMinMs * 2 ** Math.min(refusals - 1, 10));
        fixed = true;
        problem = 'denied';
        if (outcome.status === 401) this.infoPoller.kick();
      } else if (outcome.status === 509) {
        // All of the device's event streams (8) are taken.
        wait = t.monitorBusyWaitMs;
        fixed = true;
        problem = 'too_many';
      } else if (outcome.status === 404) {
        wait = t.monitorUnsupportedWaitMs;
        fixed = true;
        problem = 'unsupported';
      } else {
        oddAnswers++;
        if (oddAnswers >= 2) problem = 'failing';
        wait = nextBackoff();
      }

      this.monitor.state = 'waiting';
      this.monitor.retryAt = Date.now() + wait;
      if (problem !== this.monitor.problem) {
        this.monitor.problem = problem;
        if (problem) this.log.warn({ door: this.id, problem }, 'door events cannot be received');
        this.notify();
      }
      // With the stream down for longer, info.cgi takes over as the sign of life.
      if (fixed) this.infoPoller.kick(t.probeMs);
      await this.monitorPause(wait, !fixed, signal);
    }
    this.monitor.state = 'idle';
  }

  private monitorPause(ms: number, interruptible: boolean, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        if (this.monitorWake === done) this.monitorWake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
      this.monitorWake = interruptible ? done : null;
    });
  }

  private async monitorOnce(signal: AbortSignal): Promise<MonitorOutcome> {
    this.monitor.state = 'connecting';
    let stream: DeviceStream;
    try {
      stream = await this.client.openMonitor(signal);
    } catch (err) {
      const error = fromTransport(err);
      if (signal.aborted || error.kind === 'stopped' || error.kind === 'aborted') return { kind: 'stopped' };
      this.noteError('events', error);
      this.contact(false);
      return { kind: 'failed' };
    }
    // From here on the stream is ours: it must be destroyed on every path.
    stream.body.on('error', () => {});
    this.contact(true);
    if (stream.status !== 200) {
      stream.destroy();
      this.noteError('events', new DoorBirdError('status', `HTTP ${stream.status}`, { status: stream.status }));
      return { kind: 'status', status: stream.status };
    }
    return this.readMonitor(stream, signal);
  }

  private readMonitor(stream: DeviceStream, signal: AbortSignal): Promise<MonitorOutcome> {
    const t = this.host.timings;
    const connectedAt = Date.now();
    const reconnected = this.monitor.connects > 0;
    this.monitor.state = 'connected';
    this.monitor.connectedAt = connectedAt;
    this.monitor.lastDataAt = null;
    this.monitor.retryAt = null;
    this.monitor.connects++;
    this.edges.connected(connectedAt);
    this.log.debug({ door: this.id, reconnected }, 'door event stream connected');
    if (this.monitor.problem) {
      this.monitor.problem = null;
      this.notify();
    }
    if (reconnected) {
      // After an interruption the device may have restarted (new firmware, other relays), an idle
      // API connection may be dead without anyone knowing, and events may have been missed.
      this.client.recycle();
      this.infoPoller.kick();
      this.wantSync(LIVE_TYPES, t.historyStartDelayMs);
    }

    const parser = new MonitorParser();
    return new Promise<MonitorOutcome>((resolve) => {
      let finished = false;
      let idle: NodeJS.Timeout | null = null;
      const finish = (outcome: MonitorOutcome) => {
        if (finished) return;
        finished = true;
        if (idle) clearTimeout(idle);
        signal.removeEventListener('abort', onAbort);
        stream.destroy();
        resolve(outcome);
      };
      const ended = () => finish({ kind: 'ended', lasted: Date.now() - connectedAt });
      const onAbort = () => finish({ kind: 'stopped' });
      const arm = () => {
        if (idle) clearTimeout(idle);
        // The device repeats its state about every 20 s. Silence means the connection is dead
        // (power cut, cable pulled) even though nobody closed it.
        idle = setTimeout(() => {
          this.noteError('events', new DoorBirdError('timeout', 'event stream went silent', { executed: 'unknown' }));
          this.contact(false);
          ended();
        }, t.monitorIdleMs);
      };
      stream.body.on('data', (chunk: Buffer) => {
        if (finished) return;
        arm();
        this.monitor.lastDataAt = Date.now();
        this.contact(true);
        for (const report of parser.push(chunk)) this.onReport(report);
      });
      stream.body.on('end', ended);
      stream.body.on('close', ended);
      stream.body.on('error', ended);
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      arm();
    });
  }

  private onReport(report: MonitorReport): void {
    try {
      const now = Date.now();
      if (!this.edges.report(report, now)) return;
      const t = this.host.timings;
      if (report.signal === 'doorbell') {
        // Contact bounce or an impatient second press: still the same visitor.
        if (now - this.ringFiredAt < t.ringDebounceMs) return;
        this.ringFiredAt = now;
        this.recordLiveEvent('doorbell', now);
      } else {
        if (now - this.motionFiredAt < t.motionIntervalMs) return;
        this.motionFiredAt = now;
        this.recordLiveEvent('motion', now);
      }
    } catch (err) {
      this.log.error({ err, door: this.id }, 'could not process a door event');
    }
  }

  // --- Live events -------------------------------------------------------------------

  private recordLiveEvent(type: LiveType, ts: number): void {
    const { deps, store } = this.host;
    let eventId: string | null = randomId();
    try {
      // Stored before anything else, so the event survives even if the picture never arrives.
      store.insert({ id: eventId, doorId: this.id, type, ts, source: 'hub' });
    } catch (err) {
      this.log.error({ err, door: this.id }, 'could not store a door event');
      eventId = null;
    }
    this.log.info({ door: this.id, event: type }, type === 'doorbell' ? 'doorbell rang' : 'motion at the door');
    // Phones must ring at once: announce first, fetch the picture afterwards.
    deps.state.publish({ type: type === 'doorbell' ? 'doorbell' : 'door_motion', doorId: this.id, doorName: this.name, ts, eventId });
    this.notify();
    this.run(this.completeLiveEvent(eventId, type));
  }

  private async completeLiveEvent(eventId: string | null, type: LiveType): Promise<void> {
    const t = this.host.timings;
    if (eventId) {
      let image: Buffer | null = null;
      try {
        image = await this.cameraPicture(t.eventImageMaxAgeMs);
      } catch (err) {
        if (this.stopped) return;
        // Not fatal: the history sync adds the device's own picture of this event later.
        this.noteError('event picture', fromTransport(err));
      }
      if (this.stopped) return;
      if (image) {
        try {
          this.host.store.attachImage(eventId, image);
        } catch (err) {
          this.log.error({ err, door: this.id }, 'could not store the picture of a door event');
        }
      }
    }
    if (this.stopped) return;
    this.host.deps.state.publish({ type: 'history_updated', doorId: this.id });
    // The device files its own picture of the event a few seconds later (FHEM waits 7 s for it).
    this.wantSync([type], t.historyEventDelayMs);
  }

  // --- Camera picture ----------------------------------------------------------------

  /** A camera picture at most `maxAgeMs` old. Callers asking at the same time share one request. */
  private cameraPicture(maxAgeMs: number): Promise<Buffer> {
    const cached = this.picture;
    if (cached && Date.now() - cached.at <= maxAgeMs) return Promise.resolve(cached.image);
    if (!this.pictureRequest) {
      this.pictureRequest = this.client
        .image(this.abort.signal)
        .then(
          (image) => {
            this.picture = { at: Date.now(), image };
            this.pictureFailure = null;
            return image;
          },
          (err: unknown) => {
            this.pictureFailure = { at: Date.now(), error: fromTransport(err) };
            throw err;
          },
        )
        .finally(() => {
          this.pictureRequest = null;
        });
    }
    return this.pictureRequest;
  }

  async snapshot(): Promise<Buffer> {
    const t = this.host.timings;
    this.requireUsable('snapshot');
    // Several apps may be asking: a device that just failed is not asked again by each of them.
    const failure = this.pictureFailure;
    if (failure && Date.now() - failure.at < t.snapshotErrorCacheMs) throw toHttpError(failure.error, this.name, 'snapshot');
    try {
      return await this.cameraPicture(t.snapshotCacheMs);
    } catch (err) {
      throw toHttpError(err, this.name, 'snapshot');
    }
  }

  /** Fails fast when a request cannot succeed right now. */
  private requireUsable(action: DoorAction): void {
    if (this.stopped) throw toHttpError(new DoorBirdError('stopped', 'integration is stopping'), this.name, action);
    const gate = this.client.gate;
    if (gate.refused) throw toHttpError(new DoorBirdError(gate.state === 'locked' ? 'locked' : 'auth', 'login refused'), this.name, action);
    if (this.reach === 'down') {
      // Do not make the caller wait for a timeout — but check right away whether the device is back.
      this.monitorWake?.();
      throw toHttpError(new DoorBirdError('network', 'device is not reachable'), this.name, action);
    }
  }

  // --- Commands ----------------------------------------------------------------------

  async light(): Promise<void> {
    this.requireUsable('light');
    try {
      await this.client.lightOn();
    } catch (err) {
      const error = fromTransport(err);
      this.noteError('light', error);
      throw toHttpError(error, this.name, 'light');
    }
  }

  async openDoor(relayId: string, actor: Actor): Promise<void> {
    const t = this.host.timings;
    const { deps, store } = this.host;
    const relay = this.info ? (visibleRelays(this.info.relays, this.settings).find((candidate) => candidate.id === relayId) ?? null) : null;
    const refuse = (error: HttpError, reason: string): never => {
      this.auditFailure(actor, relay?.name ?? relayId, reason);
      throw error;
    };

    if (this.info && !relay) {
      // Also covers hidden relays: what is not offered cannot be triggered.
      refuse(new HttpError(404, 'not_found', `Diesen Türöffner gibt es an „${this.name}“ nicht.`), 'unknown_relay');
    }
    try {
      this.requireUsable('open');
    } catch (err) {
      refuse(err as HttpError, this.client.gate.refused ? 'login_refused' : 'unreachable');
    }
    if (!relay) {
      // The device has not answered since the hub started: its relays are not even known.
      return refuse(toHttpError(new DoorBirdError('network', 'device is not reachable'), this.name, 'open'), 'unreachable');
    }

    const guardedSince = this.lastOpened.get(relay.id) ?? 0;
    const sinceLast = Date.now() - guardedSince;
    if (this.opening.has(relay.id) || (sinceLast >= 0 && sinceLast < t.openGuardMs)) {
      // An accidental double tap. Not audited: the first tap is, and nothing was sent for this one.
      const retryAfter = Math.max(1, Math.ceil((t.openGuardMs - Math.max(0, sinceLast)) / 1000));
      throw new HttpError(429, 'too_fast', `„${relay.name}“ wurde gerade erst betätigt. Bitte einen Moment warten.`, retryAfter);
    }

    this.opening.add(relay.id);
    this.lastOpened.set(relay.id, Date.now());
    try {
      // The door goes first: a history download in progress gives way.
      this.bulk.abort();
      this.bulk = new AbortController();
      await this.client.openDoor(relay.id);
    } catch (err) {
      const error = fromTransport(err);
      // Nothing happened at the door: trying again at once is fine.
      if (error.executed === 'no') this.lastOpened.delete(relay.id);
      this.noteError('open door', error);
      this.log.warn({ door: this.id, relay: relay.id, user: actor.username, reason: error.kind }, 'door opening failed');
      this.auditFailure(actor, relay.name, error.kind, error.executed);
      throw toHttpError(error, this.name, 'open');
    } finally {
      this.opening.delete(relay.id);
    }

    // The door is open. Nothing below may turn that into an error for the caller.
    const ts = Date.now();
    this.lastOpened.set(relay.id, ts);
    this.log.info({ door: this.id, relay: relay.id, user: actor.username }, 'door opened');
    try {
      deps.audit.record('door.opened', { userId: actor.userId, username: actor.username, ip: actor.ip }, { door: this.name, relay: relay.name });
    } catch (err) {
      this.log.error({ err, door: this.id }, 'could not write the audit entry of a door opening');
    }
    try {
      store.insert({ doorId: this.id, type: 'open', ts, source: 'hub', actor: actor.displayName, detail: relay.name });
    } catch (err) {
      this.log.error({ err, door: this.id }, 'could not store a door opening in the history');
    }
    try {
      deps.state.publish({ type: 'door_opened', doorId: this.id, doorName: this.name, ts, actor: actor.displayName, relay: relay.name });
      deps.state.publish({ type: 'history_updated', doorId: this.id });
    } catch (err) {
      this.log.error({ err, door: this.id }, 'could not announce a door opening');
    }
  }

  private auditFailure(actor: Actor, relay: string, reason: string, executed: 'no' | 'unknown' = 'no'): void {
    try {
      this.host.deps.audit.record(
        'door.open_failed',
        { userId: actor.userId, username: actor.username, ip: actor.ip },
        { door: this.name, relay: relay.slice(0, 60), reason, ...(executed === 'unknown' ? { outcome: 'unclear' } : {}) },
      );
    } catch (err) {
      this.log.error({ err, door: this.id }, 'could not write the audit entry of a failed door opening');
    }
  }

  // --- History sync ------------------------------------------------------------------

  private wantSync(types: readonly LiveType[], delayMs: number): void {
    if (this.stopped) return;
    for (const type of types) this.syncWanted.add(type);
    this.syncPoller.kick(delayMs);
  }

  /**
   * Imports the pictures the device keeps itself (50 per event type), so rings
   * that happened while the hub was not listening show up as well.
   */
  private async syncHistory(): Promise<void> {
    const t = this.host.timings;
    if (this.stopped || !this.available) return;
    const startedAt = Date.now();
    // The regular run looks at both event types; a run after a live event only at that type.
    const full = startedAt - this.lastFullSyncAt >= t.historyIntervalMs * 0.9;
    if (full) for (const type of LIVE_TYPES) this.syncWanted.add(type);
    if (startedAt < this.historyDeniedUntil) this.syncWanted.clear();
    if (this.syncWanted.size === 0) return;
    const types = [...this.syncWanted];
    this.syncWanted.clear();

    const bulk = this.bulk.signal;
    const signal = AbortSignal.any([this.abort.signal, bulk]);
    const result = { at: startedAt, imported: 0, attached: 0, complete: false, error: null as string | null };
    this.lastSync = result;
    try {
      const marks = this.loadMarks();
      for (const type of types) {
        const outcome = await this.syncType(type, marks[type], signal);
        result.imported += outcome.imported;
        result.attached += outcome.attached;
        // Only a walk that reached the end moves the mark; after an interrupted one the next run starts over.
        marks[type] = outcome.mark;
        this.saveMarks(marks);
      }
      result.complete = true;
      if (full) this.lastFullSyncAt = startedAt;
    } catch (err) {
      if (this.stopped || this.abort.signal.aborted) return;
      const error = fromTransport(err);
      for (const type of types) this.syncWanted.add(type);
      if (bulk.aborted) {
        // A door command needed the line. Carry on in a moment.
        result.error = 'interrupted by a door command';
        this.syncPoller.kick(t.historyEventDelayMs);
      } else if (error.kind === 'permission' || error.kind === 'denied') {
        // The user may not read the history ("Verlauf" in the DoorBird app). The hub's own
        // recording of live events is not affected; ask again much later.
        result.error = 'no permission to read the history';
        this.historyDeniedUntil = Date.now() + t.historyDeniedRetryMs;
        this.syncWanted.clear();
        this.log.info({ door: this.id }, 'door station does not allow reading its history');
      } else {
        result.error = error.message;
        this.noteError('history', error);
        throw error; // the poller tries again after `historyRetryMs`
      }
    } finally {
      if (!this.stopped && (result.imported > 0 || result.attached > 0)) {
        this.log.info({ door: this.id, imported: result.imported, attached: result.attached }, 'door history synchronised');
        this.notify();
        this.host.deps.state.publish({ type: 'history_updated', doorId: this.id });
      }
    }
  }

  /** Walks the device's list for one event type from the newest picture back to what is known. */
  private async syncType(type: LiveType, mark: SyncMark, signal: AbortSignal): Promise<{ imported: number; attached: number; mark: SyncMark }> {
    const t = this.host.timings;
    const { store } = this.host;
    const cutoff = this.host.retentionCutoff();
    // A mark from the future (the device's clock was wrong once) would hide every later picture.
    const known = mark.ts > Date.now() + DAY_MS ? 0 : mark.ts;
    let newest = known;
    const hashes: string[] = [];
    let imported = 0;
    let attached = 0;
    const count = (outcome: 'imported' | 'attached' | 'known') => {
      if (outcome === 'imported') imported++;
      else if (outcome === 'attached') attached++;
    };

    for (let index = 1; index <= t.historyMaxIndex; index++) {
      const picture = await this.client.history(index, HISTORY_EVENT[type], signal);
      if (this.stopped || signal.aborted) throw new DoorBirdError('aborted', 'history sync cancelled', { executed: 'unknown' });
      if (!picture) break; // HTTP 404: the list ends here
      if (picture.timestamp !== null) {
        // Index 1 is the newest: from the first known (or expired) picture on, everything is older.
        if (picture.timestamp <= known || picture.timestamp < cutoff) break;
        newest = Math.max(newest, picture.timestamp);
        count(this.importPicture(type, picture.timestamp, picture.image, { timed: true, mayBeLive: true }));
      } else {
        // Firmware without X-Timestamp: pictures can only be told apart by their content.
        const hash = sha256Hex(picture.image);
        if (mark.hashes.includes(hash) || hashes.includes(hash) || store.hasHash(this.id, hash)) break;
        hashes.push(hash);
        const approximate = picture.lastModified ?? Date.now() - (index - 1) * 1000;
        if (approximate < cutoff) break;
        // Without a time only the newest picture can be recognised as the event the hub has just recorded itself.
        count(this.importPicture(type, approximate, picture.image, { timed: false, mayBeLive: index === 1 }));
      }
    }
    return { imported, attached, mark: { ts: newest, hashes: [...hashes, ...mark.hashes].slice(0, MAX_REMEMBERED_HASHES) } };
  }

  private importPicture(type: LiveType, ts: number, image: Buffer, options: { timed: boolean; mayBeLive: boolean }): 'imported' | 'attached' | 'known' {
    const { store } = this.host;
    if (options.timed && store.hasImported(this.id, type, ts)) return 'known';
    if (options.mayBeLive) {
      const live = store.findLive(this.id, type, ts, this.host.timings.dedupeWindowMs);
      if (live) {
        // The hub recorded this event itself, with its own picture. Only a missing picture is filled in.
        if (store.hasImage(live)) return 'known';
        return store.attachImage(live.id, image) ? 'attached' : 'known';
      }
    }
    store.insert({ doorId: this.id, type, ts, source: 'device' }, image);
    return 'imported';
  }

  /** The sync marks belong to one physical device: they start over when the address changes. */
  private loadMarks(): SyncMarks {
    const read = (value: unknown): SyncMark => {
      if (!isRecord(value)) return { ts: 0, hashes: [] };
      const ts = typeof value.ts === 'number' && Number.isFinite(value.ts) && value.ts > 0 ? value.ts : 0;
      const hashes = Array.isArray(value.hashes)
        ? value.hashes.filter((hash): hash is string => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)).slice(0, MAX_REMEMBERED_HASHES)
        : [];
      return { ts, hashes };
    };
    let stored: unknown = null;
    try {
      stored = this.host.deps.settings.getInternal<unknown>(`doorbird.sync.${this.id}`);
    } catch (err) {
      this.log.warn({ err, door: this.id }, 'stored history sync position is unreadable; starting over');
    }
    const record = isRecord(stored) && stored.host === this.settings.host ? stored : {};
    return { doorbell: read(record.doorbell), motion: read(record.motion) };
  }

  private saveMarks(marks: SyncMarks): void {
    this.host.deps.settings.setInternal(`doorbird.sync.${this.id}`, { host: this.settings.host, ...marks });
  }
}
