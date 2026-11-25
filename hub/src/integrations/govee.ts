import type { EntityCommand, GoveeSettings, LightEntity, TestResult } from '@home-hub/shared';
import { HttpError, notFound, unavailable } from '../http/errors.ts';
import { describeError } from '../util/http.ts';
import { Poller } from '../util/poller.ts';
import { GOVEE_CLOUD, GoveeCloud, GoveeCloudError, packRgb, type CloudCommand, type CloudDevice } from './govee/cloud.ts';
import { GoveeLan, GoveeLanError, kelvinToRgb, LAN_DEFAULTS, type GoveeLanOptions, type LanStatus } from './govee/lan.ts';
import type { Integration, IntegrationDeps } from './types.ts';

/**
 * Govee lights (LED strips, bulbs, lamps).
 *
 * Two ways to a light, used together:
 * - **LAN** (preferred): JSON over UDP straight to the light, for models whose
 *   "LAN control" is switched on in the Govee app. Fast, no cloud, no limits.
 * - **Cloud**: Govee's API with the household's key — names and abilities of
 *   all lights, and control of those without LAN. Govee allows 10 000 requests
 *   a day, so the state of cloud-only lights is asked for sparingly (the pause
 *   grows with the number of lights), commands of the same kind that pile up
 *   are merged (only the newest colour is sent), and a refused request pauses
 *   the cloud for as long as Govee asks.
 *
 * Lights are matched by their device id, which the cloud list and the LAN
 * search report alike (e.g. `1F:80:C5:32:32:36:72:4E`).
 */

const SERVICE = 'govee';

export interface GoveeTiming {
  /** LAN state requests while an app is open / while nobody is looking. */
  lanActiveMs: number;
  lanIdleMs: number;
  /** LAN search for new lights and changed addresses. */
  scanMs: number;
  /** A LAN light that has not answered for this long counts as gone. */
  lanLostMs: number;
  /** Time to wait for LAN answers before reporting what was found. */
  settleMs: number;
  /** Refresh of the cloud's device list. */
  cloudListMs: number;
  /** Shortest pause between state requests of one cloud-only light while an app is open / idle. */
  cloudActiveMs: number;
  cloudIdleMs: number;
  /** Cloud requests per day the state polling may use (Govee allows 10 000 in all). */
  cloudBudget: number;
  /** After a command, the cloud's (lagging) state is not trusted for this long. */
  holdMs: number;
  /** LAN state request after a command, to confirm it. */
  confirmMs: number;
  /** Pause after a refused API key. */
  authBlockMs: number;
  requestTimeoutMs: number;
}

const DEFAULT_TIMING: GoveeTiming = {
  lanActiveMs: 10_000,
  lanIdleMs: 60_000,
  scanMs: 60_000,
  lanLostMs: 150_000,
  settleMs: 2500,
  cloudListMs: 30 * 60_000,
  cloudActiveMs: 60_000,
  cloudIdleMs: 15 * 60_000,
  cloudBudget: 6000,
  holdMs: 10_000,
  confirmMs: 600,
  authBlockMs: 30 * 60_000,
  requestTimeoutMs: 10_000,
};

export interface GoveeOptions {
  /** Base address of the cloud API (tests and demo point it at a simulator). */
  cloudBase?: string;
  lan?: Partial<GoveeLanOptions>;
  timing?: Partial<GoveeTiming>;
}

interface Light {
  /** Device id as Govee reports it, upper case. */
  device: string;
  entityId: string;
  sku: string;
  name: string;
  room: string | null;
  cloud: CloudDevice | null;
  /** LAN address and when the light last answered there. */
  ip: string | null;
  heardAt: number;
  on: boolean;
  brightness: number | null;
  rgb: { r: number; g: number; b: number } | null;
  kelvin: number | null;
  cloudOnline: boolean | null;
  /** State known at least once. */
  known: boolean;
  /** Ignore the cloud's state until then (it lags behind commands). */
  holdUntil: number;
}

type Change = { on?: boolean; brightness?: number; rgb?: { r: number; g: number; b: number }; kelvin?: number };

export const goveeEntityId = (device: string) => `govee:${device.replace(/[^0-9a-zA-Z]/g, '').toLowerCase()}`;
const normalise = (device: string) => device.trim().toUpperCase();
const hex = (rgb: { r: number; g: number; b: number }) => `#${[rgb.r, rgb.g, rgb.b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
const fromHex = (value: string) => ({ r: parseInt(value.slice(1, 3), 16), g: parseInt(value.slice(3, 5), 16), b: parseInt(value.slice(5, 7), 16) });

/** Whether a cloud device is a light the app can show. */
export function isLight(device: CloudDevice): boolean {
  if (device.type) return device.type === 'devices.types.light';
  return device.capabilities.some((capability) => capability.instance === 'colorRgb' || capability.instance === 'brightness');
}

/** A room from the light's name ("Wohnzimmer Streifen" → "Wohnzimmer"), when the house has it. */
export function roomFromName(name: string, rooms: Iterable<string>): string | null {
  const lower = ` ${name.toLowerCase()} `;
  let best: string | null = null;
  for (const room of rooms) {
    const candidate = room.trim();
    if (candidate.length < 3) continue;
    if (lower.includes(` ${candidate.toLowerCase()} `) || lower.includes(` ${candidate.toLowerCase()}-`)) {
      if (!best || candidate.length > best.length) best = candidate;
    }
  }
  return best;
}

function capability(light: Light, instance: string) {
  return light.cloud?.capabilities.find((entry) => entry.instance === instance) ?? null;
}

function featuresOf(light: Light): LightEntity['features'] {
  // Lights known only from the LAN search: the LAN interface offers all three.
  if (!light.cloud) return { dim: true, color: true, colorTemp: true };
  return { dim: Boolean(capability(light, 'brightness')), color: Boolean(capability(light, 'colorRgb')), colorTemp: Boolean(capability(light, 'colorTemperatureK')) };
}

function kelvinRange(light: Light): { min: number; max: number } {
  const range = capability(light, 'colorTemperatureK')?.parameters?.range;
  return range && range.max > range.min ? { min: range.min, max: range.max } : { min: 2000, max: 9000 };
}

export class GoveeIntegration implements Integration {
  private readonly lights = new Map<string, Light>();
  private readonly timing: GoveeTiming;
  private readonly cloud: GoveeCloud | null;
  private readonly lan: GoveeLan | null;
  private readonly lanOptions: GoveeLanOptions;
  private readonly cloudPoller: Poller;
  private readonly lanPoller: Poller;
  private stopped = false;
  private active = false;

  private lanRunning = false;
  private lanProblem: string | null = null;
  private lanScannedAt = 0;
  private lanStartedAt = 0;
  private cloudListedAt = 0;
  private cloudProblem: string | null = null;
  private cloudBlockedUntil = 0;
  private cloudLastError: string | null = null;
  private settled = false;
  private readonly sendChain = new Map<string, Promise<void>>();
  private readonly latest = new Map<string, number>();
  private sequence = 0;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly deps: IntegrationDeps,
    private readonly settings: GoveeSettings,
    options: GoveeOptions = {},
  ) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.cloud = settings.apiKey ? new GoveeCloud(settings.apiKey, options.cloudBase ?? GOVEE_CLOUD, this.timing.requestTimeoutMs) : null;
    this.lanOptions = { ...LAN_DEFAULTS, ...options.lan };
    this.lan = settings.lan
      ? new GoveeLan(this.lanOptions, {
          found: (found) => this.lanFound(found.device, found.sku, found.ip),
          status: (ip, status) => this.lanStatus(ip, status),
        })
      : null;
    this.cloudPoller = new Poller(
      (signal) => this.cloudTick(signal),
      () => this.cloudInterval(),
      (err) => this.cloudFailed(err),
      this.timing.authBlockMs,
    );
    this.lanPoller = new Poller(
      async () => this.lanTick(),
      () => (this.active ? this.timing.lanActiveMs : this.timing.lanIdleMs),
      () => {},
      this.timing.lanIdleMs,
    );
  }

  start(): void {
    this.stopped = false;
    this.publish();
    if (this.cloud) this.cloudPoller.start();
    if (this.lan) {
      this.lanStartedAt = Date.now();
      this.lan.start().then(
        () => {
          if (this.stopped) return this.lan?.stop();
          this.lanRunning = true;
          this.lanProblem = null;
          this.lanPoller.start();
        },
        (err: unknown) => {
          this.lanProblem = err instanceof GoveeLanError ? err.message : `LAN-Steuerung nicht möglich: ${describeError(err)}`;
          this.deps.log.warn({ reason: this.lanProblem }, 'Govee LAN control unavailable');
          this.publish();
        },
      );
    }
    // What was found after the first answers had time to arrive.
    this.later(() => {
      this.settled = true;
      this.publish();
    }, this.timing.settleMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await Promise.all([this.cloudPoller.stop(), this.lanPoller.stop()]);
    this.lan?.stop();
    this.lanRunning = false;
  }

  setActive(active: boolean): void {
    const was = this.active;
    this.active = active;
    if (active && !was) {
      this.lanPoller.kick();
      this.cloudPoller.kick();
    }
  }

  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.stopped) fn();
    }, ms);
    timer.unref();
    this.timers.add(timer);
  }

  diagnostics(): unknown {
    const now = Date.now();
    return {
      lan: this.lan
        ? { running: this.lanRunning, problem: this.lanProblem, ports: { scan: this.lanOptions.scanPort, listen: this.lanOptions.listenPort, device: this.lanOptions.devicePort }, hosts: this.settings.lanHosts }
        : null,
      cloud: this.cloud
        ? {
            problem: this.cloudProblem,
            lastError: this.cloudLastError,
            requestsLeftToday: this.cloud.remaining,
            pausedUntil: this.cloudBlockedUntil > now ? new Date(this.cloudBlockedUntil).toISOString() : null,
            listedAt: this.cloudListedAt ? new Date(this.cloudListedAt).toISOString() : null,
            stateIntervalSec: Math.round(this.cloudInterval() / 1000),
          }
        : null,
      lights: [...this.lights.values()].map((light) => ({
        device: light.device,
        sku: light.sku,
        name: light.name,
        via: this.lanAlive(light) ? 'lan' : light.cloud ? 'cloud' : 'none',
        ip: light.ip,
        lastHeardSec: light.heardAt ? Math.round((now - light.heardAt) / 1000) : null,
        cloudOnline: light.cloudOnline,
        features: featuresOf(light),
      })),
    };
  }

  // --- Lights -------------------------------------------------------------------------------------

  private lanAlive(light: Light): boolean {
    return this.lanRunning && light.ip !== null && Date.now() - light.heardAt < this.timing.lanLostMs;
  }

  private available(light: Light): boolean {
    if (this.lanAlive(light)) return light.known;
    return Boolean(light.cloud) && this.cloudProblem === null && light.cloudOnline !== false && light.known;
  }

  private knownRooms(): Set<string> {
    const rooms = new Set<string>();
    for (const entity of this.deps.state.all()) if (entity.service !== SERVICE && entity.room) rooms.add(entity.room);
    return rooms;
  }

  private light(device: string, sku: string): Light {
    const id = normalise(device);
    let light = this.lights.get(id);
    if (!light) {
      light = {
        device: id,
        entityId: goveeEntityId(id),
        sku,
        name: `Govee ${sku || 'Licht'}`,
        room: null,
        cloud: null,
        ip: null,
        heardAt: 0,
        on: false,
        brightness: null,
        rgb: null,
        kelvin: null,
        cloudOnline: null,
        known: false,
        holdUntil: 0,
      };
      this.lights.set(id, light);
    }
    if (sku && !light.sku) light.sku = sku;
    return light;
  }

  private entity(light: Light): LightEntity {
    const features = featuresOf(light);
    const range = kelvinRange(light);
    const white = light.kelvin !== null && light.kelvin > 0;
    return {
      id: light.entityId,
      kind: 'light',
      name: light.name,
      room: light.room,
      available: this.available(light),
      service: SERVICE,
      on: light.on,
      brightness: features.dim ? (light.brightness ?? null) : null,
      color: features.color && !white && light.rgb ? hex(light.rgb) : null,
      colorTemp: features.colorTemp && white ? Math.round(((Math.min(range.max, Math.max(range.min, light.kelvin!)) - range.min) / (range.max - range.min)) * 100) : null,
      features,
      isGroup: false,
    };
  }

  private publish(): void {
    if (this.stopped) return;
    const lights = [...this.lights.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
    // A room from the name, once the house's rooms are known (the building controller may report later).
    const unplaced = lights.filter((light) => light.room === null);
    if (unplaced.length > 0) {
      const rooms = this.knownRooms();
      for (const light of unplaced) light.room = roomFromName(light.name, rooms);
    }
    this.deps.state.replace(
      SERVICE,
      lights.map((light) => this.entity(light)),
    );
    const problems = [this.cloudProblem, this.lanProblem].filter((problem): problem is string => problem !== null);
    const unavailable = lights.filter((light) => !this.available(light));
    if (!this.settled && lights.length === 0 && problems.length === 0) {
      this.deps.state.setService(SERVICE, 'starting', null);
      return;
    }
    if (lights.length === 0) {
      const hint = this.lan ? 'Ist in der Govee-App beim Licht „LAN-Steuerung“ eingeschaltet?' : 'Sind im Govee-Konto Lichter eingerichtet?';
      this.deps.state.setService(SERVICE, problems.length > 0 ? 'offline' : 'degraded', problems.length > 0 ? problems.join(' · ') : `Noch kein Govee-Licht gefunden. ${hint}`);
      return;
    }
    if (problems.length === 0 && unavailable.length === 0) {
      this.deps.state.setService(SERVICE, 'ok', null);
      return;
    }
    const text = [...problems, ...(unavailable.length > 0 ? [`nicht erreichbar: ${unavailable.map((light) => light.name).join(', ')}`] : [])].join(' · ');
    this.deps.state.setService(SERVICE, unavailable.length === lights.length ? 'offline' : 'degraded', text);
  }

  // --- LAN ----------------------------------------------------------------------------------------

  private lanFound(device: string, sku: string, ip: string): void {
    const light = this.light(device, sku);
    const isNew = light.ip !== ip;
    // Another light that had this address has moved away.
    for (const other of this.lights.values()) if (other !== light && other.ip === ip) other.ip = null;
    light.ip = ip;
    light.heardAt = Date.now();
    if (isNew) {
      this.deps.log.info({ device: light.device, sku: light.sku, ip }, 'Govee light found on the LAN');
      void this.lan?.status(ip).catch(() => {});
    }
    this.publish();
  }

  private lanStatus(ip: string, status: LanStatus): void {
    const light = [...this.lights.values()].find((entry) => entry.ip === ip);
    if (!light) return;
    light.heardAt = Date.now();
    light.on = status.on;
    light.brightness = status.brightness;
    light.rgb = status.rgb;
    light.kelvin = status.kelvin;
    light.known = true;
    this.publish();
  }

  private async lanTick(): Promise<void> {
    if (!this.lan || !this.lanRunning || this.stopped) return;
    const now = Date.now();
    if (now - this.lanScannedAt >= this.timing.scanMs) {
      this.lanScannedAt = now;
      await this.lan.scan(this.settings.lanHosts);
    }
    await Promise.allSettled([...this.lights.values()].filter((light) => light.ip).map((light) => this.lan!.status(light.ip!)));
    // Lights that stopped answering are shown as unreachable (or fall back to the cloud).
    this.later(() => this.publish(), this.timing.settleMs);
  }

  // --- Cloud --------------------------------------------------------------------------------------

  /** Lights whose state only the cloud knows. */
  private cloudOnly(): Light[] {
    return [...this.lights.values()].filter((light) => light.cloud && !this.lanAlive(light));
  }

  private cloudInterval(): number {
    const blocked = this.cloudBlockedUntil - Date.now();
    if (blocked > 0) return blocked;
    const count = Math.max(1, this.cloudOnly().length);
    // Requests per day for one round each: spread over the day so the budget is never exceeded.
    const perRound = (24 * 3600_000 * count) / this.timing.cloudBudget;
    return Math.max(this.active ? this.timing.cloudActiveMs : this.timing.cloudIdleMs, Math.round(perRound * (this.active ? 1 : 2)));
  }

  private async cloudTick(signal: AbortSignal): Promise<void> {
    if (!this.cloud || this.stopped || Date.now() < this.cloudBlockedUntil) return;
    if (Date.now() - this.cloudListedAt >= this.timing.cloudListMs) {
      const devices = (await this.cloud.devices(signal)).filter(isLight);
      this.cloudListedAt = Date.now();
      const seen = new Set<string>();
      for (const device of devices) {
        const light = this.light(device.device, device.sku);
        light.cloud = device;
        light.sku = device.sku;
        if (light.name !== device.name) light.room = null;
        light.name = device.name;
        seen.add(light.device);
      }
      // Lights removed from the account disappear, unless they still answer on the LAN.
      for (const [id, light] of this.lights) {
        if (seen.has(id)) continue;
        light.cloud = null;
        if (!this.lanAlive(light)) this.lights.delete(id);
      }
      this.deps.log.info({ lights: devices.length }, 'Govee cloud lights listed');
    }
    // Right after the start, give the LAN a moment: what answers there costs no cloud request.
    if (this.lan && !this.lanProblem && Date.now() - this.lanStartedAt < this.timing.settleMs) {
      this.later(() => this.cloudPoller.kick(), this.timing.settleMs - (Date.now() - this.lanStartedAt) + 50);
      this.cloudProblem = null;
      this.publish();
      return;
    }
    for (const light of this.cloudOnly()) {
      if (this.stopped || signal.aborted) return;
      if (Date.now() < light.holdUntil) continue;
      const state = await this.cloud.state(light.cloud!.device, light.cloud!.sku, signal);
      if (Date.now() < light.holdUntil || this.lanAlive(light)) continue;
      light.cloudOnline = state.online;
      if (state.on !== null) light.on = state.on;
      if (state.brightness !== null) light.brightness = state.brightness;
      if (state.rgb) light.rgb = state.rgb;
      if (state.kelvin !== null) light.kelvin = state.kelvin;
      light.known = true;
    }
    this.cloudProblem = null;
    this.cloudLastError = null;
    this.settled = true;
    this.publish();
  }

  private cloudFailed(err: unknown): void {
    if (this.stopped) return;
    this.cloudLastError = describeError(err);
    if (err instanceof GoveeCloudError && err.kind === 'auth') {
      this.cloudProblem = 'Govee nimmt den API-Key nicht an.';
      this.cloudBlockedUntil = Date.now() + this.timing.authBlockMs;
    } else if (err instanceof GoveeCloudError && err.kind === 'rate') {
      this.cloudProblem = 'Govee-Tageslimit erreicht – die Cloud pausiert kurz.';
      this.cloudBlockedUntil = Date.now() + (err.retryAfterMs ?? 60_000);
    } else {
      this.cloudProblem = 'Govee-Cloud nicht erreichbar.';
    }
    this.deps.log.warn({ reason: this.cloudLastError }, 'Govee cloud request failed');
    this.settled = true;
    this.publish();
  }

  // --- Commands -----------------------------------------------------------------------------------

  /** Commands of the same kind for the same light that pile up are merged: only the newest is sent. */
  private enqueue(light: Light, slot: string, run: () => Promise<void>): Promise<void> {
    const key = `${light.device}|${slot}`;
    const mine = ++this.sequence;
    this.latest.set(key, mine);
    const previous = this.sendChain.get(light.device) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (this.latest.get(key) !== mine) return;
      await run();
    });
    this.sendChain.set(
      light.device,
      next.catch(() => {}),
    );
    return next;
  }

  async command(entityId: string, command: EntityCommand): Promise<void> {
    const light = [...this.lights.values()].find((entry) => entry.entityId === entityId);
    if (!light) throw notFound('Dieses Govee-Licht gibt es nicht (mehr).');
    const features = featuresOf(light);
    const range = kelvinRange(light);
    let change: Change;
    switch (command.action) {
      case 'turn_on':
        change = { on: true };
        break;
      case 'turn_off':
        change = { on: false };
        break;
      case 'toggle':
        change = { on: !light.on };
        break;
      case 'set_brightness':
        if (!features.dim) throw new HttpError(400, 'unsupported', `„${light.name}“ lässt sich nicht dimmen.`);
        change = command.value <= 0 ? { on: false } : { on: true, brightness: Math.max(1, Math.round(command.value)) };
        break;
      case 'set_color':
        if (!features.color) throw new HttpError(400, 'unsupported', `„${light.name}“ kann keine Farben.`);
        change = { on: true, rgb: fromHex(command.value), kelvin: 0 };
        break;
      case 'set_color_temp':
        if (!features.colorTemp) throw new HttpError(400, 'unsupported', `„${light.name}“ hat keine Farbtemperatur.`);
        change = { on: true, kelvin: Math.round(range.min + (Math.min(100, Math.max(0, command.value)) / 100) * (range.max - range.min)) };
        break;
      default:
        throw new HttpError(400, 'unsupported', 'Ein Licht lässt sich so nicht bedienen.');
    }
    const viaLan = this.lanAlive(light);
    if (!viaLan && (!light.cloud || !this.cloud)) throw unavailable(`„${light.name}“ ist gerade nicht erreichbar.`);
    if (!viaLan && Date.now() < this.cloudBlockedUntil) {
      throw new HttpError(429, 'rate_limited', this.cloudProblem ?? 'Govee lässt gerade keine weiteren Befehle zu – bitte einen Moment warten.');
    }

    const steps: { slot: string; run: () => Promise<void> }[] = [];
    // Switching on first: colour or brightness alone may not wake a light that is off.
    const needsOn = change.on === true && (!light.on || (change.brightness === undefined && change.rgb === undefined && change.kelvin === undefined));
    if (change.on === false || needsOn) steps.push({ slot: 'power', run: () => this.send(light, viaLan, { on: change.on }) });
    if (change.brightness !== undefined) steps.push({ slot: 'brightness', run: () => this.send(light, viaLan, { brightness: change.brightness }) });
    if (change.rgb !== undefined || change.kelvin !== undefined) steps.push({ slot: 'color', run: () => this.send(light, viaLan, { rgb: change.rgb, kelvin: change.kelvin }) });
    await Promise.all(steps.map((step) => this.enqueue(light, step.slot, step.run)));
  }

  private async send(light: Light, viaLan: boolean, change: Change): Promise<void> {
    try {
      if (viaLan && this.lan && light.ip) {
        const ip = light.ip;
        if (change.on !== undefined) await this.lan.turn(ip, change.on);
        if (change.brightness !== undefined) await this.lan.brightness(ip, change.brightness);
        if (change.kelvin) await this.lan.color(ip, kelvinToRgb(change.kelvin), change.kelvin);
        else if (change.rgb) await this.lan.color(ip, change.rgb, 0);
        this.later(() => void this.lan?.status(ip).catch(() => {}), this.timing.confirmMs);
      } else {
        const cloud = this.cloud!;
        const device = light.cloud!;
        const commands: CloudCommand[] = [];
        if (change.on !== undefined) commands.push({ type: 'devices.capabilities.on_off', instance: 'powerSwitch', value: change.on ? 1 : 0 });
        if (change.brightness !== undefined) {
          const range = capability(light, 'brightness')?.parameters?.range;
          commands.push({ type: 'devices.capabilities.range', instance: 'brightness', value: Math.min(range?.max ?? 100, Math.max(range?.min ?? 1, change.brightness)) });
        }
        if (change.kelvin) commands.push({ type: 'devices.capabilities.color_setting', instance: 'colorTemperatureK', value: change.kelvin });
        else if (change.rgb) commands.push({ type: 'devices.capabilities.color_setting', instance: 'colorRgb', value: packRgb(change.rgb) });
        for (const command of commands) await cloud.control(device.device, device.sku, command);
        light.holdUntil = Date.now() + this.timing.holdMs;
      }
    } catch (err) {
      if (err instanceof GoveeCloudError) {
        if (err.kind === 'rate') {
          this.cloudBlockedUntil = Date.now() + (err.retryAfterMs ?? 60_000);
          throw new HttpError(429, 'rate_limited', 'Govee lässt gerade keine weiteren Befehle zu – bitte einen Moment warten.');
        }
        if (err.kind === 'auth') throw unavailable('Govee nimmt den API-Key nicht an.');
        if (err.kind === 'device') throw new HttpError(502, 'device_error', `Govee hat den Befehl für „${light.name}“ abgelehnt.`);
      }
      throw unavailable(`„${light.name}“ antwortet gerade nicht.`);
    }
    // What was sent is what the light shows now (the next state report confirms it).
    if (change.on !== undefined) light.on = change.on;
    if (change.brightness !== undefined) {
      light.brightness = change.brightness;
      light.on = true;
    }
    if (change.kelvin) {
      light.kelvin = change.kelvin;
      light.on = true;
    } else if (change.rgb) {
      light.rgb = change.rgb;
      light.kelvin = 0;
      light.on = true;
    }
    this.publish();
  }

  // --- Connection test ----------------------------------------------------------------------------

  /** What the LAN search finds within a moment (for the connection test of a running instance). */
  async searchNow(): Promise<{ device: string; sku: string; ip: string }[] | null> {
    if (!this.lan || !this.lanRunning) return null;
    await this.lan.scan(this.settings.lanHosts);
    await new Promise((resolve) => setTimeout(resolve, this.timing.settleMs));
    return [...this.lights.values()].filter((light) => this.lanAlive(light)).map((light) => ({ device: light.device, sku: light.sku, ip: light.ip! }));
  }

  /** Connection test with (possibly unsaved) settings. Never throws. */
  static async test(settings: GoveeSettings, options: GoveeOptions = {}, running: GoveeIntegration | null = null): Promise<TestResult> {
    const timing = { ...DEFAULT_TIMING, ...options.timing };
    const details: string[] = [];
    let cloudLights: CloudDevice[] | null = null;
    let lanLights: { device: string; sku: string; ip: string }[] | null = null;
    let cloudFailure: string | null = null;

    if (settings.apiKey) {
      const cloud = new GoveeCloud(settings.apiKey, options.cloudBase ?? GOVEE_CLOUD, timing.requestTimeoutMs);
      try {
        cloudLights = (await cloud.devices()).filter(isLight);
        details.push(`Cloud: API-Key angenommen, ${cloudLights.length === 1 ? '1 Licht' : `${cloudLights.length} Lichter`} im Konto${cloud.remaining !== null ? ` (heute noch ${cloud.remaining} Anfragen frei)` : ''}.`);
      } catch (err) {
        cloudFailure = err instanceof GoveeCloudError && err.kind === 'auth' ? 'Govee nimmt den API-Key nicht an.' : describeError(err);
        details.push(`Cloud: ${cloudFailure}`);
      }
    }

    if (settings.lan) {
      try {
        lanLights = await running?.searchNow() ?? null;
        if (lanLights === null) {
          const found = new Map<string, { device: string; sku: string; ip: string }>();
          const lan = new GoveeLan({ ...LAN_DEFAULTS, ...options.lan }, { found: (light) => found.set(normalise(light.device), { ...light, device: normalise(light.device) }), status: () => {} });
          await lan.start();
          try {
            await lan.scan(settings.lanHosts);
            await new Promise((resolve) => setTimeout(resolve, timing.settleMs));
          } finally {
            lan.stop();
          }
          lanLights = [...found.values()];
        }
        details.push(`Heimnetz: ${lanLights.length === 0 ? 'kein Licht mit LAN-Steuerung gefunden' : `${lanLights.length === 1 ? '1 Licht' : `${lanLights.length} Lichter`} mit LAN-Steuerung gefunden`}.`);
      } catch (err) {
        details.push(`Heimnetz: ${err instanceof GoveeLanError ? err.message : describeError(err)}`);
      }
    }

    const lan = new Map((lanLights ?? []).map((light) => [normalise(light.device), light]));
    const all = new Map<string, { name: string; sku: string; ip: string | null; cloud: boolean }>();
    for (const device of cloudLights ?? []) all.set(normalise(device.device), { name: device.name, sku: device.sku, ip: lan.get(normalise(device.device))?.ip ?? null, cloud: true });
    for (const [id, light] of lan) if (!all.has(id)) all.set(id, { name: `Govee ${light.sku || 'Licht'}`, sku: light.sku, ip: light.ip, cloud: false });

    for (const light of [...all.values()].slice(0, 20)) {
      details.push(`${light.name} (${light.sku}): ${light.ip ? `im Heimnetz (${light.ip})` : 'nur über die Govee-Cloud'}`);
    }
    if (all.size > 20) details.push(`… und ${all.size - 20} weitere`);
    const cloudOnly = [...all.values()].filter((light) => !light.ip);
    if (settings.lan && cloudOnly.length > 0) {
      details.push('Tipp: Für schnelles Schalten ohne Cloud in der Govee-App beim Licht unter Einstellungen „LAN-Steuerung“ einschalten (nicht jedes Modell kann das).');
    }

    if (cloudFailure && all.size === 0) return { ok: false, message: cloudFailure, details };
    if (all.size === 0) {
      return {
        ok: false,
        message: 'Kein Govee-Licht gefunden.',
        details: [...details, settings.lan ? 'Ist in der Govee-App beim Licht „LAN-Steuerung“ eingeschaltet? Ohne sie hilft nur der API-Key.' : 'Sind im Govee-Konto Lichter eingerichtet?'],
      };
    }
    return { ok: !cloudFailure, message: `${all.size === 1 ? '1 Govee-Licht' : `${all.size} Govee-Lichter`} gefunden${cloudFailure ? ', aber die Cloud lehnt ab' : ''}.`, details };
  }
}
