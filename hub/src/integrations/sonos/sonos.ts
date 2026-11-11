import type { MediaItem, MusicGroupCommand, MusicPlayerCommand, SonosSettings, TestResult } from '@home-hub/shared';
import type { Integration, IntegrationDeps, SonosPlayRequest } from '../types.ts';

/**
 * Sonos speakers (local UPnP/SOAP control on port 1400, no cloud).
 *
 * CONTRACT STUB — the public surface below is what the rest of the hub relies on.
 * Writes `players` and `groups` of the music state via `state.patchMusic(…)`.
 */
export class SonosIntegration implements Integration {
  constructor(
    protected readonly deps: IntegrationDeps,
    protected readonly settings: SonosSettings,
  ) {}

  start(): void {
    throw new Error('not implemented');
  }

  async stop(): Promise<void> {
    throw new Error('not implemented');
  }

  setActive(_active: boolean): void {
    throw new Error('not implemented');
  }

  diagnostics(): unknown {
    throw new Error('not implemented');
  }

  /** Transport / volume command for a group (id = coordinator UUID). Throws `HttpError` on failure. */
  async groupCommand(_groupId: string, _command: MusicGroupCommand): Promise<void> {
    throw new Error('not implemented');
  }

  /** Volume, mute and grouping for a single player. */
  async playerCommand(_playerId: string, _command: MusicPlayerCommand): Promise<void> {
    throw new Error('not implemented');
  }

  /** The household's Sonos favourites as playable items (`sonos:fav:<id>`). */
  async favorites(): Promise<MediaItem[]> {
    throw new Error('not implemented');
  }

  /** Starts / queues a favourite or Spotify content on a group. */
  async play(_groupId: string, _request: SonosPlayRequest): Promise<void> {
    throw new Error('not implemented');
  }

  /** Connection test for (possibly unsaved) settings. Never throws. */
  static async test(_settings: SonosSettings): Promise<TestResult> {
    throw new Error('not implemented');
  }
}
