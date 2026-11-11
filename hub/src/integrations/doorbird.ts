import type { DoorBirdDeviceSettings, DoorBirdSettings, DoorEntity, DoorEventType, DoorHistoryPage, ServiceStatus, TestResult } from '@home-hub/shared';
import { HttpError } from '../http/errors.ts';
import { Poller } from '../util/poller.ts';
import { DoorBirdClient } from './doorbird/client.ts';
import { fromTransport, type DoorBirdError } from './doorbird/errors.ts';
import { DoorHistoryStore } from './doorbird/history-store.ts';
import { streamSources } from './doorbird/protocol.ts';
import { DoorStation, type StationHealth, type StationHost } from './doorbird/station.ts';
import { DOORBIRD_DEFAULTS, type DoorBirdOptions, type DoorBirdTimings } from './doorbird/timings.ts';
import { streamName, type StreamSpec } from './media.ts';
import type { Actor, Integration, IntegrationDeps } from './types.ts';

export type { DoorBirdOptions } from './doorbird/timings.ts';

const DAY_MS = 24 * 60 * 60_000;

/** A configured device the hub cannot even try to reach (e.g. a port number that does not exist). */
interface InvalidDevice {
  settings: DoorBirdDeviceSettings;
  message: string;
}

/** The connection test must answer while the administrator is waiting: shorter timeouts than in normal operation. */
const TEST_TIMINGS: DoorBirdTimings = { ...DOORBIRD_DEFAULTS, requestTimeoutMs: 6_000, imageTimeoutMs: 8_000, historyTimeoutMs: 10_000 };

/**
 * DoorBird door stations (LAN API).
 *
 * `doorId` is always the configured device id (the entity id is `door:<doorId>`).
 *
 * This class is the part the rest of the hub talks to: it owns one
 * `DoorStation` per configured device (connections, event stream, history
 * sync — see `doorbird/station.ts`), publishes their entities and the
 * combined service health, and looks after the shared history store.
 * Live video and audio never pass through here: the streams are only declared
 * and go2rtc fetches them from the devices itself.
 */
export class DoorBirdIntegration implements Integration {
  private readonly timings: DoorBirdTimings;
  private readonly store: DoorHistoryStore;
  private readonly stations = new Map<string, DoorStation>();
  private readonly invalid: InvalidDevice[] = [];
  private readonly retention: Poller;
  private active = false;
  private running = false;
  private stopped = false;
  private lastCleanup: { at: number; expired: number; overLimit: number; orphanFiles: number } | null = null;

  constructor(
    protected readonly deps: IntegrationDeps,
    protected readonly settings: DoorBirdSettings,
    options: DoorBirdOptions = {},
  ) {
    this.timings = { ...DOORBIRD_DEFAULTS, ...options };
    this.store = new DoorHistoryStore(deps.db, deps.vault, deps.config.dataDir, deps.log);
    const host: StationHost = {
      deps,
      timings: this.timings,
      store: this.store,
      isActive: () => this.active,
      retentionCutoff: () => this.retentionCutoff(),
      changed: () => this.publish(),
      contacted: () => this.publishHealth(),
    };
    for (const device of settings.devices) {
      // The settings API guarantees unique ids; a second device with the same id would overwrite the first one's entity.
      if (this.stations.has(device.id) || this.invalid.some((entry) => entry.settings.id === device.id)) continue;
      try {
        const previous = deps.state.get(`door:${device.id}`);
        this.stations.set(device.id, new DoorStation(host, device, previous?.kind === 'door' ? previous : null));
      } catch (err) {
        // The address cannot be turned into a URL (the settings form accepts e.g. port 99999).
        // The other door stations must work regardless.
        deps.log.warn({ err, door: device.id }, 'door station has an unusable address');
        this.invalid.push({ settings: device, message: `${device.name}: Die Adresse der Türstation ist ungültig.` });
      }
    }
    this.retention = new Poller(
      (signal) => this.cleanUp(signal),
      () => this.timings.retentionIntervalMs,
      (err) => deps.log.warn({ err }, 'door history clean-up failed'),
      60 * 60_000,
    );
  }

  // --- Life cycle --------------------------------------------------------------------

  start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    // Show the doors at once (greyed out) and drop entities of devices that are no longer configured.
    this.publish();
    for (const station of this.stations.values()) station.start();
    this.retention.start();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    // Wait for every part, also when one of them fails to stop: the hub starts the next instance right after this.
    const results = await Promise.allSettled([this.retention.stop(), ...[...this.stations.values()].map((station) => station.stop())]);
    for (const result of results) {
      if (result.status === 'rejected') this.deps.log.warn({ err: result.reason as unknown }, 'a part of the door integration did not stop cleanly');
    }
  }

  setActive(active: boolean): void {
    this.active = active;
    for (const station of this.stations.values()) station.setActive(active);
  }

  diagnostics(): unknown {
    return {
      active: this.active,
      retentionDays: this.settings.retentionDays,
      devices: [...this.stations.values()].map((station) => station.diagnostics()),
      invalidDevices: this.invalid.map((entry) => ({ id: entry.settings.id, name: entry.settings.name, host: entry.settings.host })),
      lastCleanup: this.lastCleanup ? { ...this.lastCleanup, at: new Date(this.lastCleanup.at).toISOString() } : null,
    };
  }

  // --- Entities and health -------------------------------------------------------------

  private retentionCutoff(): number {
    return Date.now() - Math.max(1, this.settings.retentionDays) * DAY_MS;
  }

  /** Entity of a device that has no station: shown greyed out, so the owner sees that it exists but does not work. */
  private placeholder(device: DoorBirdDeviceSettings): DoorEntity {
    return {
      id: `door:${device.id}`,
      kind: 'door',
      name: device.name,
      room: device.room.trim() || null,
      available: false,
      service: 'doorbird',
      model: null,
      relays: [],
      features: { talk: true, audio: true, light: true },
      lastRingAt: this.store.newest(device.id, 'doorbell'),
      lastMotionAt: this.store.newest(device.id, 'motion'),
    };
  }

  private publish(): void {
    if (!this.running) return;
    try {
      const entities: DoorEntity[] = [];
      for (const device of this.settings.devices) {
        if (entities.some((entity) => entity.id === `door:${device.id}`)) continue;
        const station = this.stations.get(device.id);
        entities.push(station ? station.entity() : this.placeholder(device));
      }
      this.deps.state.replace('doorbird', entities);
    } catch (err) {
      // Reading the newest events can fail while the database is being closed; the next change publishes again.
      this.deps.log.error({ err }, 'could not publish the door entities');
    }
    this.publishHealth();
  }

  /**
   * Combined health of all door stations: `ok` when every one answers,
   * `degraded` when some do not (or cannot report events), `offline` when
   * none does. The message names the door stations that have a problem.
   */
  private publishHealth(): void {
    if (!this.running) return;
    const verdicts: StationHealth[] = [
      ...[...this.stations.values()].map((station) => station.health()),
      ...this.invalid.map((entry): StationHealth => ({ state: 'down', message: entry.message })),
    ];
    let status: ServiceStatus;
    let message: string | null = null;
    if (verdicts.length === 0) {
      status = 'unconfigured';
      message = 'Es ist noch keine Türstation eingetragen.';
    } else {
      const down = verdicts.filter((verdict) => verdict.state === 'down');
      const limited = verdicts.filter((verdict) => verdict.state === 'limited');
      if (down.length === verdicts.length) status = 'offline';
      else if (down.length > 0 || limited.length > 0) status = 'degraded';
      // Some device has neither answered nor failed twice yet: no verdict, the hub keeps showing "starting".
      else if (verdicts.some((verdict) => verdict.state === 'pending')) status = 'starting';
      else status = 'ok';
      const problems = [...down, ...limited].map((verdict) => verdict.message).filter((text): text is string => text !== null);
      if (status !== 'ok' && status !== 'starting' && problems.length > 0) message = problems.join(' ');
    }
    try {
      this.deps.state.setService('doorbird', status, message);
    } catch (err) {
      // This runs in the middle of requests to the devices (every answer is a sign of life):
      // a failing listener of the state store must not make e.g. a door opening look failed.
      this.deps.log.error({ err }, 'could not publish the door station health');
    }
  }

  // --- Housekeeping ------------------------------------------------------------------

  /** Deletes what is older than the retention period (rows and picture files) and files no event points to. */
  private async cleanUp(signal: AbortSignal): Promise<void> {
    const expired = await this.store.purgeOlderThan(this.retentionCutoff(), signal);
    let overLimit = 0;
    for (const station of this.stations.values()) {
      overLimit += await this.store.enforceLimit(station.id, this.timings.maxEventsPerDoor, signal);
    }
    const orphanFiles = await this.store.sweepOrphans(signal);
    if (signal.aborted) return;
    this.lastCleanup = { at: Date.now(), expired, overLimit, orphanFiles };
    if (expired + overLimit === 0) return;
    this.deps.log.info({ expired, overLimit, orphanFiles }, 'old door events deleted');
    // The newest ring may be among the deleted events, and open history lists are now out of date.
    this.publish();
    for (const station of this.stations.values()) this.deps.state.publish({ type: 'history_updated', doorId: station.id });
  }

  // --- Video -------------------------------------------------------------------------

  /**
   * go2rtc streams of all door stations (names via `streamName('door', id, …)`):
   *   `door_<id>_main`  live video + audio from the door (never opens a talk channel)
   *   `door_<id>_talk`  talk channel (browser microphone → door speaker)
   * Declared for every configured device, reachable or not — go2rtc connects on demand.
   */
  streams(): StreamSpec[] {
    const specs: StreamSpec[] = [];
    for (const station of this.stations.values()) {
      const device = this.settings.devices.find((candidate) => candidate.id === station.id);
      if (!device) continue;
      const sources = streamSources(device);
      specs.push({ name: streamName('door', device.id, 'main'), sources: sources.main });
      specs.push({ name: streamName('door', device.id, 'talk'), sources: sources.talk });
    }
    return specs;
  }

  // --- Requests from the apps ----------------------------------------------------------

  private station(doorId: string): DoorStation {
    const station = this.stations.get(doorId);
    if (station) return station;
    const broken = this.invalid.find((entry) => entry.settings.id === doorId);
    if (broken) throw new HttpError(503, 'unavailable', broken.message);
    throw new HttpError(404, 'not_found', 'Diese Türstation gibt es nicht (mehr).');
  }

  /** Current JPEG from the door camera. Throws `HttpError` when the door is unknown or unreachable. */
  async snapshot(doorId: string): Promise<Buffer> {
    return this.station(doorId).snapshot();
  }

  /** Triggers a door opener relay, records it in the door history and the audit log, and publishes `door_opened`. */
  async openDoor(doorId: string, relayId: string, actor: Actor): Promise<void> {
    let station: DoorStation;
    try {
      station = this.station(doorId);
    } catch (err) {
      // Every attempt to open a door leaves a trace, also one that names a door that does not exist.
      try {
        this.deps.audit.record(
          'door.open_failed',
          { userId: actor.userId, username: actor.username, ip: actor.ip },
          { door: doorId.slice(0, 60), relay: relayId.slice(0, 60), reason: err instanceof HttpError && err.statusCode === 404 ? 'unknown_door' : 'invalid_address' },
        );
      } catch (auditError) {
        this.deps.log.error({ err: auditError }, 'could not write the audit entry of a failed door opening');
      }
      throw err;
    }
    await station.openDoor(relayId, actor);
  }

  /** Switches the door station's light on. */
  async light(doorId: string): Promise<void> {
    await this.station(doorId).light();
  }

  /** Door history (rings, motion, openings), newest first, from the hub's own store. */
  history(doorId: string, options: { before?: number | null; limit?: number; type?: DoorEventType | null }): DoorHistoryPage {
    // The history is the hub's own: it can be read while the device is unreachable or wrongly configured.
    if (!this.settings.devices.some((device) => device.id === doorId)) {
      throw new HttpError(404, 'not_found', 'Diese Türstation gibt es nicht (mehr).');
    }
    return this.store.list(doorId, options);
  }

  /** Decrypted JPEG of a history event, or null when it has no image (any more). */
  historyImage(eventId: string): Buffer | null {
    return this.store.image(eventId);
  }

  // --- Connection test -----------------------------------------------------------------

  /** Connection test for one (possibly unsaved) device. Never throws. `options` exist for the hub's own tests. */
  static async test(device: DoorBirdDeviceSettings, options: DoorBirdOptions = {}): Promise<TestResult> {
    try {
      return await testDevice(device, { ...TEST_TIMINGS, ...options });
    } catch {
      return { ok: false, message: 'Die Prüfung ist unerwartet fehlgeschlagen. Bitte noch einmal versuchen.', details: [] };
    }
  }
}

function failed(message: string, details: string[] = []): TestResult {
  return { ok: false, message, details };
}

/** Why the login check of the connection test failed, for the administrator. */
function describeTestFailure(error: DoorBirdError): string {
  switch (error.kind) {
    case 'auth':
    case 'denied':
      return 'Anmeldung abgelehnt. Bitte Benutzername und Passwort prüfen – der Benutzer braucht in der DoorBird-App außerdem die Berechtigung „API-Operator“.';
    case 'locked':
      return 'Die Türstation hat den Zugang nach mehreren Fehlversuchen vorübergehend gesperrt. Bitte einige Minuten warten und dann noch einmal prüfen.';
    case 'timeout':
    case 'network':
      return `Die Türstation ist unter dieser Adresse nicht erreichbar${error.reason ? `: ${error.reason}` : ''}.`;
    case 'busy':
      return 'Die Türstation ist gerade beschäftigt. Bitte gleich noch einmal prüfen.';
    default:
      return 'Unter dieser Adresse antwortet keine DoorBird-Türstation. Bitte die Adresse prüfen.';
  }
}

/** One permission check of the connection test as a detail line. */
function describeCheck(error: DoorBirdError, what: string, permission: string): string {
  switch (error.kind) {
    case 'permission':
    case 'denied':
      return `✗ ${what}: nicht erlaubt. Bitte in der DoorBird-App (Administration → Benutzer) die Berechtigung „${permission}“ einschalten.`;
    case 'auth':
    case 'locked':
      return `✗ ${what}: Die Türstation lehnt die Anmeldung ab.`;
    case 'timeout':
    case 'network':
      return `✗ ${what}: keine Antwort von der Türstation.`;
    case 'busy':
      return `✗ ${what}: Die Türstation ist gerade beschäftigt.`;
    default:
      return `✗ ${what}: unerwartete Antwort der Türstation.`;
  }
}

async function testDevice(device: DoorBirdDeviceSettings, timings: DoorBirdTimings): Promise<TestResult> {
  if (!device.host.trim()) return failed('Bitte die Adresse der Türstation eintragen.');
  if (!device.username.trim() || !device.password) return failed('Bitte Benutzername und Passwort der Türstation eintragen.');
  let client: DoorBirdClient;
  try {
    client = new DoorBirdClient(device, timings);
  } catch {
    return failed('Die Adresse der Türstation ist ungültig.');
  }
  try {
    let info;
    try {
      info = await client.info();
    } catch (err) {
      return failed(describeTestFailure(fromTransport(err)));
    }
    const model = info.model ?? 'DoorBird-Türstation';
    const details = [
      `Modell: ${info.model ?? 'unbekannt'}`,
      `Firmware: ${info.firmware ?? 'unbekannt'}${info.build ? ` (Build ${info.build})` : ''}`,
      `Relais: ${info.relays.join(', ')}`,
    ];
    let missing = 0;

    // Without "watch always" the device answers 204 instead of a picture — and refuses the door opener too.
    try {
      await client.image();
      details.push('✓ Live-Bild und Türöffner: erlaubt');
    } catch (err) {
      missing++;
      details.push(describeCheck(fromTransport(err), 'Live-Bild und Türöffner', 'Immer ansehen'));
      // A refusal makes the client check the login again before anything else is sent.
      await client.info().catch(() => {});
    }

    try {
      // 404 (no picture yet) is fine: the device answered behind the permission check.
      await client.history(1, 'doorbell');
      details.push('✓ Verlauf: erlaubt');
    } catch (err) {
      missing++;
      details.push(describeCheck(fromTransport(err), 'Verlauf', 'Verlauf'));
    }

    return {
      ok: true,
      message: missing === 0 ? `Verbunden mit ${model}.` : `Verbunden mit ${model} – es funktioniert aber noch nicht alles (siehe Details).`,
      details,
    };
  } finally {
    await client.close();
  }
}
