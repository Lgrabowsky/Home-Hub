import type { AuditEntry } from '@home-hub/shared';
import type { Db } from '../db.ts';

/** Append-only record of security relevant actions (logins, door openings, changes to users and settings). */

export interface AuditActor {
  userId?: string | null;
  username?: string | null;
  ip?: string | null;
}

const RETENTION_MS = 365 * 24 * 60 * 60_000;
const MAX_ROWS = 100_000;

export class AuditLog {
  constructor(private readonly db: Db) {}

  record(action: string, actor: AuditActor = {}, detail: Record<string, unknown> | null = null): void {
    this.db.run(
      'INSERT INTO audit (ts, user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?, ?)',
      Date.now(),
      actor.userId ?? null,
      actor.username ?? null,
      action,
      detail ? JSON.stringify(detail) : null,
      actor.ip ?? null,
    );
  }

  list(options: { limit?: number; before?: number | null } = {}): AuditEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = this.db.all<{ id: number; ts: number; username: string | null; action: string; detail: string | null; ip: string | null }>(
      'SELECT id, ts, username, action, detail, ip FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?',
      options.before ?? Number.MAX_SAFE_INTEGER,
      limit,
    );
    return rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      username: row.username,
      action: row.action,
      detail: row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : null,
      ip: row.ip,
    }));
  }

  cleanup(): void {
    this.db.run('DELETE FROM audit WHERE ts < ?', Date.now() - RETENTION_MS);
    this.db.run('DELETE FROM audit WHERE id <= (SELECT MAX(id) FROM audit) - ?', MAX_ROWS);
  }
}
