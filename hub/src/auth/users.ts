import {
  DEFAULT_PREFS,
  PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS,
  type Permission,
  type Role,
  type UserInfo,
  type UserPrefs,
} from '@home-hub/shared';
import type { Db } from '../db.ts';
import { randomId, type Vault } from '../security/crypto.ts';
import { checkPasswordPolicy, hashPassword } from '../security/password.ts';
import { HttpError } from '../http/errors.ts';

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  permissions: string;
  password_hash: string;
  totp_secret: string | null;
  totp_enabled: number;
  totp_last_step: number;
  recovery_codes: string;
  disabled: number;
  prefs: string;
  created_at: number;
  updated_at: number;
}

export interface UserRecord extends UserInfo {
  passwordHash: string;
  totpLastStep: number;
  recoveryCodeHashes: string[];
  hasTotpSecret: boolean;
}

const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/;

function parsePermissions(json: string): Permission[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return PERMISSIONS.filter((p) => parsed.includes(p));
  } catch {
    return [];
  }
}

function toRecord(row: UserRow): UserRecord {
  const role = row.role;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role,
    permissions: role === 'admin' ? [...PERMISSIONS] : parsePermissions(row.permissions),
    totpEnabled: row.totp_enabled === 1,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
    passwordHash: row.password_hash,
    totpLastStep: row.totp_last_step,
    recoveryCodeHashes: JSON.parse(row.recovery_codes || '[]') as string[],
    hasTotpSecret: row.totp_secret !== null,
  };
}

export function publicUser(user: UserRecord): UserInfo {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    permissions: user.permissions,
    totpEnabled: user.totpEnabled,
    disabled: user.disabled,
    createdAt: user.createdAt,
  };
}

export class UserStore {
  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
  ) {}

  count(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
  }

  private activeAdminCount(exceptId?: string): number {
    return this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?",
      exceptId ?? '',
    )!.n;
  }

  get(id: string): UserRecord | null {
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }

  getByUsername(username: string): UserRecord | null {
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE username = ? COLLATE NOCASE', username.trim());
    return row ? toRecord(row) : null;
  }

  list(): UserRecord[] {
    return this.db.all<UserRow>('SELECT * FROM users ORDER BY created_at ASC').map(toRecord);
  }

  async create(input: {
    username: string;
    displayName?: string;
    role: Role;
    permissions?: Permission[];
    password: string;
  }): Promise<UserRecord> {
    const username = input.username.trim();
    if (!USERNAME_PATTERN.test(username)) {
      throw new HttpError(400, 'invalid_username', 'Der Benutzername muss 3–32 Zeichen lang sein (Buchstaben, Ziffern, Punkt, Binde- oder Unterstrich).');
    }
    const policy = checkPasswordPolicy(input.password, username);
    if (policy) throw new HttpError(400, 'weak_password', policy);
    if (this.getByUsername(username)) throw new HttpError(409, 'username_taken', 'Dieser Benutzername ist bereits vergeben.');

    const passwordHash = await hashPassword(input.password);
    const now = Date.now();
    const id = randomId();
    const permissions = input.role === 'admin' ? [...PERMISSIONS] : sanitizePermissions(input.permissions ?? ROLE_DEFAULT_PERMISSIONS[input.role]);
    this.db.run(
      `INSERT INTO users (id, username, display_name, role, permissions, password_hash, prefs, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      username,
      (input.displayName ?? '').trim() || username,
      input.role,
      JSON.stringify(permissions),
      passwordHash,
      JSON.stringify(DEFAULT_PREFS),
      now,
      now,
    );
    return this.get(id)!;
  }

  update(id: string, patch: { displayName?: string; role?: Role; permissions?: Permission[]; disabled?: boolean }): UserRecord {
    const current = this.get(id);
    if (!current) throw new HttpError(404, 'not_found', 'Benutzer nicht gefunden.');

    const role = patch.role ?? current.role;
    const disabled = patch.disabled ?? current.disabled;
    const losesAdmin = current.role === 'admin' && !current.disabled && (role !== 'admin' || disabled);
    if (losesAdmin && this.activeAdminCount(id) === 0) {
      throw new HttpError(409, 'last_admin', 'Es muss mindestens ein aktiver Administrator bestehen bleiben.');
    }
    const permissions =
      role === 'admin'
        ? [...PERMISSIONS]
        : sanitizePermissions(patch.permissions ?? (patch.role && patch.role !== current.role ? ROLE_DEFAULT_PERMISSIONS[role] : current.permissions));
    const displayName = patch.displayName !== undefined ? patch.displayName.trim() || current.username : current.displayName;
    if (displayName.length > 60) throw new HttpError(400, 'invalid_name', 'Der Anzeigename ist zu lang.');

    this.db.run(
      'UPDATE users SET display_name = ?, role = ?, permissions = ?, disabled = ?, updated_at = ? WHERE id = ?',
      displayName,
      role,
      JSON.stringify(permissions),
      disabled ? 1 : 0,
      Date.now(),
      id,
    );
    return this.get(id)!;
  }

  async setPassword(id: string, password: string): Promise<void> {
    const user = this.get(id);
    if (!user) throw new HttpError(404, 'not_found', 'Benutzer nicht gefunden.');
    const policy = checkPasswordPolicy(password, user.username);
    if (policy) throw new HttpError(400, 'weak_password', policy);
    this.setPasswordHash(id, await hashPassword(password));
  }

  setPasswordHash(id: string, hash: string): void {
    this.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, Date.now(), id);
  }

  delete(id: string): void {
    const user = this.get(id);
    if (!user) throw new HttpError(404, 'not_found', 'Benutzer nicht gefunden.');
    if (user.role === 'admin' && !user.disabled && this.activeAdminCount(id) === 0) {
      throw new HttpError(409, 'last_admin', 'Der letzte Administrator kann nicht gelöscht werden.');
    }
    this.db.run('DELETE FROM users WHERE id = ?', id);
  }

  // --- Two-factor ------------------------------------------------------------

  /** Stores a fresh, not yet confirmed TOTP secret. */
  setPendingTotpSecret(id: string, secretBase32: string): void {
    this.db.run(
      'UPDATE users SET totp_secret = ?, totp_enabled = 0, totp_last_step = 0, updated_at = ? WHERE id = ?',
      this.vault.encryptText(secretBase32, `totp/${id}`),
      Date.now(),
      id,
    );
  }

  getTotpSecret(id: string): string | null {
    const row = this.db.get<{ totp_secret: string | null }>('SELECT totp_secret FROM users WHERE id = ?', id);
    if (!row?.totp_secret) return null;
    return this.vault.decryptText(row.totp_secret, `totp/${id}`);
  }

  enableTotp(id: string, step: number, recoveryCodeHashes: string[]): void {
    this.db.run(
      'UPDATE users SET totp_enabled = 1, totp_last_step = ?, recovery_codes = ?, updated_at = ? WHERE id = ?',
      step,
      JSON.stringify(recoveryCodeHashes),
      Date.now(),
      id,
    );
  }

  disableTotp(id: string): void {
    this.db.run(
      "UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0, recovery_codes = '[]', updated_at = ? WHERE id = ?",
      Date.now(),
      id,
    );
  }

  /** Marks a TOTP time step as used; false when it was already consumed (replay). */
  consumeTotpStep(id: string, step: number): boolean {
    return this.db.run('UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?', step, id, step).changes === 1;
  }

  /** Removes a recovery code; false when it does not exist (any more). */
  consumeRecoveryCode(id: string, hash: string): boolean {
    return this.db.tx(() => {
      const user = this.get(id);
      if (!user || !user.recoveryCodeHashes.includes(hash)) return false;
      const remaining = user.recoveryCodeHashes.filter((h) => h !== hash);
      this.db.run('UPDATE users SET recovery_codes = ? WHERE id = ?', JSON.stringify(remaining), id);
      return true;
    });
  }

  // --- Preferences -------------------------------------------------------------

  getPrefs(id: string): UserPrefs {
    const row = this.db.get<{ prefs: string }>('SELECT prefs FROM users WHERE id = ?', id);
    return normalizePrefs(row ? safeJson(row.prefs) : {});
  }

  setPrefs(id: string, prefs: unknown): UserPrefs {
    const normalised = normalizePrefs(prefs);
    this.db.run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify(normalised), id);
    return normalised;
  }
}

function sanitizePermissions(input: readonly Permission[]): Permission[] {
  return PERMISSIONS.filter((p) => input.includes(p));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0 && item.length <= 200 && !out.includes(item)) out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

export function normalizePrefs(input: unknown): UserPrefs {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    favorites: stringList(raw.favorites, 100),
    roomOrder: stringList(raw.roomOrder, 200),
    hiddenRooms: stringList(raw.hiddenRooms, 200),
    lastMusicPlayerId: typeof raw.lastMusicPlayerId === 'string' ? raw.lastMusicPlayerId.slice(0, 100) : null,
  };
}
