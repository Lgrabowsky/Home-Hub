import { randomBytes } from 'node:crypto';
import dgram, { type Socket } from 'node:dgram';
import http from 'node:http';
import type { AddressInfo, Socket as NetSocket } from 'node:net';

/**
 * Simulator of Govee lights:
 * - the cloud API (router API v1) with key check, its JSON shapes and a daily
 *   request limit answered with HTTP 429 and `Retry-After`;
 * - the LAN interface for lights with "LAN control" switched on: every such
 *   light listens on its own loopback address (127.0.0.2, 127.0.0.3 …) on the
 *   command port, as real lights each have their own IP; one socket answers
 *   the search. Answers go back to the sender's port.
 */

export interface GoveeSimLight {
  device: string;
  sku: string;
  name: string;
  /** Reachable over the LAN interface. */
  lan?: boolean;
  /** Abilities as the cloud lists them (default: all). */
  color?: boolean;
  colorTemp?: boolean;
  dim?: boolean;
}

export interface GoveeSimOptions {
  lights?: GoveeSimLight[];
  apiKey?: string;
  /** Requests per day before the cloud answers 429 (default 10 000). */
  dailyLimit?: number;
}

export interface GoveeSimState {
  on: boolean;
  brightness: number;
  rgb: { r: number; g: number; b: number };
  kelvin: number;
  online: boolean;
}

export interface GoveeSim {
  readonly apiKey: string;
  /** Base address of the simulated cloud API. */
  readonly cloudBase: string;
  /** Port the search goes to (on 127.0.0.1). */
  readonly scanPort: number;
  /** Port the lights take commands on (each on its own address). */
  readonly devicePort: number;
  /** LAN address of a light (null when it has no LAN control or the address could not be opened). */
  lanAddress(device: string): string | null;
  state(device: string): GoveeSimState;
  readonly stats: { list: number; state: number; control: number; refused: number; lanCommands: number; scans: number };
  /** Every cloud control command, oldest first. */
  readonly controlLog: { device: string; instance: string; value: unknown }[];
  /** Every LAN command, oldest first. */
  readonly lanLog: { device: string; cmd: string; data: unknown }[];
  /** Switches the LAN interface of a light off / on (as unplugging it would for the LAN). */
  setLan(device: string, enabled: boolean): void;
  setOnline(device: string, online: boolean): void;
  /** Changes the state as the Govee app or the light's button would. */
  setState(device: string, state: Partial<GoveeSimState>): void;
  /** Sets the requests left today. */
  setRemaining(requests: number): void;
  close(): Promise<void>;
}

/** The demo's API key (a simulator: nothing secret about it). */
export const GOVEE_DEMO_KEY = '00000000-demo-4000-8000-000000000000';

/** The demo household's lights. */
export const GOVEE_DEMO_LIGHTS: GoveeSimLight[] = [
  { device: 'AA:BB:CC:DD:EE:01:02:03', sku: 'H619A', name: 'Wohnzimmer LED-Streifen', lan: true },
  { device: 'AA:BB:CC:DD:EE:01:02:04', sku: 'H6199', name: 'Küche Unterschrank', lan: true },
  { device: 'AA:BB:CC:DD:EE:01:02:05', sku: 'H6008', name: 'Schlafzimmer Leselampe', lan: false, color: true },
];

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export async function startGoveeSim(options: GoveeSimOptions = {}): Promise<GoveeSim> {
  const apiKey = options.apiKey ?? randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  const lights = (options.lights ?? GOVEE_DEMO_LIGHTS).map((light) => ({ ...light }));
  const states = new Map<string, GoveeSimState>(lights.map((light, index) => [light.device, { on: index === 0, brightness: 80, rgb: { r: 255, g: 120, b: 40 }, kelvin: 0, online: true }]));
  const lanEnabled = new Map(lights.map((light) => [light.device, light.lan ?? false]));
  const stats = { list: 0, state: 0, control: 0, refused: 0, lanCommands: 0, scans: 0 };
  const controlLog: { device: string; instance: string; value: unknown }[] = [];
  const lanLog: { device: string; cmd: string; data: unknown }[] = [];
  let remaining = options.dailyLimit ?? 10_000;

  const stateOf = (device: string) => {
    const state = states.get(device);
    if (!state) throw new Error(`unknown simulated Govee light ${device}`);
    return state;
  };

  // --- Cloud --------------------------------------------------------------------------------------

  const capabilities = (light: GoveeSimLight) => [
    { type: 'devices.capabilities.on_off', instance: 'powerSwitch', parameters: { dataType: 'ENUM', options: [{ name: 'on', value: 1 }, { name: 'off', value: 0 }] } },
    ...(light.dim !== false ? [{ type: 'devices.capabilities.range', instance: 'brightness', parameters: { unit: 'unit.percent', dataType: 'INTEGER', range: { min: 1, max: 100, precision: 1 } } }] : []),
    ...(light.color !== false ? [{ type: 'devices.capabilities.color_setting', instance: 'colorRgb', parameters: { dataType: 'INTEGER', range: { min: 0, max: 16777215, precision: 1 } } }] : []),
    ...(light.colorTemp !== false ? [{ type: 'devices.capabilities.color_setting', instance: 'colorTemperatureK', parameters: { dataType: 'INTEGER', range: { min: 2000, max: 9000, precision: 1 } } }] : []),
  ];

  function cloud(method: string, path: string, body: unknown): { status: number; json: Json; headers?: Record<string, string> } {
    if (method === 'GET' && path === '/router/api/v1/user/devices') {
      stats.list++;
      return { status: 200, json: { code: 200, message: 'success', data: lights.map((light) => ({ sku: light.sku, device: light.device, deviceName: light.name, type: 'devices.types.light', capabilities: capabilities(light) })) } };
    }
    const payload = isObject(body) && isObject(body.payload) ? body.payload : null;
    const light = payload ? lights.find((entry) => entry.device === payload.device && entry.sku === payload.sku) : undefined;
    if (method === 'POST' && (path === '/router/api/v1/device/state' || path === '/router/api/v1/device/control')) {
      if (!light) return { status: 200, json: { code: 400, msg: 'devices not exist' } };
      const state = stateOf(light.device);
      if (path.endsWith('/state')) {
        stats.state++;
        return {
          status: 200,
          json: {
            requestId: isObject(body) ? body.requestId : '',
            msg: 'success',
            code: 200,
            payload: {
              sku: light.sku,
              device: light.device,
              capabilities: [
                { type: 'devices.capabilities.online', instance: 'online', state: { value: state.online } },
                { type: 'devices.capabilities.on_off', instance: 'powerSwitch', state: { value: state.on ? 1 : 0 } },
                { type: 'devices.capabilities.range', instance: 'brightness', state: { value: state.brightness } },
                { type: 'devices.capabilities.color_setting', instance: 'colorRgb', state: { value: state.rgb.r * 65536 + state.rgb.g * 256 + state.rgb.b } },
                { type: 'devices.capabilities.color_setting', instance: 'colorTemperatureK', state: { value: state.kelvin } },
              ],
            },
          },
        };
      }
      stats.control++;
      const capability = isObject(payload!.capability) ? payload!.capability : {};
      const value = capability.value;
      controlLog.push({ device: light.device, instance: String(capability.instance), value });
      if (!state.online) return { status: 200, json: { code: 400, msg: 'device offline' } };
      switch (capability.instance) {
        case 'powerSwitch':
          state.on = value === 1;
          break;
        case 'brightness':
          if (typeof value !== 'number' || value < 1 || value > 100) return { status: 200, json: { code: 400, msg: 'parameter value out of range' } };
          state.brightness = value;
          break;
        case 'colorRgb':
          if (typeof value !== 'number' || value < 0 || value > 0xffffff) return { status: 200, json: { code: 400, msg: 'parameter value out of range' } };
          state.rgb = { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
          state.kelvin = 0;
          break;
        case 'colorTemperatureK':
          if (typeof value !== 'number' || value < 2000 || value > 9000) return { status: 200, json: { code: 400, msg: 'parameter value out of range' } };
          state.kelvin = value;
          break;
        default:
          return { status: 200, json: { code: 400, msg: 'capability not support' } };
      }
      return { status: 200, json: { requestId: isObject(body) ? body.requestId : '', msg: 'success', code: 200, capability } };
    }
    return { status: 404, json: { code: 404, message: 'Not Found' } };
  }

  const netSockets = new Set<NetSocket>();
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const send = (status: number, json: Json, headers: Record<string, string> = {}) => {
        const text = JSON.stringify(json);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'X-RateLimit-Remaining': String(Math.max(0, remaining)), ...headers });
        res.end(text);
      };
      if (req.headers['govee-api-key'] !== apiKey) {
        stats.refused++;
        return send(401, { code: 401, message: 'Invalid API Key' });
      }
      if (remaining <= 0) {
        stats.refused++;
        return send(429, { code: 429, message: 'Too Many Requests' }, { 'Retry-After': '120' });
      }
      remaining--;
      let body: unknown = null;
      if (chunks.length > 0) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return send(400, { code: 400, message: 'bad request' });
        }
      }
      const answer = cloud(req.method ?? 'GET', new URL(req.url ?? '/', 'http://127.0.0.1').pathname, body);
      send(answer.status, answer.json);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.on('connection', (socket) => {
    netSockets.add(socket);
    socket.once('close', () => netSockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const cloudPort = (server.address() as AddressInfo).port;

  // --- LAN ----------------------------------------------------------------------------------------

  const bind = (address: string, port: number) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      socket.once('error', reject);
      socket.bind(port, address, () => {
        socket.off('error', reject);
        socket.on('error', () => {});
        resolve(socket);
      });
    });

  const lanSockets = new Map<string, { socket: Socket; address: string }>();
  let devicePort = 0;
  let next = 2;
  for (const light of lights) {
    if (!light.lan) continue;
    // Each light its own loopback address (works on Linux and Windows; elsewhere the light stays cloud-only).
    for (let attempt = 0; attempt < 5 && !lanSockets.has(light.device); attempt++) {
      const address = `127.0.0.${next++}`;
      try {
        const socket = await bind(address, devicePort);
        if (!devicePort) devicePort = socket.address().port;
        lanSockets.set(light.device, { socket, address });
      } catch {
        // address not available or port taken there: try the next one
      }
    }
  }

  const reply = (socket: Socket, message: Json, port: number, address: string) => socket.send(Buffer.from(JSON.stringify({ msg: message })), port, address);
  const statusOf = (device: string) => {
    const state = stateOf(device);
    return { onOff: state.on ? 1 : 0, brightness: state.brightness, color: state.rgb, colorTemInKelvin: state.kelvin };
  };

  for (const [device, { socket }] of lanSockets) {
    socket.on('message', (raw, remote) => {
      if (!lanEnabled.get(device) || !stateOf(device).online) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      const msg = isObject(parsed) && isObject(parsed.msg) ? parsed.msg : null;
      if (!msg) return;
      const data = isObject(msg.data) ? msg.data : {};
      const state = stateOf(device);
      const cmd = String(msg.cmd);
      if (cmd !== 'devStatus') {
        stats.lanCommands++;
        lanLog.push({ device, cmd, data });
      }
      switch (cmd) {
        case 'devStatus':
          return reply(socket, { cmd: 'devStatus', data: statusOf(device) }, remote.port, remote.address);
        case 'turn':
          state.on = data.value === 1;
          return;
        case 'brightness':
          if (typeof data.value === 'number') state.brightness = Math.min(100, Math.max(1, Math.round(data.value)));
          return;
        case 'colorwc': {
          const color = isObject(data.color) ? data.color : {};
          const kelvin = typeof data.colorTemInKelvin === 'number' ? data.colorTemInKelvin : 0;
          state.kelvin = kelvin;
          if (!kelvin) state.rgb = { r: Number(color.r) || 0, g: Number(color.g) || 0, b: Number(color.b) || 0 };
          return;
        }
        default:
          return;
      }
    });
  }

  // The search: one socket answers for the lights, each answer from the light's own address.
  const scanSocket = await bind('127.0.0.1', 0);
  scanSocket.on('message', (raw, remote) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (!isObject(parsed) || !isObject(parsed.msg) || parsed.msg.cmd !== 'scan') return;
    stats.scans++;
    for (const light of lights) {
      const lan = lanSockets.get(light.device);
      if (!lan || !lanEnabled.get(light.device) || !stateOf(light.device).online) continue;
      reply(
        lan.socket,
        { cmd: 'scan', data: { ip: lan.address, device: light.device, sku: light.sku, bleVersionHard: '3.01.01', bleVersionSoft: '1.03.01', wifiVersionHard: '1.00.10', wifiVersionSoft: '1.02.03' } },
        remote.port,
        remote.address,
      );
    }
  });

  return {
    apiKey,
    cloudBase: `http://127.0.0.1:${cloudPort}`,
    scanPort: scanSocket.address().port,
    devicePort,
    lanAddress: (device) => lanSockets.get(device)?.address ?? null,
    state: (device) => stateOf(device),
    stats,
    controlLog,
    lanLog,
    setLan(device, enabled) {
      lanEnabled.set(device, enabled);
    },
    setOnline(device, online) {
      stateOf(device).online = online;
    },
    setState(device, state) {
      Object.assign(stateOf(device), state);
    },
    setRemaining(requests) {
      remaining = requests;
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of netSockets) socket.destroy();
      });
      for (const { socket } of lanSockets.values()) socket.close();
      scanSocket.close();
    },
  };
}
