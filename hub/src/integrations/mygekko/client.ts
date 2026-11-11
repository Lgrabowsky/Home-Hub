import type { MyGekkoSettings } from '@home-hub/shared';
import { DeviceHttp, DeviceHttpError, type DeviceResponse } from '../../util/http.ts';

/**
 * Transport of the myGEKKO Query API.
 *
 * Every call — commands included — is an HTTP GET that carries the credentials
 * as query parameters (PyMyGekko `data_provider.py`, pinpong `client.ts`).
 * Because of that no URL, path or query string ever leaves this module: errors
 * only name the HTTP status or the kind of network problem.
 */

export const CLOUD_BASE_URL = 'https://live.my-gekko.com';

const API = '/api/v1/var';
/** Real resource trees are a few hundred KiB; anything far beyond that is not a myGEKKO. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Looking for HTTPS on a controller that so far only answered on HTTP must not hold up a poll for long. */
const HTTPS_UPGRADE_TIMEOUT_MS = 2500;

export type GekkoErrorKind =
  /** 401/403: wrong credentials. Repeated attempts lock the account on the controller for 10 minutes. */
  | 'auth'
  /** 429: too many sessions / requests. */
  | 'rate_limit'
  /** 404: unknown resource. */
  | 'not_found'
  /** 405: the resource cannot be written. */
  | 'not_writable'
  /** 410: cloud only — the controller is offline or the id is wrong. */
  | 'gone'
  /** 444: the controller did not execute the command. */
  | 'not_executed'
  /** 400: syntax error. */
  | 'bad_request'
  /** Any other HTTP error status. */
  | 'status'
  /** The answer is not what the API documents (no JSON, too large). */
  | 'protocol'
  | 'timeout'
  | 'network'
  | 'aborted'
  /** The settings cannot work (no or malformed address). */
  | 'config';

export class GekkoError extends Error {
  constructor(
    message: string,
    readonly kind: GekkoErrorKind,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GekkoError';
  }
}

export function isGekkoError(err: unknown): err is GekkoError {
  return err instanceof GekkoError;
}

function errorForStatus(status: number): GekkoError | null {
  if (status >= 200 && status < 300) return null;
  const kind: GekkoErrorKind =
    status === 401 || status === 403
      ? 'auth'
      : status === 429
        ? 'rate_limit'
        : status === 404
          ? 'not_found'
          : status === 405
            ? 'not_writable'
            : status === 410
              ? 'gone'
              : status === 444
                ? 'not_executed'
                : status === 400
                  ? 'bad_request'
                  : 'status';
  return new GekkoError(`myGEKKO answered with HTTP ${status}`, kind, status);
}

/** The JSON document of an answer; throws `SyntaxError` when it is none. */
function parseBody(response: DeviceResponse): unknown {
  return JSON.parse(response.body.toString('utf8').replace(/^\uFEFF/, '')) as unknown;
}

/** A good answer carrying a JSON object — what both documents of the Query API look like. */
function isApiAnswer(response: DeviceResponse): boolean {
  if (response.status < 200 || response.status >= 300) return false;
  try {
    const body = parseBody(response);
    return typeof body === 'object' && body !== null && !Array.isArray(body);
  } catch {
    return false;
  }
}

/** An answer that proves the Query API is on the other end: a document, or one of its own refusals. */
function speaksApi(response: DeviceResponse): boolean {
  return isApiAnswer(response) || response.status === 401 || response.status === 403 || response.status === 429;
}

/** Something answered, but it is not the Query API: an unknown path or a page that is no JSON document. */
function isForeignAnswer(response: DeviceResponse): boolean {
  return response.status === 404 || (response.status >= 200 && response.status < 300 && !isApiAnswer(response));
}

/** The host cannot be reached at all — asking again over plain HTTP would only double the wait. */
const UNREACHABLE = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN']);

function networkCode(err: GekkoError): string {
  const cause = err.cause instanceof Error ? err.cause.cause : undefined;
  return cause instanceof Error ? ((cause as NodeJS.ErrnoException).code ?? '') : '';
}

/** No HTTP answer arrived: the request may not have reached the controller. */
function isTransportFailure(err: unknown): err is GekkoError {
  return isGekkoError(err) && (err.kind === 'network' || err.kind === 'timeout');
}

type Scheme = 'https' | 'http';
export type GekkoTransport = Scheme | 'cloud';

export interface GekkoClientOptions {
  timeoutMs: number;
  /** While talking plain HTTP: how often to look whether the controller offers HTTPS (again). */
  httpsRetryMs: number;
  /** Tests point the cloud mode at a simulator. */
  cloudBaseUrl?: string;
}

export class GekkoClient {
  readonly mode: 'local' | 'cloud';
  private readonly auth: string;
  private readonly cloud: DeviceHttp | null = null;
  private readonly local: Record<Scheme, DeviceHttp> | null = null;
  /** Local mode: the scheme the controller answered on; forgotten when it stops answering. */
  private scheme: Scheme | null = null;
  /** Local mode: the scheme that worked last (commands are never used to find out which one works). */
  private lastScheme: Scheme | null = null;
  private lastHttpsAttemptAt = 0;

  /** Throws `GekkoError('config')` when the settings cannot describe a controller. */
  constructor(
    settings: Pick<MyGekkoSettings, 'mode' | 'host' | 'username' | 'password' | 'gekkoId'>,
    private readonly options: GekkoClientOptions,
  ) {
    this.mode = settings.mode;
    const params: Record<string, string> =
      settings.mode === 'cloud'
        ? { username: settings.username, key: settings.password, gekkoid: settings.gekkoId }
        : { username: settings.username, password: settings.password };
    this.auth = Object.entries(params)
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join('&');

    const common = { timeoutMs: options.timeoutMs, maxSockets: 2, authMode: 'none' as const };
    if (settings.mode === 'cloud') {
      if (!settings.gekkoId.trim()) throw new GekkoError('no myGEKKO id configured', 'config');
      this.cloud = new DeviceHttp({ ...common, baseUrl: options.cloudBaseUrl ?? CLOUD_BASE_URL });
      return;
    }
    const host = settings.host.trim();
    let valid = false;
    try {
      const url = new URL(`http://${host}`);
      valid = host !== '' && url.host !== '' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      valid = false;
    }
    if (!valid) throw new GekkoError('invalid controller address', 'config');
    this.local = {
      // The controller's certificate is self-signed; it is accepted for this one device only.
      https: new DeviceHttp({ ...common, baseUrl: `https://${host}`, insecureTls: true }),
      http: new DeviceHttp({ ...common, baseUrl: `http://${host}` }),
    };
  }

  /** How the controller is reached right now; null until the first answer in local mode. */
  get transport(): GekkoTransport | null {
    return this.mode === 'cloud' ? 'cloud' : this.scheme;
  }

  destroy(): void {
    this.cloud?.destroy();
    this.local?.https.destroy();
    this.local?.http.destroy();
  }

  /** `GET /api/v1/var` — names, pages and format strings of all elements. */
  readTree(signal?: AbortSignal): Promise<unknown> {
    return this.readJson(API, signal);
  }

  /** `GET /api/v1/var/status` — all current values. */
  readStatus(signal?: AbortSignal): Promise<unknown> {
    return this.readJson(`${API}/status`, signal);
  }

  /**
   * `GET /api/v1/var/{system}/{element}/scmd/set?value=…`
   *
   * Sent exactly once: a command whose answer got lost may still have been
   * executed, so it is neither repeated nor tried on the other scheme.
   */
  async sendCommand(system: string, element: string, value: string, signal?: AbortSignal): Promise<void> {
    const path = `${API}/${encodeURIComponent(system)}/${encodeURIComponent(element)}/scmd/set?value=${encodeURIComponent(value)}&${this.auth}`;
    let response: DeviceResponse;
    if (this.cloud) {
      response = await this.send(this.cloud, path, signal);
    } else {
      // A single failed poll forgets `scheme`; the controller is most likely still there, on the same scheme.
      const scheme = this.scheme ?? this.lastScheme;
      if (!scheme) throw new GekkoError('no connection to the controller yet', 'network');
      response = await this.send(this.local![scheme], path, signal);
    }
    const failure = errorForStatus(response.status);
    if (failure) throw failure;
  }

  private async readJson(resource: string, signal?: AbortSignal): Promise<unknown> {
    const path = `${resource}?${this.auth}`;
    const response = this.cloud ? await this.send(this.cloud, path, signal) : await this.readLocal(path, signal);
    const failure = errorForStatus(response.status);
    if (failure) throw failure;
    try {
      return parseBody(response);
    } catch (err) {
      throw new GekkoError('answer is not JSON', 'protocol', response.status, { cause: err });
    }
  }

  /**
   * Which scheme the controller speaks depends on its firmware (PyMyGekko
   * assumes https, the pinpong client http). HTTPS is tried first; plain HTTP
   * is the fallback when no HTTPS answer can be had — or when what answers on
   * the HTTPS port is not the Query API at all (404, a web page). A login that
   * HTTPS rejects is never repeated over HTTP: every rejected login counts
   * towards the controller's lock-out. Whatever answered is kept.
   * While on HTTP the controller is asked over HTTPS again now and then, so a
   * fallback caused by a hiccup does not leave the password in clear text on
   * the network forever.
   *
   * Only reads go through here: asking twice is harmless for them.
   */
  private async readLocal(path: string, signal?: AbortSignal): Promise<DeviceResponse> {
    const local = this.local!;
    const forgetOnFailure = async (scheme: Scheme): Promise<DeviceResponse> => {
      try {
        return await this.send(local[scheme], path, signal);
      } catch (err) {
        // Detect anew next time: the firmware (or the port) may have changed.
        if (isTransportFailure(err)) this.scheme = null;
        throw err;
      }
    };

    if (this.scheme === 'https') return forgetOnFailure('https');

    if (this.scheme === 'http') {
      if (Math.abs(Date.now() - this.lastHttpsAttemptAt) >= this.options.httpsRetryMs) {
        this.lastHttpsAttemptAt = Date.now();
        try {
          const response = await this.send(local.https, path, signal, Math.min(this.options.timeoutMs, HTTPS_UPGRADE_TIMEOUT_MS));
          // Only a proper answer is a reason to leave a connection that works: whatever else listens
          // on the HTTPS port (or rejects this login there) must not cut the hub off from the controller.
          if (isApiAnswer(response)) {
            this.answeredOn('https');
            return response;
          }
        } catch (err) {
          if (!isTransportFailure(err)) throw err;
        }
      }
      return forgetOnFailure('http');
    }

    this.lastHttpsAttemptAt = Date.now();
    let foreign: DeviceResponse | null = null;
    try {
      const response = await this.send(local.https, path, signal);
      if (!isForeignAnswer(response)) {
        this.answeredOn('https');
        return response;
      }
      foreign = response;
    } catch (err) {
      if (!isTransportFailure(err) || UNREACHABLE.has(networkCode(err))) throw err;
    }
    if (!foreign) {
      const response = await this.send(local.http, path, signal);
      this.answeredOn('http');
      return response;
    }
    // Something else listens on the HTTPS port. The API may still be there on plain HTTP.
    try {
      const response = await this.send(local.http, path, signal);
      if (speaksApi(response)) {
        this.answeredOn('http');
        return response;
      }
    } catch (err) {
      if (!isTransportFailure(err)) throw err;
    }
    // Not the Query API on either side: report what the HTTPS port said and look again next time.
    return foreign;
  }

  private answeredOn(scheme: Scheme): void {
    this.scheme = scheme;
    this.lastScheme = scheme;
  }

  /** Any HTTP answer is returned as it is; only the lack of one is an error here. */
  private async send(http: DeviceHttp, path: string, signal?: AbortSignal, timeoutMs?: number): Promise<DeviceResponse> {
    try {
      return await http.request(path, { signal, timeoutMs: timeoutMs ?? this.options.timeoutMs, maxBytes: MAX_RESPONSE_BYTES });
    } catch (err) {
      if (err instanceof DeviceHttpError) {
        const kind: GekkoErrorKind =
          err.kind === 'timeout' ? 'timeout' : err.kind === 'aborted' ? 'aborted' : err.kind === 'protocol' ? 'protocol' : 'network';
        throw new GekkoError(`no answer from the controller (${err.kind})`, kind, undefined, { cause: err });
      }
      throw new GekkoError('request to the controller failed', 'network', undefined, { cause: err });
    }
  }
}
