import dgram, { type Socket } from 'node:dgram';

/**
 * Govee's LAN interface: JSON over UDP, no login, for lights whose "LAN
 * control" is switched on in the Govee Home app (not every model has it).
 *
 *   search   → 239.255.255.250:4001  {"msg":{"cmd":"scan","data":{"account_topic":"reserve"}}}
 *   answers  ← to port 4002          {"msg":{"cmd":"scan","data":{"ip","device","sku","bleVersionHard",…}}}
 *   commands → <light>:4003          {"msg":{"cmd":"turn","data":{"value":1}}}
 *                                    {"msg":{"cmd":"brightness","data":{"value":1…100}}}
 *                                    {"msg":{"cmd":"colorwc","data":{"color":{"r","g","b"},"colorTemInKelvin":0 | 2000…9000}}}
 *   state    → <light>:4003          {"msg":{"cmd":"devStatus","data":{}}}
 *            ← to port 4002          {"msg":{"cmd":"devStatus","data":{"onOff":1,"brightness":100,"color":{…},"colorTemInKelvin":0}}}
 *
 * Answers always go to port 4002, so the hub listens there — one socket for
 * sending and receiving. A light is known by its address; the device id (the
 * same as in the cloud) comes with the search answer. Lights in another
 * subnet are searched for directly at their address.
 */

export interface GoveeLanOptions {
  multicast: string;
  scanPort: number;
  listenPort: number;
  devicePort: number;
  /** Address to listen on (all interfaces by default). */
  bindAddress?: string;
}

export const LAN_DEFAULTS: GoveeLanOptions = { multicast: '239.255.255.250', scanPort: 4001, listenPort: 4002, devicePort: 4003 };

export interface LanFound {
  device: string;
  sku: string;
  ip: string;
}

export interface LanStatus {
  on: boolean;
  brightness: number;
  rgb: { r: number; g: number; b: number };
  /** 0 while the light shows a colour. */
  kelvin: number;
}

export interface LanEvents {
  found(light: LanFound): void;
  status(ip: string, status: LanStatus): void;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const byte = (value: unknown): number => Math.min(255, Math.max(0, Math.round(num(value) ?? 0)));

const isMulticast = (address: string) => /^2(2[4-9]|3\d)\./.test(address);

/** Reads one datagram; null for anything that is not a Govee answer. */
export function parseLanMessage(raw: Buffer): { cmd: 'scan'; light: LanFound } | { cmd: 'devStatus'; status: LanStatus } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  const msg = isObject(parsed) && isObject(parsed.msg) ? parsed.msg : null;
  const data = msg && isObject(msg.data) ? msg.data : null;
  if (!msg || !data) return null;
  if (msg.cmd === 'scan') {
    const device = typeof data.device === 'string' ? data.device : '';
    const ip = typeof data.ip === 'string' ? data.ip : '';
    if (!device || !ip) return null;
    return { cmd: 'scan', light: { device, sku: typeof data.sku === 'string' ? data.sku : '', ip } };
  }
  if (msg.cmd === 'devStatus') {
    const color = isObject(data.color) ? data.color : {};
    return {
      cmd: 'devStatus',
      status: {
        on: num(data.onOff) === 1,
        brightness: Math.min(100, Math.max(0, Math.round(num(data.brightness) ?? 0))),
        rgb: { r: byte(color.r), g: byte(color.g), b: byte(color.b) },
        // Some firmwares put the colour temperature inside `color`.
        kelvin: Math.round(num(data.colorTemInKelvin) ?? num(color.colorTemInKelvin) ?? 0),
      },
    };
  }
  return null;
}

export class GoveeLanError extends Error {
  constructor(
    message: string,
    readonly kind: 'busy' | 'network',
  ) {
    super(message);
    this.name = 'GoveeLanError';
  }
}

export class GoveeLan {
  private socket: Socket | null = null;

  constructor(
    private readonly options: GoveeLanOptions,
    private readonly events: LanEvents,
  ) {}

  /** Opens the socket. Rejects with `busy` when another program listens on the answer port. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const fail = (err: Error & { code?: string }) => {
        socket.close();
        reject(
          err.code === 'EADDRINUSE' || err.code === 'EACCES'
            ? new GoveeLanError(`Port ${this.options.listenPort} ist auf dem Hub schon belegt (läuft dort eine andere Govee-Steuerung?).`, 'busy')
            : new GoveeLanError(`LAN-Steuerung nicht möglich: ${err.message}`, 'network'),
        );
      };
      socket.once('error', fail);
      socket.on('message', (raw, remote) => {
        const message = parseLanMessage(raw);
        if (!message) return;
        if (message.cmd === 'scan') this.events.found(message.light);
        else this.events.status(remote.address, message.status);
      });
      socket.bind({ port: this.options.listenPort, address: this.options.bindAddress }, () => {
        socket.off('error', fail);
        // A broken network must not end the hub; sending reports its own errors.
        socket.on('error', () => {});
        if (isMulticast(this.options.multicast)) {
          try {
            socket.addMembership(this.options.multicast);
          } catch {
            // Without membership the answers still arrive (they are sent to this address directly).
          }
          socket.setMulticastTTL(1);
        }
        this.socket = socket;
        resolve();
      });
    });
  }

  private send(message: Json, port: number, address: string): Promise<void> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new GoveeLanError('LAN-Steuerung ist nicht gestartet', 'network'));
    const data = Buffer.from(JSON.stringify({ msg: message }));
    return new Promise((resolve, reject) => {
      socket.send(data, port, address, (err) => (err ? reject(new GoveeLanError(`Senden an ${address} fehlgeschlagen: ${err.message}`, 'network')) : resolve()));
    });
  }

  /** Asks every light in the network (and those at the given addresses) to report itself. */
  async scan(hosts: string[] = []): Promise<void> {
    const message = { cmd: 'scan', data: { account_topic: 'reserve' } };
    const targets = [this.options.multicast, ...hosts];
    await Promise.allSettled(targets.map((target) => this.send(message, this.options.scanPort, target)));
  }

  status(ip: string): Promise<void> {
    return this.send({ cmd: 'devStatus', data: {} }, this.options.devicePort, ip);
  }

  turn(ip: string, on: boolean): Promise<void> {
    return this.send({ cmd: 'turn', data: { value: on ? 1 : 0 } }, this.options.devicePort, ip);
  }

  brightness(ip: string, value: number): Promise<void> {
    return this.send({ cmd: 'brightness', data: { value: Math.min(100, Math.max(1, Math.round(value))) } }, this.options.devicePort, ip);
  }

  color(ip: string, rgb: { r: number; g: number; b: number }, kelvin = 0): Promise<void> {
    return this.send({ cmd: 'colorwc', data: { color: { r: rgb.r, g: rgb.g, b: rgb.b }, colorTemInKelvin: kelvin } }, this.options.devicePort, ip);
  }

  stop(): void {
    try {
      this.socket?.close();
    } catch {
      // already closed
    }
    this.socket = null;
  }
}

/** Approximate RGB of white light at a colour temperature (for the LAN command, which wants both). */
export function kelvinToRgb(kelvin: number): { r: number; g: number; b: number } {
  const t = Math.min(40_000, Math.max(1000, kelvin)) / 100;
  const clamp = (value: number) => Math.round(Math.min(255, Math.max(0, value)));
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return { r: clamp(r), g: clamp(g), b: clamp(b) };
}
