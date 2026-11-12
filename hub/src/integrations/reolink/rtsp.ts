import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';

/**
 * Asks an RTSP server what it would stream (DESCRIBE), without streaming
 * anything. Used to check address and credentials before go2rtc gets them,
 * and to find out whether the camera offers an ONVIF audio back channel
 * (its speaker) — the only way to talk to a camera through RTSP.
 */

export interface RtspTarget {
  host: string;
  port: number;
  /** Path (and query) as the camera reported it, e.g. `/h264Preview_01_main`. */
  path: string;
  username: string;
  password: string;
  timeoutMs: number;
}

export interface RtspDescription {
  /** Video codec as named in the SDP (`H264`, `H265`), null without a video track. */
  video: string | null;
  /** The stream carries sound from the camera. */
  audio: boolean;
  /** The camera offers a back channel (sendonly audio) for its speaker. */
  backchannel: boolean;
}

export class RtspError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'not_found' | 'network' | 'protocol',
  ) {
    super(message);
    this.name = 'RtspError';
  }
}

interface Response {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const md5 = (text: string) => createHash('md5').update(text).digest('hex');

function parseChallenge(header: string): { scheme: 'digest' | 'basic'; params: Record<string, string> } | null {
  const match = /^\s*(Digest|Basic)\s*(.*)$/i.exec(header);
  if (!match) return null;
  const params: Record<string, string> = {};
  for (const part of match[2]!.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/g)) params[part[1]!.toLowerCase()] = part[2] ?? part[3] ?? '';
  return { scheme: match[1]!.toLowerCase() === 'digest' ? 'digest' : 'basic', params };
}

/** The answer to a challenge for one request. */
export function rtspAuthorization(challenge: string, method: string, uri: string, username: string, password: string): string | null {
  const parsed = parseChallenge(challenge);
  if (!parsed) return null;
  if (parsed.scheme === 'basic') return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const { realm = '', nonce = '', qop, opaque } = parsed.params;
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const quoted = (value: string) => value.replace(/["\\]/g, '');
  let header = `Digest username="${quoted(username)}", realm="${quoted(realm)}", nonce="${quoted(nonce)}", uri="${uri}"`;
  if (qop && /\bauth\b/.test(qop)) {
    const cnonce = randomBytes(8).toString('hex');
    const nc = '00000001';
    header += `, qop=auth, nc=${nc}, cnonce="${cnonce}", response="${md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)}"`;
  } else {
    header += `, response="${md5(`${ha1}:${nonce}:${ha2}`)}"`;
  }
  if (opaque) header += `, opaque="${quoted(opaque)}"`;
  return header;
}

export function parseSdp(sdp: string, backchannelRequested: boolean): RtspDescription {
  const media: { type: string; lines: string[] }[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) media.push({ type: line.slice(2).split(' ')[0] ?? '', lines: [] });
    else media.at(-1)?.lines.push(line);
  }
  const video = media.find((entry) => entry.type === 'video');
  const codec = video?.lines.map((line) => /^a=rtpmap:\d+\s+([\w-]+)\//i.exec(line)?.[1]).find(Boolean) ?? null;
  const audio = media.filter((entry) => entry.type === 'audio');
  const sendOnly = (entry: { lines: string[] }) => entry.lines.some((line) => line.trim() === 'a=sendonly');
  return {
    video: video ? (codec?.toUpperCase() ?? 'unbekannt') : null,
    audio: audio.some((entry) => !sendOnly(entry)),
    backchannel: backchannelRequested && audio.some(sendOnly),
  };
}

/** One RTSP connection, requests one after another. */
class Connection {
  private buffer = Buffer.alloc(0);
  private waiting: { resolve: (response: Response) => void; reject: (err: Error) => void } | null = null;
  private failure: Error | null = null;
  private cseq = 0;

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 256 * 1024) this.fail(new RtspError('Die Antwort der Kamera ist zu groß', 'protocol'));
      else this.drain();
    });
    socket.on('error', (err) => this.fail(new RtspError(`Verbindung fehlgeschlagen (${(err as NodeJS.ErrnoException).code ?? err.message})`, 'network')));
    socket.on('close', () => this.fail(new RtspError('Die Kamera hat die Verbindung beendet', 'network')));
  }

  static open(host: string, port: number, timeoutMs: number): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error('ETIMEDOUT')));
      socket.once('connect', () => resolve(new Connection(socket)));
      socket.once('error', (err) => reject(new RtspError(`Keine Verbindung zu Port ${port} (${(err as NodeJS.ErrnoException).code ?? err.message})`, 'network')));
    });
  }

  private fail(err: Error): void {
    this.failure ??= err;
    this.waiting?.reject(err);
    this.waiting = null;
  }

  private drain(): void {
    if (!this.waiting) return;
    const end = this.buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const head = this.buffer.subarray(0, end).toString('latin1').split('\r\n');
    const status = /^RTSP\/1\.\d\s+(\d{3})/.exec(head[0] ?? '');
    if (!status) return this.fail(new RtspError('Unter dieser Adresse antwortet kein RTSP-Dienst', 'protocol'));
    const headers: Record<string, string> = {};
    for (const line of head.slice(1)) {
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const length = Number(headers['content-length'] ?? 0) || 0;
    if (this.buffer.length < end + 4 + length) return;
    const body = this.buffer.subarray(end + 4, end + 4 + length).toString('utf8');
    this.buffer = this.buffer.subarray(end + 4 + length);
    const waiting = this.waiting;
    this.waiting = null;
    waiting.resolve({ status: Number(status[1]), headers, body });
  }

  request(method: string, uri: string, headers: Record<string, string>): Promise<Response> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      const lines = [`${method} ${uri} RTSP/1.0`, `CSeq: ${++this.cseq}`, 'User-Agent: HomeHub', ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`)];
      this.socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      this.drain();
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

/** DESCRIBE with the back channel requested; again without it when the camera does not understand the request. */
export async function describeRtsp(target: RtspTarget): Promise<RtspDescription> {
  const host = target.host.replace(/:\d+$/, '');
  const uri = `rtsp://${host.includes(':') ? `[${host}]` : host}:${target.port}${target.path.startsWith('/') ? '' : '/'}${target.path}`;

  const attempt = async (backchannel: boolean): Promise<Response> => {
    const connection = await Connection.open(host, target.port, target.timeoutMs);
    try {
      let challenge: string | null = null;
      for (let round = 0; round < 2; round++) {
        const headers: Record<string, string> = { Accept: 'application/sdp' };
        if (backchannel) headers.Require = 'www.onvif.org/ver20/backchannel';
        const authorization = challenge ? rtspAuthorization(challenge, 'DESCRIBE', uri, target.username, target.password) : null;
        if (authorization) headers.Authorization = authorization;
        const response = await connection.request('DESCRIBE', uri, headers);
        if (response.status === 401 && round === 0 && response.headers['www-authenticate']) {
          challenge = response.headers['www-authenticate'];
          continue;
        }
        return response;
      }
      throw new RtspError('Benutzername oder Passwort stimmen nicht (RTSP).', 'auth');
    } finally {
      connection.close();
    }
  };

  let backchannel = true;
  let response: Response;
  try {
    response = await attempt(true);
  } catch (err) {
    // Some firmwares hang up on a request they do not understand: ask once more the plain way.
    if (!(err instanceof RtspError) || err.kind !== 'network') throw err;
    backchannel = false;
    response = await attempt(false);
  }
  // 551 Option not supported (or a camera that rejects the unknown header altogether).
  if (backchannel && (response.status === 551 || response.status === 400 || response.status === 501)) {
    backchannel = false;
    response = await attempt(false);
  }
  if (response.status === 401) throw new RtspError('Benutzername oder Passwort stimmen nicht (RTSP).', 'auth');
  if (response.status === 404) throw new RtspError('Die Kamera kennt diese Video-Adresse nicht', 'not_found');
  if (response.status !== 200) throw new RtspError(`Die Kamera antwortete mit RTSP ${response.status}`, 'protocol');
  return parseSdp(response.body, backchannel);
}
