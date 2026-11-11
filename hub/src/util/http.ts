import { createHash, randomBytes } from 'node:crypto';
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';

/**
 * Small HTTP client for talking to devices on the local network.
 *
 * Unlike `fetch` it gives us what these devices need: HTTP Digest
 * authentication, self-signed TLS (per device, never globally), long-lived
 * streaming responses without an idle body timeout, and Unix sockets.
 */

export interface DeviceHttpOptions {
  /** e.g. `http://192.168.1.20` or `https://cam.local:443`. Ignored when `socketPath` is set. */
  baseUrl?: string;
  socketPath?: string;
  auth?: { username: string; password: string };
  /** `auto` answers whatever challenge the device sends (Digest preferred). */
  authMode?: 'auto' | 'basic' | 'digest' | 'none';
  /** Accept self-signed certificates. Only for devices on the LAN that cannot have a real one. */
  insecureTls?: boolean;
  timeoutMs?: number;
  maxSockets?: number;
  headers?: Record<string, string>;
}

export interface DeviceRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  /** Abort when the response grows beyond this many bytes (default 32 MiB). */
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface DeviceResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface DeviceStream {
  status: number;
  headers: IncomingHttpHeaders;
  body: IncomingMessage;
  destroy(): void;
}

export class DeviceHttpError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'network' | 'auth' | 'status' | 'protocol' | 'aborted',
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DeviceHttpError';
  }
}

interface DigestChallenge {
  realm: string;
  nonce: string;
  qop: string | null;
  opaque: string | null;
  algorithm: string;
  nc: number;
}

function parseChallenges(header: string | string[] | undefined): { digest: Record<string, string> | null; basic: boolean } {
  const text = Array.isArray(header) ? header.join(', ') : (header ?? '');
  const basic = /(^|,\s*)basic\b/i.test(text);
  const start = text.search(/digest\s/i);
  if (start < 0) return { digest: null, basic };
  const params: Record<string, string> = {};
  const pattern = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi;
  for (const match of text.slice(start + 6).matchAll(pattern)) {
    params[match[1]!.toLowerCase()] = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3]!;
  }
  return { digest: params.nonce ? params : null, basic };
}

function hash(algorithm: string, data: string): string {
  return createHash(/sha-?256/i.test(algorithm) ? 'sha256' : 'md5')
    .update(data)
    .digest('hex');
}

export class DeviceHttp {
  private readonly base: URL | null;
  private readonly agent: http.Agent | https.Agent;
  private readonly isHttps: boolean;
  private digest: DigestChallenge | null = null;
  private useBasic: boolean;

  constructor(private readonly options: DeviceHttpOptions) {
    this.base = options.socketPath ? null : new URL(options.baseUrl ?? 'http://localhost');
    this.isHttps = this.base?.protocol === 'https:';
    const agentOptions = { keepAlive: true, keepAliveMsecs: 15_000, maxSockets: options.maxSockets ?? 6 };
    this.agent = this.isHttps
      ? new https.Agent({ ...agentOptions, rejectUnauthorized: !options.insecureTls })
      : new http.Agent(agentOptions);
    this.useBasic = options.authMode === 'basic';
  }

  destroy(): void {
    this.agent.destroy();
  }

  private authorization(method: string, path: string): string | null {
    const { auth, authMode = 'auto' } = this.options;
    if (!auth || authMode === 'none') return null;
    if (this.digest && authMode !== 'basic') {
      const d = this.digest;
      const ha1 = hash(d.algorithm, `${auth.username}:${d.realm}:${auth.password}`);
      const ha2 = hash(d.algorithm, `${method}:${path}`);
      const parts = [`username="${auth.username.replace(/["\\]/g, '\\$&')}"`, `realm="${d.realm}"`, `nonce="${d.nonce}"`, `uri="${path}"`];
      if (d.qop) {
        const nc = (++d.nc).toString(16).padStart(8, '0');
        const cnonce = randomBytes(8).toString('hex');
        const response = hash(d.algorithm, `${ha1}:${d.nonce}:${nc}:${cnonce}:${d.qop}:${ha2}`);
        parts.push(`qop=${d.qop}`, `nc=${nc}`, `cnonce="${cnonce}"`, `response="${response}"`);
      } else {
        parts.push(`response="${hash(d.algorithm, `${ha1}:${d.nonce}:${ha2}`)}"`);
      }
      if (d.opaque) parts.push(`opaque="${d.opaque}"`);
      if (!/^md5$/i.test(d.algorithm)) parts.push(`algorithm=${d.algorithm}`);
      return `Digest ${parts.join(', ')}`;
    }
    if (this.useBasic) return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
    return null;
  }

  /**
   * Learns from a 401 how to authenticate. Returns true when a retry makes sense.
   * `answeredFresh`: the refused request already carried a Digest answer to a
   * challenge obtained within this very call.
   */
  private acceptChallenge(headers: IncomingHttpHeaders, hadAuthorization: boolean, answeredFresh = false): boolean {
    const { auth, authMode = 'auto' } = this.options;
    if (!auth || authMode === 'none') return false;
    const { digest, basic } = parseChallenges(headers['www-authenticate']);
    if (digest && authMode !== 'basic') {
      const stale = /^true$/i.test(digest.stale ?? '');
      const sameNonce = this.digest?.nonce === digest.nonce;
      const hadDigest = this.digest !== null;
      const qop = digest.qop
        ?.split(',')
        .map((q) => q.trim())
        .includes('auth')
        ? 'auth'
        : null;
      this.digest = {
        realm: digest.realm ?? '',
        nonce: digest.nonce!,
        qop,
        opaque: digest.opaque ?? null,
        algorithm: digest.algorithm ?? 'MD5',
        nc: 0,
      };
      // Wrong credentials: our answer was to a fresh challenge and is refused all the same. Many servers
      // (lighttpd, Apache) hand out a new nonce with every 401, so a different nonce alone must not
      // trigger another try — every try with a wrong password counts towards the device's lockout.
      if (hadAuthorization && hadDigest && !stale && (sameNonce || answeredFresh)) return false;
      return true;
    }
    if ((basic || authMode === 'basic') && !this.useBasic) {
      this.useBasic = true;
      return true;
    }
    if (authMode === 'digest') return false;
    // No usable challenge at all: some devices answer 401 without WWW-Authenticate; try Basic once.
    if (!hadAuthorization && !this.useBasic) {
      this.useBasic = true;
      return true;
    }
    return false;
  }

  private open(path: string, request: DeviceRequest, attempt = 0): Promise<{ response: IncomingMessage; destroy: () => void }> {
    return new Promise((resolve, reject) => {
      const method = (request.method ?? 'GET').toUpperCase();
      const headers: Record<string, string> = { Accept: '*/*', ...this.options.headers, ...request.headers };
      const authorization = this.authorization(method, path);
      if (authorization) headers.Authorization = authorization;
      const body = request.body === undefined ? null : Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body);
      if (body) headers['Content-Length'] = String(body.length);

      const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? 8000;
      const transport = this.isHttps ? https : http;
      const req = transport.request({
        agent: this.agent,
        method,
        path,
        headers,
        ...(this.options.socketPath
          ? { socketPath: this.options.socketPath }
          : { host: this.base!.hostname, port: this.base!.port || (this.isHttps ? 443 : 80) }),
      });

      let settled = false;
      const onAbort = () => req.destroy(new DeviceHttpError('Anfrage abgebrochen', 'aborted'));
      const finish = (err: Error | null, response?: IncomingMessage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          request.signal?.removeEventListener('abort', onAbort);
          reject(err);
          return;
        }
        response!.once('close', () => request.signal?.removeEventListener('abort', onAbort));
        resolve({ response: response!, destroy: () => req.destroy() });
      };

      const timer = setTimeout(() => {
        req.destroy(new DeviceHttpError(`Keine Antwort innerhalb von ${Math.round(timeoutMs / 1000)} s`, 'timeout'));
      }, timeoutMs);

      if (request.signal) {
        if (request.signal.aborted) {
          onAbort();
        } else {
          request.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      req.on('error', (err) => {
        if (err instanceof DeviceHttpError) finish(err);
        else finish(new DeviceHttpError(describeNetworkError(err), 'network', undefined, { cause: err }));
      });

      req.on('response', (response) => {
        const answeredFresh = attempt >= 1 && Boolean(authorization?.startsWith('Digest '));
        if (response.statusCode === 401 && attempt < 2 && this.acceptChallenge(response.headers, Boolean(authorization), answeredFresh)) {
          response.resume();
          settled = true;
          clearTimeout(timer);
          request.signal?.removeEventListener('abort', onAbort);
          this.open(path, request, attempt + 1).then(resolve, reject);
          return;
        }
        finish(null, response);
      });

      req.end(body ?? undefined);
    });
  }

  /** Performs a request and buffers the whole response. Does not throw on HTTP error statuses. */
  async request(path: string, request: DeviceRequest = {}): Promise<DeviceResponse> {
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? 8000;
    const { response, destroy } = await this.open(path, request);
    const maxBytes = request.maxBytes ?? 32 * 1024 * 1024;
    return new Promise<DeviceResponse>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => {
        destroy();
        reject(new DeviceHttpError(`Antwort nicht innerhalb von ${Math.round(timeoutMs / 1000)} s vollständig`, 'timeout'));
      }, timeoutMs);
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          clearTimeout(timer);
          destroy();
          reject(new DeviceHttpError('Antwort des Geräts ist zu groß', 'protocol'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        clearTimeout(timer);
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
      });
      response.on('error', (err) => {
        clearTimeout(timer);
        reject(err instanceof DeviceHttpError ? err : new DeviceHttpError(describeNetworkError(err), 'network', undefined, { cause: err }));
      });
    });
  }

  /** Like `request`, but rejects unless the status is 2xx. */
  async ok(path: string, request: DeviceRequest = {}): Promise<DeviceResponse> {
    const response = await this.request(path, request);
    if (response.status === 401 || response.status === 403) {
      throw new DeviceHttpError('Anmeldung am Gerät abgelehnt (Benutzername/Passwort oder Berechtigung prüfen)', 'auth', response.status);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new DeviceHttpError(`Gerät antwortet mit HTTP ${response.status}`, 'status', response.status);
    }
    return response;
  }

  async json<T>(path: string, request: DeviceRequest = {}): Promise<T> {
    const response = await this.ok(path, request);
    try {
      return JSON.parse(response.body.toString('utf8')) as T;
    } catch (err) {
      throw new DeviceHttpError('Gerät lieferte keine gültige JSON-Antwort', 'protocol', response.status, { cause: err });
    }
  }

  /** Opens a streaming response (events, multipart). The caller owns the stream and must destroy it. */
  async stream(path: string, request: DeviceRequest = {}): Promise<DeviceStream> {
    const { response, destroy } = await this.open(path, request);
    return { status: response.statusCode ?? 0, headers: response.headers, body: response, destroy };
  }
}

function describeNetworkError(err: Error): string {
  const code = (err as NodeJS.ErrnoException).code ?? '';
  switch (code) {
    case 'ECONNREFUSED':
      return 'Verbindung abgelehnt (Gerät aus oder falscher Port?)';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'Gerät im Netzwerk nicht erreichbar';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Hostname konnte nicht aufgelöst werden';
    case 'ETIMEDOUT':
      return 'Zeitüberschreitung beim Verbinden';
    case 'ECONNRESET':
    case 'EPIPE':
      return 'Verbindung vom Gerät getrennt';
    case 'ENOENT':
      return 'Dienst nicht gestartet';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'CERT_HAS_EXPIRED':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'TLS-Zertifikat des Geräts wird nicht akzeptiert';
    default:
      return code ? `Netzwerkfehler (${code})` : `Netzwerkfehler: ${err.message}`;
  }
}

/** German one-liner for any error thrown while talking to a device. */
export function describeError(err: unknown): string {
  if (err instanceof DeviceHttpError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
