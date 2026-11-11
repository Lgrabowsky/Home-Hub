import { XMLParser } from 'fast-xml-parser';
import { DeviceHttp, DeviceHttpError } from '../../util/http.ts';

/**
 * UPnP control of a Sonos player: SOAP over HTTP on port 1400.
 * (Sonos documents none of this; the shapes follow SoCo and node-sonos-ts.)
 */

export const SERVICES = {
  AVTransport: { type: 'urn:schemas-upnp-org:service:AVTransport:1', path: '/MediaRenderer/AVTransport/Control' },
  RenderingControl: { type: 'urn:schemas-upnp-org:service:RenderingControl:1', path: '/MediaRenderer/RenderingControl/Control' },
  GroupRenderingControl: { type: 'urn:schemas-upnp-org:service:GroupRenderingControl:1', path: '/MediaRenderer/GroupRenderingControl/Control' },
  ZoneGroupTopology: { type: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1', path: '/ZoneGroupTopology/Control' },
  ContentDirectory: { type: 'urn:schemas-upnp-org:service:ContentDirectory:1', path: '/MediaServer/ContentDirectory/Control' },
} as const;

export type ServiceName = keyof typeof SERVICES;

/** The player understood the request and refused it (HTTP 500 with a UPnP error code). */
export class SoapFault extends Error {
  constructor(
    readonly action: string,
    /** UPnP error code, e.g. 701 "transition not available", 800 on Sonos for "cannot do that". */
    readonly code: number | null,
  ) {
    super(`${action}: UPnP-Fehler ${code ?? 'unbekannt'}`);
    this.name = 'SoapFault';
  }
}

export type Xml = Record<string, unknown>;

/**
 * One parser for everything Sonos sends. Namespace prefixes are dropped
 * (`dc:title` → `title`), attributes get an `@_` prefix, and nothing is turned
 * into numbers behind our back (ids like "00032020…" must stay strings).
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => name === 'ZoneGroup' || name === 'ZoneGroupMember' || name === 'item' || name === 'container',
});

export function parseXml(text: string): Xml {
  try {
    const parsed: unknown = parser.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Xml) : {};
  } catch {
    return {};
  }
}

export const node = (value: unknown): Xml => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Xml) : {});
export const nodes = (value: unknown): Xml[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).filter((entry): entry is Xml => typeof entry === 'object' && entry !== null);

/** Text of an element, whether it has attributes (`{ '#text': … }`) or not. */
export function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && value !== null) {
    const inner = (value as Xml)['#text'];
    if (typeof inner === 'string') return inner;
    if (typeof inner === 'number') return String(inner);
  }
  return '';
}

export function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!);
}

export type SoapArgs = Record<string, string | number | boolean>;

function envelope(type: string, action: string, args: SoapArgs): string {
  const body = Object.entries(args)
    .map(([name, value]) => `<${name}>${escapeXml(typeof value === 'boolean' ? (value ? '1' : '0') : String(value))}</${name}>`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${type}">${body}</u:${action}></s:Body></s:Envelope>`;
}

/** A player on the network. Host and port always come from the topology (never assume 1400). */
export class SonosDevice {
  readonly http: DeviceHttp;
  readonly baseUrl: string;

  constructor(
    readonly host: string,
    readonly port: number,
    timeoutMs: number,
  ) {
    this.baseUrl = `http://${host}:${port}`;
    this.http = new DeviceHttp({ baseUrl: this.baseUrl, authMode: 'none', timeoutMs, maxSockets: 4 });
  }

  destroy(): void {
    this.http.destroy();
  }

  /** Calls an action and returns its out-arguments as strings. */
  async call(service: ServiceName, action: string, args: SoapArgs = {}, signal?: AbortSignal): Promise<Record<string, string>> {
    const { type, path } = SERVICES[service];
    const response = await this.http.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${type}#${action}"` },
      body: envelope(type, action, args),
      signal,
    });
    const body = node(node(parseXml(response.body.toString('utf8'))).Envelope).Body;
    if (response.status === 200) {
      const out: Record<string, string> = {};
      for (const [name, value] of Object.entries(node(node(body)[`${action}Response`]))) {
        if (!name.startsWith('@_')) out[name] = text(value);
      }
      return out;
    }
    if (response.status === 500) {
      const code = Number(text(node(node(node(node(body).Fault).detail).UPnPError).errorCode));
      throw new SoapFault(action, Number.isFinite(code) && code > 0 ? code : null);
    }
    throw new DeviceHttpError(`Der Lautsprecher antwortete mit HTTP ${response.status}`, 'status', response.status);
  }
}

/** `H:MM:SS` (Sonos' time format) → seconds; null for "NOT_IMPLEMENTED" and friends. */
export function parseTime(value: string | undefined): number | null {
  const match = /^(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(value ?? '');
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function formatTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}
