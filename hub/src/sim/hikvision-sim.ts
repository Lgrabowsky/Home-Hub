import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import type { ReolinkDeviceSettings } from '@home-hub/shared';
import { renderScene } from './art.ts';

/**
 * Simulator of a Hikvision camera (or recorder) speaking ISAPI: XML over HTTP
 * with Digest authentication (MD5, qop=auth) on every request, Hikvision's
 * `ResponseStatus` answers and error shapes, and the "illegal login lock" that
 * blocks an address after repeated wrong passwords. Optionally also an RTSP
 * server that answers DESCRIBE (Digest) for `/Streaming/Channels/<id>`.
 */

export type HikvisionSimProfile = 'ptz' | 'turret' | 'varifocal';

export interface HikvisionSimOptions {
  /** 0 (default) picks a free port. */
  port?: number;
  username?: string;
  password?: string;
  name?: string;
  profile?: HikvisionSimProfile;
  scene?: 'garden' | 'driveway' | 'terrace';
  /** Codec of the two-way audio channel (profiles with a speaker). */
  talkCodec?: string;
  /** Sound in the video streams ("Video&Audio"). */
  streamAudio?: boolean;
  /** Behave like a recorder: `channels[n]` is camera D<n+1>, all with the profile's abilities. */
  nvr?: { channels: { name: string; online: boolean }[] };
  /** Lock logins after this many wrong passwords in a row (null = never). */
  lockAfterFailures?: number | null;
  lockMs?: number;
  /** Also start an RTSP server (DESCRIBE only). */
  rtsp?: boolean;
}

export interface HikvisionSimPtz {
  channel: number;
  pan: number;
  tilt: number;
  zoom: number;
  /** Preset id for a `goto`. */
  preset: number | null;
  at: number;
}

export interface HikvisionSim {
  readonly port: number;
  readonly rtspPort: number;
  readonly host: string;
  readonly username: string;
  readonly password: string;
  settings(base: { id: string; name: string } & Partial<ReolinkDeviceSettings>): ReolinkDeviceSettings;
  close(): Promise<void>;
  frame(): Buffer;
  /** Every continuous movement and preset call, oldest first. */
  readonly ptzLog: HikvisionSimPtz[];
  /** Pan position −1 (left) … 1 (right). */
  readonly pan: number;
  readonly zoom: number;
  readonly moving: boolean;
  readonly stats: { requests: number; authorised: number; failedLogins: number; pictures: number };
  /** Method and path of every authorised request, oldest first (the last 2000). */
  readonly requests: string[];
  readonly rtspLog: { path: string; authorised: boolean }[];
  /** Locked until (ms since epoch), 0 when not locked. */
  readonly lockedUntil: number;
  setCredentials(username: string, password: string): void;
  setOffline(offline: boolean): Promise<void>;
  setChannelOnline(channel: number, online: boolean): void;
  /** Releases a lock (as the camera does after its lock time). */
  unlock(): void;
}

interface Profile {
  model: string;
  deviceType: string;
  panTilt: boolean;
  zoom: boolean;
  presets: boolean;
  talk: boolean;
  mainCodec: string;
  main: [number, number];
}

const PROFILES: Record<HikvisionSimProfile, Profile> = {
  // Small pan/tilt/zoom dome.
  ptz: { model: 'DS-2DE2A404IW-DE3', deviceType: 'IPDome', panTilt: true, zoom: true, presets: true, talk: false, mainCodec: 'H.264', main: [2560, 1440] },
  // ColorVu turret with microphone and speaker.
  turret: { model: 'DS-2CD2387G2-LSU/SL', deviceType: 'IPCamera', panTilt: false, zoom: false, presets: false, talk: true, mainCodec: 'H.265', main: [3840, 2160] },
  // Fixed bullet with a motorised lens: zoom only.
  varifocal: { model: 'DS-2CD2646G2-IZS', deviceType: 'IPCamera', panTilt: false, zoom: true, presets: false, talk: false, mainCodec: 'H.264', main: [2688, 1520] },
};

const DEMO_PRESETS = [
  { id: 1, name: 'Hauseingang', pan: -0.6 },
  { id: 2, name: 'Zufahrt', pan: 0.1 },
  { id: 3, name: 'Briefkasten', pan: 0.7 },
];

/** The demo household's Hikvision camera. */
export const HIKVISION_DEMO_CAMERAS: readonly { device: { id: string; name: string; room: string }; sim: HikvisionSimOptions }[] = [
  { device: { id: 'carport', name: 'Carport', room: 'Außen' }, sim: { name: 'Carport', profile: 'ptz', scene: 'driveway' } },
];

const NS = 'http://www.hikvision.com/ver20/XMLSchema';
const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;

function responseStatus(url: string, statusCode: number, statusString: string, subStatusCode: string): string {
  return xml(
    `<ResponseStatus version="2.0" xmlns="${NS}"><requestURL>${url}</requestURL><statusCode>${statusCode}</statusCode><statusString>${statusString}</statusString><subStatusCode>${subStatusCode}</subStatusCode></ResponseStatus>`,
  );
}

const md5 = (text: string) => createHash('md5').update(text).digest('hex');

function digestParams(header: string): Record<string, string> | null {
  const match = /^Digest\s+(.*)$/is.exec(header);
  if (!match) return null;
  const params: Record<string, string> = {};
  for (const part of match[1]!.matchAll(/(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g)) params[part[1]!.toLowerCase()] = part[2] ?? part[3] ?? '';
  return params;
}

export async function startHikvisionSim(options: HikvisionSimOptions = {}): Promise<HikvisionSim> {
  let username = options.username ?? 'hub';
  let password = options.password ?? 'Hikvision-Demo-2026';
  const profile = PROFILES[options.profile ?? 'ptz'];
  const name = options.name ?? 'Kamera';
  const scene = options.scene ?? 'driveway';
  const talkCodec = options.talkCodec ?? 'G.711ulaw';
  const streamAudio = options.streamAudio ?? true;
  const channels = options.nvr?.channels.map((channel) => ({ ...channel })) ?? null;
  const lockAfter = options.lockAfterFailures === undefined ? 5 : options.lockAfterFailures;
  const lockMs = options.lockMs ?? 30 * 60_000;
  const realm = `IP Camera(${randomBytes(3).toString('hex').toUpperCase()})`;

  const ptzLog: HikvisionSimPtz[] = [];
  const requests: string[] = [];
  const stats = { requests: 0, authorised: 0, failedLogins: 0, pictures: 0 };
  const nonces = new Set<string>();
  let failedInARow = 0;
  let lockedUntil = 0;

  let pan = 0;
  let zoom = 0;
  let movement: { pan: number; zoom: number; startedAt: number } | null = null;

  function settle(): void {
    if (!movement) return;
    const elapsed = (Date.now() - movement.startedAt) / 1000;
    pan = Math.min(1, Math.max(-1, pan + (movement.pan / 100) * 1.2 * elapsed));
    zoom = Math.min(1, Math.max(0, zoom + (movement.zoom / 100) * 0.8 * elapsed));
    movement.startedAt = Date.now();
  }

  const newNonce = () => {
    const nonce = randomBytes(16).toString('hex');
    nonces.add(nonce);
    if (nonces.size > 200) nonces.delete(nonces.values().next().value!);
    return nonce;
  };

  /** null when authorised; otherwise the 401 to send. */
  function authorise(req: http.IncomingMessage): { status: number; headers: Record<string, string>; body: string } | null {
    const unauthorised = (lock: boolean) => {
      const remaining = Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));
      return {
        status: 401,
        headers: { 'WWW-Authenticate': `Digest qop="auth", realm="${realm}", nonce="${newNonce()}", stale="FALSE"`, 'Content-Type': 'application/xml' },
        body: xml(
          `<userCheck version="2.0" xmlns="${NS}"><statusValue>401</statusValue><statusString>Unauthorized</statusString><lockStatus>${lock ? 'lock' : 'unlock'}</lockStatus><unlockTime>${lock ? remaining : 0}</unlockTime><retryLoginTime>${lockAfter === null ? 0 : Math.max(0, lockAfter - failedInARow)}</retryLoginTime></userCheck>`,
        ),
      };
    };
    if (lockedUntil > Date.now()) return unauthorised(true);
    const params = digestParams(req.headers.authorization ?? '');
    if (!params) return unauthorised(false);
    const known = params.nonce !== undefined && nonces.has(params.nonce);
    const ha1 = md5(`${params.username}:${realm}:${password}`);
    const ha2 = md5(`${req.method}:${params.uri}`);
    const expected = params.qop ? md5(`${ha1}:${params.nonce}:${params.nc}:${params.cnonce}:${params.qop}:${ha2}`) : md5(`${ha1}:${params.nonce}:${ha2}`);
    if (known && params.username === username && params.response === expected && params.uri === req.url) {
      failedInARow = 0;
      return null;
    }
    // A stale nonce is not a wrong password.
    if (!known) return unauthorised(false);
    stats.failedLogins++;
    failedInARow++;
    if (lockAfter !== null && failedInARow >= lockAfter) {
      lockedUntil = Date.now() + lockMs;
      failedInARow = 0;
      return unauthorised(true);
    }
    return unauthorised(false);
  }

  const notSupported = (url: string) => ({ status: 403, body: responseStatus(url, 4, 'Invalid Operation', 'notSupport') });
  const ok = (url: string) => ({ status: 200, body: responseStatus(url, 1, 'OK', 'ok') });

  /** Channel number from a path, checked against the device (1 on a camera, 1…n on a recorder). */
  const channelOk = (no: number) => (channels ? no >= 1 && no <= channels.length && channels[no - 1]!.online : no === 1);

  function streaming(id: string): string {
    const quality = id.endsWith('01') ? 'main' : 'sub';
    const [width, height] = quality === 'main' ? profile.main : [640, 360];
    const codec = quality === 'main' ? profile.mainCodec : 'H.264';
    return xml(
      `<StreamingChannel version="2.0" xmlns="${NS}"><id>${id}</id><channelName>${name}</channelName><enabled>true</enabled>` +
        `<Video><enabled>true</enabled><videoInputChannelID>1</videoInputChannelID><videoCodecType>${codec}</videoCodecType><videoResolutionWidth>${width}</videoResolutionWidth><videoResolutionHeight>${height}</videoResolutionHeight><maxFrameRate>2500</maxFrameRate></Video>` +
        `<Audio><enabled>${streamAudio}</enabled><audioInputChannelID>1</audioInputChannelID><audioCompressionType>G.711ulaw</audioCompressionType></Audio></StreamingChannel>`,
    );
  }

  function ptzCapabilities(): string {
    const range = (tag: string) => `<${tag}><min>-100</min><max>100</max></${tag}>`;
    return xml(
      `<PTZChanelCap version="2.0" xmlns="${NS}">` +
        (profile.panTilt ? `<ContinuousPanTiltSpace>${range('XRange')}${range('YRange')}</ContinuousPanTiltSpace>` : '') +
        (profile.zoom ? `<ContinuousZoomSpace>${range('ZRange')}</ContinuousZoomSpace>` : '') +
        (profile.presets ? '<maxPresetNum>300</maxPresetNum><PresetNameCap><presetNameSupport>true</presetNameSupport></PresetNameCap>' : '') +
        '</PTZChanelCap>',
    );
  }

  function handle(method: string, path: string, body: string): { status: number; body: string; type?: string; binary?: Buffer } {
    if (method === 'GET' && path === '/ISAPI/System/deviceInfo') {
      return {
        status: 200,
        body: xml(
          `<DeviceInfo version="2.0" xmlns="${NS}"><deviceName>${name}</deviceName><deviceID>sim-${name}</deviceID><model>${channels ? 'DS-7608NXI-K2' : profile.model}</model><serialNumber>SIM000000000</serialNumber><macAddress>c0:56:e3:00:00:01</macAddress><firmwareVersion>V5.7.15</firmwareVersion><firmwareReleasedDate>build 231120</firmwareReleasedDate><deviceType>${channels ? 'NVR' : profile.deviceType}</deviceType></DeviceInfo>`,
        ),
      };
    }
    if (method === 'GET' && path === '/ISAPI/ContentMgmt/InputProxy/channels/status') {
      if (!channels) return notSupported(path);
      return {
        status: 200,
        body: xml(
          `<InputProxyChannelStatusList version="2.0" xmlns="${NS}">${channels
            .map((channel, index) => `<InputProxyChannelStatus><id>${index + 1}</id><name>${channel.name}</name><online>${channel.online}</online></InputProxyChannelStatus>`)
            .join('')}</InputProxyChannelStatusList>`,
        ),
      };
    }
    if (method === 'GET' && path === '/ISAPI/System/TwoWayAudio/channels') {
      if (!profile.talk || channels) return notSupported(path);
      return {
        status: 200,
        body: xml(
          `<TwoWayAudioChannelList version="2.0" xmlns="${NS}"><TwoWayAudioChannel><id>1</id><enabled>false</enabled><audioCompressionType>${talkCodec}</audioCompressionType><speakerVolume>50</speakerVolume></TwoWayAudioChannel></TwoWayAudioChannelList>`,
        ),
      };
    }
    const stream = /^\/ISAPI\/Streaming\/channels\/(\d+)(\/picture)?$/i.exec(path);
    if (stream && method === 'GET') {
      const id = stream[1]!;
      const no = Number(id.slice(0, -2));
      if (!channelOk(no) || !/0[12]$/.test(id)) return { status: 404, body: responseStatus(path, 4, 'Invalid Operation', 'invalidID') };
      if (!stream[2]) return { status: 200, body: streaming(id) };
      stats.pictures++;
      settle();
      return { status: 200, body: '', type: 'image/jpeg', binary: renderScene({ kind: scene, label: name, pan }) };
    }
    const ptz = /^\/ISAPI\/(PTZCtrl|ContentMgmt\/PTZCtrlProxy)\/channels\/(\d+)\/(capabilities|continuous|presets)(?:\/(\d+)\/goto)?$/i.exec(path);
    if (ptz) {
      const proxy = ptz[1] !== 'PTZCtrl';
      const no = Number(ptz[2]);
      // A recorder answers only through its proxy, a camera only directly.
      if (proxy !== Boolean(channels) || !channelOk(no) || (!profile.panTilt && !profile.zoom)) return notSupported(path);
      const what = ptz[3]!.toLowerCase();
      if (what === 'capabilities' && method === 'GET') return { status: 200, body: ptzCapabilities() };
      if (what === 'continuous' && method === 'PUT') {
        const value = (tag: string) => {
          const match = new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`).exec(body);
          return match ? Number(match[1]) : null;
        };
        const p = value('pan');
        const t = value('tilt');
        const z = value('zoom');
        if ((p !== null || t !== null) && !profile.panTilt) return { status: 400, body: responseStatus(path, 6, 'Invalid Content', 'badParameters') };
        if ((p ?? 0) < -100 || (p ?? 0) > 100 || (t ?? 0) < -100 || (t ?? 0) > 100 || (z ?? 0) < -100 || (z ?? 0) > 100) return { status: 400, body: responseStatus(path, 6, 'Invalid Content', 'badParameters') };
        settle();
        ptzLog.push({ channel: no, pan: p ?? 0, tilt: t ?? 0, zoom: z ?? 0, preset: null, at: Date.now() });
        movement = p || t || z ? { pan: p ?? 0, zoom: z ?? 0, startedAt: Date.now() } : null;
        return ok(path);
      }
      if (what === 'presets') {
        if (!profile.presets) return notSupported(path);
        if (ptz[4] && method === 'PUT') {
          const preset = DEMO_PRESETS.find((entry) => entry.id === Number(ptz[4]));
          if (!preset) return { status: 400, body: responseStatus(path, 6, 'Invalid Content', 'badParameters') };
          settle();
          movement = null;
          pan = preset.pan;
          ptzLog.push({ channel: no, pan: 0, tilt: 0, zoom: 0, preset: preset.id, at: Date.now() });
          return ok(path);
        }
        if (!ptz[4] && method === 'GET') {
          return {
            status: 200,
            body: xml(
              `<PTZPresetList version="2.0" xmlns="${NS}">${DEMO_PRESETS.map((preset) => `<PTZPreset><enabled>true</enabled><id>${preset.id}</id><presetName>${preset.name}</presetName></PTZPreset>`).join('')}</PTZPresetList>`,
            ),
          };
        }
      }
      return { status: 405, body: responseStatus(path, 4, 'Invalid Operation', 'methodNotAllowed') };
    }
    return { status: 404, body: responseStatus(path, 4, 'Invalid Operation', 'notSupport') };
  }

  // --- RTSP (DESCRIBE only) ---------------------------------------------------------------------------

  const rtspLog: { path: string; authorised: boolean }[] = [];
  const rtspNonce = randomBytes(8).toString('hex');
  const RTSP_REALM = 'Hikvision';

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
    // Hikvision's RTSP server does not know ONVIF's back channel.
    if (headers.require) return reply('551 Option not supported', [`Unsupported: ${headers.require}`]);
    let path = '';
    try {
      path = new URL(uri).pathname;
    } catch {
      return reply('400 Bad Request');
    }
    const params = digestParams(headers.authorization ?? '');
    const authorised =
      params !== null && params.username === username && params.nonce === rtspNonce && params.response === md5(`${md5(`${username}:${RTSP_REALM}:${password}`)}:${rtspNonce}:${md5(`DESCRIBE:${params.uri}`)}`);
    rtspLog.push({ path, authorised });
    if (!authorised) return reply('401 Unauthorized', [`WWW-Authenticate: Digest realm="${RTSP_REALM}", nonce="${rtspNonce}", stale="FALSE"`]);
    const match = /^\/Streaming\/Channels\/(\d+)0([12])$/i.exec(path);
    if (!match || !channelOk(Number(match[1]))) return reply('404 Not Found');
    const sdp = [
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=Media Presentation',
      't=0 0',
      'm=video 0 RTP/AVP 96',
      `a=rtpmap:96 ${match[2] === '1' && /265/.test(profile.mainCodec) ? 'H265' : 'H264'}/90000`,
      'a=control:trackID=1',
      ...(streamAudio ? ['m=audio 0 RTP/AVP 0', 'a=rtpmap:0 PCMU/8000', 'a=control:trackID=2'] : []),
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

  // --- HTTP ---------------------------------------------------------------------------------------------

  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    void (async () => {
      stats.requests++;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const refused = authorise(req);
      if (refused) {
        res.writeHead(refused.status, { ...refused.headers, 'Content-Length': Buffer.byteLength(refused.body) });
        return void res.end(refused.body);
      }
      stats.authorised++;
      const method = req.method ?? 'GET';
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      requests.push(`${method} ${path}`);
      if (requests.length > 2000) requests.splice(0, requests.length - 2000);
      const answer = handle(method, path, Buffer.concat(chunks).toString('utf8'));
      if (answer.binary) {
        res.writeHead(answer.status, { 'Content-Type': answer.type ?? 'application/octet-stream', 'Content-Length': answer.binary.length });
        return void res.end(answer.binary);
      }
      res.writeHead(answer.status, { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(answer.body) });
      res.end(answer.body);
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
        connection: 'hikvision',
        onvifPort: 8000,
        ...base,
      };
    },
    async close() {
      await Promise.all([shut(), closeRtsp()]);
    },
    frame() {
      settle();
      return renderScene({ kind: scene, label: name, pan });
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
    stats,
    requests,
    rtspLog,
    get lockedUntil() {
      return lockedUntil > Date.now() ? lockedUntil : 0;
    },
    setCredentials(nextUser, nextPassword) {
      username = nextUser;
      password = nextPassword;
    },
    async setOffline(offline) {
      if (offline) await shut();
      else if (!server.listening) await listen(port);
    },
    setChannelOnline(channel, online) {
      const entry = channels?.[channel];
      if (entry) entry.online = online;
    },
    unlock() {
      lockedUntil = 0;
      failedInARow = 0;
    },
  };
}
