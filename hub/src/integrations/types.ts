import type { HubConfig } from '../config.ts';
import type { Db } from '../db.ts';
import type { Logger } from '../log.ts';
import type { AuditLog } from '../security/audit.ts';
import type { Vault } from '../security/crypto.ts';
import type { SettingsStore } from '../settings.ts';
import type { StateStore } from '../state.ts';
import type { ImageProxy } from '../util/images.ts';

/** What every integration gets handed by the hub. */
export interface IntegrationDeps {
  config: HubConfig;
  /** Child logger of the integration. */
  log: Logger;
  state: StateStore;
  settings: SettingsStore;
  db: Db;
  vault: Vault;
  audit: AuditLog;
  images: ImageProxy;
  /** A current JPEG of a go2rtc stream (null when the video service cannot produce one). */
  streamSnapshot?(streamName: string): Promise<Buffer | null>;
  /** Tells the hub that the integration's `streams()` changed (e.g. a camera reported its video addresses). */
  streamsChanged?(): void;
}

/**
 * Life cycle shared by all integrations.
 *
 * An integration is created with its settings, started once and stopped when
 * the settings change (a new instance is created) or the hub shuts down.
 * `start()` must return quickly and never throw because a device is
 * unreachable — connection problems are reported through
 * `state.setService(id, …)` and retried in the background.
 */
export interface Integration {
  start(): void;
  stop(): Promise<void>;
  /** `true` while at least one app is connected: poll quickly. `false`: slow down to an idle rate. */
  setActive(active: boolean): void;
  /** Credential-free information for the admin diagnostics page. */
  diagnostics(): unknown;
}

/** The signed-in person on whose behalf something is done (for the audit trail and door history). */
export interface Actor {
  userId: string;
  username: string;
  displayName: string;
  ip: string | null;
}

/** What the music routes ask Sonos to play. */
export type SonosPlayRequest =
  | { kind: 'favorite'; favoriteId: string; mode: 'now' | 'next' | 'queue' }
  /** A Spotify track / album / playlist / show / episode URI (`spotify:album:…`). `startIndex` = track to start with (0-based). */
  | { kind: 'spotify'; uri: string; title: string; mode: 'now' | 'next' | 'queue'; startIndex?: number }
  /** An explicit list of Spotify tracks (e.g. liked songs). */
  | { kind: 'spotify_tracks'; tracks: { uri: string; title: string }[]; mode: 'now' | 'next' | 'queue' };
