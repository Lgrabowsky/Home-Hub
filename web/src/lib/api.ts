import type { ApiError as ApiErrorBody } from '@home-hub/shared';
import { isNative } from './platform.ts';

/**
 * HTTP access to the hub.
 *
 * Browser: same origin, the session is an HttpOnly cookie; every request
 * carries the `X-Requested-With` marker the hub requires against forged
 * cross-site requests.
 * App: the hub is a remote origin; the session token (kept in the Android
 * Keystore) is sent as a bearer token and no cookies are used.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The hub could not be reached at all (as opposed to answering with an error). */
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

let baseUrl = '';
let bearer: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function configureApi(options: { baseUrl?: string; token?: string | null; onUnauthorized?: () => void }): void {
  if (options.baseUrl !== undefined) baseUrl = options.baseUrl.replace(/\/+$/, '');
  if (options.token !== undefined) bearer = options.token;
  if (options.onUnauthorized) onUnauthorized = options.onUnauthorized;
}

export function apiBaseUrl(): string {
  return baseUrl;
}

/** `wss://…` (or `ws://…`) base for WebSockets to the hub. */
export function wsBaseUrl(): string {
  const origin = baseUrl || window.location.origin;
  return origin.replace(/^http/, 'ws');
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Do not treat a 401 as "the session ended" (used while signing in). */
  quiet401?: boolean;
}

function headers(hasBody: boolean): Record<string, string> {
  const out: Record<string, string> = { 'X-Requested-With': 'HomeHub', Accept: 'application/json' };
  if (hasBody) out['Content-Type'] = 'application/json';
  if (bearer) out.Authorization = `Bearer ${bearer}`;
  return out;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const method = options.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'DELETE';
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(baseUrl + path, {
      method,
      headers: headers(hasBody),
      body: hasBody ? JSON.stringify(options.body ?? {}) : undefined,
      credentials: isNative ? 'omit' : 'same-origin',
      cache: 'no-store',
      signal,
    });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    throw new ApiError(0, 'network', 'Der Hub ist gerade nicht erreichbar.');
  }
  if (response.ok) return response;

  let body: Partial<ApiErrorBody> = {};
  try {
    body = (await response.json()) as Partial<ApiErrorBody>;
  } catch {
    /* not JSON (e.g. a proxy error page) */
  }
  const error = new ApiError(
    response.status,
    body.error ?? 'error',
    body.message ?? (response.status >= 500 ? 'Der Hub meldet einen Fehler.' : 'Die Anfrage wurde abgelehnt.'),
    body.retryAfter,
  );
  if (response.status === 401 && !options.quiet401) onUnauthorized?.();
  throw error;
}

/** JSON request. Rejects with `ApiError` (German message, ready to show). */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const get = <T>(path: string, options?: RequestOptions) => api<T>(path, { ...options, method: 'GET' });
export const post = <T>(path: string, body?: unknown, options?: RequestOptions) => api<T>(path, { ...options, method: 'POST', body });
export const put = <T>(path: string, body?: unknown, options?: RequestOptions) => api<T>(path, { ...options, method: 'PUT', body });
export const patch = <T>(path: string, body?: unknown, options?: RequestOptions) => api<T>(path, { ...options, method: 'PATCH', body });
export const del = <T>(path: string, options?: RequestOptions) => api<T>(path, { ...options, method: 'DELETE' });

/** Binary download (pictures). */
export async function getBlob(path: string, options: RequestOptions = {}): Promise<Blob> {
  const response = await send(path, { ...options, method: 'GET' });
  return response.blob();
}

/**
 * Whether pictures from the hub can be used directly as `<img src>`.
 * In the browser the cookie authenticates them; the app has to fetch them
 * with its bearer token (see <HubImage>).
 */
export const imagesNeedFetch = isNative;

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.name === 'TimeoutError') return 'Der Hub antwortet nicht.';
  return 'Das hat leider nicht geklappt.';
}
