import type { MediaPage, SpotifySearchResult, SpotifySettings, SpotifyStatus, TestResult } from '@home-hub/shared';
import type { Integration, IntegrationDeps } from './types.ts';

export interface SpotifyEndpoints {
  /** Default `https://api.spotify.com/v1` */
  apiBase: string;
  /** Default `https://accounts.spotify.com` */
  accountsBase: string;
}

/**
 * Spotify Web API — used for browsing and searching only. Playback happens on
 * the Sonos speakers themselves (see SonosIntegration.play), because Sonos
 * devices cannot be controlled through Spotify's Web API.
 *
 * CONTRACT STUB — the public surface below is what the rest of the hub relies on.
 * Writes the `spotify` part of the music state via `state.patchMusic({ spotify })`.
 */
export class SpotifyIntegration implements Integration {
  constructor(
    protected readonly deps: IntegrationDeps,
    protected readonly settings: SpotifySettings,
    protected readonly endpoints: Partial<SpotifyEndpoints> = {},
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

  status(_redirectUri: string): SpotifyStatus {
    throw new Error('not implemented');
  }

  /** Starts the OAuth flow (Authorization Code + PKCE). Returns the URL the administrator's browser has to open. */
  beginAuth(_redirectUri: string, _userId: string): string {
    throw new Error('not implemented');
  }

  /**
   * Completes the OAuth flow with the query parameters Spotify sent to the
   * redirect URI. Throws `HttpError` (German message) when `state` is unknown
   * or expired, Spotify reported an error, or the token exchange fails.
   */
  async finishAuth(_params: { code?: string; state?: string; error?: string }, _redirectUri: string): Promise<{ account: string | null }> {
    throw new Error('not implemented');
  }

  /** Forgets the stored tokens. */
  unlink(): void {
    throw new Error('not implemented');
  }

  async search(_query: string): Promise<SpotifySearchResult> {
    throw new Error('not implemented');
  }

  /**
   * Browses the library and containers.
   * `id`: `home` | `playlists` | `albums` | `tracks` | `recent` | `top` | `shows`
   *       | `spotify:playlist:<id>` | `spotify:album:<id>` | `spotify:artist:<id>` | `spotify:show:<id>`
   */
  async browse(_id: string, _cursor: string | null): Promise<MediaPage> {
    throw new Error('not implemented');
  }

  /**
   * Expands something Sonos cannot enqueue as one container (`spotify:collection`
   * = liked songs, `spotify:top`) into single tracks (at most ~100).
   */
  async resolveTracks(_id: string): Promise<{ uri: string; title: string }[]> {
    throw new Error('not implemented');
  }

  /** Checks the client id / stored tokens. Never throws. */
  static async test(_settings: SpotifySettings, _endpoints?: Partial<SpotifyEndpoints>): Promise<TestResult> {
    throw new Error('not implemented');
  }
}
