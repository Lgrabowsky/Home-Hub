import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DoorEvent, DoorEventType, DoorHistoryPage } from '@home-hub/shared';
import type { Db } from '../../db.ts';
import type { Logger } from '../../log.ts';
import { randomId, sha256Hex, type Vault } from '../../security/crypto.ts';

/**
 * The hub's own door history: who rang, what moved, who opened — with pictures.
 *
 * Rows live in the `door_events` table. Pictures are stored outside the
 * database as `<data>/history/<doorId>/<eventId>.bin`, encrypted with the
 * master key and bound to their event id, so a file cannot be swapped for
 * another event's picture unnoticed. Directories are 0700, files 0600.
 */

export type EventSource = 'device' | 'hub';

export interface StoredEvent {
  id: string;
  doorId: string;
  type: DoorEventType;
  ts: number;
  /** Path of the picture below the history directory, null when the event has none. */
  imageFile: string | null;
  source: EventSource;
  actor: string | null;
  detail: string | null;
}

export interface NewEvent {
  id?: string;
  doorId: string;
  type: DoorEventType;
  ts: number;
  /** `hub`: recorded by the hub itself (live event, door opening). `device`: imported from the device's history. */
  source: EventSource;
  actor?: string | null;
  detail?: string | null;
}

interface Row {
  id: string;
  door_id: string;
  type: DoorEventType;
  ts: number;
  image_file: string | null;
  source: EventSource;
  actor: string | null;
  detail: string | null;
}

const COLUMNS = 'id, door_id, type, ts, image_file, source, actor, detail';
const IMAGE_FILE = /^[a-z0-9][a-z0-9-]{0,31}\/[A-Za-z0-9_-]{1,64}\.bin$/;
/** Files younger than this are never treated as left-overs (a picture is written before its row is updated). */
const ORPHAN_MIN_AGE_MS = 10 * 60_000;
const BATCH = 400;

function toEvent(row: Row): StoredEvent {
  return {
    id: row.id,
    doorId: row.door_id,
    type: row.type,
    ts: row.ts,
    imageFile: row.image_file,
    source: row.source,
    actor: row.actor,
    detail: row.detail,
  };
}

function pause(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class DoorHistoryStore {
  private readonly root: string;
  private warnedAboutModes = false;

  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
    dataDir: string,
    private readonly log: Logger,
  ) {
    this.root = join(dataDir, 'history');
  }

  // --- Writing -----------------------------------------------------------------------

  /** Stores an event, with its picture when there is one. Returns the stored event. */
  insert(event: NewEvent, image: Buffer | null = null): StoredEvent {
    const id = event.id ?? randomId();
    const imageFile = image ? this.writeImage(event.doorId, id, image) : null;
    try {
      this.db.run(
        `INSERT INTO door_events (${COLUMNS}, image_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        event.doorId,
        event.type,
        Math.round(event.ts),
        imageFile,
        event.source,
        event.actor ?? null,
        event.detail ?? null,
        image ? sha256Hex(image) : null,
      );
    } catch (err) {
      if (imageFile) this.removeFile(imageFile);
      throw err;
    }
    return {
      id,
      doorId: event.doorId,
      type: event.type,
      ts: Math.round(event.ts),
      imageFile,
      source: event.source,
      actor: event.actor ?? null,
      detail: event.detail ?? null,
    };
  }

  /** Adds (or replaces) the picture of an existing event. Returns false when the event is gone. */
  attachImage(eventId: string, image: Buffer): boolean {
    const row = this.db.get<Row>(`SELECT ${COLUMNS} FROM door_events WHERE id = ?`, eventId);
    if (!row) return false;
    const imageFile = this.writeImage(row.door_id, row.id, image);
    this.db.run('UPDATE door_events SET image_file = ?, image_hash = ? WHERE id = ?', imageFile, sha256Hex(image), row.id);
    return true;
  }

  private writeImage(doorId: string, eventId: string, image: Buffer): string {
    const relative = `${doorId}/${eventId}.bin`;
    if (!IMAGE_FILE.test(relative)) throw new Error('refusing to write a history picture outside the history directory');
    const directory = join(this.root, doorId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // mkdir's mode is subject to the umask and is ignored for directories that exist already.
    this.restrict(this.root, 0o700);
    this.restrict(directory, 0o700);
    const target = join(this.root, relative);
    const temporary = `${target}.tmp`;
    // Write next to the target and rename: a crash never leaves half a picture under the final name.
    writeFileSync(temporary, this.vault.encryptFile(image, `door-event/${eventId}`), { mode: 0o600 });
    this.restrict(temporary, 0o600);
    renameSync(temporary, target);
    return relative;
  }

  /** Narrows the permissions. Some file systems have none; the pictures are encrypted either way. */
  private restrict(path: string, mode: number): void {
    try {
      chmodSync(path, mode);
    } catch (err) {
      if (!this.warnedAboutModes) this.log.warn({ err }, 'cannot restrict the permissions of the history directory');
      this.warnedAboutModes = true;
    }
  }

  private removeFile(relative: string | null): void {
    if (!relative || !IMAGE_FILE.test(relative)) return;
    try {
      rmSync(join(this.root, relative), { force: true });
    } catch (err) {
      this.log.warn({ err }, 'could not delete a history picture');
    }
  }

  // --- Reading -----------------------------------------------------------------------

  hasImage(event: Pick<StoredEvent, 'imageFile'>): boolean {
    return event.imageFile !== null && IMAGE_FILE.test(event.imageFile) && existsSync(join(this.root, event.imageFile));
  }

  /** The decrypted picture of an event; null when it has none, the file is gone or cannot be decrypted. */
  image(eventId: string): Buffer | null {
    const row = this.db.get<{ id: string; image_file: string | null }>('SELECT id, image_file FROM door_events WHERE id = ?', eventId);
    if (!row?.image_file || !IMAGE_FILE.test(row.image_file)) return null;
    let encrypted: Buffer;
    try {
      encrypted = readFileSync(join(this.root, row.image_file));
    } catch {
      return null;
    }
    try {
      return this.vault.decryptFile(encrypted, `door-event/${row.id}`);
    } catch (err) {
      this.log.warn({ err, eventId: row.id }, 'history picture cannot be decrypted');
      return null;
    }
  }

  /**
   * One page of a door's history, newest first. `before` is an exclusive
   * timestamp cursor; events sharing the timestamp at the end of a page are all
   * delivered with it, so none can fall between two pages.
   */
  list(doorId: string, options: { before?: number | null; limit?: number; type?: DoorEventType | null }): DoorHistoryPage {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 40) || 40, 1), 100);
    const before = typeof options.before === 'number' && Number.isFinite(options.before) ? options.before : Number.MAX_SAFE_INTEGER;
    const type = options.type ?? null;
    const typeClause = type ? ' AND type = ?' : '';
    const typeArgs = type ? [type] : [];

    const rows = this.db.all<Row>(
      `SELECT ${COLUMNS} FROM door_events WHERE door_id = ?${typeClause} AND ts < ? ORDER BY ts DESC, id DESC LIMIT ?`,
      doorId,
      ...typeArgs,
      before,
      limit + 1,
    );
    let page = rows.slice(0, limit);
    let nextBefore: number | null = null;
    const last = page.at(-1);
    if (rows.length > limit && last) {
      if (rows[limit]!.ts === last.ts) {
        // The page boundary cuts through events with the same timestamp: take all of them.
        const tied = this.db.all<Row>(
          `SELECT ${COLUMNS} FROM door_events WHERE door_id = ?${typeClause} AND ts = ? ORDER BY id DESC`,
          doorId,
          ...typeArgs,
          last.ts,
        );
        page = [...page.filter((row) => row.ts !== last.ts), ...tied];
        const older = this.db.get<{ found: number }>(
          `SELECT 1 AS found FROM door_events WHERE door_id = ?${typeClause} AND ts < ? LIMIT 1`,
          doorId,
          ...typeArgs,
          last.ts,
        );
        nextBefore = older ? last.ts : null;
      } else {
        nextBefore = last.ts;
      }
    }

    const events: DoorEvent[] = page.map((row) => ({
      id: row.id,
      doorId: row.door_id,
      type: row.type,
      ts: row.ts,
      hasImage: this.hasImage({ imageFile: row.image_file }),
      actor: row.actor,
      detail: row.detail,
    }));
    return { events, nextBefore };
  }

  /** Timestamp of the newest event of a type, null when there is none. */
  newest(doorId: string, type: DoorEventType): number | null {
    const row = this.db.get<{ ts: number | null }>('SELECT MAX(ts) AS ts FROM door_events WHERE door_id = ? AND type = ?', doorId, type);
    return row?.ts ?? null;
  }

  /** The most recent event of a door (any type), for diagnostics. */
  latest(doorId: string): StoredEvent | null {
    const row = this.db.get<Row>(`SELECT ${COLUMNS} FROM door_events WHERE door_id = ? ORDER BY ts DESC, id DESC LIMIT 1`, doorId);
    return row ? toEvent(row) : null;
  }

  /** The event the hub recorded itself that lies closest to `ts`, within `windowMs`. */
  findLive(doorId: string, type: DoorEventType, ts: number, windowMs: number): StoredEvent | null {
    const row = this.db.get<Row>(
      `SELECT ${COLUMNS} FROM door_events WHERE door_id = ? AND type = ? AND source = 'hub' AND ts BETWEEN ? AND ? ORDER BY ABS(ts - ?) ASC LIMIT 1`,
      doorId,
      type,
      Math.round(ts - windowMs),
      Math.round(ts + windowMs),
      Math.round(ts),
    );
    return row ? toEvent(row) : null;
  }

  /** Whether exactly this history picture (same device timestamp) was imported before. */
  hasImported(doorId: string, type: DoorEventType, ts: number): boolean {
    const row = this.db.get<{ found: number }>(
      "SELECT 1 AS found FROM door_events WHERE door_id = ? AND type = ? AND source = 'device' AND ts = ? LIMIT 1",
      doorId,
      type,
      Math.round(ts),
    );
    return row !== undefined;
  }

  /** Whether a picture with this SHA-256 is already stored for the door. */
  hasHash(doorId: string, hash: string): boolean {
    const row = this.db.get<{ found: number }>('SELECT 1 AS found FROM door_events WHERE door_id = ? AND image_hash = ? LIMIT 1', doorId, hash);
    return row !== undefined;
  }

  // --- Housekeeping ------------------------------------------------------------------

  /** Deletes all events older than `cutoff` (of every door, also removed ones) with their pictures. */
  async purgeOlderThan(cutoff: number, signal?: AbortSignal): Promise<number> {
    let removed = 0;
    while (!signal?.aborted) {
      const rows = this.db.all<{ id: string; image_file: string | null }>('SELECT id, image_file FROM door_events WHERE ts < ? LIMIT ?', Math.round(cutoff), BATCH);
      if (rows.length === 0) break;
      this.remove(rows);
      removed += rows.length;
      await pause();
    }
    return removed;
  }

  /** Keeps at most `max` events per door by deleting the oldest. */
  async enforceLimit(doorId: string, max: number, signal?: AbortSignal): Promise<number> {
    let removed = 0;
    while (!signal?.aborted) {
      const rows = this.db.all<{ id: string; image_file: string | null }>(
        'SELECT id, image_file FROM door_events WHERE door_id = ? ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?',
        doorId,
        BATCH,
        Math.max(1, Math.trunc(max)),
      );
      if (rows.length === 0) break;
      this.remove(rows);
      removed += rows.length;
      await pause();
    }
    return removed;
  }

  private remove(rows: { id: string; image_file: string | null }[]): void {
    this.db.tx(() => {
      for (const row of rows) this.db.run('DELETE FROM door_events WHERE id = ?', row.id);
    });
    // Files go after the rows: a crash in between leaves a file without a row, which the sweep below collects.
    for (const row of rows) this.removeFile(row.image_file);
  }

  /** Deletes picture files no event points to (left behind by a crash between two steps). */
  async sweepOrphans(signal?: AbortSignal): Promise<number> {
    let removed = 0;
    let checked = 0;
    const now = Date.now();
    for (const door of this.listDirectory(this.root)) {
      const directory = join(this.root, door);
      for (const file of this.listDirectory(directory)) {
        if (signal?.aborted) return removed;
        if (++checked % BATCH === 0) await pause();
        const relative = `${door}/${file}`;
        const path = join(directory, file);
        try {
          const stat = statSync(path);
          if (!stat.isFile() || now - stat.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
          // The file name is the event id, so the primary key answers whether the picture is still wanted.
          const owner = IMAGE_FILE.test(relative)
            ? this.db.get<{ image_file: string | null }>('SELECT image_file FROM door_events WHERE id = ?', file.slice(0, -'.bin'.length))
            : undefined;
          if (owner?.image_file === relative) continue;
          rmSync(path, { force: true });
          removed++;
        } catch (err) {
          this.log.warn({ err }, 'could not check a history picture file');
        }
      }
    }
    return removed;
  }

  private listDirectory(path: string): string[] {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  }
}
