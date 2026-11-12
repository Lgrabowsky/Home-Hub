import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import { XMLParser } from 'fast-xml-parser';
import type { ReolinkDeviceSettings } from '@home-hub/shared';
import { renderScene } from './art.ts';

/**
 * Simulator of a Reolink camera (or recorder) speaking the JSON HTTP API as
 * described in the "Camera HTTP API User Guide" v8: token login with a lease,
 * batched commands in one array, JSON answers served as `text/html`, and the
 * documented error shapes. Plain HTTP only.
 *
 * It also speaks ONVIF (device, media and PTZ service with WS-Security
 * PasswordDigest, as Reolink cameras do on their ONVIF port) and, on request,
 * answers RTSP DESCRIBE with Digest authentication — enough for the hub's
 * "ONVIF + RTSP" connection used by cameras without the HTTP interface.
 */

export type ReolinkSimProfile = 'ptz' | 'fixed4k' | 'talk' | 'e1pro';

export interface ReolinkSimOptions {
  /** 0 (default) picks a free port. */
  port?: number;
  username?: string;
  password?: string;
  /** Shown in the picture and reported as the device name. */
  name?: string;
  profile?: ReolinkSimProfile;
  scene?: 'garden' | 'driveway' | 'terrace';
  /** Simultaneous sessions before logins are refused with -5 (real cameras allow few). */
  maxSessions?: number;
  /** Token lease in seconds, as reported by `Login`. */
  leaseTime?: number;
  /** Behave like a recorder: `channels[n]` describes channel n. */
  nvr?: { channels: { name: string; online: boolean }[] };
  /** Lock the account after this many wrong logins in a row (null = never). */
  lockAfterFailures?: number | null;
  lockMs?: number;
  /** The camera's clock runs this far ahead (ONVIF timestamps are checked against it). */
  clockSkewMs?: number;
  /** Also start an RTSP server (DESCRIBE only). */
  rtsp?: boolean;
}

export interface ReolinkSimPtz {
  channel: number;
  op: string;
  speed: number | null;
  /** Preset id for `ToPos`. */
  id: number | null;
  at: number;
}

export interface ReolinkSim {
  readonly port: number;
  /** Port of the RTSP server (0 without `rtsp: true`). */
  readonly rtspPort: number;
  /** `127.0.0.1` */
  readonly host: string;
  readonly username: string;
  readonly password: string;
  /** Device settings for the hub that point at this simulator. */
  settings(base: { id: string; name: string } & Partial<ReolinkDeviceSettings>): ReolinkDeviceSettings;
  close(): Promise<void>;

  /** The picture the camera sees right now (PNG) — what `Snap` would deliver. */
  frame(): Buffer;
  /** Every PTZ command received, oldest first. */
  readonly ptzLog: ReolinkSimPtz[];
  /** Pan position −1 (left) … 1 (right) right now. */
  readonly pan: number;
  /** Zoom 0 … 1 right now. */
  readonly zoom: number;
  /** True while a movement was started and not stopped. */
  readonly moving: boolean;
  /** The spotlight as the camera stores it. */
  readonly light: { state: number; bright: number; mode: number };
  readonly sirenCount: number;
  /** Sessions (valid tokens) right now. */
  readonly sessions: number;
  readonly stats: { logins: number; failedLogins: number; logouts: number; snaps: number; requests: number };
  /** RTSP requests seen: path, whether the back channel was asked for, and whether it was authorised. */
  readonly rtspLog: { path: string; backchannel: boolean; authorised: boolean }[];
  /** Every command received (without parameters), oldest first — the last 2000. ONVIF operations as `onvif:<Operation>`. */
  readonly commands: string[];

  /** Makes every token invalid, as a reboot of the camera would. */
  expireTokens(): void;
  /** Takes the camera off the network / brings it back on the same port. */
  setOffline(offline: boolean): Promise<void>;
  /** The next `count` commands are answered with this `rspCode`. */
  failNext(rspCode: number, count?: number): void;
  setCredentials(username: string, password: string): void;
  setChannelOnline(channel: number, online: boolean): void;
}

/** The demo household: four cameras as the hub should name them. */
export const REOLINK_DEMO_CAMERAS: readonly { device: { id: string; name: string; room: string }; sim: ReolinkSimOptions }[] = [
  { device: { id: 'garten', name: 'Garten', room: 'Außen' }, sim: { name: 'Garten', profile: 'ptz', scene: 'garden' } },
  { device: { id: 'einfahrt', name: 'Einfahrt', room: 'Außen' }, sim: { name: 'Einfahrt', profile: 'fixed4k', scene: 'driveway' } },
  { device: { id: 'terrasse', name: 'Terrasse', room: 'Außen' }, sim: { name: 'Terrasse', profile: 'talk', scene: 'terrace' } },
  // An indoor pan/tilt camera without HTTP interface: connected through ONVIF and RTSP.
  { device: { id: 'wohnzimmer', name: 'Wohnzimmer', room: 'Wohnzimmer' }, sim: { name: 'Wohnzimmer', profile: 'e1pro', scene: 'terrace', rtsp: true } },
];

interface Profile {
  model: string;
  /** `ptzType.ver`: 0 none, 1 zoom/focus only, 3 pan/tilt with speed. */
  ptzType: number;
  presets: boolean;
  light: boolean;
  siren: boolean;
  talk: boolean;
  mainCodec: 'h264' | 'h265';
  /** The HTTP(S) interface is switched on (the E1 series has none). */
  httpApi: boolean;
}

const PROFILES: Record<ReolinkSimProfile, Profile> = {
  ptz: { model: 'RLC-823A', ptzType: 3, presets: true, light: true, siren: true, talk: false, mainCodec: 'h264', httpApi: true },
  fixed4k: { model: 'RLC-810A', ptzType: 0, presets: false, light: false, siren: false, talk: false, mainCodec: 'h265', httpApi: true },
  talk: { model: 'RLC-811A', ptzType: 1, presets: false, light: true, siren: true, talk: true, mainCodec: 'h264', httpApi: true },
  // Pan/tilt indoor camera; its app only offers "Basisdienste", RTSP and ONVIF.
  e1pro: { model: 'E1 Pro', ptzType: 3, presets: true, light: false, siren: false, talk: false, mainCodec: 'h264', httpApi: false },
};

const DEMO_PRESETS = [
  { id: 1, name: 'Terrasse', pan: -0.7 },
  { id: 2, name: 'Rasen', pan: 0 },
  { id: 3, name: 'Tor', pan: 0.75 },
];

const PAN_DIRECTION: Record<string, number> = { Left: -1, LeftUp: -1, LeftDown: -1, Right: 1, RightUp: 1, RightDown: 1 };
const KNOWN_OPS = new Set(['Stop', 'Left', 'Right', 'Up', 'Down', 'LeftUp', 'LeftDown', 'RightUp', 'RightDown', 'ZoomInc', 'ZoomDec', 'FocusInc', 'FocusDec', 'Auto', 'ToPos']);

type Json = Record<string, unknown>;

export async function startReolinkSim(options: ReolinkSimOptions = {}): Promise<ReolinkSim> {
  let username = options.username ?? 'hub';
  let password = options.password ?? 'Reolink-Demo-2026';
  const profile = PROFILES[options.profile ?? 'ptz'];
  const name = options.name ?? 'Kamera';
  const scene = options.scene ?? 'garden';
  const maxSessions = options.maxSessions ?? 8;
  const leaseTime = options.leaseTime ?? 3600;
  const channels = options.nvr?.channels.map((channel) => ({ ...channel })) ?? null;

  const tokens = new Map<string, number>();
  const ptzLog: ReolinkSimPtz[] = [];
  const commands: string[] = [];
  const stats = { logins: 0, failedLogins: 0, logouts: 0, snaps: 0, requests: 0 };
  const light = { state: 0, bright: 85, mode: 1 };
  let sirenCount = 0;
  let failure: { rspCode: number; count: number } | null = null;
  let failedInARow = 0;
  let lockedUntil = 0;

  // Movement is computed from when it started, so the position is right whenever somebody looks.
  let pan = 0;
  let zoom = 0;
  let movement: { op: string; speed: number; startedAt: number } | null = null;

  function settle(): void {
    if (!movement) return;
    const elapsed = (Date.now() - movement.startedAt) / 1000;
    const rate = (movement.speed / 64) * 1.2;
    const direction = PAN_DIRECTION[movement.op] ?? 0;
    pan = Math.min(1, Math.max(-1, pan + direction * rate * elapsed));
    if (movement.op === 'ZoomInc') zoom = Math.min(1, zoom + 0.5 * elapsed);
    if (movement.op === 'ZoomDec') zoom = Math.max(0, zoom - 0.5 * elapsed);
    movement.startedAt = Date.now();
  }

  const validToken = (token: string | null): boolean => {
    if (!token) return false;
    const expires = tokens.get(token);
    if (expires === undefined) return false;
    if (expires < Date.now()) {
      tokens.delete(token);
      return false;
    }
    return true;
  };

  const fail = (cmd: string, rspCode: number, detail: string): Json => ({ cmd, code: 1, error: { detail, rspCode } });
  const ok = (cmd: string, value?: Json): Json => (value ? { cmd, code: 0, value } : { cmd, code: 0, value: { rspCode: 200 } });
  const permit = (v: number) => ({ permit: v > 0 ? 6 : 0, ver: v });

  function ability(): Json {
    const chn = {
      ptzType: permit(profile.ptzType),
      ptzCtrl: permit(profile.ptzType > 0 ? 1 : 0),
      ptzPreset: permit(profile.presets ? 1 : 0),
      floodLight: permit(profile.light ? 1 : 0),
      supportFLswitch: permit(profile.light ? 1 : 0),
      alarmAudio: permit(profile.siren ? 1 : 0),
      supportAudioAlarm: permit(profile.siren ? 1 : 0),
      mainEncType: permit(profile.mainCodec === 'h265' ? 1 : 0),
      snap: permit(1),
      live: permit(1),
    };
    return { Ability: { abilityChn: (channels ?? [null]).map(() => chn), talk: permit(profile.talk ? 1 : 0), rtsp: permit(3), onvif: permit(1) } };
  }

  function run(command: Json, token: string | null): Json {
    const cmd = typeof command.cmd === 'string' ? command.cmd : '';
    const param = (typeof command.param === 'object' && command.param !== null ? command.param : {}) as Json;
    commands.push(cmd);
    if (commands.length > 2000) commands.splice(0, 1000);

    if (cmd === 'Login') {
      const user = (typeof param.User === 'object' && param.User !== null ? param.User : {}) as Json;
      if (Date.now() < lockedUntil) return fail(cmd, -506, 'login locked');
      if (user.userName !== username || user.password !== password) {
        stats.failedLogins++;
        if (options.lockAfterFailures && ++failedInARow >= options.lockAfterFailures) {
          lockedUntil = Date.now() + (options.lockMs ?? 60_000);
          failedInARow = 0;
        }
        return fail(cmd, -7, 'login failed');
      }
      failedInARow = 0;
      for (const [known, expires] of tokens) if (expires < Date.now()) tokens.delete(known);
      if (tokens.size >= maxSessions) return fail(cmd, -5, 'max session');
      const granted = randomBytes(6).toString('hex');
      tokens.set(granted, Date.now() + leaseTime * 1000);
      stats.logins++;
      return { cmd, code: 0, value: { Token: { leaseTime, name: granted } } };
    }

    if (!validToken(token)) return fail(cmd, -6, 'please login first');
    if (failure) {
      const { rspCode } = failure;
      if (--failure.count <= 0) failure = null;
      return fail(cmd, rspCode, rspCode === -9 ? 'not support' : 'simulated failure');
    }

    const channel = typeof param.channel === 'number' ? param.channel : 0;
    switch (cmd) {
      case 'Logout':
        tokens.delete(token!);
        stats.logouts++;
        return ok(cmd);
      case 'GetDevInfo':
        return ok(cmd, {
          DevInfo: {
            B485: 0,
            IOInputNum: 0,
            IOOutputNum: 0,
            audioNum: 1,
            buildDay: 'build 24061312',
            cfgVer: 'v3.1.0.0',
            channelNum: channels?.length ?? 1,
            detail: 'IPC_523128M8MP',
            diskNum: 1,
            exactType: channels ? 'NVR' : 'IPC',
            firmVer: 'v3.1.0.3514_24061312',
            frameworkVer: 1,
            hardVer: 'IPC_523128M8MP',
            model: channels ? 'RLN8-410' : profile.model,
            name,
            pakSuffix: 'pak,paks',
            serial: '00000000000000',
            type: channels ? 'NVR' : 'IPC',
            wifi: 0,
          },
        });
      case 'GetAbility':
        return ok(cmd, ability());
      case 'GetChannelstatus':
        return ok(cmd, { count: channels?.length ?? 1, status: (channels ?? [{ name, online: true }]).map((entry, index) => ({ channel: index, name: entry.name, online: entry.online ? 1 : 0, typeInfo: entry.online ? profile.model : '' })) });
      case 'GetEnc':
        return ok(cmd, {
          Enc: {
            audio: 1,
            channel,
            mainStream: { bitRate: 6144, frameRate: 25, gop: 2, height: 2160, profile: 'High', size: '3840*2160', vType: profile.mainCodec, width: 3840 },
            subStream: { bitRate: 256, frameRate: 10, gop: 4, height: 360, profile: 'High', size: '640*360', vType: 'h264', width: 640 },
          },
        });
      case 'PtzCtrl': {
        if (profile.ptzType === 0) return fail(cmd, -9, 'not support');
        const op = typeof param.op === 'string' ? param.op : '';
        if (!KNOWN_OPS.has(op)) return fail(cmd, -4, 'param error');
        const speed = typeof param.speed === 'number' ? param.speed : null;
        // Zoom-only lenses know neither pan/tilt nor a speed.
        if (profile.ptzType === 1 && (op in PAN_DIRECTION || op === 'Up' || op === 'Down' || op === 'ToPos' || speed !== null)) return fail(cmd, -9, 'not support');
        const id = typeof param.id === 'number' ? param.id : null;
        ptzLog.push({ channel, op, speed, id, at: Date.now() });
        settle();
        if (op === 'Stop') movement = null;
        else if (op === 'ToPos') {
          const preset = DEMO_PRESETS.find((entry) => entry.id === id);
          if (!preset || !profile.presets) return fail(cmd, -4, 'param error');
          movement = null;
          pan = preset.pan;
        } else movement = { op, speed: speed ?? 32, startedAt: Date.now() };
        return ok(cmd);
      }
      case 'GetPtzPreset': {
        if (!profile.presets) return fail(cmd, -9, 'not support');
        // Cameras report all 64 slots; unused ones are disabled and carry a placeholder name.
        const PtzPreset = Array.from({ length: 8 }, (_, index) => {
          const preset = DEMO_PRESETS.find((entry) => entry.id === index);
          return { channel, enable: preset ? 1 : 0, id: index, name: preset?.name ?? `pos${index}` };
        });
        return ok(cmd, { PtzPreset });
      }
      case 'GetWhiteLed':
        if (!profile.light) return fail(cmd, -9, 'not support');
        return ok(cmd, { WhiteLed: { LightingSchedule: { EndHour: 6, EndMin: 0, StartHour: 18, StartMin: 0 }, bright: light.bright, channel, mode: light.mode, state: light.state, wlAiDetectType: { dog_cat: 0, face: 0, people: 1, vehicle: 0 } } });
      case 'SetWhiteLed': {
        if (!profile.light) return fail(cmd, -9, 'not support');
        const next = (param.WhiteLed ?? {}) as Json;
        if (typeof next.state === 'number') light.state = next.state ? 1 : 0;
        if (typeof next.bright === 'number') light.bright = next.bright;
        if (typeof next.mode === 'number') light.mode = next.mode;
        return ok(cmd);
      }
      case 'AudioAlarmPlay':
        if (!profile.siren) return fail(cmd, -9, 'not support');
        if (param.alarm_mode !== 'times' && param.alarm_mode !== 'manul') return fail(cmd, -4, 'param error');
        sirenCount++;
        return ok(cmd);
      default:
        return fail(cmd, -9, 'not support');
    }
  }


  // --- ONVIF --------------------------------------------------------------------------------------

  const clock = () => Date.now() + (options.clockSkewMs ?? 0);
  const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false, trimValues: true });
  const pick = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((current, key) => (typeof current === 'object' && current !== null ? (current as Json)[key] : undefined), value);
  const textOf = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'object' && value !== null && typeof (value as Json)['#text'] === 'string' ? ((value as Json)['#text'] as string) : '');
  const SOAP = 'http://www.w3.org/2003/05/soap-envelope';
  const ADVERTISED = 'http://192.0.2.10:8000';
  const panTilt = [2, 3, 5, 6, 7].includes(profile.ptzType);
  const zoomable = [1, 2, 5].includes(profile.ptzType);
  const PROFILES_XML = [
    { token: '000', name: 'mainStream', width: 2560, height: 1440, quality: 'main' },
    { token: '001', name: 'subStream', width: 640, height: 360, quality: 'sub' },
  ];

  function soapEnvelope(body: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="${SOAP}" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:ter="http://www.onvif.org/ver10/error"><SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
  }
  function soapFault(code: string, reason: string): string {
    return soapEnvelope(`<SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>SOAP-ENV:Sender</SOAP-ENV:Value><SOAP-ENV:Subcode><SOAP-ENV:Value>${code}</SOAP-ENV:Value></SOAP-ENV:Subcode></SOAP-ENV:Code><SOAP-ENV:Reason><SOAP-ENV:Text xml:lang="en">${reason}</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>`);
  }

  /** WS-Security UsernameToken with PasswordDigest, timestamp within five minutes of the camera's clock. */
  function onvifAuthorised(header: unknown): boolean {
    const token = pick(header, 'Security', 'UsernameToken');
    const user = textOf(pick(token, 'Username'));
    const digest = textOf(pick(token, 'Password'));
    const nonce = textOf(pick(token, 'Nonce'));
    const created = textOf(pick(token, 'Created'));
    if (!user || !digest || !nonce || !created) return false;
    const createdAt = Date.parse(created);
    if (!Number.isFinite(createdAt) || Math.abs(createdAt - clock()) > 5 * 60_000) return false;
    const expected = createHash('sha1').update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8')])).digest('base64');
    return user === username && expected === digest;
  }

  function onvif(service: string, raw: string): { status: number; body: string } {
    let parsed: unknown;
    try {
      parsed = xml.parse(raw);
    } catch {
      return { status: 400, body: soapFault('ter:InvalidArgVal', 'malformed request') };
    }
    const bodyNode = pick(parsed, 'Envelope', 'Body');
    const operation = typeof bodyNode === 'object' && bodyNode !== null ? Object.keys(bodyNode).find((key) => !key.startsWith('@_')) ?? '' : '';
    const request = pick(bodyNode, operation);
    commands.push(`onvif:${operation}`);
    if (commands.length > 2000) commands.splice(0, 1000);

    if (operation === 'GetSystemDateAndTime') {
      const now = new Date(clock());
      return {
        status: 200,
        body: soapEnvelope(
          `<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType><tt:DaylightSavings>false</tt:DaylightSavings><tt:UTCDateTime><tt:Time><tt:Hour>${now.getUTCHours()}</tt:Hour><tt:Minute>${now.getUTCMinutes()}</tt:Minute><tt:Second>${now.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${now.getUTCFullYear()}</tt:Year><tt:Month>${now.getUTCMonth() + 1}</tt:Month><tt:Day>${now.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`,
        ),
      };
    }
    if (Date.now() < lockedUntil) return { status: 400, body: soapFault('ter:NotAuthorized', 'Sender not Authorized') };
    if (!onvifAuthorised(pick(parsed, 'Envelope', 'Header'))) {
      stats.failedLogins++;
      if (options.lockAfterFailures && ++failedInARow >= options.lockAfterFailures) {
        lockedUntil = Date.now() + (options.lockMs ?? 60_000);
        failedInARow = 0;
      }
      return { status: 400, body: soapFault('ter:NotAuthorized', 'Sender not Authorized') };
    }
    failedInARow = 0;
    const ok = (body: string) => ({ status: 200, body: soapEnvelope(body) });
    const notSupported = () => ({ status: 400, body: soapFault('ter:ActionNotSupported', 'Optional Action Not Implemented') });

    switch (`${service}:${operation}`) {
      case 'device:GetDeviceInformation':
        return ok(`<tds:GetDeviceInformationResponse><tds:Manufacturer>Reolink</tds:Manufacturer><tds:Model>${profile.model}</tds:Model><tds:FirmwareVersion>v3.0.0.1889_23031701</tds:FirmwareVersion><tds:SerialNumber>00000000000000</tds:SerialNumber><tds:HardwareId>IPC_5161</tds:HardwareId></tds:GetDeviceInformationResponse>`);
      case 'device:GetCapabilities':
        // The camera reports its own idea of its address (here: a foreign one) — clients must only use the paths.
        return ok(
          `<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Device><tt:XAddr>${ADVERTISED}/onvif/device_service</tt:XAddr></tt:Device><tt:Media><tt:XAddr>${ADVERTISED}/onvif/media_service</tt:XAddr></tt:Media>` +
            (profile.ptzType > 0 ? `<tt:PTZ><tt:XAddr>${ADVERTISED}/onvif/ptz_service</tt:XAddr></tt:PTZ>` : '') +
            `</tds:Capabilities></tds:GetCapabilitiesResponse>`,
        );
      case 'media:GetProfiles':
        return ok(
          `<trt:GetProfilesResponse>${PROFILES_XML.map(
            (entry) =>
              `<trt:Profiles fixed="true" token="${entry.token}"><tt:Name>${entry.name}</tt:Name><tt:VideoEncoderConfiguration token="${entry.token}"><tt:Name>${entry.name}</tt:Name><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>${entry.width}</tt:Width><tt:Height>${entry.height}</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration>` +
              (profile.ptzType > 0 ? `<tt:PTZConfiguration token="000"><tt:Name>PTZ</tt:Name><tt:NodeToken>000</tt:NodeToken></tt:PTZConfiguration>` : '') +
              `</trt:Profiles>`,
          ).join('')}</trt:GetProfilesResponse>`,
        );
      case 'media:GetStreamUri': {
        const entry = PROFILES_XML.find((candidate) => candidate.token === textOf(pick(request, 'ProfileToken')));
        if (!entry) return { status: 400, body: soapFault('ter:NoProfile', 'Profile not exist') };
        return ok(`<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://192.0.2.10:554/h264Preview_01_${entry.quality}</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>false</tt:InvalidAfterReboot><tt:Timeout>PT0S</tt:Timeout></trt:MediaUri></trt:GetStreamUriResponse>`);
      }
      case 'ptz:GetNodes':
        if (profile.ptzType === 0) return notSupported();
        return ok(
          `<tptz:GetNodesResponse><tptz:PTZNode token="000"><tt:Name>PTZ</tt:Name><tt:SupportedPTZSpaces>` +
            (panTilt ? `<tt:ContinuousPanTiltVelocitySpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace</tt:URI></tt:ContinuousPanTiltVelocitySpace>` : '') +
            (zoomable ? `<tt:ContinuousZoomVelocitySpace><tt:URI>http://www.onvif.org/ver10/tptz/ZoomSpaces/VelocityGenericSpace</tt:URI></tt:ContinuousZoomVelocitySpace>` : '') +
            `</tt:SupportedPTZSpaces><tt:MaximumNumberOfPresets>${profile.presets ? 64 : 0}</tt:MaximumNumberOfPresets><tt:HomeSupported>false</tt:HomeSupported></tptz:PTZNode></tptz:GetNodesResponse>`,
        );
      case 'ptz:ContinuousMove': {
        if (profile.ptzType === 0) return notSupported();
        const velocity = pick(request, 'Velocity');
        const x = Number(pick(velocity, 'PanTilt', '@_x') ?? 0);
        const y = Number(pick(velocity, 'PanTilt', '@_y') ?? 0);
        const z = Number(pick(velocity, 'Zoom', '@_x') ?? 0);
        let op: string;
        if (z !== 0) op = z > 0 ? 'ZoomInc' : 'ZoomDec';
        else if (x < 0) op = y > 0 ? 'LeftUp' : y < 0 ? 'LeftDown' : 'Left';
        else if (x > 0) op = y > 0 ? 'RightUp' : y < 0 ? 'RightDown' : 'Right';
        else if (y !== 0) op = y > 0 ? 'Up' : 'Down';
        else return { status: 400, body: soapFault('ter:InvalidArgVal', 'no velocity') };
        if ((op.startsWith('Zoom') && !zoomable) || (!op.startsWith('Zoom') && !panTilt)) return { status: 400, body: soapFault('ter:InvalidArgVal', 'space not supported') };
        const speed = Math.round(Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) * 64);
        settle();
        ptzLog.push({ channel: 0, op, speed, id: null, at: Date.now() });
        movement = { op, speed, startedAt: Date.now() };
        return ok('<tptz:ContinuousMoveResponse/>');
      }
      case 'ptz:Stop':
        if (profile.ptzType === 0) return notSupported();
        settle();
        movement = null;
        ptzLog.push({ channel: 0, op: 'Stop', speed: null, id: null, at: Date.now() });
        return ok('<tptz:StopResponse/>');
      case 'ptz:GetPresets':
        if (!profile.presets) return ok('<tptz:GetPresetsResponse/>');
        return ok(`<tptz:GetPresetsResponse>${DEMO_PRESETS.map((preset) => `<tptz:Preset token="${preset.id}"><tt:Name>${preset.name}</tt:Name></tptz:Preset>`).join('')}</tptz:GetPresetsResponse>`);
      case 'ptz:GotoPreset': {
        const id = Number(textOf(pick(request, 'PresetToken')));
        const preset = DEMO_PRESETS.find((entry) => entry.id === id);
        if (!preset || !profile.presets) return { status: 400, body: soapFault('ter:NoToken', 'preset not exist') };
        settle();
        movement = null;
        pan = preset.pan;
        ptzLog.push({ channel: 0, op: 'ToPos', speed: null, id, at: Date.now() });
        return ok('<tptz:GotoPresetResponse/>');
      }
      default:
        return notSupported();
    }
  }

  // --- RTSP (DESCRIBE only) ---------------------------------------------------------------------------

  const rtspLog: { path: string; backchannel: boolean; authorised: boolean }[] = [];
  const rtspNonce = randomBytes(8).toString('hex');
  const REALM = 'BC Streaming Media';

  function rtspAnswer(request: string): string {
    const [first = '', ...lines] = request.split('\r\n');
    const [method = '', uri = ''] = first.split(' ');
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const cseq = headers.cseq ?? '0';
    const reply = (status: string, extra: string[] = [], body = '') =>
      [`RTSP/1.0 ${status}`, `CSeq: ${cseq}`, ...extra, ...(body ? ['Content-Type: application/sdp', `Content-Length: ${Buffer.byteLength(body)}`] : ['Content-Length: 0']), '', body].join('\r\n');
    if (method === 'OPTIONS') return reply('200 OK', ['Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN']);
    if (method !== 'DESCRIBE') return reply('405 Method Not Allowed');
    let path = '';
    try {
      path = new URL(uri).pathname;
    } catch {
      return reply('400 Bad Request');
    }
    const backchannel = /backchannel/i.test(headers.require ?? '');
    const auth = /^Digest\s+(.*)$/i.exec(headers.authorization ?? '');
    let authorised = false;
    if (auth) {
      const params: Record<string, string> = {};
      for (const part of auth[1]!.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/g)) params[part[1]!] = part[2] ?? part[3] ?? '';
      const md5 = (text: string) => createHash('md5').update(text).digest('hex');
      const expected = md5(`${md5(`${username}:${REALM}:${password}`)}:${rtspNonce}:${md5(`DESCRIBE:${params.uri}`)}`);
      authorised = params.username === username && params.nonce === rtspNonce && params.response === expected;
    }
    rtspLog.push({ path, backchannel, authorised });
    if (!authorised) return reply('401 Unauthorized', [`WWW-Authenticate: Digest realm="${REALM}", nonce="${rtspNonce}"`]);
    if (!/^\/(h264)?Preview_01_(main|sub)$/.test(path)) return reply('404 Not Found');
    const sdp = [
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=Session streamed by "preview"',
      't=0 0',
      'm=video 0 RTP/AVP 96',
      `a=rtpmap:96 ${profile.mainCodec === 'h265' && path.endsWith('main') ? 'H265' : 'H264'}/90000`,
      'a=control:trackID=1',
      'a=recvonly',
      'm=audio 0 RTP/AVP 97',
      'a=rtpmap:97 MPEG4-GENERIC/16000',
      'a=control:trackID=2',
      'a=recvonly',
      ...(backchannel && profile.talk ? ['m=audio 0 RTP/AVP 8', 'a=rtpmap:8 PCMA/8000', 'a=control:trackID=3', 'a=sendonly'] : []),
      '',
    ].join('\r\n');
    return reply('200 OK', [], sdp);
  }

  const rtspSockets = new Set<Socket>();
  const rtspServer = options.rtsp
    ? net.createServer((socket) => {
        rtspSockets.add(socket);
        socket.once('close', () => rtspSockets.delete(socket));
        let pending = '';
        socket.on('data', (chunk) => {
          pending += chunk.toString('latin1');
          let end: number;
          while ((end = pending.indexOf('\r\n\r\n')) >= 0) {
            const request = pending.slice(0, end);
            pending = pending.slice(end + 4);
            socket.write(rtspAnswer(request));
          }
        });
        socket.on('error', () => {});
      })
    : null;

  function send(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    // The API really serves its JSON as text/html.
    res.writeHead(status, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    void (async () => {
      stats.requests++;
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const service = /^\/onvif\/(device|media|ptz)_service$/.exec(url.pathname)?.[1];
      if (service && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const answer = onvif(service, Buffer.concat(chunks).toString('utf8'));
        res.writeHead(answer.status, { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(answer.body) });
        return void res.end(answer.body);
      }
      // Cameras without the HTTP interface (E1 series) only answer ONVIF here.
      if (!profile.httpApi || (url.pathname !== '/cgi-bin/api.cgi' && url.pathname !== '/api.cgi')) {
        res.writeHead(404);
        return void res.end();
      }
      const rawToken = url.searchParams.get('token');
      const token = rawToken && rawToken !== 'null' ? rawToken : null;

      if (req.method === 'GET' && url.searchParams.get('cmd') === 'Snap') {
        commands.push('Snap');
        if (!validToken(token)) return send(res, 200, [fail('Snap', -6, 'please login first')]);
        stats.snaps++;
        settle();
        const picture = renderScene({ kind: scene, label: name, pan, light: light.state === 1 });
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': picture.length });
        return void res.end(picture);
      }

      if (req.method !== 'POST') return send(res, 200, [fail(url.searchParams.get('cmd') ?? '', -1, 'not exist')]);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 200, [fail(url.searchParams.get('cmd') ?? '', -4, 'param error')]);
      }
      const list = (Array.isArray(body) ? body : [body]).filter((entry): entry is Json => typeof entry === 'object' && entry !== null);
      send(res, 200, list.map((command) => run(command, token)));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  const shut = () =>
    new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    });

  await listen(options.port ?? 0);
  const port = (server.address() as AddressInfo).port;
  if (rtspServer) await new Promise<void>((resolve) => rtspServer.listen(0, '127.0.0.1', () => resolve()));
  const rtspPort = rtspServer ? (rtspServer.address() as AddressInfo).port : 0;
  const closeRtsp = () =>
    new Promise<void>((resolve) => {
      if (!rtspServer?.listening) return resolve();
      rtspServer.close(() => resolve());
      for (const socket of rtspSockets) socket.destroy();
    });

  return {
    port,
    rtspPort,
    rtspLog,
    host: '127.0.0.1',
    get username() {
      return username;
    },
    get password() {
      return password;
    },
    settings(base) {
      return {
        host: '127.0.0.1',
        port,
        https: false,
        username,
        password,
        channel: 0,
        room: '',
        rtspPort: rtspPort || 554,
        streamProtocol: 'rtsp',
        connection: profile.httpApi ? 'api' : 'onvif',
        onvifPort: port,
        ...base,
      };
    },
    async close() {
      await Promise.all([shut(), closeRtsp()]);
    },
    frame() {
      settle();
      return renderScene({ kind: scene, label: name, pan, light: light.state === 1 });
    },
    ptzLog,
    get pan() {
      settle();
      return pan;
    },
    get zoom() {
      settle();
      return zoom;
    },
    get moving() {
      return movement !== null;
    },
    light,
    get sirenCount() {
      return sirenCount;
    },
    get sessions() {
      for (const [known, expires] of tokens) if (expires < Date.now()) tokens.delete(known);
      return tokens.size;
    },
    stats,
    commands,
    expireTokens() {
      tokens.clear();
    },
    async setOffline(offline) {
      if (offline) await shut();
      else if (!server.listening) await listen(port);
    },
    failNext(rspCode, count = 1) {
      failure = { rspCode, count };
    },
    setCredentials(nextUser, nextPassword) {
      username = nextUser;
      password = nextPassword;
    },
    setChannelOnline(channel, online) {
      const entry = channels?.[channel];
      if (entry) entry.online = online;
    },
  };
}
