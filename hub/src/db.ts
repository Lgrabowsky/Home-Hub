import { createRequire } from 'node:module';
import type { DatabaseSync, StatementSync, SQLInputValue } from 'node:sqlite';

/**
 * Thin wrapper around Node's built-in SQLite (`node:sqlite`): no native add-on
 * has to be compiled, which keeps the hub trivially portable to ARM boards.
 */

type SqliteModule = typeof import('node:sqlite');

function loadSqlite(): SqliteModule {
  // The module prints an ExperimentalWarning on Node 22; it is stable enough
  // for our use (plain tables, prepared statements), so keep the log clean.
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (text.includes('SQLite is an experimental feature')) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)('node:sqlite') as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
}

const MIGRATIONS: string[] = [
  // 1 — initial schema
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
    permissions TEXT NOT NULL DEFAULT '[]',
    password_hash TEXT NOT NULL,
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    totp_last_step INTEGER NOT NULL DEFAULT 0,
    recovery_codes TEXT NOT NULL DEFAULT '[]',
    disabled INTEGER NOT NULL DEFAULT 0,
    prefs TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('full', 'enroll')),
    client TEXT NOT NULL CHECK (client IN ('web', 'native')),
    device_name TEXT,
    user_agent TEXT,
    ip TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX sessions_expires ON sessions(expires_at);

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    user_id TEXT,
    username TEXT,
    action TEXT NOT NULL,
    detail TEXT,
    ip TEXT
  ) STRICT;
  CREATE INDEX audit_ts ON audit(ts);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE door_events (
    id TEXT PRIMARY KEY,
    door_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('doorbell', 'motion', 'open')),
    ts INTEGER NOT NULL,
    image_file TEXT,
    image_hash TEXT,
    source TEXT NOT NULL CHECK (source IN ('device', 'hub')),
    actor TEXT,
    detail TEXT
  ) STRICT;
  CREATE INDEX door_events_door_ts ON door_events(door_id, ts DESC);
  CREATE INDEX door_events_hash ON door_events(door_id, image_hash);
  `,
];

export type SqlValue = SQLInputValue;

export class Db {
  readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private txDepth = 0;

  constructor(path: string) {
    const { DatabaseSync: Database } = loadSqlite();
    this.raw = new Database(path);
    if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    const row = this.raw.prepare('PRAGMA user_version').get() as { user_version: number };
    let version = row.user_version;
    if (version > MIGRATIONS.length) {
      throw new Error(
        `Database schema version ${version} is newer than this hub understands (${MIGRATIONS.length}). ` +
          'Please update the hub instead of downgrading.',
      );
    }
    while (version < MIGRATIONS.length) {
      const sql = MIGRATIONS[version]!;
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        this.raw.exec(sql);
        this.raw.exec(`PRAGMA user_version = ${version + 1}`);
        this.raw.exec('COMMIT');
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
      version++;
    }
  }

  private statement(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const result = this.statement(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.statement(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.statement(sql).all(...params) as T[];
  }

  /** Runs `fn` atomically. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  close(): void {
    this.statements.clear();
    this.raw.close();
  }
}
