/**
 * KNXnet/IP (ISO 22510 / KNX standard 03.08.02) — just what the hub needs to
 * listen to a KNX installation and ask for states: tunnelling and routing of
 * cEMI L_Data frames with group telegrams, and the search for interfaces.
 *
 * The hub never writes values to the bus: it only sends GroupValue_Read.
 */

export const KNX_PORT = 3671;
export const ROUTING_MULTICAST = '224.0.23.12';

export const SERVICE = {
  SEARCH_REQUEST: 0x0201,
  SEARCH_RESPONSE: 0x0202,
  CONNECT_REQUEST: 0x0205,
  CONNECT_RESPONSE: 0x0206,
  CONNECTIONSTATE_REQUEST: 0x0207,
  CONNECTIONSTATE_RESPONSE: 0x0208,
  DISCONNECT_REQUEST: 0x0209,
  DISCONNECT_RESPONSE: 0x020a,
  TUNNELLING_REQUEST: 0x0420,
  TUNNELLING_ACK: 0x0421,
  ROUTING_INDICATION: 0x0530,
} as const;

export const MESSAGE_CODE = { L_DATA_REQ: 0x11, L_DATA_CON: 0x2e, L_DATA_IND: 0x29 } as const;

/** Status codes of the connection services, in words for the administrator. */
export const STATUS_TEXT: Record<number, string> = {
  0x00: 'in Ordnung',
  0x21: 'Die Verbindung ist der Schnittstelle nicht (mehr) bekannt.',
  0x22: 'Die Schnittstelle kann keine Tunnel-Verbindung aufbauen.',
  0x23: 'Die Schnittstelle unterstützt diese Verbindungsart nicht.',
  0x24: 'Die Schnittstelle hat keine freie Verbindung mehr (alle Tunnel belegt).',
  0x26: 'Die Schnittstelle meldet einen Fehler bei der Datenverbindung.',
  0x27: 'Die Schnittstelle meldet einen Fehler auf dem KNX-Bus.',
  0x29: 'Die Schnittstelle unterstützt die Busmonitor-/Link-Layer-Verbindung nicht.',
};

// --- Addresses ---------------------------------------------------------------------------------

/** "1/2/3" (main/middle/sub) or "1/515" (main/sub) → 16-bit group address; null when invalid. */
export function parseGroupAddress(text: string): number | null {
  const three = /^\s*(\d{1,2})\/(\d)\/(\d{1,3})\s*$/.exec(text);
  if (three) {
    const [main, middle, sub] = three.slice(1).map(Number) as [number, number, number];
    if (main > 31 || middle > 7 || sub > 255) return null;
    return (main << 11) | (middle << 8) | sub;
  }
  const two = /^\s*(\d{1,2})\/(\d{1,4})\s*$/.exec(text);
  if (two) {
    const [main, sub] = two.slice(1).map(Number) as [number, number];
    if (main > 31 || sub > 2047) return null;
    return (main << 11) | sub;
  }
  return null;
}

export function formatGroupAddress(address: number): string {
  return `${(address >> 11) & 0x1f}/${(address >> 8) & 0x07}/${address & 0xff}`;
}

export function parseIndividualAddress(text: string): number | null {
  const match = /^\s*(\d{1,2})\.(\d{1,2})\.(\d{1,3})\s*$/.exec(text);
  if (!match) return null;
  const [area, line, device] = match.slice(1).map(Number) as [number, number, number];
  if (area > 15 || line > 15 || device > 255) return null;
  return (area << 12) | (line << 8) | device;
}

export function formatIndividualAddress(address: number): string {
  return `${(address >> 12) & 0x0f}.${(address >> 8) & 0x0f}.${address & 0xff}`;
}

// --- Frames ------------------------------------------------------------------------------------

export function frame(service: number, body: Buffer): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt8(0x06, 0);
  header.writeUInt8(0x10, 1);
  header.writeUInt16BE(service, 2);
  header.writeUInt16BE(6 + body.length, 4);
  return Buffer.concat([header, body]);
}

export interface Frame {
  service: number;
  body: Buffer;
}

export function parseFrame(data: Buffer): Frame | null {
  if (data.length < 6 || data[0] !== 0x06 || data[1] !== 0x10) return null;
  const length = data.readUInt16BE(4);
  if (length > data.length || length < 6) return null;
  return { service: data.readUInt16BE(2), body: data.subarray(6, length) };
}

/** Host protocol address information: IPv4/UDP endpoint; 0.0.0.0:0 means "answer where it came from" (NAT). */
export function hpai(ip = '0.0.0.0', port = 0): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt8(0x08, 0);
  buffer.writeUInt8(0x01, 1);
  ip.split('.').forEach((part, index) => buffer.writeUInt8(Number(part) & 0xff, 2 + index));
  buffer.writeUInt16BE(port, 6);
  return buffer;
}

export function readHpai(buffer: Buffer, offset: number): { ip: string; port: number } | null {
  if (buffer.length < offset + 8 || buffer[offset] !== 0x08) return null;
  return { ip: [...buffer.subarray(offset + 2, offset + 6)].join('.'), port: buffer.readUInt16BE(offset + 6) };
}

/** Tunnel connection on the link layer. */
export function connectRequest(): Buffer {
  return frame(SERVICE.CONNECT_REQUEST, Buffer.concat([hpai(), hpai(), Buffer.from([0x04, 0x04, 0x02, 0x00])]));
}

export function parseConnectResponse(body: Buffer): { channel: number; status: number; address: number | null } {
  const channel = body[0] ?? 0;
  const status = body[1] ?? 0xff;
  // CRD after the data endpoint: length, type, individual address of the tunnel.
  const address = status === 0 && body.length >= 14 ? body.readUInt16BE(12) : null;
  return { channel, status, address };
}

export function connectionStateRequest(channel: number): Buffer {
  return frame(SERVICE.CONNECTIONSTATE_REQUEST, Buffer.concat([Buffer.from([channel, 0x00]), hpai()]));
}

export function disconnectRequest(channel: number): Buffer {
  return frame(SERVICE.DISCONNECT_REQUEST, Buffer.concat([Buffer.from([channel, 0x00]), hpai()]));
}

export function disconnectResponse(channel: number, status = 0): Buffer {
  return frame(SERVICE.DISCONNECT_RESPONSE, Buffer.from([channel, status]));
}

export function tunnellingRequest(channel: number, sequence: number, cemi: Buffer): Buffer {
  return frame(SERVICE.TUNNELLING_REQUEST, Buffer.concat([Buffer.from([0x04, channel, sequence & 0xff, 0x00]), cemi]));
}

export function tunnellingAck(channel: number, sequence: number, status = 0): Buffer {
  return frame(SERVICE.TUNNELLING_ACK, Buffer.from([0x04, channel, sequence & 0xff, status]));
}

export function parseConnectionHeader(body: Buffer): { channel: number; sequence: number; status: number; rest: Buffer } | null {
  if (body.length < 4 || body[0] !== 0x04) return null;
  return { channel: body[1]!, sequence: body[2]!, status: body[3]!, rest: body.subarray(4) };
}

export function searchRequest(ip: string, port: number): Buffer {
  return frame(SERVICE.SEARCH_REQUEST, hpai(ip, port));
}

export interface FoundInterface {
  host: string;
  port: number;
  name: string;
  address: string;
  /** Supports tunnelling / routing (from the supported service families). */
  tunnelling: boolean;
  routing: boolean;
}

export function parseSearchResponse(body: Buffer, from: string): FoundInterface | null {
  const endpoint = readHpai(body, 0);
  if (!endpoint) return null;
  const dib = body.subarray(8);
  if (dib.length < 54 || dib[1] !== 0x01) return null;
  const name = dib.subarray(24, 54).toString('latin1').replace(/\0.*$/s, '').trim();
  const families = dib.subarray(54);
  const ids: number[] = [];
  if (families.length >= 2 && families[1] === 0x02) for (let i = 2; i + 1 < families[0]! && i + 1 < families.length; i += 2) ids.push(families[i]!);
  return {
    host: endpoint.ip === '0.0.0.0' ? from : endpoint.ip,
    port: endpoint.port || KNX_PORT,
    name: name || 'KNX IP',
    address: formatIndividualAddress(dib.readUInt16BE(4)),
    tunnelling: ids.length === 0 || ids.includes(0x04),
    routing: ids.includes(0x05),
  };
}

// --- cEMI ------------------------------------------------------------------------------------------

export type GroupService = 'read' | 'response' | 'write';

export interface GroupTelegram {
  messageCode: number;
  source: number;
  destination: number;
  service: GroupService;
  /** Up to 6 bits carried in the APCI byte (switches, contacts …) — null when the value has its own bytes. */
  small: number | null;
  /** The value's own bytes (empty for small values and reads). */
  data: Buffer;
}

const APCI: Record<number, GroupService> = { 0: 'read', 1: 'response', 2: 'write' };

/** Group telegrams only; everything else (individual addresses, management) is ignored. */
export function parseCemi(cemi: Buffer): GroupTelegram | null {
  if (cemi.length < 2) return null;
  const messageCode = cemi[0]!;
  if (messageCode !== MESSAGE_CODE.L_DATA_IND && messageCode !== MESSAGE_CODE.L_DATA_CON && messageCode !== MESSAGE_CODE.L_DATA_REQ) return null;
  const at = 2 + cemi[1]!;
  if (cemi.length < at + 8) return null;
  const control2 = cemi[at + 1]!;
  if ((control2 & 0x80) === 0) return null;
  const source = cemi.readUInt16BE(at + 2);
  const destination = cemi.readUInt16BE(at + 4);
  const length = cemi[at + 6]!;
  const tpdu = cemi.subarray(at + 7);
  if (tpdu.length < 2 || tpdu.length < length + 1) return null;
  const apci = ((tpdu[0]! & 0x03) << 2) | (tpdu[1]! >> 6);
  const service = APCI[apci];
  if (!service) return null;
  const small = length === 1 ? tpdu[1]! & 0x3f : null;
  return { messageCode, source, destination, service, small: service === 'read' ? null : small, data: length > 1 ? Buffer.from(tpdu.subarray(2, length + 1)) : Buffer.alloc(0) };
}

/** A GroupValue_Read for one group address (the device answers with its current value). */
export function groupReadCemi(destination: number, messageCode: number = MESSAGE_CODE.L_DATA_REQ, source = 0): Buffer {
  const cemi = Buffer.alloc(11);
  cemi.writeUInt8(messageCode, 0);
  cemi.writeUInt8(0x00, 1); // no additional info
  cemi.writeUInt8(0xbc, 2); // standard frame, no repetition, broadcast, low priority
  cemi.writeUInt8(0xe0, 3); // group address, hop count 6
  cemi.writeUInt16BE(source, 4);
  cemi.writeUInt16BE(destination, 6);
  cemi.writeUInt8(0x01, 8);
  cemi.writeUInt8(0x00, 9);
  cemi.writeUInt8(0x00, 10);
  return cemi;
}

/** A group telegram carrying a small value (simulator and tests). */
export function groupValueCemi(destination: number, value: number, service: 'write' | 'response', messageCode: number = MESSAGE_CODE.L_DATA_IND, source = 0x1101): Buffer {
  const cemi = groupReadCemi(destination, messageCode, source);
  cemi.writeUInt8((service === 'write' ? 0x80 : 0x40) | (value & 0x3f), 10);
  return cemi;
}
