import { randomBytes } from 'node:crypto';
import type { CameraEntity, PtzOp, PtzPreset, ReolinkDeviceSettings, ReolinkSettings, TestResult } from '@home-hub/shared';
import { HttpError, notFound, unavailable } from '../http/errors.ts';
import { describeError, DeviceHttp, DeviceHttpError } from '../util/http.ts';
import { Mutex, Poller } from '../util/poller.ts';
import { streamName, type StreamSpec } from './media.ts';
import type { Integration, IntegrationDeps } from './types.ts';

/**
 * Reolink cameras / NVR channels: local HTTP API for state and control, RTSP
 * or FLV (through go2rtc) for video.
 *
 * `cameraId` is always the configured device id (the entity id is `cam:<cameraId>`).
 *
 * What shapes this code (Reolink "Camera HTTP API User Guide" v8 and reolink_aio):
 * - Sessions are scarce on a camera. One token per device is kept, renewed
 *   shortly before its lease ends, and logged out when the hub stops.
 * - A camera locks its account after repeated wrong logins, so a refused login
 *   is not repeated for five minutes.
 * - PTZ movements are continuous: the camera turns until it is told to stop.
 *   The hub therefore stops a camera by itself when the app stops asking.
 */

export interface ReolinkTiming {
  /** Keep-alive while an app is open / while nobody is looking. */
  activeMs: number;
  idleMs: number;
  /** Refresh of the spotlight state while an app is open. */
  lightMs: number;
  requestTimeoutMs: number;
  /** Pause after a refused login. */
  blockMs: number;
  /** A movement ends by itself when no PTZ call arrives for this long. */
  ptzHoldMs: number;
  /** Renew the token this long before its lease ends. */
  renewBeforeMs: number;
  snapshotCacheMs: number;
  presetCacheMs: number;
}

export interface ReolinkOptions {
  timing?: Partial<ReolinkTiming>;
}

const DEFAULT_TIMING: ReolinkTiming = {
  activeMs: 60_000,
  idleMs: 5 * 60_000,
  lightMs: 30_000,
  requestTimeoutMs: 8000,
  blockMs: 5 * 60_000,
  ptzHoldMs: 1500,
  renewBeforeMs: 5 * 60_000,
  snapshotCacheMs: 1000,
  presetCacheMs: 60_000,
};

const SERVICE = 'reolink';
const DEFAULT_PTZ_SPEED = 24;

/** `rspCode`s that mean "this token is not valid (any more)": log in again once. */
const TOKEN_ERRORS = new Set([-6, -21]);
/** `rspCode`s that mean "do not try again soon": wrong credentials, locked account, no free session. */
const LOGIN_REFUSALS = new Set([-5, -7, -27, -105, -502, -503, -506, -507]);

const PTZ_COMMANDS: Record<PtzOp, { op: string; needs: 'ptz' | 'zoom' | null }> = {
  left: { op: 'Left', needs: 'ptz' },
  right: { op: 'Right', needs: 'ptz' },
  up: { op: 'Up', needs: 'ptz' },
  down: { op: 'Down', needs: 'ptz' },
  left_up: { op: 'LeftUp', needs: 'ptz' },
  left_down: { op: 'LeftDown', needs: 'ptz' },
  right_up: { op: 'RightUp', needs: 'ptz' },
  right_down: { op: 'RightDown', needs: 'ptz' },
  zoom_in: { op: 'ZoomInc', needs: 'zoom' },
  zoom_out: { op: 'ZoomDec', needs: 'zoom' },
  stop: { op: 'Stop', needs: null },
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const obj = (value: unknown): Json => (isObject(value) ? value : {});
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
/** Ability entries look like `{ "permit": 6, "ver": 1 }`. */
const ver = (value: unknown): number => num(obj(value).ver) ?? 0;

class ReolinkError extends Error {
  constructor(
    message: string,
    readonly kind: 'refused' | 'token' | 'unsupported' | 'api' | 'protocol' | 'scheme',
    readonly rspCode: number | null = null,
  ) {
    super(message);
    this.name = 'ReolinkError';
  }
}

interface Transport {
  https: boolean;
  port: number;
}

function transports(device: Pick<ReolinkDeviceSettings, 'https' | 'port'>): Transport[] {
  // An explicit port is used exactly as configured; otherwise the configured scheme first, then the other
  // one (newer cameras ship with HTTPS only, older ones with HTTP only).
  if (device.port > 0) return [{ https: device.https, port: device.port }];
  return [
    { https: device.https, port: device.https ? 443 : 80 },
    { https: !device.https, port: device.https ? 80 : 443 },
  ];
}

function hostOnly(host: string): string {
  return host.replace(/:\d+$/, '');
}

function httpClient(device: ReolinkDeviceSettings, transport: Transport, timeoutMs: number): DeviceHttp {
  return new DeviceHttp({
    baseUrl: `${transport.https ? 'https' : 'http'}://${hostOnly(device.host)}:${transport.port}`,
    // Cameras only have self-signed certificates. Accepted per device, never globally.
    insecureTls: true,
    authMode: 'none',
    timeoutMs,
    maxSockets: 2,
  });
}

/** Sends a batch of commands and returns the answers in the same order. */
async function post(http: DeviceHttp, token: string | null, commands: Json[], signal?: AbortSignal): Promise<Json[]> {
  const first = str(commands[0]?.cmd);
  const response = await http.request(`/cgi-bin/api.cgi?cmd=${encodeURIComponent(first)}&token=${token ?? 'null'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal,
  });
  // A camera that only speaks HTTPS answers plain HTTP logins with a redirect-like 300.
  if (response.status >= 300 && response.status < 400) throw new ReolinkError('wrong scheme', 'scheme');
  if (response.status !== 200) throw new DeviceHttpError(`Die Kamera antwortete mit HTTP ${response.status}`, 'status', response.status);
  let parsed: unknown;
  try {
    // JSON is served as text/html.
    parsed = JSON.parse(response.body.toString('utf8'));
  } catch {
    throw new ReolinkError('Die Kamera lieferte keine gültige Antwort', 'protocol');
  }
  if (!Array.isArray(parsed)) throw new ReolinkError('Die Kamera lieferte keine gültige Antwort', 'protocol');
  return parsed.filter(isObject);
}

/** Throws for an answer that carries an error; returns its `value` otherwise. */
function valueOf(answer: Json | undefined, cmd: string): Json {
  if (!answer) throw new ReolinkError(`${cmd}: keine Antwort`, 'protocol');
  if (num(answer.code) === 0) return obj(answer.value);
  const error = obj(answer.error);
  const rspCode = num(error.rspCode);
  const detail = str(error.detail) || 'unbekannter Fehler';
  if (rspCode !== null && TOKEN_ERRORS.has(rspCode)) throw new ReolinkError(detail, 'token', rspCode);
  if (rspCode !== null && LOGIN_REFUSALS.has(rspCode)) throw new ReolinkError(detail, 'refused', rspCode);
  if (rspCode === -9 || rspCode === -26) throw new ReolinkError(detail, 'unsupported', rspCode);
  throw new ReolinkError(`${cmd}: ${detail}`, 'api', rspCode);
}

function refusalMessage(rspCode: number | null): string {
  switch (rspCode) {
    case -5:
    case -507:
      return 'An der Kamera sind zu viele Geräte gleichzeitig angemeldet.';
    case -105:
      return 'Die Kamera wehrt gerade zu häufige Anmeldungen ab.';
    case -506:
      return 'Das Konto ist an der Kamera vorübergehend gesperrt.';
    case -503:
      return 'Die Kamera lässt diesen Benutzer nicht zu.';
    default:
      return 'Benutzername oder Passwort stimmen nicht.';
  }
}

async function login(http: DeviceHttp, device: ReolinkDeviceSettings, signal?: AbortSignal): Promise<{ name: string; leaseMs: number }> {
  const answers = await post(http, null, [{ cmd: 'Login', action: 0, param: { User: { Version: '0', userName: device.username, password: device.password } } }], signal);
  const token = obj(valueOf(answers[0], 'Login').Token);
  const name = str(token.name);
  if (!name) throw new ReolinkError('Login ohne Token', 'protocol');
  return { name, leaseMs: Math.max(60, num(token.leaseTime) ?? 3600) * 1000 };
}

async function logout(http: DeviceHttp, token: string): Promise<void> {
  // Never without a token: an anonymous Logout is counted as a failed request by some firmwares.
  await post(http, token, [{ cmd: 'Logout', action: 0, param: {} }]).catch(() => {});
}

interface Abilities {
  features: CameraEntity['features'];
  /** `ptzType.ver`: 2 and 3 accept a speed. */
  ptzType: number;
}

function readAbilities(ability: Json, channel: number): Abilities {
  const chn = obj((Array.isArray(ability.abilityChn) ? ability.abilityChn : [])[channel]);
  const ptzType = ver(chn.ptzType);
  return {
    ptzType,
    features: {
      ptz: [2, 3, 5, 6, 7].includes(ptzType),
      zoom: [1, 2, 5].includes(ptzType),
      presets: ver(chn.ptzPreset) > 0,
      // Says that the camera has a speaker. Whether talking works through the hub depends on the
      // camera offering an RTSP back channel.
      talk: ver(ability.talk) > 0 || ver(chn.talk) > 0,
      audio: true,
      light: ver(chn.floodLight) > 0 || ver(chn.supportFLswitch) > 0,
      siren: ver(chn.alarmAudio) > 0 || ver(chn.supportAudioAlarm) > 0,
    },
  };
}

const NO_FEATURES: CameraEntity['features'] = { ptz: false, zoom: false, presets: false, talk: false, audio: true, light: false, siren: false };

function isImage(data: Buffer): boolean {
  return data.length > 3 && ((data[0] === 0xff && data[1] === 0xd8) || (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47));
}

/** Percent-encodes everything that could end the user-info part of a URL — including what `encodeURIComponent` leaves alone. */
function encodeUserInfo(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

// --- One camera -------------------------------------------------------------------------------------

class Camera {
  readonly id: string;
  private http: DeviceHttp | null = null;
  private transport: Transport | null = null;
  private token: { name: string; expiresAt: number } | null = null;
  private readonly session = new Mutex();
  private readonly poller: Poller;
  private stopped = false;
  private active = false;

  private info: { model: string | null; firmware: string | null; nvr: boolean } | null = null;
  private abilities: Abilities | null = null;
  private codecs: { main: string | null; sub: string | null } = { main: null, sub: null };
  private lightOn: boolean | null = null;
  private channelOnline = true;
  reachable = false;
  private failures = 0;
  private blockedUntil = 0;
  problem: string | null = null;
  private lastError: string | null = null;

  private moving: { op: string; timer: NodeJS.Timeout } | null = null;
  private snap: { at: number; data: Buffer } | null = null;
  private snapInFlight: Promise<Buffer> | null = null;
  private presetCache: { at: number; list: PtzPreset[] } | null = null;

  constructor(
    private readonly deps: IntegrationDeps,
    readonly device: ReolinkDeviceSettings,
    private readonly timing: ReolinkTiming,
    private readonly changed: () => void,
  ) {
    this.id = device.id;
    this.poller = new Poller(
      (signal) => this.tick(signal),
      () => this.interval(),
      (err) => this.failed(err),
      5 * 60_000,
    );
  }

  start(): void {
    this.poller.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.poller.stop();
    if (this.moving) {
      clearTimeout(this.moving.timer);
      this.moving = null;
      // Never leave a camera turning.
      await this.call([{ cmd: 'PtzCtrl', action: 0, param: { channel: this.device.channel, op: 'Stop' } }]).catch(() => {});
    }
    await this.session.run(async () => {
      if (this.http && this.token) await logout(this.http, this.token.name);
      this.token = null;
    });
    this.http?.destroy();
    this.http = null;
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active) this.poller.kick();
  }

  private interval(): number {
    const blocked = this.blockedUntil - Date.now();
    if (blocked > 0) return blocked;
    if (!this.active) return this.timing.idleMs;
    return this.abilities?.features.light ? Math.min(this.timing.lightMs, this.timing.activeMs) : this.timing.activeMs;
  }

  entity(): CameraEntity {
    return {
      id: `cam:${this.id}`,
      kind: 'camera',
      name: this.device.name,
      room: this.device.room.trim() || null,
      available: this.reachable && this.channelOnline,
      service: SERVICE,
      model: this.info?.model ?? null,
      features: this.abilities?.features ?? NO_FEATURES,
      lightOn: this.abilities?.features.light ? this.lightOn : null,
    };
  }

  diagnostics(): unknown {
    return {
      id: this.id,
      name: this.device.name,
      reachable: this.reachable,
      transport: this.transport ? `${this.transport.https ? 'https' : 'http'}:${this.transport.port}` : null,
      model: this.info?.model ?? null,
      firmware: this.info?.firmware ?? null,
      recorder: this.info?.nvr ?? false,
      channel: this.device.channel,
      channelOnline: this.channelOnline,
      features: this.abilities?.features ?? null,
      codecs: this.codecs,
      streamProtocol: this.device.streamProtocol,
      tokenLeaseRemainingSec: this.token ? Math.max(0, Math.round((this.token.expiresAt - Date.now()) / 1000)) : null,
      pausedUntil: this.blockedUntil > Date.now() ? new Date(this.blockedUntil).toISOString() : null,
      lastError: this.lastError,
    };
  }

  // --- Session ----------------------------------------------------------------------------------

  /** A valid token on a working transport. Single flight; never logs in while a refusal is fresh. */
  private ensureSession(signal?: AbortSignal): Promise<{ http: DeviceHttp; token: string }> {
    return this.session.run(async () => {
      const now = Date.now();
      if (this.http && this.token && this.token.expiresAt - now > this.timing.renewBeforeMs) return { http: this.http, token: this.token.name };
      if (now < this.blockedUntil) throw new ReolinkError(this.problem ?? 'Anmeldung pausiert', 'refused');

      const candidates = this.transport ? [this.transport] : transports(this.device);
      let lastErr: unknown = new ReolinkError('Kamera nicht erreichbar', 'protocol');
      for (const candidate of candidates) {
        const http = this.http && this.transport === candidate ? this.http : httpClient(this.device, candidate, this.timing.requestTimeoutMs);
        try {
          const granted = await login(http, this.device, signal);
          const previous = this.http && this.token ? { http: this.http, token: this.token.name } : null;
          if (this.http && this.http !== http) this.http.destroy();
          this.http = http;
          this.transport = candidate;
          this.token = { name: granted.name, expiresAt: Date.now() + granted.leaseMs };
          // The renewed lease replaces the old session instead of adding to it.
          if (previous && previous.http === http) void logout(http, previous.token);
          return { http, token: granted.name };
        } catch (err) {
          if (http !== this.http) http.destroy();
          lastErr = err;
          // A refusal is an answer: the other scheme would only produce a second failed login.
          if (err instanceof ReolinkError && err.kind === 'refused') {
            this.blockedUntil = Date.now() + this.timing.blockMs;
            this.token = null;
            throw err;
          }
        }
      }
      // Nothing answered: forget the transport so both schemes are tried again next time.
      this.token = null;
      this.transport = null;
      throw lastErr;
    });
  }

  /** Runs commands with the session token; logs in again once when the camera no longer knows the token. */
  private async call(commands: Json[], signal?: AbortSignal): Promise<Json[]> {
    for (let attempt = 0; ; attempt++) {
      const { http, token } = await this.ensureSession(signal);
      const answers = await post(http, token, commands, signal);
      const tokenProblem = answers.some((answer) => {
        const rspCode = num(obj(answer.error).rspCode);
        return rspCode !== null && TOKEN_ERRORS.has(rspCode);
      });
      if (!tokenProblem || attempt > 0) return answers;
      await this.session.run(async () => {
        if (this.token?.name === token) this.token = null;
      });
    }
  }

  // --- Polling ----------------------------------------------------------------------------------

  private async tick(signal: AbortSignal): Promise<void> {
    if (this.stopped) return;
    const channel = this.device.channel;
    if (!this.info || !this.abilities) {
      const answers = await this.call(
        [
          { cmd: 'GetDevInfo', action: 0, param: {} },
          { cmd: 'GetAbility', action: 0, param: { User: { userName: this.device.username } } },
          { cmd: 'GetEnc', action: 0, param: { channel } },
        ],
        signal,
      );
      const dev = obj(valueOf(answers[0], 'GetDevInfo').DevInfo);
      const type = `${str(dev.type)} ${str(dev.exactType)}`.toUpperCase();
      this.info = { model: str(dev.model) || null, firmware: str(dev.firmVer) || null, nvr: /\b(NVR|WIFI_NVR|HOMEHUB)\b/.test(type) };
      this.abilities = readAbilities(obj(valueOf(answers[1], 'GetAbility').Ability), channel);
      try {
        const enc = obj(valueOf(answers[2], 'GetEnc').Enc);
        this.codecs = { main: str(obj(enc.mainStream).vType) || null, sub: str(obj(enc.subStream).vType) || null };
      } catch {
        // Informational only (shown in diagnostics and the connection test).
      }
      this.deps.log.info({ camera: this.id, model: this.info.model, firmware: this.info.firmware, transport: this.transport?.https ? 'https' : 'http' }, 'camera connected');
    }

    const commands: Json[] = [];
    if (this.abilities.features.light) commands.push({ cmd: 'GetWhiteLed', action: 0, param: { channel } });
    if (this.info.nvr) commands.push({ cmd: 'GetChannelstatus', action: 0, param: {} });
    // Something cheap, so every round proves that the camera and the token are alive.
    if (commands.length === 0) commands.push({ cmd: 'GetDevInfo', action: 0, param: {} });
    const answers = await this.call(commands, signal);
    for (const answer of answers) {
      const cmd = str(answer.cmd);
      if (cmd === 'GetWhiteLed') {
        try {
          const state = num(obj(valueOf(answer, cmd).WhiteLed).state);
          if (state !== null) this.lightOn = state !== 0;
        } catch (err) {
          if (err instanceof ReolinkError && err.kind === 'token') throw err;
        }
      } else if (cmd === 'GetChannelstatus') {
        const status = (Array.isArray(obj(valueOf(answer, cmd)).status) ? (obj(answer.value).status as unknown[]) : []).filter(isObject);
        const mine = status.find((entry) => num(entry.channel) === channel);
        this.channelOnline = mine ? num(mine.online) !== 0 : true;
      } else {
        valueOf(answer, cmd);
      }
    }

    this.failures = 0;
    this.blockedUntil = 0;
    this.lastError = null;
    const problem = this.info.nvr && !this.channelOnline ? 'Die Kamera ist am Rekorder nicht angemeldet.' : null;
    const wasFine = this.reachable && this.problem === problem;
    this.reachable = true;
    this.problem = problem;
    if (!wasFine) this.deps.log.debug({ camera: this.id }, 'camera reachable');
    this.changed();
  }

  private failed(err: unknown): void {
    if (this.stopped) return;
    this.lastError = describeError(err);
    const refused = err instanceof ReolinkError && err.kind === 'refused';
    this.failures++;
    // One hiccup is not an outage — except a refused login, which will not get better by itself.
    if (refused || this.failures >= 2) {
      const was = this.reachable;
      this.reachable = false;
      this.problem = refused ? refusalMessage(err.rspCode) : 'nicht erreichbar';
      if (was || refused) this.deps.log.warn({ camera: this.id, reason: this.lastError }, 'camera unavailable');
      // Start from scratch when it returns (a camera may come back with other abilities after an update).
      if (!refused) {
        this.info = null;
        this.abilities = null;
      }
    }
    this.changed();
  }

  private assertReachable(): void {
    if (!this.reachable) throw unavailable(`Die Kamera „${this.device.name}“ ist gerade nicht erreichbar.`);
  }

  /** For user actions: a German error instead of whatever went wrong underneath. */
  private async act(commands: Json[], what: string): Promise<Json[]> {
    this.assertReachable();
    try {
      const answers = await this.call(commands);
      answers.forEach((answer, index) => valueOf(answer, str(commands[index]?.cmd)));
      return answers;
    } catch (err) {
      this.lastError = describeError(err);
      if (err instanceof ReolinkError && err.kind === 'unsupported') throw new HttpError(400, 'unsupported', `Das unterstützt die Kamera „${this.device.name}“ nicht.`);
      if (err instanceof ReolinkError && err.kind === 'api') throw new HttpError(502, 'device_error', `Die Kamera „${this.device.name}“ hat das abgelehnt (${what}).`);
      throw unavailable(`Die Kamera „${this.device.name}“ antwortet gerade nicht.`);
    }
  }

  // --- Operations --------------------------------------------------------------------------------

  snapshot(): Promise<Buffer> {
    if (this.snap && Date.now() - this.snap.at < this.timing.snapshotCacheMs) return Promise.resolve(this.snap.data);
    if (this.snapInFlight) return this.snapInFlight;
    this.assertReachable();
    const load = async (): Promise<Buffer> => {
      for (let attempt = 0; ; attempt++) {
        const { http, token } = await this.ensureSession();
        const path = `/cgi-bin/api.cgi?cmd=Snap&channel=${this.device.channel}&rs=${randomBytes(8).toString('hex')}&token=${token}`;
        const response = await http.request(path, { timeoutMs: Math.max(this.timing.requestTimeoutMs, 10_000), maxBytes: 12 * 1024 * 1024 });
        if (response.status === 200 && isImage(response.body)) return response.body;
        // Errors arrive as JSON (served as text/html), e.g. "please login first".
        let rspCode: number | null = null;
        try {
          const parsed: unknown = JSON.parse(response.body.toString('utf8'));
          rspCode = num(obj(obj(Array.isArray(parsed) ? parsed[0] : parsed).error).rspCode);
        } catch {
          /* not JSON either */
        }
        if (rspCode !== null && TOKEN_ERRORS.has(rspCode) && attempt === 0) {
          await this.session.run(async () => {
            if (this.token?.name === token) this.token = null;
          });
          continue;
        }
        throw new ReolinkError('Die Kamera lieferte kein Bild', 'api', rspCode);
      }
    };
    this.snapInFlight = load()
      .then(
        (data) => {
          this.snap = { at: Date.now(), data };
          return data;
        },
        (err: unknown) => {
          this.lastError = describeError(err);
          throw unavailable(`Die Kamera „${this.device.name}“ liefert gerade kein Bild.`);
        },
      )
      .finally(() => {
        this.snapInFlight = null;
      });
    return this.snapInFlight;
  }

  async ptz(op: PtzOp, speed?: number): Promise<void> {
    const command = PTZ_COMMANDS[op];
    const features = this.abilities?.features ?? NO_FEATURES;
    if (command.needs === 'ptz' && !features.ptz) throw new HttpError(400, 'unsupported', `Die Kamera „${this.device.name}“ lässt sich nicht schwenken.`);
    if (command.needs === 'zoom' && !features.zoom) throw new HttpError(400, 'unsupported', `Die Kamera „${this.device.name}“ hat keinen Zoom.`);

    if (op === 'stop') {
      if (this.moving) clearTimeout(this.moving.timer);
      this.moving = null;
      await this.act([{ cmd: 'PtzCtrl', action: 0, param: { channel: this.device.channel, op: 'Stop' } }], 'Stopp');
      return;
    }

    const arm = (): NodeJS.Timeout => {
      const timer = setTimeout(() => {
        // The app went quiet (closed, lost its connection): the camera must not keep turning.
        this.moving = null;
        void this.call([{ cmd: 'PtzCtrl', action: 0, param: { channel: this.device.channel, op: 'Stop' } }]).catch(() => {});
      }, this.timing.ptzHoldMs);
      timer.unref();
      return timer;
    };

    if (this.moving?.op === command.op) {
      // Same movement, held: only keep the dead-man switch alive, the camera is already turning.
      clearTimeout(this.moving.timer);
      this.moving.timer = arm();
      return;
    }
    if (this.moving) clearTimeout(this.moving.timer);
    this.moving = { op: command.op, timer: arm() };
    const param: Json = { channel: this.device.channel, op: command.op };
    // Only these PTZ types take a speed; others reject the command when one is sent.
    if (this.abilities && [2, 3].includes(this.abilities.ptzType)) param.speed = Math.min(64, Math.max(1, Math.round(speed ?? DEFAULT_PTZ_SPEED)));
    try {
      await this.act([{ cmd: 'PtzCtrl', action: 0, param }], 'Bewegung');
    } catch (err) {
      if (this.moving?.op === command.op) {
        clearTimeout(this.moving.timer);
        this.moving = null;
      }
      throw err;
    }
  }

  async presets(): Promise<PtzPreset[]> {
    if (!this.abilities?.features.presets) return [];
    if (this.presetCache && Date.now() - this.presetCache.at < this.timing.presetCacheMs) return this.presetCache.list;
    const answers = await this.act([{ cmd: 'GetPtzPreset', action: 0, param: { channel: this.device.channel } }], 'Positionen');
    const raw = obj(answers[0]?.value).PtzPreset;
    const list = (Array.isArray(raw) ? raw : [])
      .filter(isObject)
      .filter((preset) => num(preset.enable) === 1 && num(preset.id) !== null)
      .map((preset) => ({ id: num(preset.id)!, name: str(preset.name).trim() || `Position ${num(preset.id)}` }));
    this.presetCache = { at: Date.now(), list };
    return list;
  }

  async gotoPreset(presetId: number): Promise<void> {
    if (!this.abilities?.features.presets) throw new HttpError(400, 'unsupported', `Die Kamera „${this.device.name}“ hat keine gespeicherten Positionen.`);
    if (this.moving) clearTimeout(this.moving.timer);
    this.moving = null;
    await this.act([{ cmd: 'PtzCtrl', action: 0, param: { channel: this.device.channel, op: 'ToPos', id: presetId, speed: 32 } }], 'Position anfahren');
  }

  async setLight(on: boolean): Promise<void> {
    if (!this.abilities?.features.light) throw new HttpError(400, 'unsupported', `Die Kamera „${this.device.name}“ hat kein Licht.`);
    const channel = this.device.channel;
    const current = obj(obj((await this.act([{ cmd: 'GetWhiteLed', action: 0, param: { channel } }], 'Licht'))[0]?.value).WhiteLed);
    // Mode and brightness go back exactly as read: the camera's own schedule/automatic stays as the owner set it.
    const next: Json = { channel, state: on ? 1 : 0 };
    if (num(current.mode) !== null) next.mode = current.mode;
    if (num(current.bright) !== null) next.bright = current.bright;
    await this.act([{ cmd: 'SetWhiteLed', param: { WhiteLed: next } }], 'Licht');
    this.lightOn = on;
    this.changed();
    this.poller.kick(2500);
  }

  async siren(): Promise<void> {
    if (!this.abilities?.features.siren) throw new HttpError(400, 'unsupported', `Die Kamera „${this.device.name}“ hat keine Sirene.`);
    await this.act([{ cmd: 'AudioAlarmPlay', action: 0, param: { alarm_mode: 'times', times: 1, channel: this.device.channel } }], 'Sirene');
  }
}

// --- The integration ---------------------------------------------------------------------------------

export class ReolinkIntegration implements Integration {
  private readonly cameras = new Map<string, Camera>();
  private readonly timing: ReolinkTiming;
  private stopped = false;

  constructor(
    protected readonly deps: IntegrationDeps,
    protected readonly settings: ReolinkSettings,
    options: ReolinkOptions = {},
  ) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    for (const device of settings.devices) {
      if (!this.cameras.has(device.id)) this.cameras.set(device.id, new Camera(deps, device, this.timing, () => this.publish()));
    }
  }

  start(): void {
    this.stopped = false;
    this.publish();
    for (const camera of this.cameras.values()) camera.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.cameras.values()].map((camera) => camera.stop()));
  }

  setActive(active: boolean): void {
    for (const camera of this.cameras.values()) camera.setActive(active);
  }

  diagnostics(): unknown {
    return { cameras: [...this.cameras.values()].map((camera) => camera.diagnostics()) };
  }

  /** Entities and the combined health of all cameras. Cameras are independent of each other. */
  private publish(): void {
    if (this.stopped) return;
    const cameras = [...this.cameras.values()];
    this.deps.state.replace(
      SERVICE,
      cameras.map((camera) => camera.entity()),
    );
    if (cameras.length === 0) {
      this.deps.state.setService(SERVICE, 'unconfigured', 'Es ist noch keine Kamera eingetragen.');
      return;
    }
    const troubled = cameras.filter((camera) => !camera.reachable || camera.problem);
    const settled = cameras.filter((camera) => camera.reachable || camera.problem);
    if (troubled.length === 0) this.deps.state.setService(SERVICE, 'ok', null);
    else if (settled.length < cameras.length && troubled.every((camera) => !camera.problem)) this.deps.state.setService(SERVICE, 'starting', null);
    else {
      const text = troubled
        .filter((camera) => camera.problem)
        .map((camera) => `${camera.device.name}: ${camera.problem}`)
        .join(' · ');
      const anyFine = cameras.some((camera) => camera.reachable);
      this.deps.state.setService(SERVICE, anyFine ? 'degraded' : 'offline', text || null);
    }
  }

  private camera(cameraId: string): Camera {
    const camera = this.cameras.get(cameraId);
    if (!camera) throw notFound('Diese Kamera gibt es nicht (mehr).');
    return camera;
  }

  /**
   * go2rtc streams of all cameras (names via `streamName('cam', id, …)`):
   *   `cam_<id>_main`  full resolution (may be H.265)
   *   `cam_<id>_sub`   low resolution H.264, used for tiles and as fallback
   *   `cam_<id>_talk`  talk channel (browser microphone → camera speaker), RTSP back channel
   *
   * Why three: in go2rtc a bare `rtsp://` source opens the camera's back channel
   * (speaker) together with the video, and an always-open back channel can block
   * the speaker for everything else. So the viewing streams switch it off
   * (`#backchannel=0`) and talking uses its own stream that only exists while
   * somebody talks. The cameras' audio is AAC, which WebRTC cannot carry — hence
   * the second source that transcodes the audio to Opus on demand.
   */
  streams(): StreamSpec[] {
    const specs: StreamSpec[] = [];
    for (const { device } of this.cameras.values()) {
      const host = hostOnly(device.host);
      const user = encodeUserInfo(device.username);
      const password = encodeUserInfo(device.password);
      // `Preview_01_main` is channel 0.
      const nn = String(device.channel + 1).padStart(2, '0');
      const rtsp = (quality: 'main' | 'sub') => `rtsp://${user}:${password}@${host}:${device.rtspPort}/Preview_${nn}_${quality}`;
      for (const quality of ['main', 'sub'] as const) {
        const name = streamName('cam', device.id, quality);
        let source: string;
        if (device.streamProtocol === 'flv') {
          // The camera does not percent-decode these values, so they are written as they are; only what
          // would break the URL itself is escaped.
          const raw = (text: string) => text.replace(/[%&#\s]/g, (char) => encodeURIComponent(char));
          const port = device.port > 0 ? `:${device.port}` : '';
          // `httpx` is go2rtc's "https without certificate check" (cameras are self-signed).
          source = `${device.https ? 'httpx' : 'http'}://${host}${port}/flv?port=1935&app=bcs&stream=channel${device.channel}_${quality}.bcs&user=${raw(device.username)}&password=${raw(device.password)}`;
        } else {
          source = `${rtsp(quality)}#backchannel=0`;
        }
        specs.push({ name, sources: [source, `ffmpeg:${name}#audio=opus`] });
      }
      // No `#…` suffix and no `ffmpeg:` wrapper: either would switch the back channel off.
      specs.push({ name: streamName('cam', device.id, 'talk'), sources: [rtsp('sub')] });
    }
    return specs;
  }

  /** Current JPEG. Throws `HttpError` when the camera is unknown or unreachable. */
  async snapshot(cameraId: string): Promise<Buffer> {
    return this.camera(cameraId).snapshot();
  }

  /**
   * Continuous pan/tilt/zoom. The movement keeps going only while this is
   * called again at least once per second; otherwise the hub stops the camera
   * by itself (so a lost "stop" can never leave it spinning). `stop` halts at once.
   */
  async ptz(cameraId: string, op: PtzOp, speed?: number): Promise<void> {
    await this.camera(cameraId).ptz(op, speed);
  }

  async presets(cameraId: string): Promise<PtzPreset[]> {
    return this.camera(cameraId).presets();
  }

  async gotoPreset(cameraId: string, presetId: number): Promise<void> {
    await this.camera(cameraId).gotoPreset(presetId);
  }

  /** Spotlight on/off. */
  async setLight(cameraId: string, on: boolean): Promise<void> {
    await this.camera(cameraId).setLight(on);
  }

  /** Sounds the siren once. */
  async siren(cameraId: string): Promise<void> {
    await this.camera(cameraId).siren();
  }

  /** Connection test for one (possibly unsaved) device. Never throws. */
  static async test(device: ReolinkDeviceSettings, options: ReolinkOptions = {}): Promise<TestResult> {
    const timeoutMs = options.timing?.requestTimeoutMs ?? DEFAULT_TIMING.requestTimeoutMs;
    const tried: string[] = [];
    try {
      for (const transport of transports(device)) {
        const label = `${transport.https ? 'HTTPS' : 'HTTP'} (Port ${transport.port})`;
        const http = httpClient(device, transport, timeoutMs);
        try {
          let token: string;
          try {
            token = (await login(http, device)).name;
          } catch (err) {
            if (err instanceof ReolinkError && err.kind === 'refused') {
              return { ok: false, message: refusalMessage(err.rspCode), details: [`Die Kamera ist über ${label} erreichbar, hat die Anmeldung aber abgelehnt.`, 'Bitte Benutzername und Passwort prüfen – nach mehreren Fehlversuchen sperrt die Kamera das Konto für einige Minuten.'] };
            }
            tried.push(`${label}: ${err instanceof ReolinkError && err.kind === 'scheme' ? 'die Kamera verlangt die andere Verbindungsart' : describeError(err)}`);
            continue;
          }
          try {
            const answers = await post(http, token, [
              { cmd: 'GetDevInfo', action: 0, param: {} },
              { cmd: 'GetAbility', action: 0, param: { User: { userName: device.username } } },
              { cmd: 'GetEnc', action: 0, param: { channel: device.channel } },
            ]);
            const dev = obj(valueOf(answers[0], 'GetDevInfo').DevInfo);
            const abilities = readAbilities(obj(valueOf(answers[1], 'GetAbility').Ability), device.channel);
            let codecs = '';
            try {
              const enc = obj(valueOf(answers[2], 'GetEnc').Enc);
              const main = str(obj(enc.mainStream).vType);
              const sub = str(obj(enc.subStream).vType);
              codecs = [main && `HD: ${main.toUpperCase()}`, sub && `SD: ${sub.toUpperCase()}`].filter(Boolean).join(', ');
            } catch {
              /* optional */
            }
            const f = abilities.features;
            const can = [f.ptz && 'Schwenken/Neigen', f.zoom && 'Zoom', f.presets && 'gespeicherte Positionen', f.light && 'Licht', f.siren && 'Sirene', f.talk && 'Lautsprecher (Gegensprechen)'].filter(Boolean);
            const details = [
              `Verbindung: ${label}${transport.https ? '' : ' – unverschlüsselt im Heimnetz'}`,
              `Funktionen: ${can.length > 0 ? can.join(', ') : 'Live-Bild'}`,
            ];
            if (codecs) details.push(`Video: ${codecs}`);
            if (/h265|hevc/i.test(codecs)) details.push('Hinweis: H.265 kann nicht jeder Browser anzeigen – die App weicht dann auf die SD-Ansicht aus.');
            if (device.streamProtocol === 'rtsp') details.push(`Für das Live-Bild muss an der Kamera zusätzlich „RTSP“ (Port ${device.rtspPort}) eingeschaltet sein.`);
            const model = str(dev.model) || 'Reolink-Kamera';
            const firmware = str(dev.firmVer);
            return { ok: true, message: `${model} gefunden${firmware ? ` (Firmware ${firmware})` : ''}.`, details };
          } finally {
            await logout(http, token);
          }
        } finally {
          http.destroy();
        }
      }
      return {
        ok: false,
        message: 'Die Kamera ist unter dieser Adresse nicht erreichbar.',
        details: [...tried, 'Stimmt die Adresse? In den Netzwerk-Einstellungen der Kamera muss „HTTPS“ oder „HTTP“ eingeschaltet sein.'],
      };
    } catch (err) {
      return { ok: false, message: 'Der Test konnte nicht abgeschlossen werden.', details: [...tried, describeError(err)] };
    }
  }
}
