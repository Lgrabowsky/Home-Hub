import {
  SERVICE_LABELS,
  type Entity,
  type EntityCommand,
  type IntegrationSettingsMap,
  type ServiceId,
  type SettingsKey,
  type TestResult,
} from '@home-hub/shared';
import { HttpError, notFound } from '../http/errors.ts';
import { describeError } from '../util/http.ts';
import { Mutex } from '../util/poller.ts';
import { DoorBirdIntegration } from './doorbird.ts';
import { MediaManager, type StreamSpec } from './media.ts';
import { MyGekkoIntegration } from './mygekko.ts';
import { ReolinkIntegration } from './reolink.ts';
import { SonosIntegration } from './sonos/sonos.ts';
import { SpotifyIntegration, type SpotifyEndpoints } from './spotify.ts';
import type { Integration, IntegrationDeps } from './types.ts';

/**
 * Owns the integrations: creates them from the stored settings, restarts the
 * affected one when an administrator changes something, and routes requests
 * from the API to the right place.
 */

type DeviceKey = 'mygekko' | 'doorbird' | 'reolink' | 'sonos' | 'spotify';
const DEVICE_KEYS: DeviceKey[] = ['mygekko', 'doorbird', 'reolink', 'sonos', 'spotify'];

/** Entities are stored under an owner equal to the service id. */
const ENTITY_OWNERS: Partial<Record<DeviceKey, string>> = { mygekko: 'mygekko', doorbird: 'doorbird', reolink: 'reolink' };

export class IntegrationManager {
  readonly media: MediaManager;
  mygekko: MyGekkoIntegration | null = null;
  doorbird: DoorBirdIntegration | null = null;
  reolink: ReolinkIntegration | null = null;
  sonos: SonosIntegration | null = null;
  spotify: SpotifyIntegration | null = null;

  /** Demo mode: replaces the sources of a stream by name. */
  readonly streamOverrides = new Map<string, string[]>();
  /** Demo mode / tests: alternative Spotify endpoints. */
  spotifyEndpoints: Partial<SpotifyEndpoints> = {};

  private active = false;
  private started = false;
  private readonly lock = new Mutex();

  constructor(private readonly deps: IntegrationDeps) {
    this.media = new MediaManager(deps.config, deps.state, deps.log.child({ mod: 'media' }));
  }

  async start(): Promise<void> {
    this.started = true;
    this.applyGeneral();
    for (const key of DEVICE_KEYS) await this.configure(key);
    this.media.start();
    this.deps.settings.on('changed', (key) => {
      void this.lock.run(async () => {
        if (!this.started) return;
        if (key === 'general') this.applyGeneral();
        else await this.configure(key);
      });
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.lock.run(async () => {
      await Promise.all(DEVICE_KEYS.map((key) => this.stopOne(key)));
      await this.media.stop();
    });
  }

  /** Called when the first app connects / the last one leaves. */
  setActive(active: boolean): void {
    this.active = active;
    for (const key of DEVICE_KEYS) this.safely(key, () => this[key]?.setActive(active));
  }

  private applyGeneral(): void {
    const general = this.deps.settings.get('general');
    this.deps.state.setLayout(general.hubName, general.floors);
  }

  private depsFor(key: DeviceKey): IntegrationDeps {
    return { ...this.deps, log: this.deps.log.child({ mod: key }) };
  }

  private safely(key: DeviceKey, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.deps.log.error({ err, integration: key }, 'integration call failed');
    }
  }

  private async stopOne(key: DeviceKey): Promise<void> {
    const current: Integration | null = this[key];
    if (!current) return;
    this[key] = null;
    try {
      await current.stop();
    } catch (err) {
      this.deps.log.warn({ err, integration: key }, 'integration did not stop cleanly');
    }
  }

  private async configure(key: DeviceKey): Promise<void> {
    const { settings, state } = this.deps;
    await this.stopOne(key);
    const owner = ENTITY_OWNERS[key];
    const enabled = settings.get(key).enabled;

    if (!enabled) {
      if (owner) state.replace(owner, []);
      if (key === 'sonos') state.patchMusic({ players: [], groups: [] });
      if (key === 'spotify') state.patchMusic({ spotify: { linked: false, account: null } });
      state.setService(key, 'unconfigured');
    } else {
      // Keep the last known entities visible (greyed out) until the new instance reports in.
      if (owner) state.setAvailable(owner, false);
      state.setService(key, 'starting');
      try {
        const instance = this.create(key);
        (this as Record<DeviceKey, Integration | null>)[key] = instance;
        instance.start();
        instance.setActive(this.active);
      } catch (err) {
        (this as Record<DeviceKey, Integration | null>)[key] = null;
        this.deps.log.error({ err, integration: key }, 'integration failed to start');
        state.setService(key, 'offline', `${SERVICE_LABELS[key]} konnte nicht gestartet werden: ${describeError(err)}`);
      }
    }
    if (key === 'doorbird' || key === 'reolink') this.syncStreams();
  }

  private create(key: DeviceKey): Integration {
    const { settings } = this.deps;
    const deps = this.depsFor(key);
    switch (key) {
      case 'mygekko':
        return new MyGekkoIntegration(deps, settings.get('mygekko'));
      case 'doorbird':
        return new DoorBirdIntegration(deps, settings.get('doorbird'));
      case 'reolink':
        return new ReolinkIntegration(deps, settings.get('reolink'));
      case 'sonos':
        return new SonosIntegration(deps, settings.get('sonos'));
      case 'spotify':
        return new SpotifyIntegration(deps, settings.get('spotify'), this.spotifyEndpoints);
    }
  }

  /** Hands the current set of video streams to go2rtc. */
  syncStreams(): void {
    const specs: StreamSpec[] = [];
    try {
      if (this.doorbird) specs.push(...this.doorbird.streams());
      if (this.reolink) specs.push(...this.reolink.streams());
    } catch (err) {
      this.deps.log.error({ err }, 'could not build stream list');
    }
    this.media.setStreams(
      specs.map((spec) => {
        const override = this.streamOverrides.get(spec.name);
        return override ? { name: spec.name, sources: override } : spec;
      }),
    );
  }

  // --- Request routing ------------------------------------------------------------

  /** Returns the integration or fails with a clear message when it is not set up. */
  need<K extends DeviceKey>(key: K): NonNullable<IntegrationManager[K]> {
    const instance = this[key];
    if (!instance) throw new HttpError(503, 'not_configured', `${SERVICE_LABELS[key]} ist nicht eingerichtet.`);
    return instance as NonNullable<IntegrationManager[K]>;
  }

  entity(entityId: string): Entity {
    const entity = this.deps.state.get(entityId);
    if (!entity) throw notFound('Dieses Gerät gibt es nicht (mehr).');
    return entity;
  }

  async entityCommand(entityId: string, command: EntityCommand): Promise<void> {
    const entity = this.entity(entityId);
    if (!entity.available) throw new HttpError(503, 'unavailable', `„${entity.name}“ ist gerade nicht erreichbar.`);
    switch (entity.service) {
      case 'mygekko':
        return this.need('mygekko').command(entityId, command);
      default:
        throw new HttpError(400, 'unsupported', 'Dieses Gerät lässt sich so nicht bedienen.');
    }
  }

  // --- Admin ------------------------------------------------------------------------

  /** Connection test with settings that need not be saved yet. */
  async test<K extends SettingsKey>(key: K, value: IntegrationSettingsMap[K]): Promise<TestResult> {
    try {
      switch (key) {
        case 'mygekko':
          return await MyGekkoIntegration.test(value as IntegrationSettingsMap['mygekko']);
        case 'doorbird':
          return await this.testDevices((value as IntegrationSettingsMap['doorbird']).devices, (d) => DoorBirdIntegration.test(d));
        case 'reolink':
          return await this.testDevices((value as IntegrationSettingsMap['reolink']).devices, (d) => ReolinkIntegration.test(d));
        case 'sonos':
          return await SonosIntegration.test(value as IntegrationSettingsMap['sonos']);
        case 'spotify':
          return await SpotifyIntegration.test(value as IntegrationSettingsMap['spotify'], this.spotifyEndpoints);
        default:
          return { ok: true, message: 'Keine Prüfung nötig.', details: [] };
      }
    } catch (err) {
      this.deps.log.warn({ err, key }, 'connection test failed unexpectedly');
      return { ok: false, message: `Test fehlgeschlagen: ${describeError(err)}`, details: [] };
    }
  }

  private async testDevices<D extends { name: string }>(devices: D[], test: (device: D) => Promise<TestResult>): Promise<TestResult> {
    if (devices.length === 0) return { ok: false, message: 'Es ist noch kein Gerät eingetragen.', details: [] };
    const results = await Promise.all(devices.map(async (device) => ({ device, result: await test(device) })));
    const failed = results.filter((r) => !r.result.ok);
    return {
      ok: failed.length === 0,
      message:
        failed.length === 0
          ? results.length === 1
            ? results[0]!.result.message
            : `Alle ${results.length} Geräte sind erreichbar.`
          : `${failed.length} von ${results.length} Geräten nicht erreichbar.`,
      details: results.flatMap(({ device, result }) => [
        `${result.ok ? '✓' : '✗'} ${device.name}: ${result.message}`,
        ...result.details.map((line) => `   ${line}`),
      ]),
    };
  }

  diagnostics(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of DEVICE_KEYS) {
      try {
        out[key] = this[key]?.diagnostics() ?? null;
      } catch (err) {
        out[key] = { error: describeError(err) };
      }
    }
    return out;
  }

  serviceOf(id: ServiceId): Integration | null {
    return id === 'media' ? null : this[id];
  }
}
