import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Vault } from '../src/security/crypto.ts';
import { ensureTlsMaterial, isPermittedName } from '../src/security/tls.ts';
import { createTestHub, type TestHub } from './helpers.ts';

const dirs: string[] = [];
let hub: TestHub | null = null;

afterEach(async () => {
  await hub?.destroy();
  hub = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function vaultDir(): { dir: string; vault: Vault } {
  const dir = mkdtempSync(join(tmpdir(), 'hub-tls-'));
  dirs.push(dir);
  return { dir, vault: Vault.open(dir, null).vault };
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function get(url: string, options: https.RequestOptions = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
}

describe('the hub as its own certificate authority', () => {
  const names = ['localhost', '127.0.0.1', '::1', '192.168.1.20', 'pc.local'];

  it('issues a server certificate that its CA vouches for, only for home-network names', () => {
    const { dir, vault } = vaultDir();
    const tls = ensureTlsMaterial(dir, vault, [...names, 'example.com', '8.8.8.8']);
    const ca = new X509Certificate(tls.caCert);
    const server = new X509Certificate(tls.cert);
    expect(ca.ca).toBe(true);
    expect(server.ca).toBe(false);
    expect(server.checkIssued(ca)).toBe(true);
    expect(server.verify(ca.publicKey)).toBe(true);
    expect(server.checkHost('pc.local')).toBe('pc.local');
    expect(server.checkIP('192.168.1.20')).toBe('192.168.1.20');
    // Public names never make it into the certificate.
    expect(server.checkHost('example.com')).toBeUndefined();
    expect(server.checkIP('8.8.8.8')).toBeUndefined();
    // Server certificates stay below the 398 days Apple accepts.
    expect(new Date(server.validTo).getTime() - Date.now()).toBeLessThan(398 * 86_400_000);
    expect(tls.caFingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('limits the CA to the home network (critical name constraints)', () => {
    const { dir, vault } = vaultDir();
    const tls = ensureTlsMaterial(dir, vault, names);
    const der = new X509Certificate(tls.caCert).raw;
    // OID 2.5.29.30 (nameConstraints) followed by "critical = TRUE".
    expect(der.includes(Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x1e, 0x01, 0x01, 0xff]))).toBe(true);
    expect(isPermittedName('192.168.178.10')).toBe(true);
    expect(isPermittedName('100.101.102.103')).toBe(true);
    expect(isPermittedName('fd12::1')).toBe(true);
    expect(isPermittedName('hub.fritz.box')).toBe(true);
    expect(isPermittedName('8.8.8.8')).toBe(false);
    expect(isPermittedName('bank.example')).toBe(false);
    expect(isPermittedName('evil-local')).toBe(false);
  });

  it('keeps its CA and renews the server certificate when addresses change or it ages', () => {
    const { dir, vault } = vaultDir();
    const first = ensureTlsMaterial(dir, vault, names);
    expect(ensureTlsMaterial(dir, vault, names).cert).toBe(first.cert);
    const moved = ensureTlsMaterial(dir, vault, [...names, '10.0.0.7']);
    expect(moved.caCert).toBe(first.caCert);
    expect(moved.cert).not.toBe(first.cert);
    const later = ensureTlsMaterial(dir, vault, [...names, '10.0.0.7'], new Date(Date.now() + 380 * 86_400_000));
    expect(later.caCert).toBe(first.caCert);
    expect(later.cert).not.toBe(moved.cert);
  });

  it('stores the keys encrypted, never in plain text', async () => {
    const { dir: base, vault } = vaultDir();
    const dir = join(base, 'tls');
    const tls = ensureTlsMaterial(dir, vault, names);
    const { readdirSync, readFileSync } = await import('node:fs');
    const files = readdirSync(dir);
    expect(files.sort()).toEqual(['ca.crt', 'ca.key.enc', 'server.crt', 'server.key.enc']);
    for (const file of files) expect(readFileSync(join(dir, file), 'utf8')).not.toContain('PRIVATE KEY');
    expect(tls.key).toContain('PRIVATE KEY');
  });
});

describe('a hub with HUB_TLS=auto', () => {
  it('serves the app over https and only the certificate page over http', async () => {
    const [plain, secure] = [await freePort(), await freePort()];
    hub = await createTestHub({ HUB_TLS: 'auto', HUB_PORT: String(plain), HUB_HTTPS_PORT: String(secure) });
    const address = await hub.start();
    expect(address).toMatch(/^https:\/\//);
    const tls = hub.ctx.tls!;

    // Trusted once the CA is known …
    const ok = await get(`https://127.0.0.1:${secure}/api/health`, { ca: tls.caCert });
    expect(ok.status).toBe(200);
    // HSTS would hold for every port of this host — including the plain certificate page.
    expect(ok.headers['strict-transport-security']).toBeUndefined();
    // … and refused by a client that does not know it.
    await expect(get(`https://127.0.0.1:${secure}/api/health`)).rejects.toThrow(/self[- ]signed|unable to verify|certificate/i);

    const download = await get(`https://127.0.0.1:${secure}/hub-ca.crt`, { ca: tls.caCert });
    expect(download.status).toBe(200);
    expect(download.body).toBe(tls.caCert);
    expect(download.headers['content-type']).toContain('x509');

    // Plain http: the page with the certificate, and nothing else.
    const page = await get(`http://127.0.0.1:${plain}/`);
    expect(page.status).toBe(200);
    expect(page.body).toContain(tls.caFingerprint);
    expect(page.body).toContain(`https://127.0.0.1:${secure}`);
    expect((await get(`http://127.0.0.1:${plain}/hub-ca.crt`)).body).toBe(tls.caCert);
    const redirect = await get(`http://127.0.0.1:${plain}/api/auth/me`);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.location).toBe(`https://127.0.0.1:${secure}/api/auth/me`);
  });

  it('sets the session cookie only for https (the __Host- cookie)', async () => {
    const [plain, secure] = [await freePort(), await freePort()];
    hub = await createTestHub({ HUB_TLS: 'auto', HUB_PORT: String(plain), HUB_HTTPS_PORT: String(secure) });
    await hub.start();
    const setup = await new Promise<{ status: number; cookie: string }>((resolve, reject) => {
      const body = JSON.stringify({ setupCode: 'TEST-SETU-PCOD', displayName: 'Admin', username: 'admin', password: 'correct horse battery', client: 'web' });
      const req = https.request(
        `https://127.0.0.1:${secure}/api/setup`,
        {
          method: 'POST',
          ca: hub!.ctx.tls!.caCert,
          headers: { 'content-type': 'application/json', 'x-requested-with': 'HomeHub', origin: `https://127.0.0.1:${secure}`, 'content-length': Buffer.byteLength(body) },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0, cookie: String(res.headers['set-cookie'] ?? '') }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    expect(setup.status).toBe(200);
    expect(setup.cookie).toMatch(/^__Host-hh_session=.*Secure/);
  });
});
