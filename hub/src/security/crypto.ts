import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Encryption at rest.
 *
 * One 256-bit master key protects every secret the hub stores: device
 * passwords, OAuth tokens, TOTP seeds and the door history images. The key
 * comes from HUB_MASTER_KEY (keep it outside the data directory for the
 * strongest setup) or from `<data>/master.key`, created on first start.
 *
 * Each purpose gets its own sub-key (HKDF), and every ciphertext is bound to a
 * context string (AES-256-GCM additional data), so a value cannot be moved to
 * another field without detection.
 */

const TEXT_PREFIX = 'v1:';
const FILE_MAGIC = Buffer.from('HHE1');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class Vault {
  private readonly keys = new Map<string, Buffer>();

  constructor(private readonly masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error('The master key must be exactly 32 bytes');
  }

  /** Loads the key from the environment or the data directory, creating one if needed. */
  static open(dataDir: string, envKey: string | null): { vault: Vault; source: 'env' | 'file' | 'generated' } {
    if (envKey) {
      const key = decodeKey(envKey);
      if (!key) {
        throw new Error('HUB_MASTER_KEY must be 32 random bytes, base64 or hex encoded (e.g. `openssl rand -base64 32`)');
      }
      return { vault: new Vault(key), source: 'env' };
    }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = join(dataDir, 'master.key');
    if (existsSync(file)) {
      const key = decodeKey(readFileSync(file, 'utf8').trim());
      if (!key) throw new Error(`${file} is damaged: expected 32 base64 encoded bytes`);
      return { vault: new Vault(key), source: 'file' };
    }
    const key = randomBytes(32);
    writeFileSync(file, key.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
    chmodSync(file, 0o600);
    return { vault: new Vault(key), source: 'generated' };
  }

  private subKey(purpose: string): Buffer {
    let key = this.keys.get(purpose);
    if (!key) {
      key = Buffer.from(hkdfSync('sha256', this.masterKey, Buffer.alloc(0), `home-hub/${purpose}`, 32));
      this.keys.set(purpose, key);
    }
    return key;
  }

  /** Encrypts a short secret for storage in the database. */
  encryptText(plaintext: string, context: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.subKey('secrets'), nonce);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return TEXT_PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64');
  }

  decryptText(payload: string, context: string): string {
    if (!payload.startsWith(TEXT_PREFIX)) throw new Error('Unknown secret format');
    const raw = Buffer.from(payload.slice(TEXT_PREFIX.length), 'base64');
    if (raw.length < NONCE_BYTES + TAG_BYTES) throw new Error('Secret is truncated');
    const decipher = createDecipheriv('aes-256-gcm', this.subKey('secrets'), raw.subarray(0, NONCE_BYTES));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  }

  /** Encrypts a file body (history images). */
  encryptFile(data: Buffer, context: string): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.subKey('files'), nonce);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const body = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([FILE_MAGIC, nonce, cipher.getAuthTag(), body]);
  }

  decryptFile(data: Buffer, context: string): Buffer {
    const header = FILE_MAGIC.length + NONCE_BYTES + TAG_BYTES;
    if (data.length < header || !data.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
      throw new Error('Unknown file format');
    }
    const nonce = data.subarray(FILE_MAGIC.length, FILE_MAGIC.length + NONCE_BYTES);
    const tag = data.subarray(FILE_MAGIC.length + NONCE_BYTES, header);
    const decipher = createDecipheriv('aes-256-gcm', this.subKey('files'), nonce);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data.subarray(header)), decipher.final()]);
  }

  /** Keyed MAC, e.g. to sign short-lived URLs. */
  sign(purpose: string, message: string): string {
    return createHmac('sha256', this.subKey(`sign/${purpose}`)).update(message).digest('base64url');
  }

  verify(purpose: string, message: string, signature: string): boolean {
    return safeEqual(this.sign(purpose, message), signature);
  }
}

function decodeKey(text: string): Buffer | null {
  const trimmed = text.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const normalised = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalised)) return null;
  const key = Buffer.from(normalised, 'base64');
  return key.length === 32 ? key : null;
}

/** URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Short random identifier for database rows (not a secret). */
export function randomId(bytes = 12): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still burn comparable time so the length is not a cheap oracle.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
