import type { DoorBirdDeviceSettings, DoorRelay } from '@home-hub/shared';

/**
 * Wire-level knowledge about the DoorBird LAN API (rev. 0.36): paths, payload
 * shapes and the event stream. Pure functions and small state machines only —
 * everything in here can be tested without a device.
 */

export type HistoryEvent = 'doorbell' | 'motionsensor';

export const DOORBIRD_PATHS = {
  info: '/bha-api/info.cgi',
  image: '/bha-api/image.cgi',
  lightOn: '/bha-api/light-on.cgi',
  /** Endless multipart stream with the state of the bell button and the motion sensor. */
  monitor: '/bha-api/monitor.cgi?ring=doorbell,motionsensor',
  /** Relay ids of door controllers contain an "@" ("gggaaa@1"), hence the escaping (doorbirdpy does the same). */
  openDoor: (relayId: string): string => `/bha-api/open-door.cgi?r=${encodeURIComponent(relayId)}`,
  /** `index` 1 is the newest picture, the device keeps 50 per event type. */
  history: (index: number, event: HistoryEvent): string => `/bha-api/history.cgi?index=${index}&event=${event}`,
} as const;

// --- Address and stream URLs ---------------------------------------------------------

/** Splits the configured address (`192.168.1.40` or `tuer.lan:8080`) into host name and HTTP port. */
export function splitHost(host: string): { hostname: string; port: number | null } {
  const trimmed = host.trim();
  const match = /^(.+):(\d{1,5})$/.exec(trimmed);
  if (!match) return { hostname: trimmed, port: null };
  return { hostname: match[1]!, port: Number(match[2]) };
}

/** Percent-encodes everything outside RFC 3986 "unreserved", so the result is safe in any part of a URL. */
export function escapeUrlPart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * go2rtc sources of one door station.
 *
 * `main`: H.264 video over RTSP (port 554, then 8557 as fall-back — some
 * firmware only serves it there), plus the device's audio stream so that
 * listening works even where the RTSP stream carries no sound. `#backchannel=0`
 * keeps go2rtc from asking for a talk channel on a stream that is only watched.
 *
 * `talk`: go2rtc posts the microphone audio (G.711 µ-law) to
 * `audio-transmit.cgi`.
 *
 * How go2rtc (pkg/doorbird, internal/doorbird, v1.9.15) treats the credentials
 * decides how they must be written here — checked against a running go2rtc:
 * - `rtsp://` and `doorbird://…?media=audio` URLs are parsed with Go's
 *   `net/url`, which decodes the user info once: normal percent-encoding.
 * - The plain `doorbird://` (talk) URL is decoded the same way, but go2rtc then
 *   pastes user and password *unescaped* into the query string
 *   `?http-user=…&http-password=…`. A password containing `&`, `#`, `%`, `+` or a
 *   space would arrive mangled, so the hub encodes these credentials twice:
 *   after go2rtc's decoding a correctly escaped query string remains.
 *
 * The HTTP port of the configured address applies to the `doorbird://` sources
 * (go2rtc assumes 80 when none is given); RTSP always uses its own ports.
 */
export function streamSources(device: Pick<DoorBirdDeviceSettings, 'host' | 'username' | 'password'>): { main: string[]; talk: string[] } {
  const address = device.host.trim();
  const { hostname } = splitHost(address);
  const user = escapeUrlPart(device.username);
  const password = escapeUrlPart(device.password);
  const login = `${user}:${password}`;
  const talkLogin = `${escapeUrlPart(user)}:${escapeUrlPart(password)}`;
  return {
    main: [
      `rtsp://${login}@${hostname}:554/mpeg/media.amp#backchannel=0`,
      `rtsp://${login}@${hostname}:8557/mpeg/media.amp#backchannel=0`,
      `doorbird://${login}@${address}?media=audio`,
    ],
    talk: [`doorbird://${talkLogin}@${address}`],
  };
}

// --- info.cgi ------------------------------------------------------------------------

export interface DoorBirdInfo {
  /** e.g. "DoorBird D2101V". Firmware older than 000108 does not report it. */
  model: string | null;
  firmware: string | null;
  build: string | null;
  /** Relay ids as the device names them: "1", "2", or "gggaaa@1" for a paired door controller. */
  relays: string[];
}

/** The device answered, but not with what the API documents. */
export class DoorBirdPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DoorBirdPayloadError';
  }
}

const RELAY_ID = /^[A-Za-z0-9][A-Za-z0-9@._-]{0,39}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Devices send strings; accept numbers as well and treat blanks as missing. */
function text(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseBha(body: Buffer | string): Record<string, unknown> {
  // Strip a UTF-8 byte order mark: JSON.parse rejects it.
  const raw = (typeof body === 'string' ? body : body.toString('utf8')).replace(/^﻿/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DoorBirdPayloadError('answer is not JSON');
  }
  if (!isRecord(parsed) || !isRecord(parsed.BHA)) throw new DoorBirdPayloadError('answer has no "BHA" object');
  return parsed.BHA;
}

/**
 * Parses the answer of `info.cgi`:
 * `{"BHA":{"RETURNCODE":"1","VERSION":[{"FIRMWARE":"000125","BUILD_NUMBER":"15870439","WIFI_MAC_ADDR":"…","RELAYS":["1","2","gggaaa@1"],"DEVICE-TYPE":"DoorBird D2101V"}]}}`
 *
 * RELAYS and DEVICE-TYPE only exist since firmware 000108 (doorbirdpy); every
 * door station has at least relay "1", so that is assumed when the list is missing.
 */
export function parseInfo(body: Buffer | string): DoorBirdInfo {
  const bha = parseBha(body);
  const code = text(bha.RETURNCODE);
  if (code !== null && code !== '1') throw new DoorBirdPayloadError(`RETURNCODE ${code}`);

  const versions: unknown = bha.VERSION;
  const version = Array.isArray(versions) ? versions.find(isRecord) : isRecord(versions) ? versions : undefined;
  if (code === null && !version) throw new DoorBirdPayloadError('answer has neither RETURNCODE nor VERSION');

  const relays: string[] = [];
  const list: unknown = version?.RELAYS;
  if (Array.isArray(list)) {
    for (const entry of list) {
      const id = text(entry);
      if (id !== null && RELAY_ID.test(id) && !relays.includes(id)) relays.push(id);
    }
  }
  if (relays.length === 0) relays.push('1');

  return {
    model: text(version?.['DEVICE-TYPE']),
    firmware: text(version?.FIRMWARE),
    build: text(version?.BUILD_NUMBER),
    relays,
  };
}

/**
 * `BHA.RETURNCODE` of a command answer (`{"BHA":{"RETURNCODE":"1"}}`): "1" = done,
 * "204" = the user lacks the permission (FHEM 73_DoorBird.pm). Null when the
 * body is not such a document.
 */
export function returnCode(body: Buffer | string): string | null {
  try {
    return text(parseBha(body).RETURNCODE);
  } catch {
    return null;
  }
}

// --- Relays --------------------------------------------------------------------------

export function defaultRelayName(relayId: string): string {
  return relayId === '1' ? 'Türöffner' : `Relais ${relayId}`;
}

/** The relays offered in the apps: everything the device reports minus the hidden ones, with their display names. */
export function visibleRelays(relayIds: readonly string[], device: Pick<DoorBirdDeviceSettings, 'relayNames' | 'hiddenRelays'>): DoorRelay[] {
  const hidden = new Set(device.hiddenRelays);
  return relayIds
    .filter((id) => !hidden.has(id))
    .map((id) => {
      // Relay ids come from the device: only look at own properties ("constructor" must not hit Object.prototype).
      const custom: unknown = Object.hasOwn(device.relayNames, id) ? device.relayNames[id] : undefined;
      const name = typeof custom === 'string' ? custom.trim() : '';
      return { id, name: name || defaultRelayName(id) };
    });
}

// --- Pictures ------------------------------------------------------------------------

/** JPEG or PNG by signature. Guards against storing an error page as a "picture". */
export function looksLikeImage(data: Buffer): boolean {
  if (data.length < 16) return false;
  const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const png = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
  return jpeg || png;
}

/**
 * `X-Timestamp` of a history picture: Unix time in seconds (openHAB DoorbirdAPI,
 * FHEM). Returns milliseconds, or null when the header is missing or cannot be
 * a real time (a device without a set clock reports 1970 or 2000).
 */
export function parseTimestampHeader(value: string | string[] | undefined, now = Date.now()): number | null {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!raw || !/^\d{9,13}$/.test(raw)) return null;
  const ms = raw.length >= 12 ? Number(raw) : Number(raw) * 1000;
  if (ms < Date.UTC(2010, 0, 1) || ms > now + 24 * 60 * 60_000) return null;
  return ms;
}

/** An HTTP date header (`Last-Modified`) as milliseconds, when it is a believable time in the past. */
export function parseHttpDate(value: string | string[] | undefined, now = Date.now()): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || ms < Date.UTC(2010, 0, 1) || ms > now) return null;
  return ms;
}

// --- monitor.cgi ---------------------------------------------------------------------

export type MonitorSignal = 'doorbell' | 'motionsensor';

export interface MonitorReport {
  signal: MonitorSignal;
  /** `H` = pressed / motion, `L` = idle. */
  high: boolean;
}

const REPORT_IN_LINE = /(doorbell|motionsensor)\s*:\s*([HL])(?![A-Za-z0-9])/i;
const REPORT_ALONE = /^\s*(doorbell|motionsensor)\s*:\s*([HL])\s*$/i;
const MAX_PENDING_CHARS = 4096;

function matchReport(pattern: RegExp, line: string): MonitorReport | null {
  const match = pattern.exec(line);
  if (!match) return null;
  return { signal: match[1]!.toLowerCase() as MonitorSignal, high: match[2]!.toUpperCase() === 'H' };
}

/**
 * Extracts the state reports from the `monitor.cgi` stream.
 *
 * On the wire the stream looks like this (nymea doorbird.cpp, homebridge-doorbird):
 *
 *     --ioboundary\r\nContent-Type: text/plain\r\n\r\ndoorbell:H\r\n\r\n
 *
 * The device announces `boundary=--ioboundary` but then writes the boundary
 * without the two extra dashes MIME requires, so a strict multipart parser
 * finds no parts at all. The stream is therefore read line by line and only
 * the `name:H|L` lines are picked out.
 */
export class MonitorParser {
  private pending = '';

  push(chunk: Buffer | string): MonitorReport[] {
    this.pending += typeof chunk === 'string' ? chunk : chunk.toString('latin1');
    const reports: MonitorReport[] = [];
    for (;;) {
      const end = this.pending.search(/[\r\n]/);
      if (end < 0) break;
      const report = matchReport(REPORT_IN_LINE, this.pending.slice(0, end));
      this.pending = this.pending.slice(end + 1);
      if (report) reports.push(report);
    }
    // A complete report whose line end has not arrived yet must not wait for the
    // next heartbeat (up to 20 s). Reporting a level twice is harmless.
    const tail = matchReport(REPORT_ALONE, this.pending);
    if (tail) {
      reports.push(tail);
      this.pending = '';
    } else if (this.pending.length > MAX_PENDING_CHARS) {
      this.pending = '';
    }
    return reports;
  }
}

/**
 * Turns level reports into events: only a change from L to H counts.
 *
 * The device repeats the current levels as a heartbeat and sends them once
 * right after connecting. After a (re)connect the previous level is unknown,
 * so a first `H` only counts when it arrives later than the grace period —
 * otherwise a reconnect during a ring would announce the same ring again.
 */
export class EdgeDetector {
  private readonly levels = new Map<MonitorSignal, boolean>();
  private connectedAt = 0;

  constructor(private readonly graceMs: number) {}

  /** Call when a new stream starts: all levels become unknown. */
  connected(now: number): void {
    this.levels.clear();
    this.connectedAt = now;
  }

  /** Returns true when this report is a new event. */
  report(report: MonitorReport, now: number): boolean {
    const previous = this.levels.get(report.signal);
    this.levels.set(report.signal, report.high);
    if (!report.high || previous === true) return false;
    if (previous === false) return true;
    return now - this.connectedAt > this.graceMs;
  }
}
