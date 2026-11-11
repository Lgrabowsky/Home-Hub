import { createHash, randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { DoorBirdDeviceSettings } from '@home-hub/shared';
import { renderScene } from './art.ts';

/**
 * In-process DoorBird door station speaking the LAN API (rev. 0.36) the way
 * the reference implementations see it on the wire:
 *
 * - `/bha-api/info.cgi`, `image.cgi`, `history.cgi`, `open-door.cgi`,
 *   `light-on.cgi`, `monitor.cgi` — payloads as in doorbirdpy's fixtures,
 *   the event stream exactly as nymea's plugin documents it;
 * - `audio-receive.cgi` (G.711 µ-law, silence) and `audio-transmit.cgi` (a
 *   sink, one talker at a time), so that go2rtc's `doorbird://` sources can
 *   connect in demo mode. There is no RTSP video;
 * - HTTP Digest (RFC 2617, a fresh nonce with every 401) and Basic with the
 *   realm "DoorBird" — every 401 offers both; like the real device it also
 *   accepts the credentials as `http-user` / `http-password` query parameters
 *   (go2rtc sends them so);
 * - status codes: 401 wrong login or no "API-Operator", 423 locked, 204 no
 *   permission, 404 no such history picture, 503 busy, 509 too many event streams.
 *
 * One instance is one door station. The pictures are drawn, the household is invented.
 */

export type DoorBirdSimEvent = 'doorbell' | 'motionsensor';

export interface DoorBirdSimOptions {
  /** 0 (default) = any free port. */
  port?: number;
  host?: string;
  username?: string;
  password?: string;
  /** Which login challenge the device sends. `digest` (default) offers Digest and Basic and accepts both; `basic` knows Basic only. */
  auth?: 'digest' | 'basic';
  /** Fault injection: every answer to the Digest challenge is refused (a Digest implementation the hub cannot talk to). Basic works. */
  rejectDigest?: boolean;
  /** Name shown in the camera picture. */
  name?: string;
  scene?: 'door' | 'side-door';
  /** DEVICE-TYPE of `info.cgi`. */
  model?: string;
  firmware?: string;
  buildNumber?: string;
  mac?: string;
  /** RELAYS of `info.cgi`. `null` = firmware older than 000108: neither RELAYS nor DEVICE-TYPE are reported. */
  relays?: string[] | null;
  /** The device repeats the current state at this interval (real: about 20 s). 0 = never. */
  heartbeatMs?: number;
  /** How long a signal stays "H" after `ring()` / `motion()`. */
  pulseMs?: number;
  /** The device files the picture of an event in its history this long after the event. */
  historyDelayMs?: number;
  /** More simultaneous event streams than this are refused with HTTP 509 (real: 8). */
  maxMonitorStreams?: number;
  /** Number of history pictures present at start. Default: a few of each. */
  history?: { doorbell?: number; motionsensor?: number };
  /** false = firmware that does not send `X-Timestamp` with history pictures. */
  timestampHeader?: boolean;
  /** Permissions of the API user as set in the DoorBird app. */
  permissions?: Partial<DoorBirdSimPermissions>;
  /** How missing "watch always" shows for commands: `{"BHA":{"RETURNCODE":"204"}}` (default) or HTTP 204. */
  denyStyle?: 'returncode' | 'http';
  /** After this many wrong logins every request is answered with 423 for `lockMs`. 0 (default) = never. */
  lockAfterFailures?: number;
  lockMs?: number;
  /** Lifetime of a Digest nonce; older ones are answered with `stale=true`. */
  nonceLifetimeMs?: number;
}

export interface DoorBirdSimPermissions {
  /** "API-Operator": without it every API call is answered with 401. */
  apiOperator: boolean;
  /** "Immer ansehen": live picture, door opener, light. */
  watchAlways: boolean;
  /** "Verlauf": history pictures. */
  history: boolean;
}

export interface DoorBirdSimRequest {
  at: number;
  method: string;
  /** Path with query string (a password given as query parameter is masked). */
  path: string;
  status: number;
  /** How the request tried to authenticate. */
  auth: 'none' | 'basic' | 'digest' | 'query';
}

export interface DoorBirdSimHistoryEntry {
  /** Time of the event (ms). `X-Timestamp` carries it in seconds. */
  at: number;
  person: boolean;
}

export interface DoorBirdSim {
  readonly host: string;
  readonly port: number;
  /** `host:port`, as it goes into the hub's device settings. */
  readonly address: string;
  readonly username: string;
  readonly password: string;
  close(): Promise<void>;
  /** Device settings for the hub that point at this simulator. */
  settings(base: { id: string; name: string } & Partial<DoorBirdDeviceSettings>): DoorBirdDeviceSettings;

  /** Somebody presses the bell button. */
  ring(): void;
  /** The motion sensor fires. */
  motion(): void;
  /** Every relay that was triggered, oldest first. */
  readonly opened: { relay: string; at: number }[];
  /** How often the light was switched on. */
  readonly lightOn: number;
  /** The device's own history, newest first (index 1 of `history.cgi` is element 0). */
  readonly history: Record<DoorBirdSimEvent, DoorBirdSimHistoryEntry[]>;
  /** Adds a picture to the device's history as if the event had happened at `at`. */
  addHistory(event: DoorBirdSimEvent, at: number, person?: boolean): void;
  /** Mutable: change what the API user may do. */
  readonly permissions: DoorBirdSimPermissions;

  /** Takes the device off the network (connections are refused) or brings it back on the same port. */
  setOffline(offline: boolean): Promise<void>;
  /** Cuts all open event streams, as a restart of the device or a network hiccup would. */
  dropMonitorStreams(): void;
  /** The next `count` API requests are answered with this HTTP status (e.g. 503 = busy). */
  failNext(status: number, count?: number): void;

  /** Every request that reached the device, oldest first (the last 1000). */
  readonly requests: DoorBirdSimRequest[];
  readonly stats: {
    /** All 401 answers. */
    unauthorized: number;
    /** 401 answers to requests that carried wrong credentials. */
    failedLogins: number;
    /** 423 answers. */
    locked: number;
    /** Event streams opened so far. */
    monitorOpened: number;
    /** TCP connections accepted so far. */
    connections: number;
    /** Bytes of intercom audio received through `audio-transmit.cgi`. */
    audioBytes: number;
  };
  /** Event streams open right now. */
  readonly monitorStreams: number;
  /** Somebody is talking to the door right now (`audio-transmit.cgi` is open). */
  readonly talking: boolean;
}

/** The demo household: what the two door stations look like and how the hub should name them. */
export const DOORBIRD_DEMO_STATIONS: readonly {
  device: { id: string; name: string; room: string; relayNames: Record<string, string> };
  sim: DoorBirdSimOptions;
}[] = [
  {
    device: { id: 'haustuer', name: 'Haustür', room: 'Eingang', relayNames: { '1': 'Haustür', '2': 'Gartentor' } },
    sim: { name: 'Haustür', scene: 'door', model: 'DoorBird D2101V', relays: ['1', '2'], mac: '1CCAE3A10F42', username: 'ghhaus0001' },
  },
  {
    device: { id: 'seiteneingang', name: 'Seiteneingang', room: 'Hauswirtschaftsraum', relayNames: { '1': 'Seitentür' } },
    sim: { name: 'Seiteneingang', scene: 'side-door', model: 'DoorBird D1101V', relays: ['1'], mac: '1CCAE3A2B7C9', username: 'ghseit0001' },
  },
];

const REALM = 'DoorBird';
const BOUNDARY = '--ioboundary';
/** The device keeps this many pictures per event type. */
const HISTORY_SIZE = 50;
const MAX_LOGGED_REQUESTS = 1000;
const PERSON_STAYS_MS = 20_000;
/** The device switches its light off again by itself after three minutes. */
const LIGHT_STAYS_MS = 3 * 60_000;
/** 20 ms of silence in G.711 µ-law at 8 kHz, the format of `audio-receive.cgi`. */
const SILENCE = Buffer.alloc(160, 0xff);

interface MonitorStream {
  response: ServerResponse;
  signals: DoorBirdSimEvent[];
  heartbeat: NodeJS.Timeout | null;
}

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

function parseAuthParams(text: string): Record<string, string> {
  const params: Record<string, string> = {};
  const pattern = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi;
  for (const match of text.matchAll(pattern)) {
    params[match[1]!.toLowerCase()] = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3]!;
  }
  return params;
}

export async function startDoorBirdSim(options: DoorBirdSimOptions = {}): Promise<DoorBirdSim> {
  const host = options.host ?? '127.0.0.1';
  const username = options.username ?? 'ghdemo0001';
  const password = options.password ?? 'Kb7mQx2pWz';
  const authMode = options.auth ?? 'digest';
  const name = options.name ?? 'Haustür';
  const scene = options.scene ?? 'door';
  const relays = options.relays === undefined ? ['1', '2'] : options.relays;
  const heartbeatMs = options.heartbeatMs ?? 20_000;
  const pulseMs = options.pulseMs ?? 2_000;
  const historyDelayMs = options.historyDelayMs ?? 2_000;
  const maxMonitorStreams = options.maxMonitorStreams ?? 8;
  const timestampHeader = options.timestampHeader ?? true;
  const denyStyle = options.denyStyle ?? 'returncode';
  const lockAfterFailures = options.lockAfterFailures ?? 0;
  const lockMs = options.lockMs ?? 5 * 60_000;
  const nonceLifetimeMs = options.nonceLifetimeMs ?? 5 * 60_000;
  const permissions: DoorBirdSimPermissions = { apiOperator: true, watchAlways: true, history: true, ...options.permissions };

  const opened: { relay: string; at: number }[] = [];
  const requests: DoorBirdSimRequest[] = [];
  const stats = { unauthorized: 0, failedLogins: 0, locked: 0, monitorOpened: 0, connections: 0, audioBytes: 0 };
  const history: Record<DoorBirdSimEvent, DoorBirdSimHistoryEntry[]> = { doorbell: [], motionsensor: [] };
  const pictures = new WeakMap<DoorBirdSimHistoryEntry, Buffer>();
  const levels: Record<DoorBirdSimEvent, boolean> = { doorbell: false, motionsensor: false };
  const lowTimers: Record<DoorBirdSimEvent, NodeJS.Timeout | null> = { doorbell: null, motionsensor: null };
  const pendingTimers = new Set<NodeJS.Timeout>();
  const monitors = new Set<MonitorStream>();
  const audioTimers = new Set<NodeJS.Timeout>();
  const sockets = new Set<Socket>();
  const nonces = new Map<string, number>();
  const forced: number[] = [];
  let lightOn = 0;
  let lightUntil = 0;
  let personUntil = 0;
  let recentFailures = 0;
  let lockedUntil = 0;
  let listening = false;
  let closed = false;
  let talking = false;
  let live: { second: number; key: string; image: Buffer } | null = null;

  // --- History -----------------------------------------------------------------------

  function addHistory(event: DoorBirdSimEvent, at: number, person = event === 'doorbell'): void {
    const list = history[event];
    list.push({ at, person });
    list.sort((a, b) => b.at - a.at);
    list.length = Math.min(list.length, HISTORY_SIZE);
  }

  function historyPicture(entry: DoorBirdSimHistoryEntry): Buffer {
    let image = pictures.get(entry);
    if (!image) {
      image = renderScene({ kind: scene, label: name, person: entry.person, time: new Date(entry.at) });
      pictures.set(entry, image);
    }
    return image;
  }

  function livePicture(): Buffer {
    const now = Date.now();
    const person = now < personUntil;
    const light = now < lightUntil;
    const second = Math.floor(now / 1000);
    const key = `${person}/${light}`;
    // The overlay shows the time to the second: one drawing per second is enough.
    if (!live || live.second !== second || live.key !== key) {
      live = { second, key, image: renderScene({ kind: scene, label: name, person, light, time: new Date(now) }) };
    }
    return live.image;
  }

  const seeded = { doorbell: options.history?.doorbell ?? 4, motionsensor: options.history?.motionsensor ?? 6 };
  const startedAt = Date.now();
  for (let i = 0; i < Math.min(seeded.doorbell, HISTORY_SIZE); i++) addHistory('doorbell', startedAt - (i * 7 + 2) * 3_600_000 - i * 23 * 60_000, true);
  for (let i = 0; i < Math.min(seeded.motionsensor, HISTORY_SIZE); i++) {
    addHistory('motionsensor', startedAt - (i * 3 + 1) * 3_600_000 - i * 11 * 60_000, i % 3 === 0);
  }

  // --- Event stream ------------------------------------------------------------------

  /** One part of the stream, byte for byte as the device writes it (nymea doorbird.cpp). */
  function part(signal: DoorBirdSimEvent): string {
    return `${BOUNDARY}\r\nContent-Type: text/plain\r\n\r\n${signal}:${levels[signal] ? 'H' : 'L'}\r\n\r\n`;
  }

  function broadcast(signal: DoorBirdSimEvent): void {
    for (const stream of monitors) {
      if (stream.signals.includes(signal)) stream.response.write(part(signal));
    }
  }

  function trigger(signal: DoorBirdSimEvent, person: boolean): void {
    if (closed) return;
    const at = Date.now();
    if (person) personUntil = at + PERSON_STAYS_MS;
    levels[signal] = true;
    broadcast(signal);
    const previous = lowTimers[signal];
    if (previous) clearTimeout(previous);
    lowTimers[signal] = setTimeout(() => {
      lowTimers[signal] = null;
      levels[signal] = false;
      broadcast(signal);
    }, pulseMs);
    // The picture of the event appears in the device's history a moment later (FHEM waits 7 s for it).
    const filed = setTimeout(() => {
      pendingTimers.delete(filed);
      addHistory(signal, at, person);
    }, historyDelayMs);
    pendingTimers.add(filed);
  }

  function closeStream(stream: MonitorStream): void {
    if (stream.heartbeat) clearInterval(stream.heartbeat);
    stream.heartbeat = null;
    monitors.delete(stream);
  }

  // --- Authentication ------------------------------------------------------------------

  function challenge(stale: boolean): string | string[] {
    if (authMode === 'basic') return `Basic realm="${REALM}"`;
    const now = Date.now();
    for (const [nonce, issuedAt] of nonces) {
      if (now - issuedAt > nonceLifetimeMs || nonces.size > 200) nonces.delete(nonce);
    }
    const nonce = randomBytes(16).toString('hex');
    nonces.set(nonce, now);
    return [`Digest realm="${REALM}", nonce="${nonce}", qop="auth"${stale ? ', stale=true' : ''}`, `Basic realm="${REALM}"`];
  }

  /** `ok`, `none` (no credentials), `wrong`, or `stale` (right scheme, but the nonce is not valid any more). */
  function authenticate(request: IncomingMessage, url: URL): { result: 'ok' | 'none' | 'wrong' | 'stale'; via: DoorBirdSimRequest['auth'] } {
    const queryUser = url.searchParams.get('http-user');
    const queryPassword = url.searchParams.get('http-password');
    if (queryUser !== null && queryPassword !== null) {
      return { result: queryUser === username && queryPassword === password ? 'ok' : 'wrong', via: 'query' };
    }
    const header = request.headers.authorization ?? '';
    if (/^basic\s/i.test(header)) {
      const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
      return { result: decoded === `${username}:${password}` ? 'ok' : 'wrong', via: 'basic' };
    }
    if (/^digest\s/i.test(header)) {
      if (authMode === 'basic' || options.rejectDigest) return { result: 'wrong', via: 'digest' };
      const params = parseAuthParams(header.slice(7));
      const issuedAt = params.nonce === undefined ? undefined : nonces.get(params.nonce);
      if (issuedAt === undefined || Date.now() - issuedAt > nonceLifetimeMs) return { result: 'stale', via: 'digest' };
      const ha1 = md5(`${username}:${REALM}:${password}`);
      const ha2 = md5(`${request.method ?? 'GET'}:${params.uri ?? ''}`);
      const expected =
        params.qop === undefined
          ? md5(`${ha1}:${params.nonce}:${ha2}`)
          : md5(`${ha1}:${params.nonce}:${params.nc ?? ''}:${params.cnonce ?? ''}:${params.qop}:${ha2}`);
      const valid = params.username === username && params.realm === REALM && params.uri === request.url && params.response === expected;
      return { result: valid ? 'ok' : 'wrong', via: 'digest' };
    }
    return { result: 'none', via: 'none' };
  }

  // --- Requests ----------------------------------------------------------------------

  function handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', 'http://doorbird.invalid');
    const login = authenticate(request, url);
    const entry: DoorBirdSimRequest = {
      at: Date.now(),
      method: request.method ?? 'GET',
      path: (request.url ?? '/').replace(/(http-password=)[^&]*/i, '$1***'),
      status: 0,
      auth: login.via,
    };
    requests.push(entry);
    if (requests.length > MAX_LOGGED_REQUESTS) requests.shift();

    const send = (status: number, headers: Record<string, string | string[]> = {}, body: Buffer | string = ''): void => {
      entry.status = status;
      const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      // 204 never carries a body (RFC 7230).
      response.writeHead(status, status === 204 ? headers : { ...headers, 'Content-Length': String(data.length) });
      response.end(status === 204 ? undefined : data);
    };
    const json = (value: unknown): void => send(200, { 'Content-Type': 'application/json' }, JSON.stringify(value));
    const returnCode = (code: string): void => json({ BHA: { RETURNCODE: code } });
    const picture = (image: Buffer, headers: Record<string, string> = {}): void => {
      const png = image[0] === 0x89;
      send(200, { 'Content-Type': png ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-cache', ...headers }, image);
    };

    if (!url.pathname.startsWith('/bha-api/')) return send(404, { 'Content-Type': 'text/plain' }, 'Not Found');

    const now = Date.now();
    if (now < lockedUntil) {
      stats.locked++;
      return send(423, { 'Content-Type': 'text/plain' }, 'Locked');
    }
    if (login.result !== 'ok' || !permissions.apiOperator) {
      stats.unauthorized++;
      if (login.result === 'wrong') {
        stats.failedLogins++;
        recentFailures++;
        if (lockAfterFailures > 0 && recentFailures >= lockAfterFailures) {
          recentFailures = 0;
          lockedUntil = now + lockMs;
        }
      }
      return send(401, { 'WWW-Authenticate': challenge(login.result === 'stale'), 'Content-Type': 'text/plain' }, 'Unauthorized');
    }
    recentFailures = 0;

    const status = forced.shift();
    if (status !== undefined) return send(status, { 'Content-Type': 'text/plain' }, status === 503 ? 'Service Unavailable' : '');

    if (url.pathname === '/bha-api/audio-transmit.cgi' && request.method === 'POST') {
      if (!permissions.watchAlways) return send(204);
      // Only one talker at a time (the DoorBird app would even take precedence).
      if (talking) return send(503, { 'Content-Type': 'text/plain' }, 'Service Unavailable');
      // go2rtc announces a body of 9999999 bytes and simply writes audio until it hangs up.
      talking = true;
      entry.status = 200;
      request.on('data', (chunk: Buffer) => {
        stats.audioBytes += chunk.length;
      });
      request.on('end', () => {
        response.writeHead(200, { 'Content-Length': '0' });
        response.end();
      });
      request.on('close', () => {
        talking = false;
      });
      return;
    }
    if (request.method !== 'GET') return send(405, { Allow: 'GET', 'Content-Type': 'text/plain' }, 'Method Not Allowed');

    switch (url.pathname) {
      case '/bha-api/info.cgi': {
        // Field names and order as in doorbirdpy's fixture of a D2101V; firmware before 000108 reported neither relays nor type.
        const version: Record<string, unknown> = {
          FIRMWARE: options.firmware ?? (relays ? '000125' : '000099'),
          BUILD_NUMBER: options.buildNumber ?? '15870439',
          WIFI_MAC_ADDR: options.mac ?? '1CCAE3A10F42',
        };
        if (relays) {
          version.RELAYS = relays;
          version['DEVICE-TYPE'] = options.model ?? 'DoorBird D2101V';
        }
        return json({ BHA: { RETURNCODE: '1', VERSION: [version] } });
      }

      case '/bha-api/image.cgi':
        if (!permissions.watchAlways) return send(204);
        return picture(livePicture());

      case '/bha-api/history.cgi': {
        if (!permissions.history) return send(204);
        const event = url.searchParams.get('event') ?? 'doorbell';
        const index = Number(url.searchParams.get('index') ?? '1');
        if ((event !== 'doorbell' && event !== 'motionsensor') || !Number.isInteger(index) || index < 1 || index > HISTORY_SIZE) {
          return send(400, { 'Content-Type': 'text/plain' }, 'Bad Request');
        }
        const item = history[event][index - 1];
        if (!item) return send(404, { 'Content-Type': 'text/plain' }, 'Not Found');
        return picture(historyPicture(item), timestampHeader ? { 'X-Timestamp': String(Math.floor(item.at / 1000)) } : {});
      }

      case '/bha-api/open-door.cgi': {
        if (!permissions.watchAlways) return denyStyle === 'http' ? send(204) : returnCode('204');
        const relay = url.searchParams.get('r') ?? '1';
        if (!(relays ?? ['1']).includes(relay)) return send(400, { 'Content-Type': 'text/plain' }, 'Bad Request');
        opened.push({ relay, at: now });
        return returnCode('1');
      }

      case '/bha-api/light-on.cgi':
        if (!permissions.watchAlways) return denyStyle === 'http' ? send(204) : returnCode('204');
        lightOn++;
        lightUntil = now + LIGHT_STAYS_MS;
        return returnCode('1');

      case '/bha-api/audio-receive.cgi': {
        if (!permissions.watchAlways) return send(204);
        entry.status = 200;
        response.useChunkedEncodingByDefault = false;
        response.writeHead(200, { 'Content-Type': 'audio/basic', 'Cache-Control': 'no-cache', Connection: 'close' });
        const timer = setInterval(() => response.write(SILENCE), 20);
        audioTimers.add(timer);
        response.on('close', () => {
          clearInterval(timer);
          audioTimers.delete(timer);
        });
        return;
      }

      case '/bha-api/monitor.cgi': {
        // Legacy one-shot form: "doorbell=0" (doorbirdpy doorbell_state).
        const check = url.searchParams.get('check');
        if (check === 'doorbell' || check === 'motionsensor') {
          return send(200, { 'Content-Type': 'text/plain' }, `${check}=${levels[check] ? 1 : 0}\r\n`);
        }
        const signals = (url.searchParams.get('ring') ?? '')
          .split(',')
          .filter((signal): signal is DoorBirdSimEvent => signal === 'doorbell' || signal === 'motionsensor');
        if (signals.length === 0) return send(400, { 'Content-Type': 'text/plain' }, 'Bad Request');
        if (monitors.size >= maxMonitorStreams) return send(509, { 'Content-Type': 'text/plain' }, 'Bandwidth Limit Exceeded');

        entry.status = 200;
        stats.monitorOpened++;
        // An endless body without a length: the connection is the stream.
        response.useChunkedEncodingByDefault = false;
        response.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`, 'Cache-Control': 'no-cache', Connection: 'close' });
        const stream: MonitorStream = { response, signals, heartbeat: null };
        monitors.add(stream);
        response.on('close', () => closeStream(stream));
        const state = (): void => {
          for (const signal of signals) response.write(part(signal));
        };
        // The current state right away, then again as a heartbeat.
        state();
        if (heartbeatMs > 0) stream.heartbeat = setInterval(state, heartbeatMs);
        return;
      }

      default:
        return send(404, { 'Content-Type': 'text/plain' }, 'Not Found');
    }
  }

  const server = http.createServer((request, response) => {
    try {
      handle(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  // An intercom call may last longer than Node's default limit for receiving a request.
  server.requestTimeout = 0;
  server.on('connection', (socket) => {
    stats.connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  function listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once('error', onError);
      server.listen(port, host, () => {
        server.off('error', onError);
        listening = true;
        resolve();
      });
    });
  }

  function unlisten(): Promise<void> {
    if (!listening) return Promise.resolve();
    listening = false;
    for (const stream of [...monitors]) closeStream(stream);
    for (const timer of audioTimers) clearInterval(timer);
    audioTimers.clear();
    return new Promise((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    });
  }

  await listen(options.port ?? 0);
  const port = (server.address() as AddressInfo).port;

  return {
    host,
    port,
    address: `${host}:${port}`,
    username,
    password,
    opened,
    history,
    permissions,
    requests,
    stats,
    get lightOn() {
      return lightOn;
    },
    get monitorStreams() {
      return monitors.size;
    },
    get talking() {
      return talking;
    },
    settings(base) {
      // `base` wins, so a test can point the hub at this device with a wrong password.
      return { room: '', relayNames: {}, hiddenRelays: [], host: `${host}:${port}`, username, password, ...base };
    },
    ring: () => trigger('doorbell', true),
    motion: () => trigger('motionsensor', false),
    addHistory,
    async setOffline(offline) {
      if (closed) return;
      if (offline) await unlisten();
      else if (!listening) await listen(port);
    },
    dropMonitorStreams() {
      for (const stream of [...monitors]) {
        closeStream(stream);
        stream.response.destroy();
      }
    },
    failNext(status, count = 1) {
      for (let i = 0; i < count; i++) forced.push(status);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
      for (const signal of ['doorbell', 'motionsensor'] as const) {
        const timer = lowTimers[signal];
        if (timer) clearTimeout(timer);
        lowTimers[signal] = null;
      }
      await unlisten();
    },
  };
}
