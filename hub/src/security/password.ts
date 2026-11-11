import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with scrypt (built into Node, memory-hard).
 * Parameters follow the OWASP recommendation N=2^15, r=8, p=3 (~32 MiB per hash).
 * Stored format: scrypt$<log2 N>$<r>$<p>$<salt b64>$<hash b64>
 */

const PARAMS = { logN: 15, r: 8, p: 3 };
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

// Each hash needs ~32 MiB; cap parallel work so a burst of logins cannot exhaust
// the memory of a small board.
const MAX_PARALLEL = 2;
let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function derive(password: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const N = 2 ** logN;
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r, p, maxmem: 256 * N * r }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await withSlot(() => derive(password, salt, PARAMS.logN, PARAMS.r, PARAMS.p));
  return ['scrypt', PARAMS.logN, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const logN = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(logN) || logN < 10 || logN > 20 || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) {
    return false;
  }
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  const actual = await withSlot(() => derive(password, salt, logN, r, p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  return parts[0] !== 'scrypt' || Number(parts[1]) !== PARAMS.logN || Number(parts[2]) !== PARAMS.r || Number(parts[3]) !== PARAMS.p;
}

/** A hash of a random password: lets us spend the same time for unknown users. */
let dummyHash: Promise<string> | null = null;
export function dummyVerify(password: string): Promise<boolean> {
  dummyHash ??= hashPassword(randomBytes(18).toString('base64'));
  return dummyHash.then((hash) => verifyPassword(password, hash)).then(() => false);
}

export const PASSWORD_MIN_LENGTH = 10;

/** Returns a German error message, or null when the password is acceptable. */
export function checkPasswordPolicy(password: string, username: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Das Passwort muss mindestens ${PASSWORD_MIN_LENGTH} Zeichen lang sein.`;
  if (password.length > 256) return 'Das Passwort ist zu lang (maximal 256 Zeichen).';
  const lower = password.toLowerCase();
  if (username && lower.includes(username.toLowerCase())) return 'Das Passwort darf den Benutzernamen nicht enthalten.';
  if (/^(.)\1+$/.test(password)) return 'Das Passwort darf nicht nur aus einem wiederholten Zeichen bestehen.';
  const trivial = ['1234567890', '0123456789', 'passwort123', 'password123', 'qwertzuiop', 'qwertyuiop', 'homehub123'];
  if (trivial.some((t) => lower.startsWith(t) || t.startsWith(lower))) return 'Dieses Passwort ist zu leicht zu erraten.';
  return null;
}
