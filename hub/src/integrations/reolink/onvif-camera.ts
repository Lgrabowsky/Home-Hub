import { spawn } from 'node:child_process';
import type { CameraEntity, PtzOp, PtzPreset, ReolinkDeviceSettings, TestResult } from '@home-hub/shared';
import { HttpError, unavailable } from '../../http/errors.ts';
import { describeError } from '../../util/http.ts';
import { Poller } from '../../util/poller.ts';
import { streamName } from '../media.ts';
import type { IntegrationDeps } from '../types.ts';
import { OnvifClient, OnvifError, type OnvifProfile } from './onvif.ts';
import { describeRtsp, RtspError, type RtspDescription } from './rtsp.ts';

/**
 * A Reolink camera without its HTTP(S) interface — the E1 series and others
 * whose app only offers "Basisdienste", RTSP and ONVIF. Control goes through
 * ONVIF (port 8000), video through RTSP (port 554):
 *
 * - live picture, sound, pan/tilt (and zoom where the camera has it), stored
 *   positions;
 * - talking only when the camera offers an ONVIF audio back channel over RTSP
 *   (many Reolink models do not; the hub checks and says so);
 * - no spotlight or siren — ONVIF has no command for them;
 * - still pictures come from the live stream (go2rtc, or ffmpeg directly).
 */

export interface OnvifCameraTiming {
  activeMs: number;
  idleMs: number;
  requestTimeoutMs: number;
  blockMs: number;
  ptzHoldMs: number;
  snapshotCacheMs: number;
  presetCacheMs: number;
}

const SERVICE = 'reolink';
const NO_FEATURES: CameraEntity['features'] = { ptz: false, zoom: false, presets: false, talk: false, audio: true, light: false, siren: false };

/** Pan/tilt directions as ONVIF velocities (x: right positive, y: up positive). */
const DIRECTIONS: Partial<Record<PtzOp, { x: number; y: number }>> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: 1 },
  down: { x: 0, y: -1 },
  left_up: { x: -1, y: 1 },
  left_down: { x: -1, y: -1 },
  right_up: { x: 1, y: 1 },
  right_down: { x: 1, y: -1 },
};

/** The app's speed (1…64, like the Reolink API) as an ONVIF velocity. */
export function onvifSpeed(speed: number | undefined): number {
  if (speed === undefined || !Number.isFinite(speed)) return 0.5;
  return Math.min(1, Math.max(0.1, speed / 64));
}

/** Default RTSP paths of Reolink cameras, used until the camera reports its own. */
export function defaultRtspPaths(channel: number): { main: string; sub: string } {
  const nn = String(channel + 1).padStart(2, '0');
  return { main: `/Preview_${nn}_main`, sub: `/Preview_${nn}_sub` };
}

/** Path and query of an RTSP address the camera reported (host and port are always the configured ones). */
export function rtspPath(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'rtsp:' && url.protocol !== 'rtsps:') return null;
    const path = `${url.pathname}${url.search}`;
    return path && path !== '/' ? path : null;
  } catch {
    return null;
  }
}

function isJpeg(data: Buffer): boolean {
  return data.length > 3 && data[0] === 0xff && data[1] === 0xd8;
}

function encodeUserInfo(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function rtspUrl(device: ReolinkDeviceSettings, path: string): string {
  const host = device.host.replace(/:\d+$/, '');
  return `rtsp://${encodeUserInfo(device.username)}:${encodeUserInfo(device.password)}@${host}:${device.rtspPort}${path}`;
}

/** One frame of an RTSP stream as JPEG, straight through ffmpeg (when go2rtc is not there to ask). */
function grabFrame(ffmpeg: string, url: string, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', url, '-frames:v', '1', '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 12 * 1024 * 1024) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', () => {
      clearTimeout(timer);
      const data = Buffer.concat(chunks);
      if (isJpeg(data)) resolve(data);
      else reject(new Error('ffmpeg lieferte kein Bild'));
    });
  });
}

function refusal(err: unknown): boolean {
  return (err instanceof OnvifError && err.kind === 'auth') || (err instanceof RtspError && err.kind === 'auth');
}

export class OnvifCamera {
  readonly id: string;
  private client: OnvifClient;
  private readonly poller: Poller;
  private stopped = false;
  private active = false;

  private info: { model: string | null; firmware: string | null } | null = null;
  private features: CameraEntity['features'] | null = null;
  private profiles: { main: OnvifProfile; sub: OnvifProfile; ptz: OnvifProfile } | null = null;
  private paths: { main: string; sub: string } | null = null;
  private stream: RtspDescription | null = null;
  reachable = false;
  problem: string | null = null;
  private failures = 0;
  private blockedUntil = 0;
  private lastError: string | null = null;

  private moving: { op: PtzOp; timer: NodeJS.Timeout } | null = null;
  private snap: { at: number; data: Buffer } | null = null;
  private snapInFlight: Promise<Buffer> | null = null;
  private presetCache: { at: number; list: PtzPreset[]; tokens: Map<number, string> } | null = null;

  constructor(
    private readonly deps: IntegrationDeps,
    readonly device: ReolinkDeviceSettings,
    private readonly timing: OnvifCameraTiming,
    private readonly changed: () => void,
  ) {
    this.id = device.id;
    this.client = OnvifCamera.clientFor(device, timing.requestTimeoutMs);
    this.poller = new Poller(
      (signal) => this.tick(signal),
      () => this.interval(),
      (err) => this.failed(err),
      5 * 60_000,
    );
  }

  private static clientFor(device: ReolinkDeviceSettings, timeoutMs: number): OnvifClient {
    return new OnvifClient({ host: device.host, port: device.onvifPort, username: device.username, password: device.password, timeoutMs });
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
      if (this.profiles) await this.client.stop(this.profiles.ptz.token).catch(() => {});
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

  /** RTSP paths for go2rtc: what the camera reported, Reolink's defaults until then. */
  rtspPaths(): { main: string; sub: string } {
    return this.paths ?? defaultRtspPaths(this.device.channel);
  }

  entity(): CameraEntity {
    return {
      id: `cam:${this.id}`,
      kind: 'camera',
      name: this.device.name,
      room: this.device.room.trim() || null,
      available: this.reachable,
      service: SERVICE,
      model: this.info?.model ?? null,
      features: this.features ?? NO_FEATURES,
      lightOn: null,
    };
  }

  diagnostics(): unknown {
    return {
      id: this.id,
      name: this.device.name,
      connection: `onvif:${this.device.onvifPort}`,
      rtspPort: this.device.rtspPort,
      reachable: this.reachable,
      model: this.info?.model ?? null,
      firmware: this.info?.firmware ?? null,
      features: this.features,
      profiles: this.profiles ? { main: this.profiles.main.name || this.profiles.main.token, sub: this.profiles.sub.name || this.profiles.sub.token } : null,
      rtspPaths: this.paths,
      video: this.stream ? { codec: this.stream.video, audio: this.stream.audio, backchannel: this.stream.backchannel } : null,
      clockOffsetSec: Math.round(this.client.clockOffset / 1000),
      pausedUntil: this.blockedUntil > Date.now() ? new Date(this.blockedUntil).toISOString() : null,
      lastError: this.lastError,
    };
  }

  // --- Polling ------------------------------------------------------------------------------------

  private async tick(signal: AbortSignal): Promise<void> {
    if (this.stopped) return;
    // After a refused login nothing is sent until the pause is over (an app opening must not trigger a retry).
    if (Date.now() < this.blockedUntil) throw new OnvifError(this.problem ?? 'Anmeldung pausiert', 'auth');
    if (!this.info || !this.profiles) {
      await this.connect(signal);
    } else {
      try {
        // Cheap and needs a valid login: proves that the camera and the credentials still work.
        await this.client.deviceInformation(signal);
      } catch (err) {
        if (!(err instanceof OnvifError && err.kind === 'auth')) throw err;
        // Perhaps the camera's clock jumped (NTP after a restart): read it again before calling it a refusal.
        await this.client.syncClock(signal);
        await this.client.deviceInformation(signal);
      }
    }
    this.failures = 0;
    this.blockedUntil = 0;
    this.lastError = null;
    const wasFine = this.reachable && this.problem === null;
    this.reachable = true;
    this.problem = null;
    if (!wasFine) this.deps.log.debug({ camera: this.id }, 'camera reachable');
    this.changed();
  }

  private async connect(signal: AbortSignal): Promise<void> {
    await this.client.syncClock(signal);
    const info = await this.client.deviceInformation(signal);
    await this.client.discoverServices(signal);
    const profiles = await this.client.profiles(signal);
    if (profiles.length === 0) throw new OnvifError('Die Kamera meldet keine Video-Profile', 'protocol');
    const main = profiles[0]!;
    const sub = profiles[1] ?? main;
    const ptzProfile = profiles.find((profile) => profile.ptz) ?? main;

    const paths = { main: defaultRtspPaths(this.device.channel).main, sub: defaultRtspPaths(this.device.channel).sub };
    for (const [quality, profile] of [['main', main], ['sub', sub]] as const) {
      try {
        paths[quality] = rtspPath(await this.client.streamUri(profile.token, signal)) ?? paths[quality];
      } catch (err) {
        if (err instanceof OnvifError && err.kind === 'auth') throw err;
        // Reolink's own paths are a good guess.
      }
    }

    const ptz = this.client.hasPtzService && profiles.some((profile) => profile.ptz) ? await this.client.ptzCapabilities(signal) : { panTilt: false, zoom: false, presets: false };

    // What the stream carries — and whether the camera has a speaker the hub can reach.
    let stream: RtspDescription | null = null;
    try {
      stream = await describeRtsp({ host: this.device.host, port: this.device.rtspPort, path: paths.sub, username: this.device.username, password: this.device.password, timeoutMs: this.timing.requestTimeoutMs });
    } catch (err) {
      if (refusal(err)) throw err;
      this.deps.log.warn({ camera: this.id, reason: describeError(err) }, 'RTSP of the camera not reachable');
    }

    const pathsChanged = JSON.stringify(paths) !== JSON.stringify(this.rtspPaths());
    this.info = { model: [info.manufacturer, info.model].filter(Boolean).join(' ').replace(/^Reolink\s+/i, '') || null, firmware: info.firmware || null };
    this.profiles = { main, sub, ptz: ptzProfile };
    this.paths = paths;
    this.stream = stream;
    this.features = {
      ptz: ptz.panTilt,
      zoom: ptz.zoom,
      presets: ptz.presets,
      talk: stream?.backchannel ?? false,
      audio: stream?.audio ?? true,
      light: false,
      siren: false,
    };
    this.deps.log.info({ camera: this.id, model: this.info.model, firmware: this.info.firmware, connection: 'onvif', paths, features: this.features }, 'camera connected');
    if (pathsChanged) this.deps.streamsChanged?.();
  }

  private failed(err: unknown): void {
    if (this.stopped) return;
    this.lastError = describeError(err);
    const refused = refusal(err);
    this.failures++;
    if (refused || this.failures >= 2) {
      const was = this.reachable;
      this.reachable = false;
      this.problem = refused ? 'Benutzername oder Passwort stimmen nicht.' : 'nicht erreichbar';
      // Reolink locks an account after repeated wrong logins: do not keep trying.
      if (refused && Date.now() >= this.blockedUntil) this.blockedUntil = Date.now() + this.timing.blockMs;
      if (was || refused) this.deps.log.warn({ camera: this.id, reason: this.lastError }, 'camera unavailable');
      if (!refused) {
        this.info = null;
        this.profiles = null;
      }
    }
    this.changed();
  }

  private assertReachable(): void {
    if (!this.reachable || !this.profiles) throw unavailable(`Die Kamera „${this.device.name}“ ist gerade nicht erreichbar.`);
  }

  private async act<T>(run: () => Promise<T>, what: string): Promise<T> {
    this.assertReachable();
    try {
      return await run();
    } catch (err) {
      this.lastError = describeError(err);
      if (err instanceof OnvifError && err.kind === 'fault') throw new HttpError(502, 'device_error', `Die Kamera „${this.device.name}“ hat das abgelehnt (${what}).`);
      throw unavailable(`Die Kamera „${this.device.name}“ antwortet gerade nicht.`);
    }
  }

  // --- Operations --------------------------------------------------------------------------------------

  snapshot(): Promise<Buffer> {
    if (this.snap && Date.now() - this.snap.at < this.timing.snapshotCacheMs) return Promise.resolve(this.snap.data);
    if (this.snapInFlight) return this.snapInFlight;
    if (!this.reachable) throw unavailable(`Die Kamera „${this.device.name}“ ist gerade nicht erreichbar.`);
    const load = async (): Promise<Buffer> => {
      const fromVideo = await this.deps.streamSnapshot?.(streamName('cam', this.id, 'sub'));
      if (fromVideo && isJpeg(fromVideo)) return fromVideo;
      return grabFrame(this.deps.config.media.ffmpegBin, rtspUrl(this.device, this.rtspPaths().sub), 12_000);
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
    const features = this.features ?? NO_FEATURES;
    const zoom = op === 'zoom_in' || op === 'zoom_out';
    if (op !== 'stop' && !zoom && !features.ptz) throw new HttpError(400, 'unsupported', `Die Kamera „${this.device.name}“ lässt sich nicht schwenken.`);
    if (zoom && !features.zoom) throw new HttpError(400, 'unsupported', `Die Kamera „${this.device.name}“ hat keinen Zoom.`);

    if (op === 'stop') {
      if (this.moving) clearTimeout(this.moving.timer);
      this.moving = null;
      await this.act(() => this.client.stop(this.profiles!.ptz.token), 'Stopp');
      return;
    }

    const arm = (): NodeJS.Timeout => {
      const timer = setTimeout(() => {
        // The app went quiet (closed, lost its connection): the camera must not keep turning.
        this.moving = null;
        if (this.profiles) void this.client.stop(this.profiles.ptz.token).catch(() => {});
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
    const velocity = onvifSpeed(speed);
    const direction = DIRECTIONS[op];
    try {
      await this.act(
        () =>
          this.client.continuousMove(
            this.profiles!.ptz.token,
            direction ? { x: direction.x * velocity, y: direction.y * velocity } : null,
            zoom ? (op === 'zoom_in' ? velocity : -velocity) : null,
          ),
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

  private async loadPresets(): Promise<{ list: PtzPreset[]; tokens: Map<number, string> }> {
    if (this.presetCache && Date.now() - this.presetCache.at < this.timing.presetCacheMs) return this.presetCache;
    const raw = await this.act(() => this.client.presets(this.profiles!.ptz.token), 'Positionen');
    const tokens = new Map<number, string>();
    const list: PtzPreset[] = [];
    raw.forEach((preset, index) => {
      // Numeric tokens keep their number (so ids stay stable); others are numbered in order.
      let id = /^\d{1,6}$/.test(preset.token) ? Number(preset.token) : index + 1;
      while (tokens.has(id)) id += 1000;
      tokens.set(id, preset.token);
      list.push({ id, name: preset.name || `Position ${list.length + 1}` });
    });
    this.presetCache = { at: Date.now(), list, tokens };
    return this.presetCache;
  }

  async presets(): Promise<PtzPreset[]> {
    if (!this.features?.presets) return [];
    return (await this.loadPresets()).list;
  }

  async gotoPreset(presetId: number): Promise<void> {
    if (!this.features?.presets) throw new HttpError(400, 'unsupported', `Die Kamera „${this.device.name}“ hat keine gespeicherten Positionen.`);
    const token = (await this.loadPresets()).tokens.get(presetId);
    if (token === undefined) throw new HttpError(404, 'not_found', 'Diese Position gibt es an der Kamera nicht (mehr).');
    if (this.moving) clearTimeout(this.moving.timer);
    this.moving = null;
    await this.act(() => this.client.gotoPreset(this.profiles!.ptz.token, token), 'Position anfahren');
  }

  async setLight(_on: boolean): Promise<void> {
    throw new HttpError(400, 'unsupported', `Das Licht der Kamera „${this.device.name}“ lässt sich über ONVIF nicht schalten.`);
  }

  async siren(): Promise<void> {
    throw new HttpError(400, 'unsupported', `Die Sirene der Kamera „${this.device.name}“ lässt sich über ONVIF nicht auslösen.`);
  }

  /** Connection test for one (possibly unsaved) device. Never throws. */
  static async test(device: ReolinkDeviceSettings, timeoutMs: number): Promise<TestResult> {
    const client = OnvifCamera.clientFor(device, timeoutMs);
    const label = `ONVIF (Port ${device.onvifPort})`;
    try {
      try {
        await client.syncClock();
      } catch (err) {
        return {
          ok: false,
          message: 'Die Kamera antwortet nicht über ONVIF.',
          details: [
            `${label}: ${describeError(err)}`,
            'In der Reolink-App unter Einstellungen › Netzwerk › Erweitert › Server-Einstellungen muss „ONVIF“ eingeschaltet sein; der Port dort muss mit dem hier eingetragenen übereinstimmen.',
          ],
        };
      }
      let info: { manufacturer: string; model: string; firmware: string };
      try {
        info = await client.deviceInformation();
      } catch (err) {
        if (err instanceof OnvifError && err.kind === 'auth') {
          const offset = Math.round(client.clockOffset / 60_000);
          return {
            ok: false,
            message: 'Benutzername oder Passwort stimmen nicht.',
            details: [
              `Die Kamera ist über ${label} erreichbar, hat die Anmeldung aber abgelehnt.`,
              'Bitte Benutzername und Passwort prüfen – nach mehreren Fehlversuchen sperrt die Kamera das Konto für einige Minuten.',
              ...(Math.abs(offset) >= 5 ? [`Die Uhr der Kamera weicht um etwa ${Math.abs(offset)} Minuten ab; bitte in der Reolink-App die Zeit (NTP) einstellen.`] : []),
            ],
          };
        }
        throw err;
      }
      await client.discoverServices();
      const profiles = await client.profiles();
      if (profiles.length === 0) return { ok: false, message: 'Die Kamera meldet über ONVIF kein Video.', details: [] };
      const sub = profiles[1] ?? profiles[0]!;
      const subPath = rtspPath(await client.streamUri(sub.token).catch(() => '')) ?? defaultRtspPaths(device.channel).sub;
      const ptz = client.hasPtzService && profiles.some((profile) => profile.ptz) ? await client.ptzCapabilities() : { panTilt: false, zoom: false, presets: false };

      const details = [`Verbindung: ${label} und RTSP (Port ${device.rtspPort}) – unverschlüsselt im Heimnetz`];
      let stream: RtspDescription | null = null;
      try {
        stream = await describeRtsp({ host: device.host, port: device.rtspPort, path: subPath, username: device.username, password: device.password, timeoutMs });
      } catch (err) {
        const reason = err instanceof RtspError ? err.message : describeError(err);
        return {
          ok: false,
          message: 'Steuerung erreichbar, aber kein Live-Bild.',
          details: [
            ...details,
            `RTSP: ${reason}`,
            `In der Reolink-App unter Server-Einstellungen muss „RTSP“ eingeschaltet sein (Port ${device.rtspPort}).`,
          ],
        };
      }
      const can = [ptz.panTilt && 'Schwenken/Neigen', ptz.zoom && 'Zoom', ptz.presets && 'gespeicherte Positionen', stream.audio && 'Mithören', stream.backchannel && 'Gegensprechen'].filter(Boolean);
      details.push(`Funktionen: ${can.length > 0 ? `Live-Bild, ${can.join(', ')}` : 'Live-Bild'}`);
      const sizes = profiles
        .slice(0, 2)
        .map((profile, index) => `${index === 0 ? 'HD' : 'SD'}: ${[profile.encoding, profile.width && profile.height ? `${profile.width}×${profile.height}` : null].filter(Boolean).join(' ')}`)
        .filter((entry) => !entry.endsWith(': '));
      if (sizes.length > 0) details.push(`Video: ${sizes.join(', ')}`);
      if (/265|hevc/i.test(`${profiles[0]?.encoding ?? ''} ${stream.video ?? ''}`)) details.push('Hinweis: H.265 kann nicht jeder Browser anzeigen – die App weicht dann auf die SD-Ansicht aus.');
      if (!stream.backchannel) details.push('Gegensprechen: Die Kamera bietet über RTSP keinen Rückkanal für ihren Lautsprecher an. Sprechen geht dann nur in der Reolink-App; Mithören funktioniert.');
      details.push('Licht und Sirene lassen sich über ONVIF nicht schalten.');
      const model = [info.manufacturer, info.model].filter(Boolean).join(' ') || 'Kamera';
      return { ok: true, message: `${model} gefunden${info.firmware ? ` (Firmware ${info.firmware})` : ''}.`, details };
    } catch (err) {
      return { ok: false, message: 'Der Test konnte nicht abgeschlossen werden.', details: [describeError(err)] };
    } finally {
      client.destroy();
    }
  }
}
