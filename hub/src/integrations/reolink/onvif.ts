import { createHash, randomBytes } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { DeviceHttp, DeviceHttpError } from '../../util/http.ts';

/**
 * A small ONVIF client: exactly what a camera without its own HTTP API needs
 * from ONVIF (Profile S) — device information, media profiles with their RTSP
 * addresses, and PTZ (continuous move, stop, presets).
 *
 * - SOAP 1.2 with a WS-Security UsernameToken (PasswordDigest). The digest
 *   contains a timestamp that the camera checks against its own clock, so the
 *   camera's clock is read first (that call needs no login) and the offset is
 *   applied to every request.
 * - Service addresses the camera reports carry its own idea of its address;
 *   only their paths are used, the host and port are always the configured ones.
 * - Cameras that insist on HTTP Digest instead get it (DeviceHttp answers the
 *   challenge by itself).
 */

const NS = {
  s: 'http://www.w3.org/2003/05/soap-envelope',
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  trt: 'http://www.onvif.org/ver10/media/wsdl',
  tptz: 'http://www.onvif.org/ver20/ptz/wsdl',
  tt: 'http://www.onvif.org/ver10/schema',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
};
const PASSWORD_DIGEST = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
const BASE64 = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

export class OnvifError extends Error {
  constructor(
    message: string,
    /** `auth`: the camera refused the credentials. `fault`: it refused the request. `protocol`: unreadable answer. */
    readonly kind: 'auth' | 'fault' | 'protocol',
  ) {
    super(message);
    this.name = 'OnvifError';
  }
}

export type Xml = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: false,
});

export const isXml = (value: unknown): value is Xml => typeof value === 'object' && value !== null && !Array.isArray(value);
export const node = (value: unknown): Xml => (isXml(value) ? value : {});
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
/** Text content of an element (that may carry attributes). */
export const text = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (isXml(value) && typeof value['#text'] === 'string') return value['#text'];
  return '';
};

export function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]!);
}

/** WS-Security PasswordDigest = Base64(SHA-1(nonce + created + password)). */
export function passwordDigest(nonce: Buffer, created: string, password: string): string {
  return createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8')])).digest('base64');
}

function securityHeader(username: string, password: string, now: Date): string {
  const nonce = randomBytes(16);
  // Without milliseconds: some firmwares cannot parse them.
  const created = `${now.toISOString().slice(0, 19)}Z`;
  return (
    `<wsse:Security s:mustUnderstand="1" xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}"><wsse:UsernameToken>` +
    `<wsse:Username>${escapeXml(username)}</wsse:Username>` +
    `<wsse:Password Type="${PASSWORD_DIGEST}">${passwordDigest(nonce, created, password)}</wsse:Password>` +
    `<wsse:Nonce EncodingType="${BASE64}">${nonce.toString('base64')}</wsse:Nonce>` +
    `<wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`
  );
}

export function envelope(body: string, security: string | null): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="${NS.s}" xmlns:tds="${NS.tds}" xmlns:trt="${NS.trt}" xmlns:tptz="${NS.tptz}" xmlns:tt="${NS.tt}">` +
    `<s:Header>${security ?? ''}</s:Header><s:Body>${body}</s:Body></s:Envelope>`
  );
}

/** Reads a SOAP fault into words; `auth` when it says the credentials are wrong. */
function faultOf(parsed: Xml): OnvifError | null {
  const fault = node(node(node(parsed.Envelope).Body).Fault);
  if (Object.keys(fault).length === 0) return null;
  const codes: string[] = [];
  // SOAP 1.2: Code/Value + nested Subcode/Value; SOAP 1.1: faultcode.
  let code: Xml = node(fault.Code);
  while (Object.keys(code).length > 0) {
    codes.push(text(code.Value));
    code = node(code.Subcode);
  }
  codes.push(text(fault.faultcode));
  const reason = text(node(fault.Reason).Text) || text(fault.faultstring) || codes.filter(Boolean).join(' / ') || 'Fehler';
  const auth = codes.some((entry) => /NotAuthorized|FailedAuthentication|InvalidSecurity|Sender\.NotAuthorized/i.test(entry)) || /not ?authori[sz]ed|authenticat/i.test(reason);
  return new OnvifError(reason, auth ? 'auth' : 'fault');
}

export interface OnvifTarget {
  host: string;
  port: number;
  username: string;
  password: string;
  timeoutMs: number;
}

export interface OnvifProfile {
  token: string;
  name: string;
  encoding: string | null;
  width: number | null;
  height: number | null;
  /** The profile has a PTZ configuration. */
  ptz: boolean;
}

export interface PtzCapabilities {
  panTilt: boolean;
  zoom: boolean;
  presets: boolean;
}

export class OnvifClient {
  private readonly http: DeviceHttp;
  /** Camera clock minus our clock. */
  private clockOffsetMs = 0;
  private paths = { device: '/onvif/device_service', media: '/onvif/media_service', ptz: '/onvif/ptz_service' as string | null };

  constructor(private readonly target: OnvifTarget) {
    this.http = new DeviceHttp({
      baseUrl: `http://${target.host.replace(/:\d+$/, '')}:${target.port}`,
      auth: { username: target.username, password: target.password },
      // Only answers a Digest challenge; WS-Security in the body is the normal way.
      authMode: 'digest',
      timeoutMs: target.timeoutMs,
      maxSockets: 2,
    });
  }

  destroy(): void {
    this.http.destroy();
  }

  get hasPtzService(): boolean {
    return this.paths.ptz !== null;
  }

  private async soap(path: string, body: string, options: { auth?: boolean; signal?: AbortSignal } = {}): Promise<Xml> {
    const security = options.auth === false ? null : securityHeader(this.target.username, this.target.password, new Date(Date.now() + this.clockOffsetMs));
    const response = await this.http.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
      body: envelope(body, security),
      signal: options.signal,
      maxBytes: 2 * 1024 * 1024,
    });
    const raw = response.body.toString('utf8');
    let parsed: Xml = {};
    try {
      parsed = node(parser.parse(raw));
    } catch {
      /* handled below */
    }
    const fault = faultOf(parsed);
    if (fault) throw fault;
    if (response.status === 401 || response.status === 403) throw new OnvifError('Benutzername oder Passwort stimmen nicht.', 'auth');
    if (response.status !== 200) throw new DeviceHttpError(`Die Kamera antwortete mit HTTP ${response.status}`, 'status', response.status);
    const answer = node(node(parsed.Envelope).Body);
    if (Object.keys(answer).length === 0) throw new OnvifError('Die Kamera lieferte keine gültige ONVIF-Antwort', 'protocol');
    return answer;
  }

  /** Reads the camera's clock (no login needed) so the security timestamps match it. */
  async syncClock(signal?: AbortSignal): Promise<void> {
    const answer = await this.soap(this.paths.device, '<tds:GetSystemDateAndTime/>', { auth: false, signal });
    const info = node(node(answer.GetSystemDateAndTimeResponse).SystemDateAndTime);
    const utc = node(info.UTCDateTime);
    const date = node(utc.Date);
    const time = node(utc.Time);
    const parts = [text(date.Year), text(date.Month), text(date.Day), text(time.Hour), text(time.Minute), text(time.Second)].map(Number);
    if (parts.some((part) => !Number.isFinite(part)) || parts[0]! < 2000) {
      this.clockOffsetMs = 0;
      return;
    }
    const camera = Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!, parts[3]!, parts[4]!, parts[5]!);
    const offset = camera - Date.now();
    // Below a few seconds the difference is noise.
    this.clockOffsetMs = Math.abs(offset) > 5000 ? offset : 0;
  }

  get clockOffset(): number {
    return this.clockOffsetMs;
  }

  async deviceInformation(signal?: AbortSignal): Promise<{ manufacturer: string; model: string; firmware: string }> {
    const info = node((await this.soap(this.paths.device, '<tds:GetDeviceInformation/>', { signal })).GetDeviceInformationResponse);
    return { manufacturer: text(info.Manufacturer), model: text(info.Model), firmware: text(info.FirmwareVersion) };
  }

  /** Finds the media and PTZ services. */
  async discoverServices(signal?: AbortSignal): Promise<void> {
    const answer = await this.soap(this.paths.device, '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>', { signal });
    const capabilities = node(node(answer.GetCapabilitiesResponse).Capabilities);
    const pathOf = (value: unknown): string | null => {
      const address = text(node(value).XAddr);
      if (!address) return null;
      try {
        const url = new URL(address);
        return `${url.pathname}${url.search}` || null;
      } catch {
        return null;
      }
    };
    this.paths.media = pathOf(capabilities.Media) ?? this.paths.media;
    this.paths.ptz = pathOf(capabilities.PTZ);
  }

  async profiles(signal?: AbortSignal): Promise<OnvifProfile[]> {
    const answer = node((await this.soap(this.paths.media, '<trt:GetProfiles/>', { signal })).GetProfilesResponse);
    return list(answer.Profiles)
      .map((entry) => {
        const profile = node(entry);
        const encoder = node(profile.VideoEncoderConfiguration);
        const resolution = node(encoder.Resolution);
        const width = Number(text(resolution.Width));
        const height = Number(text(resolution.Height));
        return {
          token: text(profile['@_token']),
          name: text(profile.Name),
          encoding: text(encoder.Encoding) || null,
          width: Number.isFinite(width) && width > 0 ? width : null,
          height: Number.isFinite(height) && height > 0 ? height : null,
          ptz: Object.keys(node(profile.PTZConfiguration)).length > 0,
        };
      })
      .filter((profile) => profile.token);
  }

  async streamUri(profileToken: string, signal?: AbortSignal): Promise<string> {
    const body =
      `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>` +
      `<trt:ProfileToken>${escapeXml(profileToken)}</trt:ProfileToken></trt:GetStreamUri>`;
    const answer = node((await this.soap(this.paths.media, body, { signal })).GetStreamUriResponse);
    const uri = text(node(answer.MediaUri).Uri);
    if (!uri) throw new OnvifError('Die Kamera nannte keine Video-Adresse', 'protocol');
    return uri;
  }

  /** What the PTZ unit can do. Falls back to "pan/tilt, presets" when the camera does not describe its node. */
  async ptzCapabilities(signal?: AbortSignal): Promise<PtzCapabilities> {
    if (!this.paths.ptz) return { panTilt: false, zoom: false, presets: false };
    try {
      const answer = node((await this.soap(this.paths.ptz, '<tptz:GetNodes/>', { signal })).GetNodesResponse);
      const nodes = list(answer.PTZNode).map(node);
      if (nodes.length === 0) return { panTilt: true, zoom: false, presets: true };
      const spaces = nodes.map((entry) => node(entry.SupportedPTZSpaces));
      return {
        panTilt: spaces.some((space) => list(space.ContinuousPanTiltVelocitySpace).length > 0),
        zoom: spaces.some((space) => list(space.ContinuousZoomVelocitySpace).length > 0),
        presets: nodes.some((entry) => Number(text(entry.MaximumNumberOfPresets)) > 0),
      };
    } catch (err) {
      if (err instanceof OnvifError && err.kind === 'auth') throw err;
      return { panTilt: true, zoom: false, presets: true };
    }
  }

  private needPtz(): string {
    if (!this.paths.ptz) throw new OnvifError('Die Kamera bietet kein PTZ über ONVIF an', 'fault');
    return this.paths.ptz;
  }

  async continuousMove(profileToken: string, velocity: { x: number; y: number } | null, zoom: number | null): Promise<void> {
    const round = (value: number) => Math.round(value * 1000) / 1000;
    const body =
      `<tptz:ContinuousMove><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken><tptz:Velocity>` +
      (velocity ? `<tt:PanTilt x="${round(velocity.x)}" y="${round(velocity.y)}"/>` : '') +
      (zoom !== null ? `<tt:Zoom x="${round(zoom)}"/>` : '') +
      `</tptz:Velocity></tptz:ContinuousMove>`;
    await this.soap(this.needPtz(), body);
  }

  async stop(profileToken: string): Promise<void> {
    await this.soap(this.needPtz(), `<tptz:Stop><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken><tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>`);
  }

  async presets(profileToken: string): Promise<{ token: string; name: string }[]> {
    const answer = node((await this.soap(this.needPtz(), `<tptz:GetPresets><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken></tptz:GetPresets>`)).GetPresetsResponse);
    return list(answer.Preset)
      .map((entry) => ({ token: text(node(entry)['@_token']), name: text(node(entry).Name).trim() }))
      .filter((preset) => preset.token);
  }

  async gotoPreset(profileToken: string, presetToken: string): Promise<void> {
    await this.soap(
      this.needPtz(),
      `<tptz:GotoPreset><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken><tptz:PresetToken>${escapeXml(presetToken)}</tptz:PresetToken></tptz:GotoPreset>`,
    );
  }
}
