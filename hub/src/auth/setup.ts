import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { safeEqual } from '../security/crypto.ts';
import type { UserStore } from './users.ts';
import type { Logger } from '../log.ts';

/**
 * First-run protection: creating the very first administrator requires a
 * one-time code that only someone with access to the hub's console (or data
 * directory) can read. Otherwise whoever reaches a fresh hub first would own it.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

export class SetupGuard {
  private code: string | null = null;
  private readonly file: string;

  constructor(
    private readonly users: UserStore,
    dataDir: string,
    private readonly log: Logger,
    presetCode: string | null,
  ) {
    this.file = join(dataDir, 'setup-code.txt');
    if (this.required) {
      this.code = presetCode ?? generateCode();
      if (presetCode) {
        this.log.info('first-run setup pending: use the code from HUB_SETUP_TOKEN');
      } else {
        try {
          writeFileSync(this.file, this.code + '\n', { mode: 0o600 });
        } catch (err) {
          this.log.warn({ err }, 'could not write setup-code.txt');
        }
        this.announce();
      }
    } else {
      this.cleanup();
    }
  }

  get required(): boolean {
    return this.users.count() === 0;
  }

  private announce(): void {
    if (!this.code) return;
    const line = '='.repeat(64);
    // Deliberately plain text on stdout so it is easy to spot in `docker logs`.
    process.stdout.write(
      `\n${line}\n  Home Hub – Ersteinrichtung\n  Einrichtungscode: ${this.code}\n  (auch in ${this.file})\n${line}\n\n`,
    );
  }

  verify(candidate: string): boolean {
    if (!this.code || !this.required) return false;
    const normalise = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return safeEqual(normalise(candidate), normalise(this.code));
  }

  /** Call once the first administrator exists. */
  complete(): void {
    this.code = null;
    this.cleanup();
  }

  private cleanup(): void {
    try {
      if (existsSync(this.file)) rmSync(this.file);
    } catch {
      /* best effort */
    }
  }
}
