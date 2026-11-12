import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { HubConfig } from '../config.ts';
import { Vault } from './crypto.ts';

/**
 * HTTPS without a domain name and without a third party: the hub becomes its
 * own small certificate authority (CA) and issues the certificate for its web
 * server itself. Each device trusts the hub once by installing the CA
 * certificate (`/hub-ca.crt`); from then on browser and app connect over
 * https://<address of the hub>:8443 without warnings.
 *
 * Installing a CA on a phone is a strong act of trust, so this one is
 * deliberately limited (X.509 name constraints, marked critical): it can only
 * vouch for addresses that exist exclusively inside a home network — private
 * IPv4/IPv6 ranges, Tailscale's 100.64/10, `localhost`, and names under
 * `.local`, `.lan`, `.home.arpa`, `.internal`, `.fritz.box`. Even if someone
 * stole the CA key, they could not use it to impersonate a website on the
 * internet. The key is stored encrypted with the hub's master key.
 *
 * The server certificate lives about a year and is renewed automatically —
 * also when the computer's addresses change. The CA lives ten years; it only
 * changes (and has to be installed again) if its files are deleted.
 *
 * Certificates are encoded here directly (DER, ECDSA P-256, SHA-256) to avoid
 * pulling a crypto library into the hub.
 */

// --- DER --------------------------------------------------------------------------------------------

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, ...content: Buffer[]): Buffer => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const seq = (...items: Buffer[]) => tlv(0x30, ...items);
const set = (...items: Buffer[]) => tlv(0x31, ...items);
const octets = (data: Buffer) => tlv(0x04, data);
const bitString = (data: Buffer) => tlv(0x03, Buffer.from([0]), data);
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, 'utf8'));
const bool = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0]));
const explicit = (n: number, content: Buffer) => tlv(0xa0 + n, content);

function integer(value: Buffer | number): Buffer {
  let bytes = typeof value === 'number' ? Buffer.from(value.toString(16).padStart(2, '0').replace(/^(.(..)*)$/, '0$1'), 'hex') : value;
  while (bytes.length > 1 && bytes[0] === 0 && bytes[1]! < 0x80) bytes = bytes.subarray(1);
  if (bytes[0]! >= 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const bytes = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    let rest = part >>> 7;
    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime until 2049, GeneralizedTime after (RFC 5280 §4.1.2.5). */
function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}

const OID = {
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  subjectAltName: '2.5.29.17',
  subjectKeyId: '2.5.29.14',
  authorityKeyId: '2.5.29.35',
  nameConstraints: '2.5.29.30',
};

const name = (commonName: string) => seq(set(seq(oid(OID.organization), utf8('Home Hub'))), set(seq(oid(OID.commonName), utf8(commonName))));
const extension = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

/** keyUsage bits as a DER BIT STRING (bit 0 = most significant bit of the first byte). */
function keyUsage(bits: number[]): Buffer {
  let value = 0;
  for (const bit of bits) value |= 0x80 >> bit;
  const unused = value === 0 ? 0 : Math.min(...bits.map((bit) => 7 - bit));
  return tlv(0x03, Buffer.from([unused, value]));
}

function ipBytes(ip: string): Buffer {
  if (isIP(ip) === 4) return Buffer.from(ip.split('.').map(Number));
  // Expand "::" and an embedded IPv4 tail.
  let text = ip.split('%')[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const b = v4[1]!.split('.').map(Number);
    text = text.replace(v4[1]!, `${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`);
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return Buffer.concat(groups.map((group) => Buffer.from(group.padStart(4, '0'), 'hex')));
}

/** The ranges the CA may vouch for: only addresses that exist inside a home network. */
export const PERMITTED_DNS = ['localhost', 'local', 'lan', 'home.arpa', 'internal', 'fritz.box'];
export const PERMITTED_NETS: [string, number][] = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['::1', 128],
];

function mask(prefix: number, bytes: number): Buffer {
  const out = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) out[i] = prefix >= (i + 1) * 8 ? 0xff : prefix <= i * 8 ? 0 : (0xff << (8 - (prefix - i * 8))) & 0xff;
  return out;
}

function nameConstraints(extraDns: string[]): Buffer {
  const dns = [...PERMITTED_DNS, ...extraDns].map((entry) => seq(tlv(0x82, Buffer.from(entry, 'ascii'))));
  const ips = PERMITTED_NETS.map(([address, prefix]) => {
    const raw = ipBytes(address);
    return seq(tlv(0x87, Buffer.concat([raw, mask(prefix, raw.length)])));
  });
  return seq(tlv(0xa0, ...dns, ...ips));
}

/** Whether an address/name is one the CA may vouch for. */
export function isPermittedName(entry: string, extraDns: string[] = []): boolean {
  if (isIP(entry)) {
    const raw = ipBytes(entry);
    return PERMITTED_NETS.some(([address, prefix]) => {
      const base = ipBytes(address);
      if (base.length !== raw.length) return false;
      const m = mask(prefix, raw.length);
      return raw.every((byte, i) => (byte & m[i]!) === (base[i]! & m[i]!));
    });
  }
  const lower = entry.toLowerCase();
  return [...PERMITTED_DNS, ...extraDns].some((allowed) => lower === allowed || lower.endsWith(`.${allowed}`));
}

function spkiDer(key: KeyObject): Buffer {
  return key.export({ type: 'spki', format: 'der' });
}

/** SHA-1 of the subject public key bit string (RFC 5280 §4.2.1.2, method 1). */
function keyId(publicKey: KeyObject): Buffer {
  const spki = spkiDer(publicKey);
  // The BIT STRING is the last element of the SubjectPublicKeyInfo; for P-256 it is the final 66 bytes (03 42 00 + 65).
  return createHash('sha1').update(spki.subarray(spki.length - 65)).digest();
}

interface IssueOptions {
  subject: string;
  publicKey: KeyObject;
  issuer: { name: string; key: KeyObject; publicKey: KeyObject };
  days: number;
  extensions: Buffer[];
}

function issue(options: IssueOptions): string {
  const serial = randomBytes(16);
  serial[0]! &= 0x7f;
  const algorithm = seq(oid(OID.ecdsaWithSha256));
  const notBefore = new Date(Date.now() - 60 * 60_000);
  const notAfter = new Date(Date.now() + options.days * 24 * 60 * 60_000);
  const tbs = seq(
    explicit(0, integer(2)),
    integer(serial),
    algorithm,
    name(options.issuer.name),
    seq(time(notBefore), time(notAfter)),
    name(options.subject),
    spkiDer(options.publicKey),
    explicit(3, seq(...options.extensions)),
  );
  const signature = sign('sha256', tbs, options.issuer.key);
  const der = seq(tbs, algorithm, bitString(signature));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE-----\n`;
}

// --- The hub's certificates ----------------------------------------------------------------------------

export interface TlsMaterial {
  /** PEM of the server certificate followed by the CA (the chain browsers expect). */
  cert: string;
  key: string;
  /** PEM of the CA certificate — what devices install. */
  caCert: string;
  /** SHA-256 fingerprint of the CA certificate, `AB:CD:…`, for comparing on the phone. */
  caFingerprint: string;
  /** Addresses and names in the server certificate. */
  names: string[];
  /** `own`: certificate files provided by the owner (HUB_TLS_CERT/KEY). */
  source: 'generated' | 'own';
  serverNotAfter: Date;
}

/** Addresses of this computer that the certificate should cover (only those the CA may vouch for). */
export function localNames(extra: string[] = []): string[] {
  const names = new Set<string>(['localhost', '127.0.0.1', '::1']);
  const host = hostname().trim().toLowerCase();
  if (/^[a-z0-9-]{1,63}$/.test(host)) names.add(`${host}.local`);
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.internal) continue;
      const address = entry.address.split('%')[0]!;
      if (isPermittedName(address)) names.add(address);
    }
  }
  for (const name of extra) if (name.trim()) names.add(name.trim().toLowerCase());
  return [...names];
}

function fingerprint(pem: string): string {
  return new X509Certificate(pem).fingerprint256;
}

const CA_DAYS = 3650;
/** Below Apple's 398-day limit for server certificates. */
const SERVER_DAYS = 397;
const RENEW_BEFORE_DAYS = 30;

/**
 * Loads the hub's CA and server certificate from `dir`, creating or renewing
 * what is missing, about to expire, or no longer matching `names`. The keys are
 * stored encrypted with `vault`.
 */
export function ensureTlsMaterial(dir: string, vault: Vault, names: string[], now = new Date()): TlsMaterial {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = (fileName: string) => join(dir, fileName);
  const write = (fileName: string, content: string, secret = false) => {
    const temp = `${file(fileName)}.tmp`;
    writeFileSync(temp, content, { mode: secret ? 0o600 : 0o644 });
    renameSync(temp, file(fileName));
    if (secret) {
      try {
        chmodSync(file(fileName), 0o600);
      } catch {
        /* Windows */
      }
    }
  };

  const permitted = names.filter((entry) => isPermittedName(entry));

  // The CA: kept for its whole life (devices trust exactly this one).
  let caCert: string | null = existsSync(file('ca.crt')) ? readFileSync(file('ca.crt'), 'utf8') : null;
  let caKey: KeyObject | null = null;
  if (caCert && existsSync(file('ca.key.enc'))) {
    try {
      caKey = createPrivateKey(vault.decryptText(readFileSync(file('ca.key.enc'), 'utf8'), 'tls-ca'));
      if (new Date(new X509Certificate(caCert).validTo).getTime() - now.getTime() < RENEW_BEFORE_DAYS * 86_400_000) caKey = null;
    } catch {
      caKey = null;
    }
  }
  if (!caCert || !caKey) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    caKey = pair.privateKey;
    const caName = `Home Hub ${randomBytes(3).toString('hex').toUpperCase()}`;
    caCert = issue({
      subject: caName,
      publicKey: pair.publicKey,
      issuer: { name: caName, key: pair.privateKey, publicKey: pair.publicKey },
      days: CA_DAYS,
      extensions: [
        extension(OID.basicConstraints, true, seq(bool(true), integer(0))),
        extension(OID.keyUsage, true, keyUsage([5, 6])),
        extension(OID.subjectKeyId, false, octets(keyId(pair.publicKey))),
        extension(OID.nameConstraints, true, nameConstraints([])),
      ],
    });
    write('ca.key.enc', vault.encryptText(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'tls-ca'), true);
    write('ca.crt', caCert);
    // A new CA makes every older server certificate worthless.
    for (const stale of ['server.crt', 'server.key.enc']) if (existsSync(file(stale))) writeFileSync(file(stale), '');
  }
  const ca = new X509Certificate(caCert);
  const caPublic = ca.publicKey;

  // The server certificate: renewed when it ages or the addresses changed.
  const wanted = [...new Set(permitted)].sort();
  let serverCert: string | null = existsSync(file('server.crt')) ? readFileSync(file('server.crt'), 'utf8') || null : null;
  let serverKeyPem: string | null = null;
  if (serverCert && existsSync(file('server.key.enc'))) {
    try {
      const current = new X509Certificate(serverCert);
      // IPv6 is written differently by Node ("0:0:…:1" for "::1"): compare the raw bytes.
      const canonical = (entry: string) => (isIP(entry) ? ipBytes(entry).toString('hex') : entry.toLowerCase());
      const covered = (current.subjectAltName ?? '')
        .split(', ')
        .map((entry) => canonical(entry.replace(/^(DNS|IP Address):/, '')))
        .sort();
      const expected = wanted.map(canonical).sort();
      const fresh = new Date(current.validTo).getTime() - now.getTime() > RENEW_BEFORE_DAYS * 86_400_000;
      const sameNames = covered.length === expected.length && covered.every((entry, index) => entry === expected[index]);
      if (fresh && sameNames && current.checkIssued(ca) && current.verify(caPublic)) {
        serverKeyPem = vault.decryptText(readFileSync(file('server.key.enc'), 'utf8'), 'tls-server');
      }
    } catch {
      serverKeyPem = null;
    }
  }
  if (!serverKeyPem) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const san = seq(...wanted.map((entry) => (isIP(entry) ? tlv(0x87, ipBytes(entry)) : tlv(0x82, Buffer.from(entry, 'ascii')))));
    serverCert = issue({
      subject: wanted.find((entry) => !isIP(entry) && entry !== 'localhost') ?? 'Home Hub',
      publicKey: pair.publicKey,
      issuer: { name: ca.subject.split('\n').find((line) => line.startsWith('CN='))!.slice(3), key: caKey, publicKey: caPublic },
      days: SERVER_DAYS,
      extensions: [
        extension(OID.basicConstraints, true, seq()),
        extension(OID.keyUsage, true, keyUsage([0])),
        extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
        extension(OID.subjectAltName, false, san),
        extension(OID.subjectKeyId, false, octets(keyId(pair.publicKey))),
        extension(OID.authorityKeyId, false, seq(tlv(0x80, keyId(caPublic)))),
      ],
    });
    serverKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    write('server.key.enc', vault.encryptText(serverKeyPem, 'tls-server'), true);
    write('server.crt', serverCert);
  }

  return {
    cert: `${serverCert}${caCert}`,
    key: serverKeyPem,
    caCert,
    caFingerprint: fingerprint(caCert),
    names: wanted,
    source: 'generated',
    serverNotAfter: new Date(new X509Certificate(serverCert!).validTo),
  };
}

/** The owner's own certificate files (e.g. from their own CA or a public one). */
export function loadOwnTls(certFile: string, keyFile: string): TlsMaterial {
  const cert = readFileSync(certFile, 'utf8');
  const key = readFileSync(keyFile, 'utf8');
  const leaf = new X509Certificate(cert);
  // The last certificate of the chain is what devices would install, if it is not publicly trusted anyway.
  const chain = cert.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n?/g) ?? [cert];
  const caCert = chain[chain.length - 1]!;
  return {
    cert,
    key,
    caCert,
    caFingerprint: fingerprint(caCert),
    names: (leaf.subjectAltName ?? '').split(', ').map((entry) => entry.replace(/^(DNS|IP Address):/, '')),
    source: 'own',
    serverNotAfter: new Date(leaf.validTo),
  };
}

/** The certificate as configured: none, the owner's files, or the hub's own (in `tls.dir` or `<dataDir>/tls`). */
export function loadTlsMaterial(config: Pick<HubConfig, 'tls' | 'dataDir'>, vault: Vault): TlsMaterial | null {
  if (config.tls.mode === 'files') return loadOwnTls(config.tls.certFile!, config.tls.keyFile!);
  if (config.tls.mode !== 'auto') return null;
  if (!config.tls.dir) return ensureTlsMaterial(join(config.dataDir, 'tls'), vault, localNames(config.tls.names));
  // A shared directory has a key of its own (the data directories' master keys differ).
  mkdirSync(config.tls.dir, { recursive: true, mode: 0o700 });
  return ensureTlsMaterial(config.tls.dir, Vault.open(config.tls.dir, null).vault, localNames(config.tls.names));
}
