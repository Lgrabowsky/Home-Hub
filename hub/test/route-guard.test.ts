import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHub, setupAdmin, type Client, type TestHub } from './helpers.ts';

/**
 * The hub is private by default: a route answers without a session only when it
 * says so. These tests walk over EVERY registered route, so a route added later
 * is covered without anybody remembering to write a test for it.
 */

/** The complete list of routes that may answer without a session. Extending it is a security decision. */
const PUBLIC_ROUTES = new Set([
  '/api/health', // liveness for the container health check, no data
  '/api/bootstrap', // "is this hub set up?" for the sign-in screen
  '/api/setup', // first-run set-up, protected by the set-up code
  '/api/auth/login',
  '/api/spotify/callback', // protected by the one-time state of the flow an administrator started
  '/api/ws', // authenticates with a one-time ticket
  '/api/media/ws', // authenticates with a one-time ticket
  '/api/*', // CORS preflight (OPTIONS) only
  '/hub-ca.crt', // the hub's public CA certificate (HTTPS without a domain), nothing secret
  '/zertifikat', // how to install it
]);

let hub: TestHub;
let admin: Client;
let port: number;

function raw(requestText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.on('connect', () => socket.write(requestText));
    socket.on('data', (chunk) => (data += chunk.toString('latin1')));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

beforeAll(async () => {
  hub = await createTestHub();
  admin = (await setupAdmin(hub)).client;
  port = Number(new URL(await hub.start()).port);
});

afterAll(async () => {
  await hub.destroy();
});

describe('private by default', () => {
  it('has exactly the public routes that were decided on', () => {
    const routes = hub.app.routeTable;
    expect(routes.length).toBeGreaterThan(60);
    expect(routes.map((route) => route.url)).toEqual(expect.arrayContaining(['/api/users', '/api/state', '/api/doors/:id/open', '/api/admin/settings/:key']));
    const declaredPublic = new Set(routes.filter((route) => route.access === 'public').map((route) => route.url));
    expect([...declaredPublic].sort()).toEqual([...PUBLIC_ROUTES].sort());
    // The catch-all only answers preflight requests.
    expect(routes.filter((route) => route.url === '/api/*').map((route) => route.method)).toEqual(['OPTIONS']);
  });

  it('refuses every other route without a session — however the path is written', async () => {
    const disguises = [
      (url: string) => url,
      // The router decodes percent-escapes: these reach the same handlers as the plain spelling.
      (url: string) => url.replace('/api/', '/%61pi/'),
      (url: string) => url.replace('/api/', '/ap%69/'),
      (url: string) => url.replace('/api/', '/./api/'),
      (url: string) => `${url}?x=/api/health`,
    ];
    let checked = 0;
    for (const route of hub.app.routeTable) {
      if (route.access === 'public') continue;
      const concrete = route.url.replace(/:[A-Za-z]+/g, 'x').replace(/\*/g, 'x');
      for (const method of [route.method].filter((entry) => entry !== 'HEAD' && entry !== 'OPTIONS')) {
        for (const disguise of disguises) {
          const response = await hub.app.inject({
            method: method as 'GET',
            url: disguise(concrete),
            // Its own address, so that the request budget of the other tests is not used up.
            remoteAddress: '10.9.9.9',
            headers: { 'x-requested-with': 'HomeHub', 'content-type': 'application/json' },
            payload: method === 'GET' || method === 'DELETE' ? undefined : '{}',
          });
          // 401 = turned away. (429 = turned away even earlier by the rate limit of the sensitive routes.)
          expect([401, 429], `${method} ${disguise(concrete)} answered ${response.statusCode}: ${response.body.slice(0, 120)}`).toContain(response.statusCode);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it('treats an absolute-form request target like its path', async () => {
    for (const target of [`http://x/api/users`, `http://127.0.0.1:${port}/api/state`, `https://hub.example/api/admin/settings`, '/%61pi/users', '/api/users']) {
      const answer = await raw(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      expect(answer.split('\r\n')[0], target).toBe('HTTP/1.1 401 Unauthorized');
    }
    const body = JSON.stringify({ username: 'intruder', role: 'admin', password: 'a long invented password 9' });
    const created = await raw(`POST /%61pi/users HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nX-Requested-With: HomeHub\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    expect(created.split('\r\n')[0]).toBe('HTTP/1.1 401 Unauthorized');
    expect(hub.ctx.users.list().map((user) => user.username)).toEqual(['admin']);
  });

  it('applies the CSRF check to disguised paths as well', async () => {
    // With the administrator's session cookie but without the app's header — what a foreign page could send.
    for (const url of ['/api/auth/sessions/revoke-others', '/%61pi/auth/sessions/revoke-others', '/ap%69/users']) {
      const forged = await hub.app.inject({ method: 'POST', url, cookies: admin.cookies, payload: {}, remoteAddress: '10.9.9.10' });
      expect(forged.statusCode, url).toBe(403);
      expect(forged.json()).toMatchObject({ error: 'csrf' });
    }
    // The same request from the app itself is accepted.
    expect((await admin.post('/api/auth/sessions/revoke-others')).statusCode).toBe(200);
  });
});
