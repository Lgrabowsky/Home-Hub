import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { LoginResponse, MeResponse, ServerMessage } from '@home-hub/shared';
import { SECRET_SET } from '@home-hub/shared';
import { ADMIN, Client, SETUP_CODE, createTestHub, nextTotp, setupAdmin, type TestHub } from './helpers.ts';

let hub: TestHub;

beforeEach(async () => {
  hub = await createTestHub();
});

afterEach(async () => {
  await hub.destroy();
});

describe('first-run setup', () => {
  it('requires the setup code and can only be done once', async () => {
    const client = new Client(hub);
    expect((await client.get('/api/bootstrap')).json()).toMatchObject({ setupRequired: true, hubName: 'Home Hub', session: 'none' });

    const wrong = await client.post('/api/setup', { setupCode: 'AAAA-BBBB-CCCC', ...ADMIN });
    expect(wrong.statusCode).toBe(403);

    const weak = await client.post('/api/setup', { setupCode: SETUP_CODE, username: 'admin', password: 'short' });
    expect(weak.statusCode).toBe(400);

    const ok = await client.post('/api/setup', { setupCode: SETUP_CODE, ...ADMIN });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as LoginResponse).status).toBe('enroll_required');

    const again = await new Client(hub).post('/api/setup', { setupCode: SETUP_CODE, username: 'other', password: 'another long password' });
    expect(again.statusCode).toBe(409);
    expect((await client.get('/api/bootstrap')).json()).toMatchObject({ setupRequired: false, session: 'enroll' });
  });
});

describe('sign-in and two-factor authentication', () => {
  it('confines a new account to 2FA enrolment until it is completed', async () => {
    const client = new Client(hub);
    await client.post('/api/setup', { setupCode: SETUP_CODE, ...ADMIN });

    const me = (await client.get('/api/auth/me')).json() as MeResponse;
    expect(me.enrollRequired).toBe(true);
    // Everything else is closed while enrolment is pending.
    expect((await client.get('/api/state')).statusCode).toBe(403);
    expect((await client.get('/api/users')).statusCode).toBe(403);
    expect((await client.post('/api/auth/ticket', { scope: 'realtime' })).statusCode).toBe(403);
  });

  it('logs in with password + TOTP, rejects replayed codes and wrong passwords', async () => {
    const { secret } = await setupAdmin(hub);

    const client = new Client(hub);
    const noCode = await client.post('/api/auth/login', { ...ADMIN, client: 'web' });
    expect(noCode.json()).toEqual({ status: 'totp_required' });

    const badCode = await client.post('/api/auth/login', { ...ADMIN, code: '000000', client: 'web' });
    expect(badCode.statusCode).toBe(401);

    const code = nextTotp(secret);
    const good = await client.post('/api/auth/login', { ...ADMIN, code, client: 'web' });
    expect(good.statusCode).toBe(200);
    expect((good.json() as LoginResponse).status).toBe('ok');
    expect(Object.keys(client.cookies)).toContain('hh_session');
    expect((await client.get('/api/state')).statusCode).toBe(200);

    // The same code must not work a second time.
    const replay = await new Client(hub).post('/api/auth/login', { ...ADMIN, code, client: 'web' });
    expect(replay.statusCode).toBe(401);

    const wrongPassword = await new Client(hub).post('/api/auth/login', { username: 'admin', password: 'wrong password!!', client: 'web' });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.json()).toMatchObject({ error: 'invalid_credentials' });
    // Unknown users get exactly the same answer.
    const unknown = await new Client(hub).post('/api/auth/login', { username: 'nobody', password: 'wrong password!!', client: 'web' });
    expect(unknown.json()).toEqual(wrongPassword.json());
  });

  it('accepts a recovery code exactly once', async () => {
    const client = new Client(hub);
    await client.post('/api/setup', { setupCode: SETUP_CODE, ...ADMIN });
    const secret = ((await client.post('/api/auth/totp/setup')).json() as { secret: string }).secret;
    const { totpCode } = await import('../src/security/totp.ts');
    const enabled = (await client.post('/api/auth/totp/enable', { code: totpCode(secret) })).json() as { recoveryCodes: string[] };
    expect(enabled.recoveryCodes).toHaveLength(8);

    const first = await new Client(hub).post('/api/auth/login', { ...ADMIN, code: enabled.recoveryCodes[0], client: 'web' });
    expect(first.statusCode).toBe(200);
    const second = await new Client(hub).post('/api/auth/login', { ...ADMIN, code: enabled.recoveryCodes[0], client: 'web' });
    expect(second.statusCode).toBe(401);
  });

  it('locks out after repeated failures', async () => {
    await setupAdmin(hub);
    const attacker = new Client(hub);
    attacker.ip = '203.0.113.9';
    let last = 0;
    for (let i = 0; i < 6; i++) {
      last = (await attacker.post('/api/auth/login', { username: 'admin', password: `guess number ${i}`, client: 'web' })).statusCode;
    }
    expect(last).toBe(429);
    // Even the right password is refused while locked …
    const locked = await attacker.post('/api/auth/login', { ...ADMIN, client: 'web' });
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBeDefined();
    // … but the legitimate user on another address is not locked out.
    const owner = new Client(hub);
    owner.ip = '10.0.0.77';
    expect((await owner.post('/api/auth/login', { ...ADMIN, client: 'web' })).json()).toEqual({ status: 'totp_required' });
  });

  it('issues bearer tokens to native clients and rotates the token after enrolment', async () => {
    const client = new Client(hub);
    const setup = (await client.post('/api/setup', { setupCode: SETUP_CODE, ...ADMIN, client: 'native', deviceName: 'Pixel' })).json() as {
      token: string;
    };
    expect(setup.token).toBeTruthy();
    expect(client.cookies).toEqual({});
    client.token = setup.token;
    const secret = ((await client.post('/api/auth/totp/setup')).json() as { secret: string }).secret;
    const { totpCode } = await import('../src/security/totp.ts');
    const enabled = (await client.post('/api/auth/totp/enable', { code: totpCode(secret) })).json() as { token: string };
    expect(enabled.token).toBeTruthy();
    expect(enabled.token).not.toBe(setup.token);
    // The enrolment token is dead, the new one works.
    expect((await client.get('/api/auth/me')).statusCode).toBe(401);
    client.token = enabled.token;
    const me = (await client.get('/api/auth/me')).json() as MeResponse;
    expect(me.enrollRequired).toBe(false);
    expect(me.session).toMatchObject({ client: 'native', deviceName: 'Pixel' });
  });
});

describe('request forgery protection', () => {
  it('rejects cookie-authenticated writes without the app header or from another origin', async () => {
    const { client } = await setupAdmin(hub);
    const noHeader = await hub.app.inject({ method: 'PUT', url: '/api/prefs', cookies: client.cookies, payload: { favorites: [] } });
    expect(noHeader.statusCode).toBe(403);
    expect(noHeader.json()).toMatchObject({ error: 'csrf' });

    const foreignOrigin = await client.request('PUT', '/api/prefs', { favorites: [] }, { origin: 'https://evil.example' });
    expect(foreignOrigin.statusCode).toBe(403);

    const crossSite = await client.request('GET', '/api/state', undefined, { 'sec-fetch-site': 'cross-site' });
    expect(crossSite.statusCode).toBe(403);

    expect((await client.put('/api/prefs', { favorites: ['gekko:lights/item1'] })).statusCode).toBe(200);
  });

  it('only answers CORS for the packaged app origins and never with credentials', async () => {
    const preflight = await hub.app.inject({
      method: 'OPTIONS',
      url: '/api/auth/login',
      headers: { origin: 'https://localhost', 'access-control-request-method': 'POST' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://localhost');
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();

    const other = await hub.app.inject({ method: 'GET', url: '/api/bootstrap', headers: { origin: 'https://evil.example' } });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sends strict security headers', async () => {
    const response = await hub.app.inject({ method: 'GET', url: '/api/health' });
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('private by default', () => {
  it('requires authentication for every API route except the public few', async () => {
    const publicRoutes = new Set(['/api/health', '/api/bootstrap', '/api/setup', '/api/auth/login', '/api/spotify/callback', '/api/ws', '/api/media/ws', '/api/*']);
    const routes = hub.app
      .printRoutes({ commonPrefix: false })
      .split('\n')
      .map((line) => /(\/api\/[^\s(]*)\s+\(([A-Z, ]+)\)/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ path: m[1]!, methods: m[2]!.split(',').map((s) => s.trim()) }));
    expect(routes.length).toBeGreaterThan(30);
    for (const route of routes) {
      if (publicRoutes.has(route.path)) continue;
      for (const method of route.methods.filter((m) => m !== 'HEAD' && m !== 'OPTIONS')) {
        const url = route.path.replace(/:([a-zA-Z]+)/g, 'x');
        const response = await hub.app.inject({ method: method as 'GET', url, headers: { 'x-requested-with': 'HomeHub' }, payload: method === 'GET' ? undefined : {} });
        expect(response.statusCode, `${method} ${route.path}`).toBe(401);
      }
    }
  });

  it('returns 401 for unknown API paths without revealing whether they exist', async () => {
    expect((await hub.app.inject({ method: 'GET', url: '/api/does-not-exist' })).statusCode).toBe(401);
  });
});

describe('users, roles and sessions', () => {
  it('lets administrators manage users and enforces permissions', async () => {
    const { client: admin } = await setupAdmin(hub);
    await admin.put('/api/admin/settings/general', { hubName: 'Zuhause', requireTotp: false, sessionDays: 30 });

    const created = await admin.post('/api/users', { username: 'gast', role: 'guest', password: 'a long guest password' });
    expect(created.statusCode).toBe(200);
    const guestId = (created.json() as { user: { id: string; permissions: string[] } }).user.id;
    expect((created.json() as { user: { permissions: string[] } }).user.permissions).toEqual(['home.control', 'music.control']);

    const guest = new Client(hub);
    expect(((await guest.post('/api/auth/login', { username: 'gast', password: 'a long guest password', client: 'web' })).json() as LoginResponse).status).toBe('ok');
    expect((await guest.get('/api/users')).statusCode).toBe(403);
    expect((await guest.get('/api/admin/settings')).statusCode).toBe(403);
    expect((await guest.post('/api/doors/haustuer/open', { relay: '1' })).statusCode).toBe(403);
    expect((await guest.get('/api/cameras/garten/snapshot')).statusCode).toBe(403);

    // Disabling the account ends its sessions immediately.
    expect((await admin.patch(`/api/users/${guestId}`, { disabled: true })).statusCode).toBe(200);
    expect((await guest.get('/api/auth/me')).statusCode).toBe(401);

    // The last administrator cannot be removed or demoted.
    const adminId = ((await admin.get('/api/auth/me')).json() as MeResponse).user.id;
    expect((await admin.delete(`/api/users/${adminId}`)).statusCode).toBe(409);
    expect((await admin.patch(`/api/users/${adminId}`, { role: 'member' })).statusCode).toBe(409);
  });

  it('revokes other sessions on password change and lists devices', async () => {
    const { client: first, secret } = await setupAdmin(hub);
    const second = new Client(hub);
    await second.post('/api/auth/login', { ...ADMIN, code: nextTotp(secret), client: 'web', deviceName: 'Tablet' });
    expect(((await first.get('/api/auth/sessions')).json() as { sessions: unknown[] }).sessions).toHaveLength(2);

    const changed = await first.post('/api/auth/password', { current: ADMIN.password, next: 'an even longer new password' });
    expect(changed.statusCode).toBe(200);
    expect((await second.get('/api/auth/me')).statusCode).toBe(401);
    expect((await first.get('/api/auth/me')).statusCode).toBe(200);
  });
});

describe('settings', () => {
  it('never returns stored secrets and keeps them when the placeholder is sent back', async () => {
    const { client } = await setupAdmin(hub);
    const device = { id: 'haustuer', name: 'Haustür', host: '192.168.1.40', username: 'abcdef0001', password: 'geheim123', room: 'Eingang' };
    const saved = await client.put('/api/admin/settings/doorbird', { enabled: false, retentionDays: 30, devices: [device] });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('geheim123');
    expect((saved.json() as { value: { devices: { password: string }[] } }).value.devices[0]!.password).toBe(SECRET_SET);

    await client.put('/api/admin/settings/doorbird', { enabled: false, retentionDays: 30, devices: [{ ...device, name: 'Haustür neu', password: SECRET_SET }] });
    expect(hub.ctx.settings.get('doorbird').devices[0]).toMatchObject({ name: 'Haustür neu', password: 'geheim123' });

    // Encrypted at rest: the password does not appear in the database file.
    const raw = hub.ctx.db.all<{ value: string }>('SELECT value FROM settings');
    expect(JSON.stringify(raw)).not.toContain('geheim123');
    expect(JSON.stringify(raw)).not.toContain('192.168.1.40');

    const invalid = await client.put('/api/admin/settings/doorbird', { enabled: true, devices: [{ ...device, host: 'http://bad/' }] });
    expect(invalid.statusCode).toBe(400);
  });

  it('stores the storeys and hands them to every app', async () => {
    const { client } = await setupAdmin(hub);
    await hub.start();
    const floors = [
      { name: 'Erdgeschoss', rooms: ['Küche', 'Wohnzimmer'] },
      { name: 'Obergeschoss', rooms: ['Bad'] },
    ];
    const saved = await client.put('/api/admin/settings/general', { hubName: 'Zuhause', requireTotp: false, sessionDays: 30, floors });
    expect(saved.statusCode).toBe(200);
    await expect.poll(async () => ((await client.get('/api/state')).json() as { floors: unknown }).floors).toEqual(floors);

    const nameless = await client.put('/api/admin/settings/general', { hubName: 'Zuhause', requireTotp: false, sessionDays: 30, floors: [{ name: ' ', rooms: [] }] });
    expect(nameless.statusCode).toBe(400);
  });

  it('never writes credentials to the log', async () => {
    const { client } = await setupAdmin(hub);
    await client.post('/api/auth/login', { ...ADMIN, client: 'web' });
    const text = hub.logs.join('\n');
    expect(text).not.toContain(ADMIN.password);
    expect(text).not.toContain(client.cookies.hh_session!);
  });
});

describe('realtime channel', () => {
  it('needs a one-time ticket and delivers a snapshot', async () => {
    const { client } = await setupAdmin(hub);
    const address = await hub.start();
    const wsUrl = address.replace('http', 'ws');

    const rejected = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`${wsUrl}/api/ws?ticket=nope`);
      socket.on('close', (code) => resolve(code));
      socket.on('error', () => resolve(-1));
    });
    expect(rejected).toBe(4401);

    const { ticket } = (await client.post('/api/auth/ticket', { scope: 'realtime' })).json() as { ticket: string };
    const messages: ServerMessage[] = [];
    const socket = new WebSocket(`${wsUrl}/api/ws?ticket=${ticket}`);
    await new Promise<void>((resolve, reject) => {
      socket.on('message', (data) => {
        messages.push(JSON.parse(data.toString()) as ServerMessage);
        if (messages.length === 2) resolve();
      });
      socket.on('error', reject);
    });
    expect(messages[0]).toMatchObject({ type: 'hello' });
    expect(messages[1]).toMatchObject({ type: 'snapshot' });

    // A ticket works exactly once.
    const reused = await new Promise<number>((resolve) => {
      const again = new WebSocket(`${wsUrl}/api/ws?ticket=${ticket}`);
      again.on('close', (code) => resolve(code));
    });
    expect(reused).toBe(4401);

    // Signing out closes the live connection.
    const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
    await client.post('/api/auth/logout');
    expect(await closed).toBe(4001);
  });

  it('refuses sockets from foreign web origins', async () => {
    const { client } = await setupAdmin(hub);
    const address = await hub.start();
    const { ticket } = (await client.post('/api/auth/ticket', { scope: 'realtime' })).json() as { ticket: string };
    const code = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`${address.replace('http', 'ws')}/api/ws?ticket=${ticket}`, { origin: 'https://evil.example' });
      socket.on('close', (c) => resolve(c));
    });
    expect(code).toBe(4403);
  });
});
