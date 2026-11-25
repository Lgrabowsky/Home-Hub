import { randomUUID } from 'node:crypto';

/**
 * Govee's cloud API ("Govee Developer Platform", router API v1): the list of
 * devices with their abilities, the state of one device, and one command at a
 * time. Every request carries the household's API key in `Govee-API-Key`.
 *
 * Limits (Govee): 10 000 requests per day per account, and about ten per
 * minute per device for state and control. A refused request comes back as
 * HTTP 429 with `Retry-After`; the hub then pauses the cloud.
 *
 * Formats, as the API sends them:
 *   GET  /router/api/v1/user/devices → { code: 200, message, data: [{ sku, device, deviceName, type, capabilities: [{ type, instance, parameters }] }] }
 *   POST /router/api/v1/device/state   { requestId, payload: { sku, device } }
 *        → { code: 200, msg, payload: { sku, device, capabilities: [{ type, instance, state: { value } }] } }
 *   POST /router/api/v1/device/control { requestId, payload: { sku, device, capability: { type, instance, value } } }
 * Colours are one integer: r × 65536 + g × 256 + b.
 */

export const GOVEE_CLOUD = 'https://openapi.api.govee.com';

export class GoveeCloudError extends Error {
  constructor(
    message: string,
    /** `auth`: key refused. `rate`: limit reached. `device`: Govee refused the request. `protocol`: unreadable answer. `network`: no answer. */
    readonly kind: 'auth' | 'rate' | 'device' | 'protocol' | 'network',
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'GoveeCloudError';
  }
}

export interface CloudCapability {
  type: string;
  instance: string;
  parameters?: { dataType?: string; range?: { min: number; max: number; precision?: number } };
}

export interface CloudDevice {
  device: string;
  sku: string;
  name: string;
  /** `devices.types.light`, `devices.types.socket` … */
  type: string;
  capabilities: CloudCapability[];
}

export interface CloudState {
  online: boolean;
  on: boolean | null;
  brightness: number | null;
  rgb: { r: number; g: number; b: number } | null;
  /** 0 while the light shows a colour. */
  kelvin: number | null;
}

export type CloudCommand = { type: string; instance: string; value: number };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function packRgb(rgb: { r: number; g: number; b: number }): number {
  return (rgb.r & 0xff) * 65536 + (rgb.g & 0xff) * 256 + (rgb.b & 0xff);
}

export function unpackRgb(value: number): { r: number; g: number; b: number } {
  return { r: Math.floor(value / 65536) & 0xff, g: Math.floor(value / 256) & 0xff, b: value & 0xff };
}

function capabilityOf(raw: unknown): CloudCapability | null {
  if (!isObject(raw)) return null;
  const type = str(raw.type);
  const instance = str(raw.instance);
  if (!type || !instance) return null;
  const parameters = isObject(raw.parameters) ? raw.parameters : {};
  const range = isObject(parameters.range) ? parameters.range : null;
  const min = num(range?.min);
  const max = num(range?.max);
  return {
    type,
    instance,
    parameters: {
      dataType: str(parameters.dataType) || undefined,
      range: min !== null && max !== null ? { min, max, precision: num(range?.precision) ?? 1 } : undefined,
    },
  };
}

export class GoveeCloud {
  /** Requests left today, as Govee last reported (null until it has). */
  remaining: number | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly base: string = GOVEE_CLOUD,
    private readonly timeoutMs = 10_000,
  ) {}

  private async call(method: 'GET' | 'POST', path: string, body?: Json, signal?: AbortSignal): Promise<Json> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: { 'Govee-API-Key': this.apiKey, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'keine Antwort' : 'nicht erreichbar';
      throw new GoveeCloudError(`Govee-Cloud ${reason}`, 'network');
    }
    // Requests left in the day, if Govee says.
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining !== null && remaining.trim() !== '' && Number.isFinite(Number(remaining))) this.remaining = Number(remaining);
    if (response.status === 401 || response.status === 403) throw new GoveeCloudError('Govee nimmt den API-Key nicht an.', 'auth');
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      throw new GoveeCloudError('Govee lässt gerade keine weiteren Anfragen zu (Limit erreicht).', 'rate', Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new GoveeCloudError(`Govee-Cloud antwortete mit HTTP ${response.status}`, 'protocol');
    }
    if (!isObject(json)) throw new GoveeCloudError('Govee-Cloud lieferte keine gültige Antwort', 'protocol');
    const code = num(json.code);
    const message = str(json.message) || str(json.msg);
    if (code === 401) throw new GoveeCloudError('Govee nimmt den API-Key nicht an.', 'auth');
    if (code === 429) throw new GoveeCloudError('Govee lässt gerade keine weiteren Anfragen zu (Limit erreicht).', 'rate', 60_000);
    if (!response.ok || (code !== null && code !== 200)) throw new GoveeCloudError(message || `Govee-Cloud antwortete mit ${code ?? `HTTP ${response.status}`}`, 'device');
    return json;
  }

  async devices(signal?: AbortSignal): Promise<CloudDevice[]> {
    const json = await this.call('GET', '/router/api/v1/user/devices', undefined, signal);
    if (!Array.isArray(json.data)) throw new GoveeCloudError('Govee-Cloud lieferte keine Geräteliste', 'protocol');
    const devices: CloudDevice[] = [];
    for (const raw of json.data) {
      if (!isObject(raw)) continue;
      const device = str(raw.device);
      const sku = str(raw.sku);
      if (!device || !sku) continue;
      devices.push({
        device,
        sku,
        name: str(raw.deviceName).trim() || `Govee ${sku}`,
        type: str(raw.type),
        capabilities: (Array.isArray(raw.capabilities) ? raw.capabilities : []).map(capabilityOf).filter((entry): entry is CloudCapability => entry !== null),
      });
    }
    return devices;
  }

  async state(device: string, sku: string, signal?: AbortSignal): Promise<CloudState> {
    const json = await this.call('POST', '/router/api/v1/device/state', { requestId: randomUUID(), payload: { sku, device } }, signal);
    const payload = isObject(json.payload) ? json.payload : isObject(json.data) ? json.data : {};
    const state: CloudState = { online: true, on: null, brightness: null, rgb: null, kelvin: null };
    for (const raw of Array.isArray(payload.capabilities) ? payload.capabilities : []) {
      if (!isObject(raw)) continue;
      const instance = str(raw.instance);
      const value = isObject(raw.state) ? raw.state.value : undefined;
      if (instance === 'online') state.online = value === true || value === 1 || value === 'true';
      else if (instance === 'powerSwitch') state.on = value === 1 || value === true;
      else if (instance === 'brightness' && num(value) !== null) state.brightness = num(value);
      else if (instance === 'colorRgb' && num(value) !== null) state.rgb = unpackRgb(num(value)!);
      else if (instance === 'colorTemperatureK' && num(value) !== null) state.kelvin = num(value);
    }
    return state;
  }

  async control(device: string, sku: string, capability: CloudCommand, signal?: AbortSignal): Promise<void> {
    await this.call('POST', '/router/api/v1/device/control', { requestId: randomUUID(), payload: { sku, device, capability } }, signal);
  }
}
