import { XMLParser } from 'fast-xml-parser';
import type { CameraEntity, PtzOp, PtzPreset, ReolinkDeviceSettings, TestResult } from '@home-hub/shared';
import { HttpError, unavailable } from '../../http/errors.ts';
import { describeError, DeviceHttp, DeviceHttpError, type DeviceResponse } from '../../util/http.ts';
import { Poller } from '../../util/poller.ts';
import { streamName } from '../media.ts';
import type { IntegrationDeps } from '../types.ts';
import { encodeUserInfo, grabFrame, isJpeg } from './onvif-camera.ts';
import { isXml, list, node, text, type Xml } from './onvif.ts';
import { describeRtsp, RtspError, type RtspDescription } from './rtsp.ts';

/**
 * Hikvision cameras — and cameras on a Hikvision recorder — through ISAPI, the
 * camera's own HTTP interface, and RTSP for the video:
 *
 * - live picture and sound, pan/tilt/zoom (also the motorised lens of fixed
 *   cameras), stored positions, still pictures straight from the camera;
 * - talking through go2rtc's ISAPI back channel, when the camera has a
 *   two-way audio channel with G.711 (the only codec that path carries);
 * - no spotlight or siren: the white light of ColorVu cameras only shines
 *   when it is dark and cannot be switched on at will, and deterrence
 *   (strobe, siren) differs from model to model.
 *
 * What shapes this code:
 * - ISAPI authenticates every request with HTTP Digest (Basic on old
 *   firmwares); there is no session to keep.
 * - Hikvision locks logins from an address after a few wrong passwords
 *   ("illegal login lock", 30 minutes by default) — which also stops the
 *   video. So a refused login is not repeated soon, the pause doubles with
 *   every further refusal, and a lock reported by the camera is waited out.
 * - Channel numbers: camera 1 on a stand-alone camera; D1…Dn on a recorder,
 *   whose cameras are reached through its proxy paths. Streams are numbered
 *   `<channel>01` (main) and `<channel>02` (sub).
 */

export interface HikvisionTiming {
  activeMs: number;
  idleMs: number;
  requestTimeoutMs: number;
  /** First pause after a refused login; it doubles with each further refusal (at most an hour). */
  blockMs: number;
  ptzHoldMs: number;
  snapshotCacheMs: number;
  presetCacheMs: number;
}

const SERVICE = 'reolink';
const NO_FEATURES: CameraEntity['features'] = { ptz: false, zoom: false, presets: false, talk: false, audio: true, light: false, siren: false };
const MAX_BLOCK_MS = 60 * 60_000;
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

/** Pan/tilt directions (pan: right positive, tilt: up positive). */
const DIRECTIONS: Partial<Record<PtzOp, { pan: number; tilt: number }>> = {
  left: { pan: -1, tilt: 0 },
  right: { pan: 1, tilt: 0 },
  up: { pan: 0, tilt: 1 },
  down: { pan: 0, tilt: -1 },
  left_up: { pan: -1, tilt: 1 },
  left_down: { pan: -1, tilt: -1 },
  right_up: { pan: 1, tilt: 1 },
  right_down: { pan: 1, tilt: -1 },
};

export class IsapiError extends Error {
  constructor(
    message: string,
    /**
     * `auth`: wrong user name or password. `locked`: the camera locked logins from the hub.
     * `forbidden`: the user lacks the right. `unsupported`: the camera does not have this.
     * `device`: it refused the request. `protocol`: unreadable answer. `paused`: the hub waits out a refusal.
     */
    readonly kind: 'auth' | 'locked' | 'forbidden' | 'unsupported' | 'device' | 'protocol' | 'paused',
    readonly unlockInMs: number | null = null,
  ) {
    super(message);
    this.name = 'IsapiError';
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: false,
});

function parse(body: Buffer): Xml | null {
  const raw = body.toString('utf8').trim();
  if (!raw.startsWith('<')) return null;
  try {
    const parsed: unknown = parser.parse(raw);
    return isXml(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The app's speed (1…64, like the Reolink API) as a Hikvision speed (1…100). */
export function hikSpeed(speed: number | undefined): number {
  if (speed === undefined || !Number.isFinite(speed)) return 50;
  return Math.round(Math.min(100, Math.max(10, (speed / 64) * 100)));
}

/** Camera number on the device: 1 for a stand-alone camera, D1… on a recorder (the setting counts from 0). */
export function hikChannel(device: Pick<ReolinkDeviceSettings, 'channel'>): number {
  return device.channel + 1;
}

/** Stream id: `101` main and `102` sub stream of camera 1, `201`/`202` of D2 on a recorder. */
export function hikStreamId(device: Pick<ReolinkDeviceSettings, 'channel'>, quality: 'main' | 'sub'): string {
  return `${hikChannel(device)}${quality === 'main' ? '01' : '02'}`;
}

function hostOnly(host: string): string {
  return host.replace(/:\d+$/, '');
}

export function hikRtspPath(device: Pick<ReolinkDeviceSettings, 'channel'>, quality: 'main' | 'sub'): string {
  return `/Streaming/Channels/${hikStreamId(device, quality)}`;
}

export function hikRtspUrl(device: ReolinkDeviceSettings, quality: 'main' | 'sub'): string {
  return `rtsp://${encodeUserInfo(device.username)}:${encodeUserInfo(device.password)}@${hostOnly(device.host)}:${device.rtspPort}${hikRtspPath(device, quality)}`;
}

/** go2rtc's ISAPI back channel (talking). It only speaks plain HTTP. */
export function hikTalkUrl(device: ReolinkDeviceSettings): string {
  const port = !device.https && device.port > 0 ? device.port : 80;
  return `isapi://${encodeUserInfo(device.username)}:${encodeUserInfo(device.password)}@${hostOnly(device.host)}:${port}/`;
}

/** Lock messages: "for about 25 minutes". */
function lockedMessage(unlockInMs: number | null): string {
  const minutes = unlockInMs ? Math.max(1, Math.ceil(unlockInMs / 60_000)) : null;
  return minutes ? `Die Kamera hat die Anmeldung des Hubs wegen falscher Passwörter für etwa ${minutes} Minute${minutes === 1 ? '' : 'n'} gesperrt.` : 'Die Kamera hat die Anmeldung des Hubs wegen falscher Passwörter vorübergehend gesperrt.';
}

function authError(body: Buffer): IsapiError {
  const check = node(parse(body)?.userCheck);
  if (/^lock/i.test(text(check.lockStatus))) {
    const seconds = Number(text(check.unlockTime));
    const unlockInMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
    return new IsapiError(lockedMessage(unlockInMs), 'locked', unlockInMs);
  }
  return new IsapiError('Benutzername oder Passwort stimmen nicht.', 'auth');
}

interface Transport {
  https: boolean;
  port: number;
}

function transports(device: Pick<ReolinkDeviceSettings, 'https' | 'port'>): Transport[] {
  // An explicit port is used exactly as configured; otherwise the configured scheme first, then the other one.
  if (device.port > 0) return [{ https: device.https, port: device.port }];
  return [
    { https: device.https, port: device.https ? 443 : 80 },
    { https: !device.https, port: device.https ? 80 : 443 },
  ];
}

const transportLabel = (transport: Transport) => `${transport.https ? 'HTTPS' : 'HTTP'} (Port ${transport.port})`;

/** ISAPI over the first scheme that answers. Requests are independent; Digest needs no session. */
class Isapi {
  private http: DeviceHttp | null = null;
  transport: Transport | null = null;
  /** What was tried before a scheme answered (for the connection test). */
  readonly tried: string[] = [];

  constructor(
    private readonly device: ReolinkDeviceSettings,
    private readonly timeoutMs: number,
  ) {}

  private client(transport: Transport): DeviceHttp {
    return new DeviceHttp({
      baseUrl: `${transport.https ? 'https' : 'http'}://${hostOnly(this.device.host)}:${transport.port}`,
      auth: { username: this.device.username, password: this.device.password },
      authMode: 'auto',
      // Cameras only have self-signed certificates. Accepted per device, never globally.
      insecureTls: true,
      timeoutMs: this.timeoutMs,
      maxSockets: 2,
    });
  }

  async request(method: string, path: string, options: { body?: string; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {}): Promise<DeviceResponse> {
    const send = (http: DeviceHttp) =>
      http.request(path, {
        method,
        body: options.body,
        headers: options.body !== undefined ? { 'Content-Type': 'application/xml; charset=UTF-8' } : undefined,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        maxBytes: options.maxBytes,
      });
    if (this.http) return send(this.http);
    let lastErr: unknown = new DeviceHttpError('Kamera nicht erreichbar', 'network');
    for (const candidate of transports(this.device)) {
      const http = this.client(candidate);
      try {
        const response = await send(http);
        // HTTP that only redirects to HTTPS: the other scheme is the right one.
        if (response.status >= 300 && response.status < 400) {
          this.tried.push(`${transportLabel(candidate)}: leitet nur weiter`);
          http.destroy();
          continue;
        }
        this.http = http;
        this.transport = candidate;
        return response;
      } catch (err) {
        http.destroy();
        lastErr = err;
        this.tried.push(`${transportLabel(candidate)}: ${describeError(err)}`);
        if (err instanceof DeviceHttpError && err.kind === 'aborted') throw err;
      }
    }
    throw lastErr;
  }

  /** A request whose answer is XML; throws `IsapiError` for every refusal. */
  async xml(method: string, path: string, body?: string, signal?: AbortSignal): Promise<Xml> {
    const response = await this.request(method, path, { body, signal });
    if (response.status === 401) throw authError(response.body);
    const parsed = parse(response.body);
    const status = node(parsed?.ResponseStatus);
    const sub = text(status.subStatusCode);
    const code = text(status.statusCode);
    if (response.status >= 200 && response.status < 300) {
      // Some firmwares answer 200 with an error inside.
      if (code && code !== '0' && code !== '1') throw new IsapiError(`${text(status.statusString) || 'Fehler'}${sub ? ` (${sub})` : ''}`, /notSupport/i.test(sub) ? 'unsupported' : 'device');
      if (!parsed && body === undefined) throw new IsapiError('Die Kamera lieferte keine gültige Antwort', 'protocol');
      return parsed ?? {};
    }
    if (parsed?.userCheck) throw authError(response.body);
    if (response.status === 404 || /notSupport|invalidOperation/i.test(sub)) throw new IsapiError('Das unterstützt die Kamera nicht', 'unsupported');
    if (/lowPrivilege|noPermission|privilege/i.test(sub)) throw new IsapiError('Dem Benutzer fehlt an der Kamera das Recht dafür', 'forbidden');
    throw new IsapiError(`${text(status.statusString) || `HTTP ${response.status}`}${sub ? ` (${sub})` : ''}`, 'device');
  }

  forget(): void {
    this.http?.destroy();
    this.http = null;
    this.transport = null;
  }

  destroy(): void {
    this.forget();
  }
}

/** Optional parts: whatever the camera does not have or allow is simply missing. Refused logins still count. */
async function optional<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof IsapiError && err.kind !== 'auth' && err.kind !== 'locked' && err.kind !== 'paused') return null;
    throw err;
  }
}

interface StreamInfo {
  codec: string | null;
  width: number | null;
  height: number | null;
  /** The stream carries sound ("Video&Audio"). */
  audio: boolean;
  audioCodec: string | null;
}

function streamInfo(xml: Xml): StreamInfo {
  const channel = node(xml.StreamingChannel);
  const video = node(channel.Video);
  const audio = node(channel.Audio);
  const count = (value: unknown) => {
    const number = Number(text(value));
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  return {
    codec: text(video.videoCodecType) || null,
    width: count(video.videoResolutionWidth),
    height: count(video.videoResolutionHeight),
    audio: text(audio.enabled) === 'true',
    audioCodec: text(audio.audioCompressionType) || null,
  };
}

interface PtzCaps {
  panTilt: boolean;
  zoom: boolean;
  presets: boolean;
}

function ptzCaps(xml: Xml): PtzCaps {
  const cap = node(xml.PTZChanelCap ?? xml.PTZChannelCap);
  const panTilt = 'ContinuousPanTiltSpace' in cap;
  const zoom = 'ContinuousZoomSpace' in cap;
  const maxPresets = Number(text(cap.maxPresetNum));
  return { panTilt, zoom, presets: panTilt && ((Number.isFinite(maxPresets) && maxPresets > 0) || 'PresetNameCap' in cap) };
}

interface Discovery {
  info: { model: string | null; firmware: string | null; deviceType: string; nvr: boolean };
  ptz: PtzCaps;
  main: StreamInfo | null;
  sub: StreamInfo | null;
  /** Codec of the two-way audio channel; null without one. */
  talkCodec: string | null;
  channelOnline: boolean;
}

const ptzBase = (device: ReolinkDeviceSettings, nvr: boolean) =>
  nvr ? `/ISAPI/ContentMgmt/PTZCtrlProxy/channels/${hikChannel(device)}` : `/ISAPI/PTZCtrl/channels/${hikChannel(device)}`;

/** Whether camera D<n> is connected to the recorder (true when the recorder does not say). */
async function channelOnline(client: Isapi, device: ReolinkDeviceSettings, signal?: AbortSignal): Promise<boolean> {
  const status = await optional(() => client.xml('GET', '/ISAPI/ContentMgmt/InputProxy/channels/status', undefined, signal));
  if (!status) return true;
  const mine = list(node(status.InputProxyChannelStatusList).InputProxyChannelStatus)
    .map(node)
    .find((entry) => Number(text(entry.id)) === hikChannel(device));
  return mine ? text(mine.online) !== 'false' : true;
}

/** Everything the hub needs to know about the camera; throws only when the camera cannot be used at all. */
async function discover(client: Isapi, device: ReolinkDeviceSettings, signal?: AbortSignal): Promise<Discovery> {
  const info = node((await client.xml('GET', '/ISAPI/System/deviceInfo', undefined, signal)).DeviceInfo);
  const deviceType = text(info.deviceType);
  const nvr = /NVR|DVR|HVR|XVR|NVS/i.test(deviceType);
  const firmware = [text(info.firmwareVersion), text(info.firmwareReleasedDate)].filter(Boolean).join(' ') || null;
  const caps = await optional(() => client.xml('GET', `${ptzBase(device, nvr)}/capabilities`, undefined, signal));
  const main = await optional(() => client.xml('GET', `/ISAPI/Streaming/channels/${hikStreamId(device, 'main')}`, undefined, signal));
  const sub = await optional(() => client.xml('GET', `/ISAPI/Streaming/channels/${hikStreamId(device, 'sub')}`, undefined, signal));
  // A recorder's own audio channel would speak at the recorder, not at the camera.
  const talk = nvr ? null : await optional(() => client.xml('GET', '/ISAPI/System/TwoWayAudio/channels', undefined, signal));
  const talkChannel = talk ? node(list(node(talk.TwoWayAudioChannelList).TwoWayAudioChannel)[0]) : null;
  return {
    info: { model: text(info.model) || text(info.deviceName) || null, firmware, deviceType, nvr },
    ptz: caps ? ptzCaps(caps) : { panTilt: false, zoom: false, presets: false },
    main: main ? streamInfo(main) : null,
    sub: sub ? streamInfo(sub) : null,
    talkCodec: talkChannel && Object.keys(talkChannel).length > 0 ? text(talkChannel.audioCompressionType) || 'unbekannt' : null,
    channelOnline: nvr ? await channelOnline(client, device, signal) : true,
  };
}

/** go2rtc carries G.711 to the camera's speaker, nothing else. */
const talkable = (codec: string | null) => codec !== null && (codec === 'unbekannt' || /711/.test(codec));

function featuresOf(found: Discovery): CameraEntity['features'] {
  return {
    ptz: found.ptz.panTilt,
    zoom: found.ptz.zoom,
    presets: found.ptz.presets,
    talk: talkable(found.talkCodec),
    audio: found.sub?.audio ?? found.main?.audio ?? true,
    light: false,
    siren: false,
  };
}

function isImage(data: Buffer): boolean {
  return isJpeg(data) || (data.length > 3 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47);
}

export class HikvisionCamera {
  readonly id: string;
  private readonly client: Isapi;
  private readonly poller: Poller;
  private stopped = false;
  private active = false;

  private found: Discovery | null = null;
  private features: CameraEntity['features'] | null = null;
  private online = true;
  reachable = false;
  problem: string | null = null;
  private failures = 0;
  private refusals = 0;
  private blockedUntil = 0;
  private lastError: string | null = null;
  /** The camera has no `/picture`: still pictures come from the video. */
  private noPicture = false;

  private moving: { op: PtzOp; timer: NodeJS.Timeout } | null = null;
  private snap: { at: number; data: Buffer } | null = null;
  private snapInFlight: Promise<Buffer> | null = null;
  private presetCache: { at: number; list: PtzPreset[] } | null = null;

  constructor(
    private readonly deps: IntegrationDeps,
    readonly device: ReolinkDeviceSettings,
    private readonly timing: HikvisionTiming,
    private readonly changed: () => void,
  ) {
    this.id = device.id;
    this.client = new Isapi(device, timing.requestTimeoutMs);
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
      await this.move(0, 0, 0).catch(() => {});
    }
    this.client.destroy();
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active) this.poller.kick();
  }

  private interval(): number {
    const blocked = this.blockedUntil - Date.now();
    if (blocked > 0) return blocked;
    return this.active ? this.timing.activeMs : this.timing.idleMs;
  }

  /** go2rtc sources: RTSP for the picture, the ISAPI back channel for talking. */
  streamSources(): { main: string; sub: string; talk: string } {
    return { main: hikRtspUrl(this.device, 'main'), sub: hikRtspUrl(this.device, 'sub'), talk: hikTalkUrl(this.device) };
  }

  /** What the camera reported it can; null until it has. */
  detected(): CameraEntity['features'] | null {
    return this.features;
  }

  entity(): CameraEntity {
    return {
      id: `cam:${this.id}`,
      kind: 'camera',
      name: this.device.name,
      room: this.device.room.trim() || null,
      available: this.reachable && this.online,
      service: SERVICE,
      model: this.found?.info.model ?? null,
      features: this.features ?? NO_FEATURES,
      lightOn: null,
    };
  }

  diagnostics(): unknown {
    const transport = this.client.transport;
    return {
      id: this.id,
      name: this.device.name,
      connection: 'hikvision',
      transport: transport ? `${transport.https ? 'https' : 'http'}:${transport.port}` : null,
      rtspPort: this.device.rtspPort,
      reachable: this.reachable,
      model: this.found?.info.model ?? null,
      firmware: this.found?.info.firmware ?? null,
      deviceType: this.found?.info.deviceType ?? null,
      recorder: this.found?.info.nvr ?? false,
      channel: this.found?.info.nvr ? `D${hikChannel(this.device)}` : hikChannel(this.device),
      channelOnline: this.online,
      features: this.features,
      video: this.found ? { main: this.found.main, sub: this.found.sub } : null,
      talkCodec: this.found?.talkCodec ?? null,
      pausedUntil: this.blockedUntil > Date.now() ? new Date(this.blockedUntil).toISOString() : null,
      lastError: this.lastError,
    };
  }

  // --- Polling ------------------------------------------------------------------------------------

  private async tick(signal: AbortSignal): Promise<void> {
    if (this.stopped) return;
    // After a refused login nothing is sent until the pause is over (an app opening must not trigger a retry).
    // Returning quietly lets the poller wait for exactly the rest of the pause.
    if (Date.now() < this.blockedUntil) return;
    if (!this.found) {
      const found = await discover(this.client, this.device, signal);
      this.found = found;
      this.features = featuresOf(found);
      this.online = found.channelOnline;
      this.deps.log.info(
        { camera: this.id, model: found.info.model, firmware: found.info.firmware, connection: 'hikvision', recorder: found.info.nvr, features: this.features },
        'camera connected',
      );
    } else if (this.found.info.nvr) {
      // Proves that the recorder and the credentials still work, and whether the camera is still connected to it.
      await this.client.xml('GET', '/ISAPI/System/deviceInfo', undefined, signal);
      this.online = await channelOnline(this.client, this.device, signal);
    } else {
      await this.client.xml('GET', '/ISAPI/System/deviceInfo', undefined, signal);
    }
    this.failures = 0;
    this.refusals = 0;
    this.blockedUntil = 0;
    this.lastError = null;
    const problem = this.online ? null : `Die Kamera D${hikChannel(this.device)} ist am Rekorder nicht verbunden.`;
    const wasFine = this.reachable && this.problem === problem;
    this.reachable = true;
    this.problem = problem;
    if (!wasFine) this.deps.log.debug({ camera: this.id }, 'camera reachable');
    this.changed();
  }

  private failed(err: unknown): void {
    if (this.stopped) return;
    // Waiting out an earlier refusal: nothing new happened.
    if (err instanceof IsapiError && err.kind === 'paused') return;
    this.lastError = describeError(err);
    const refused = err instanceof IsapiError && (err.kind === 'auth' || err.kind === 'locked');
    this.failures++;
    if (refused || this.failures >= 2) {
      const was = this.reachable;
      this.reachable = false;
      if (refused) {
        this.refusals++;
        const pause = err.kind === 'locked' && err.unlockInMs ? err.unlockInMs + 5000 : Math.min(MAX_BLOCK_MS, this.timing.blockMs * 2 ** (this.refusals - 1));
        this.blockedUntil = Date.now() + pause;
        // The next try starts with a fresh challenge: answering a cached one first would count as a second
        // wrong password on the way to the camera's lock.
        this.client.forget();
        this.problem = err.message;
      } else {
        this.problem = 'nicht erreichbar';
        // Start from scratch when it returns (other address, other scheme, other abilities after an update).
        this.found = null;
        this.client.forget();
      }
      if (was || refused) this.deps.log.warn({ camera: this.id, reason: this.lastError }, 'camera unavailable');
    }
    this.changed();
  }

  private assertReachable(): void {
    if (!this.reachable || !this.found) throw unavailable(`Die Kamera „${this.device.name}“ ist gerade nicht erreichbar.`);
  }

  /** For user actions: a German error instead of whatever went wrong underneath. */
  private async act<T>(run: () => Promise<T>, what: string): Promise<T> {
    this.assertReachable();
    try {
      return await run();
    } catch (err) {
      this.lastError = describeError(err);
      if (err instanceof IsapiError) {
        if (err.kind === 'unsupported') throw new HttpError(400, 'unsupported', `Das unterstützt die Kamera „${this.device.name}“ nicht.`);
        if (err.kind === 'forbidden') throw new HttpError(502, 'device_error', `Der Benutzer des Hubs darf das an der Kamera „${this.device.name}“ nicht (${what}). Bitte seine Rechte in der Kamera prüfen.`);
        if (err.kind === 'device') throw new HttpError(502, 'device_error', `Die Kamera „${this.device.name}“ hat das abgelehnt (${what}).`);
        if (err.kind === 'auth' || err.kind === 'locked') {
          // Credentials changed at the camera: let the poller find out (and pause) instead of trying again here.
          this.client.forget();
          this.poller.kick();
        }
      }
      throw unavailable(`Die Kamera „${this.device.name}“ antwortet gerade nicht.`);
    }
  }

  // --- Operations --------------------------------------------------------------------------------------

  snapshot(): Promise<Buffer> {
    if (this.snap && Date.now() - this.snap.at < this.timing.snapshotCacheMs) return Promise.resolve(this.snap.data);
    if (this.snapInFlight) return this.snapInFlight;
    if (!this.reachable) throw unavailable(`Die Kamera „${this.device.name}“ ist gerade nicht erreichbar.`);
    const load = async (): Promise<Buffer> => {
      if (!this.noPicture) {
        try {
          const response = await this.client.request('GET', `/ISAPI/Streaming/channels/${hikStreamId(this.device, 'main')}/picture`, {
            timeoutMs: Math.max(this.timing.requestTimeoutMs, 10_000),
            maxBytes: 12 * 1024 * 1024,
          });
          if (response.status === 200 && isImage(response.body)) return response.body;
          if (response.status === 404 || response.status === 403) this.noPicture = true;
        } catch (err) {
          this.lastError = describeError(err);
        }
      }
      const fromVideo = await this.deps.streamSnapshot?.(streamName('cam', this.id, 'sub'));
      if (fromVideo && isJpeg(fromVideo)) return fromVideo;
      return grabFrame(this.deps.config.media.ffmpegBin, hikRtspUrl(this.device, 'sub'), 12_000);
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

  /** One continuous movement (all zero = stop). Values −100…100. */
  private move(pan: number, tilt: number, zoom: number): Promise<Xml> {
    const features = this.features ?? NO_FEATURES;
    const parts: string[] = [];
    if (features.ptz) parts.push(`<pan>${pan}</pan><tilt>${tilt}</tilt>`);
    if (features.zoom) parts.push(`<zoom>${zoom}</zoom>`);
    return this.client.xml('PUT', `${ptzBase(this.device, this.found?.info.nvr ?? false)}/continuous`, `${XML_HEADER}<PTZData>${parts.join('')}</PTZData>`);
  }

  async ptz(op: PtzOp, speed?: number): Promise<void> {
    const features = this.features ?? NO_FEATURES;
    const zoom = op === 'zoom_in' || op === 'zoom_out';
    if (op !== 'stop' && !zoom && !features.ptz) throw new HttpError(400, 'unsupported', `Die Kamera „${this.device.name}“ lässt sich nicht schwenken.`);
    if (zoom && !features.zoom) throw new HttpError(400, 'unsupported', `Die Kamera „${this.device.name}“ hat keinen Zoom.`);
    if (op === 'stop' && !features.ptz && !features.zoom) throw new HttpError(400, 'unsupported', `Die Kamera „${this.device.name}“ lässt sich nicht schwenken.`);

    if (op === 'stop') {
      if (this.moving) clearTimeout(this.moving.timer);
      this.moving = null;
      await this.act(() => this.move(0, 0, 0), 'Stopp');
      return;
    }

    const arm = (): NodeJS.Timeout => {
      const timer = setTimeout(() => {
        // The app went quiet (closed, lost its connection): the camera must not keep turning.
        this.moving = null;
        void this.move(0, 0, 0).catch(() => {});
      }, this.timing.ptzHoldMs);
      timer.unref();
      return timer;
    };

    if (this.moving?.op === op) {
      // Same movement, held: only keep the dead-man switch alive.
      clearTimeout(this.moving.timer);
      this.moving.timer = arm();
      return;
    }
    if (this.moving) clearTimeout(this.moving.timer);
    this.moving = { op, timer: arm() };
    const velocity = hikSpeed(speed);
    const direction = DIRECTIONS[op];
    try {
      await this.act(
        () => this.move(direction ? direction.pan * velocity : 0, direction ? direction.tilt * velocity : 0, zoom ? (op === 'zoom_in' ? velocity : -velocity) : 0),
        'Bewegung',
      );
    } catch (err) {
      if (this.moving?.op === op) {
        clearTimeout(this.moving.timer);
        this.moving = null;
      }
      throw err;
    }
  }

  private async loadPresets(): Promise<PtzPreset[]> {
    if (this.presetCache && Date.now() - this.presetCache.at < this.timing.presetCacheMs) return this.presetCache.list;
    const xml = await this.act(() => this.client.xml('GET', `${ptzBase(this.device, this.found?.info.nvr ?? false)}/presets`), 'Positionen');
    const seen = new Set<number>();
    const presets: PtzPreset[] = [];
    for (const entry of list(node(xml.PTZPresetList).PTZPreset).map(node)) {
      const id = Number(text(entry.id));
      // Firmwares that list every slot mark the unused ones.
      if (!Number.isInteger(id) || id < 1 || seen.has(id) || text(entry.enabled) === 'false') continue;
      seen.add(id);
      presets.push({ id, name: text(entry.presetName).trim() || `Position ${id}` });
    }
    presets.sort((a, b) => a.id - b.id);
    this.presetCache = { at: Date.now(), list: presets };
    return presets;
  }

  async presets(): Promise<PtzPreset[]> {
    if (!this.features?.presets) return [];
    return this.loadPresets();
  }

  async gotoPreset(presetId: number): Promise<void> {
    if (!this.features?.presets) throw new HttpError(400, 'unsupported', `Die Kamera „${this.device.name}“ hat keine gespeicherten Positionen.`);
    if (!(await this.loadPresets()).some((preset) => preset.id === presetId)) throw new HttpError(404, 'not_found', 'Diese Position gibt es an der Kamera nicht (mehr).');
    if (this.moving) clearTimeout(this.moving.timer);
    this.moving = null;
    await this.act(() => this.client.xml('PUT', `${ptzBase(this.device, this.found?.info.nvr ?? false)}/presets/${presetId}/goto`, ''), 'Position anfahren');
  }

  async setLight(_on: boolean): Promise<void> {
    throw new HttpError(400, 'unsupported', `Das Licht der Kamera „${this.device.name}“ lässt sich nicht direkt schalten.`);
  }

  async siren(): Promise<void> {
    throw new HttpError(400, 'unsupported', `Die Sirene der Kamera „${this.device.name}“ lässt sich nicht auslösen.`);
  }

  /** Connection test for one (possibly unsaved) device. Never throws. */
  static async test(device: ReolinkDeviceSettings, timeoutMs: number): Promise<TestResult> {
    const client = new Isapi(device, timeoutMs);
    try {
      let found: Discovery;
      try {
        found = await discover(client, device);
      } catch (err) {
        const label = client.transport ? transportLabel(client.transport) : null;
        if (err instanceof IsapiError && (err.kind === 'auth' || err.kind === 'locked')) {
          return {
            ok: false,
            message: err.kind === 'locked' ? lockedMessage(err.unlockInMs) : 'Benutzername oder Passwort stimmen nicht.',
            details: [
              `Die Kamera ist über ${label ?? 'ISAPI'} erreichbar, hat die Anmeldung aber abgelehnt.`,
              'Hikvision sperrt die Anmeldung nach einigen Fehlversuchen für bis zu 30 Minuten – auch für das Live-Bild. Bitte Benutzername und Passwort genau prüfen, bevor du erneut testest.',
            ],
          };
        }
        if (err instanceof IsapiError && err.kind === 'forbidden') {
          return { ok: false, message: 'Der Benutzer darf an der Kamera nichts abfragen.', details: ['Bitte in der Benutzerverwaltung der Kamera seine Rechte prüfen (mindestens „Live-Ansicht“).'] };
        }
        if (err instanceof IsapiError) {
          return {
            ok: false,
            message: 'Unter dieser Adresse antwortet keine Hikvision-Kamera.',
            details: [`${label ?? 'ISAPI'}: ${err.message}`, 'Lässt sich unter dieser Adresse im Browser die Weboberfläche der Kamera öffnen? Bei Kameras anderer Hersteller passt die Verbindungsart „ONVIF + RTSP“.'],
          };
        }
        return {
          ok: false,
          message: 'Die Kamera ist unter dieser Adresse nicht erreichbar.',
          details: [...client.tried, 'Stimmt die Adresse? Unter ihr muss sich im Browser die Weboberfläche der Kamera öffnen lassen (HTTP, Port 80 – oder HTTPS, Port 443).'],
        };
      }

      const { info } = found;
      const label = client.transport ? transportLabel(client.transport) : 'ISAPI';
      const details = [`Verbindung: ISAPI über ${label}${client.transport?.https ? '' : ' – unverschlüsselt im Heimnetz'}, Video über RTSP (Port ${device.rtspPort})`];
      if (info.nvr) {
        details.push(`Rekorder (${info.deviceType || 'NVR'}): Kamera D${hikChannel(device)}`);
        if (!found.channelOnline) {
          return { ok: false, message: `Der Rekorder ist erreichbar, aber die Kamera D${hikChannel(device)} ist nicht mit ihm verbunden.`, details: [...details, 'Stimmt die Kameranummer unter „Erweitert“?'] };
        }
      }

      let stream: RtspDescription | null = null;
      try {
        stream = await describeRtsp({ host: device.host, port: device.rtspPort, path: hikRtspPath(device, 'sub'), username: device.username, password: device.password, timeoutMs });
      } catch (err) {
        const reason = err instanceof RtspError ? err.message : describeError(err);
        return {
          ok: false,
          message: 'Steuerung erreichbar, aber kein Live-Bild.',
          details: [
            ...details,
            `RTSP: ${reason}`,
            `Der RTSP-Port der Kamera (Netzwerk › Grundeinstellungen › Port) muss mit dem hier eingetragenen übereinstimmen (Standard: 554).`,
          ],
        };
      }

      const features = featuresOf(found);
      const can = [
        features.ptz && 'Schwenken/Neigen',
        features.zoom && 'Zoom',
        features.presets && 'gespeicherte Positionen',
        (found.sub ? found.sub.audio : stream.audio) && 'Mithören',
        features.talk && 'Gegensprechen',
      ].filter(Boolean);
      details.push(`Funktionen: ${can.length > 0 ? `Live-Bild, ${can.join(', ')}` : 'Live-Bild'}`);
      const describe = (name: string, entry: StreamInfo | null) =>
        entry ? `${name}: ${[entry.codec, entry.width && entry.height ? `${entry.width}×${entry.height}` : null].filter(Boolean).join(' ')}` : null;
      const sizes = [describe('HD', found.main), describe('SD', found.sub)].filter((entry): entry is string => entry !== null && !entry.endsWith(': '));
      if (sizes.length > 0) details.push(`Video: ${sizes.join(', ')}`);
      if (/265|hevc/i.test(`${found.main?.codec ?? ''} ${stream.video ?? ''}`)) details.push('Hinweis: H.265 kann nicht jeder Browser anzeigen – die App weicht dann auf die SD-Ansicht aus. Wer das vermeiden will, stellt den Hauptstream der Kamera auf H.264.');
      if (/\+/.test(`${found.main?.codec ?? ''} ${found.sub?.codec ?? ''}`)) details.push('Hinweis: H.264+/H.265+ können manche Geräte ruckelig zeigen; unter Video/Audio › Video lässt sich das abschalten.');
      if (found.sub && !found.sub.audio) details.push('Ton: Im Substream ist kein Ton eingeschaltet. Unter Video/Audio › Video beim Haupt- und beim Substream den Stream-Typ „Video&Audio“ wählen.');
      if (info.nvr) details.push('Gegensprechen geht über den Rekorder nicht – dafür die Kamera direkt mit ihrer eigenen Adresse eintragen.');
      else if (found.talkCodec && !features.talk)
        details.push(`Gegensprechen: Die Kamera spricht ${found.talkCodec}. Unter Video/Audio › Audio die Audiokodierung „G.711ulaw“ (oder „G.711alaw“) wählen, dann klappt es auch aus der App.`);
      else if (!found.talkCodec) details.push('Gegensprechen: Die Kamera meldet keinen Lautsprecher (oder der Benutzer hat das Recht „Zweiwege-Audio“ nicht).');
      else if (device.https && device.port > 0) details.push('Gegensprechen braucht an der Kamera zusätzlich HTTP auf Port 80.');
      details.push('Licht und Sirene lassen sich über diese Verbindung nicht schalten – Lichter des Hauses kannst du der Kamera aber auf ihrer Seite in der App zuordnen.');
      const model = info.model ? `Hikvision ${info.model.replace(/^hikvision\s+/i, '')}` : 'Hikvision-Kamera';
      return { ok: true, message: `${model} gefunden${info.firmware ? ` (Firmware ${info.firmware})` : ''}.`, details, supports: { ptz: features.ptz || features.zoom, talk: features.talk } };
    } catch (err) {
      return { ok: false, message: 'Der Test konnte nicht abgeschlossen werden.', details: [describeError(err)] };
    } finally {
      client.destroy();
    }
  }
}
