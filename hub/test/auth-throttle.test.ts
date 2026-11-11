import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { totpCode } from '../src/security/totp.ts';
import { ADMIN, Client, createTestHub, setupAdmin, type TestHub } from './helpers.ts';

/** Guessing passwords and codes must stay slow — also when the guesses arrive all at once. */

let hub: TestHub;
let secret: string;

beforeEach(async () => {
  hub = await createTestHub({ HUB_TRUST_PROXY: '0' });
  secret = (await setupAdmin(hub)).secret;
});

afterEach(async () => {
  await hub.destroy();
});

function attacker(ip: string): Client {
  const client = new Client(hub);
  client.ip = ip;
  return client;
}

const statuses = (responses: { statusCode: number }[]) => responses.map((response) => response.statusCode).sort();

describe('login throttling', () => {
  it('evaluates parallel password guesses one after the other', async () => {
    const client = attacker('203.0.113.10');
    const responses = await Promise.all(Array.from({ length: 30 }, () => client.post('/api/auth/login', { username: ADMIN.username, password: 'wrong password 123' })));
    const evaluated = statuses(responses).filter((status) => status === 401).length;
    expect(evaluated).toBeLessThanOrEqual(5);
    expect(statuses(responses).filter((status) => status === 429).length).toBe(30 - evaluated);

    // The owner is not locked out by it.
    const owner = attacker('198.51.100.7');
    const login = await owner.post('/api/auth/login', { username: ADMIN.username, password: ADMIN.password });
    expect(login.json()).toMatchObject({ status: 'totp_required' });
  });

  it('allows only a few wrong codes after a correct password, from any address', async () => {
    let refused = 0;
    for (let i = 0; i < 20; i++) {
      // A new address for every guess: the per-address rules do not help here.
      const response = await attacker(`203.0.113.${100 + i}`).post('/api/auth/login', { username: ADMIN.username, password: ADMIN.password, code: '000000' });
      if (response.statusCode === 429) refused++;
    }
    expect(refused).toBeGreaterThanOrEqual(12);
    // While locked, even the right code is not checked.
    const locked = await attacker('198.51.100.8').post('/api/auth/login', { username: ADMIN.username, password: ADMIN.password, code: totpCode(secret, Date.now() + 30_000) });
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ error: 'too_many_attempts' });
  });

  it('forgets the wrong codes after a successful sign-in', async () => {
    // From changing addresses (one address alone is stopped after five failures anyway).
    for (let i = 0; i < 7; i++) {
      expect((await attacker(`198.51.100.${20 + i}`).post('/api/auth/login', { username: ADMIN.username, password: ADMIN.password, code: '000000' })).statusCode).toBe(401);
    }
    const ok = await attacker('198.51.100.30').post('/api/auth/login', { username: ADMIN.username, password: ADMIN.password, code: totpCode(secret, Date.now() + 30_000) });
    expect(ok.statusCode).toBe(200);
    for (let i = 0; i < 7; i++) {
      expect((await attacker(`198.51.100.${40 + i}`).post('/api/auth/login', { username: ADMIN.username, password: ADMIN.password, code: '000000' })).statusCode).toBe(401);
    }
  });
});
