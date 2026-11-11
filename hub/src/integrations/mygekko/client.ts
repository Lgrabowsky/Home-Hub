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
  /** Local mode: the scheme the controller answered on. */
  private scheme: Scheme | null = null;
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
      if (!this.scheme) throw new GekkoError('no connection to the controller yet', 'network');
      response = await this.send(this.local![this.scheme], path, signal);
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
      return JSON.parse(response.body.toString('utf8').replace(/^﻿/, '')) as unknown;
    } catch (err) {
      throw new GekkoError('answer is not JSON', 'protocol', response.status, { cause: err });
    }
  }

  /**
   * Which scheme the controller speaks depends on its firmware (PyMyGekko
   * assumes https, the pinpong client http). HTTPS is tried first; plain HTTP
   * is the fallback when no HTTPS answer can be had. Whatever answered is kept.
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
      if (Date.now() - this.lastHttpsAttemptAt >= this.options.httpsRetryMs) {
        this.lastHttpsAttemptAt = Date.now();
        try {
          const response = await this.send(local.https, path, signal, Math.min(this.options.timeoutMs, HTTPS_UPGRADE_TIMEOUT_MS));
          this.scheme = 'https';
          return response;
        } catch (err) {
          if (!isTransportFailure(err)) throw err;
        }
      }
      return forgetOnFailure('http');
    }

    this.lastHttpsAttemptAt = Date.now();
    try {
      const response = await this.send(local.https, path, signal);
      this.scheme = 'https';
      return response;
    } catch (err) {
      if (!isTransportFailure(err) || UNREACHABLE.has(networkCode(err))) throw err;
    }
    const response = await this.send(local.http, path, signal);
    this.scheme = 'http';
    return response;
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
