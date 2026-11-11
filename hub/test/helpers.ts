import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { createHub, type Hub } from '../src/app.ts';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { createLogger } from '../src/log.ts';
import { totpCode } from '../src/security/totp.ts';

export const SETUP_CODE = 'TEST-SETU-PCOD';
export const ADMIN = { username: 'admin', password: 'correct horse battery' };

export interface TestHub extends Hub {
  dataDir: string;
  config: HubConfig;
  logs: string[];
  destroy(): Promise<void>;
}

/** A hub with a fresh temporary data directory. No device integration is enabled. */
export async function createTestHub(env: Record<string, string> = {}): Promise<TestHub> {
  const dataDir = mkdtempSync(join(tmpdir(), 'hub-test-'));
  const config = loadConfig({
    HUB_DATA_DIR: dataDir,
    HUB_PORT: '0',
    HUB_HOST: '127.0.0.1',
    HUB_SETUP_TOKEN: SETUP_CODE,
    HUB_MEDIA: '0',
    HUB_LOG_LEVEL: 'debug',
    HUB_WEB_DIR: join(dataDir, 'no-web'),
    ...env,
  });
  config.webDir = null;
  const logs: string[] = [];
  const hub = await createHub(config, { log: createLogger('debug', {}, (line) => logs.push(line)) });
  return {
    ...hub,
    dataDir,
    config,
    logs,
    async destroy() {
      await hub.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Minimal cookie-aware client on top of Fastify's inject(). Behaves like our web app (same-origin, CSRF header). */
export class Client {
  cookies: Record<string, string> = {};
  token: string | null = null;
  ip = '10.0.0.5';

  constructor(private readonly hub: Hub) {}

  async request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const allHeaders: Record<string, string> = { 'x-requested-with': 'HomeHub', ...headers };
    if (this.token) allHeaders.authorization = `Bearer ${this.token}`;
    const response = await this.hub.app.inject({
      method: method as 'GET',
      url,
      headers: allHeaders,
      cookies: this.token ? {} : this.cookies,
      remoteAddress: this.ip,
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    for (const cookie of response.cookies) {
      if (cookie.value === '' || (cookie.maxAge !== undefined && cookie.maxAge <= 0)) delete this.cookies[cookie.name];
      else this.cookies[cookie.name] = cookie.value;
    }
    return response;
  }

  get(url: string, headers?: Record<string, string>) {
    return this.request('GET', url, undefined, headers);
  }

  post(url: string, body: unknown = {}, headers?: Record<string, string>) {
    return this.request('POST', url, body, headers);
  }

  put(url: string, body: unknown = {}) {
    return this.request('PUT', url, body);
  }

  patch(url: string, body: unknown = {}) {
    return this.request('PATCH', url, body);
  }

  delete(url: string) {
    return this.request('DELETE', url);
  }
}

/** Creates the first administrator and completes 2FA enrolment. Returns a signed-in client and the TOTP secret. */
export async function setupAdmin(hub: Hub): Promise<{ client: Client; secret: string }> {
  const client = new Client(hub);
  const setup = await client.post('/api/setup', { setupCode: SETUP_CODE, ...ADMIN, displayName: 'Admin' });
  if (setup.statusCode !== 200) throw new Error(`setup failed: ${setup.body}`);
  const status = (setup.json() as { status: string }).status;
  if (status === 'ok') return { client, secret: '' };
  const begin = await client.post('/api/auth/totp/setup');
  const secret = (begin.json() as { secret: string }).secret;
  const enable = await client.post('/api/auth/totp/enable', { code: totpCode(secret) });
  if (enable.statusCode !== 200) throw new Error(`totp enable failed: ${enable.body}`);
  return { client, secret };
}

/** The TOTP code of the *next* time step — needed because a step may only be used once. */
export function nextTotp(secret: string, stepsAhead = 1): string {
  return totpCode(secret, Date.now() + stepsAhead * 30_000);
}
