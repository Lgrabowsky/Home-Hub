import { EventEmitter } from 'node:events';
import type { SessionInfo } from '@home-hub/shared';
import type { Db } from '../db.ts';
import { randomId, randomToken, sha256Hex } from '../security/crypto.ts';
import type { UserRecord, UserStore } from './users.ts';

/**
 * Server-side sessions.
 *
 * The client only ever holds an opaque 256-bit token; the database stores its
 * SHA-256, so a leaked database cannot be replayed. Sessions slide: every use
 * extends them, they end after `idleDays` without use or after a hard cap.
 */

interface SessionRow {
  id: string;
  token_hash: string;
  user_id: string;
  kind: 'full' | 'enroll';
  client: 'web' | 'native';
  device_name: string | null;
  user_agent: string | null;
  ip: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

export interface Session {
  id: string;
  userId: string;
  kind: 'full' | 'enroll';
  client: 'web' | 'native';
  deviceName: string | null;
  userAgent: string | null;
  ip: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface AuthContext {
  session: Session;
  user: UserRecord;
}

const DAY = 24 * 60 * 60_000;
const ABSOLUTE_MAX_MS = 400 * DAY;
const ENROLL_TTL_MS = 15 * 60_000;
const TOUCH_INTERVAL_MS = 60_000;

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    client: row.client,
    deviceName: row.device_name,
    userAgent: row.user_agent,
    ip: row.ip,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  };
}

export function publicSession(session: Session, currentId: string | null): SessionInfo {
  return {
    id: session.id,
    current: session.id === currentId,
    client: session.client,
    deviceName: session.deviceName,
    userAgent: session.userAgent,
    ip: session.ip,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
  };
}

export interface SessionEvents {
  ended: [sessionId: string, reason: 'revoked' | 'expired'];
}

export class SessionStore extends EventEmitter<SessionEvents> {
  constructor(
    private readonly db: Db,
    private readonly users: UserStore,
    private readonly idleDays: () => number,
  ) {
    super();
  }

  private idleMs(): number {
    return Math.max(1, this.idleDays()) * DAY;
  }

  create(
    userId: string,
    meta: { kind: 'full' | 'enroll'; client: 'web' | 'native'; deviceName?: string | null; userAgent?: string | null; ip?: string | null },
  ): { token: string; session: Session } {
    const token = randomToken(32);
    const now = Date.now();
    const id = randomId();
    const ttl = meta.kind === 'enroll' ? ENROLL_TTL_MS : this.idleMs();
    this.db.run(
      `INSERT INTO sessions (id, token_hash, user_id, kind, client, device_name, user_agent, ip, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      sha256Hex(token),
      userId,
      meta.kind,
      meta.client,
      meta.deviceName?.slice(0, 80) || null,
      meta.userAgent?.slice(0, 300) || null,
      meta.ip ?? null,
      now,
      now,
      now + ttl,
    );
    return { token, session: this.get(id)! };
  }

  get(id: string): Session | null {
    const row = this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id);
    return row ? toSession(row) : null;
  }

  /** Resolves a bearer/cookie token to a live session and its user. */
  authenticate(token: string, ip?: string | null): AuthContext | null {
    if (!token || token.length < 20 || token.length > 200) return null;
    const row = this.db.get<SessionRow>('SELECT * FROM sessions WHERE token_hash = ?', sha256Hex(token));
    if (!row) return null;
    const now = Date.now();
    if (row.expires_at <= now) {
      this.remove(row.id, 'expired');
      return null;
    }
    const user = this.users.get(row.user_id);
    if (!user || user.disabled) {
      this.remove(row.id, 'revoked');
      return null;
    }
    const session = toSession(row);
    if (session.kind === 'full' && now - row.last_seen_at > TOUCH_INTERVAL_MS) {
      const expiresAt = Math.min(now + this.idleMs(), row.created_at + ABSOLUTE_MAX_MS);
      this.db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ?, ip = COALESCE(?, ip) WHERE id = ?', now, expiresAt, ip ?? null, row.id);
      session.lastSeenAt = now;
      session.expiresAt = expiresAt;
      if (ip) session.ip = ip;
    }
    return { session, user };
  }

  /** Cheap liveness check for long-lived connections (WebSockets). */
  isAlive(sessionId: string): boolean {
    const row = this.db.get<{ expires_at: number; user_id: string }>('SELECT expires_at, user_id FROM sessions WHERE id = ?', sessionId);
    if (!row || row.expires_at <= Date.now()) return false;
    const user = this.users.get(row.user_id);
    return Boolean(user && !user.disabled);
  }

  /**
   * Replaces an enrolment session by a full one. The token is rotated so that
   * nothing issued before the second factor was confirmed stays valid.
   */
  promote(session: Session): { token: string; session: Session } {
    return this.db.tx(() => {
      this.db.run('DELETE FROM sessions WHERE id = ?', session.id);
      return this.create(session.userId, {
        kind: 'full',
        client: session.client,
        deviceName: session.deviceName,
        userAgent: session.userAgent,
        ip: session.ip,
      });
    });
  }

  list(userId: string): Session[] {
    return this.db
      .all<SessionRow>("SELECT * FROM sessions WHERE user_id = ? AND kind = 'full' AND expires_at > ? ORDER BY last_seen_at DESC", userId, Date.now())
      .map(toSession);
  }

  revoke(sessionId: string): boolean {
    return this.remove(sessionId, 'revoked');
  }

  revokeAllForUser(userId: string, exceptSessionId?: string | null): number {
    const rows = this.db.all<{ id: string }>('SELECT id FROM sessions WHERE user_id = ? AND id != ?', userId, exceptSessionId ?? '');
    for (const row of rows) this.remove(row.id, 'revoked');
    return rows.length;
  }

  private remove(sessionId: string, reason: 'revoked' | 'expired'): boolean {
    const removed = this.db.run('DELETE FROM sessions WHERE id = ?', sessionId).changes > 0;
    if (removed) this.emit('ended', sessionId, reason);
    return removed;
  }

  cleanup(): void {
    const rows = this.db.all<{ id: string }>('SELECT id FROM sessions WHERE expires_at <= ?', Date.now());
    for (const row of rows) this.remove(row.id, 'expired');
  }
}
