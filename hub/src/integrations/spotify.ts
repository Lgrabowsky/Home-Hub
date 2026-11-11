import { createHash, randomBytes } from 'node:crypto';
import type { MediaItem, MediaPage, SpotifySearchResult, SpotifySettings, SpotifyStatus, TestResult } from '@home-hub/shared';
import { HttpError } from '../http/errors.ts';
import { describeError } from '../util/http.ts';
import { Mutex } from '../util/poller.ts';
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
 * One account is linked for the household (Authorization Code flow with PKCE).
 * The API surface follows the rules for apps created from 2025/26 on: search
 * returns at most 10 results per type, a playlist's tracks are under
 * `/playlists/{id}/items` and only for playlists the user owns, and the batch,
 * "featured" and "top tracks of an artist" endpoints no longer exist.
 */

const DEFAULT_ENDPOINTS: SpotifyEndpoints = { apiBase: 'https://api.spotify.com/v1', accountsBase: 'https://accounts.spotify.com' };

const SCOPES = ['user-read-private', 'playlist-read-private', 'playlist-read-collaborative', 'user-library-read', 'user-top-read', 'user-read-recently-played'].join(' ');

const TOKENS_KEY = 'spotify.tokens';
const TIMEOUT_MS = 10_000;
/** Refresh this long before the access token runs out. */
const REFRESH_MARGIN_MS = 60_000;
const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 5;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 300;
const PAGE = 50;
/** Search and an artist's albums are capped at 10 per request for new apps. */
const SMALL_PAGE = 10;
const RESOLVE_MAX = 100;
/** Looks at the link now and then, so an expired authorisation is noticed before somebody wants music. */
const HEALTH_INTERVAL_MS = 30 * 60_000;
const SPOTIFY_ID = /^[A-Za-z0-9]{10,40}$/;

const NOT_LINKED_MESSAGE = 'Noch nicht mit einem Spotify-Konto verbunden.';
const EXPIRED_MESSAGE = 'Die Spotify-Anmeldung ist abgelaufen – bitte neu verbinden.';
const UNREACHABLE_MESSAGE = 'Spotify ist gerade nicht erreichbar.';

const FOLDERS: { id: string; title: string }[] = [
  { id: 'playlists', title: 'Playlists' },
  { id: 'tracks', title: 'Lieblingssongs' },
  { id: 'albums', title: 'Alben' },
  { id: 'recent', title: 'Zuletzt gehört' },
  { id: 'top', title: 'Meine Top-Titel' },
  { id: 'shows', title: 'Podcasts' },
];

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  account: string | null;
  linkedAt: number;
  /** Tokens belong to one developer app; a changed client id makes them useless. */
  clientId: string;
}

interface PendingAuth {
  verifier: string;
  redirectUri: string;
  userId: string;
  createdAt: number;
}

type Json = Record<string, unknown>;

// --- Reading loosely typed JSON ---------------------------------------------------------------

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);
const obj = (value: unknown): Json => (isObject(value) ? value : {});

function names(value: unknown): string {
  return list(value)
    .map((entry) => str(entry.name))
    .filter(Boolean)
    .join(', ');
}

/** The picture closest to tile size: big enough to look sharp, small enough to load quickly on mobile data. */
function pickImage(images: unknown): string | null {
  const candidates = list(images).filter((image) => str(image.url) !== '');
  if (candidates.length === 0) return null;
  const score = (image: Json): number => {
    const width = num(image.width);
    // Unknown size (playlist mosaics): assume the usual 640 px.
    return Math.abs((width ?? 640) - 300) + ((width ?? 640) < 300 ? 200 : 0);
  };
  return str([...candidates].sort((a, b) => score(a) - score(b))[0]!.url);
}

function seconds(ms: unknown): number | null {
  const value = num(ms);
  return value === null ? null : Math.round(value / 1000);
}

function b64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export class SpotifyIntegration implements Integration {
  private readonly api: string;
  private readonly accounts: string;
  private tokens: StoredTokens | null = null;
  private readonly pending = new Map<string, PendingAuth>();
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private readonly refreshLock = new Mutex();
  private healthTimer: NodeJS.Timeout | null = null;
  private readonly abort = new AbortController();
  private stopped = false;
  private failures = 0;
  private lastError: string | null = null;
  private stats = { requests: 0, refreshes: 0 };

  constructor(
    protected readonly deps: IntegrationDeps,
    protected readonly settings: SpotifySettings,
    protected readonly endpoints: Partial<SpotifyEndpoints> = {},
  ) {
    this.api = (endpoints.apiBase ?? DEFAULT_ENDPOINTS.apiBase).replace(/\/+$/, '');
    this.accounts = (endpoints.accountsBase ?? DEFAULT_ENDPOINTS.accountsBase).replace(/\/+$/, '');
  }

  // --- Life cycle ---------------------------------------------------------------------------

  start(): void {
    this.stopped = false;
    const stored = this.deps.settings.getInternal<StoredTokens>(TOKENS_KEY);
    if (stored && stored.clientId === this.settings.clientId && stored.refreshToken) {
      this.tokens = stored;
    } else if (stored) {
      // Tokens of another developer app cannot be refreshed with this client id.
      this.deps.settings.setInternal(TOKENS_KEY, null);
    }
    this.publish();
    if (this.tokens) void this.checkLink();
    this.healthTimer = setInterval(() => void this.checkLink(), HEALTH_INTERVAL_MS);
    this.healthTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.abort.abort();
    this.pending.clear();
    this.cache.clear();
    // Let a refresh that is already on its way finish (or fail on the abort) before we report "stopped".
    await this.refreshLock.run(async () => {});
  }

  setActive(_active: boolean): void {
    // Nothing is polled: Spotify is only asked when somebody browses or searches.
  }

  diagnostics(): unknown {
    return {
      configured: Boolean(this.settings.clientId),
      linked: this.tokens !== null,
      account: this.tokens?.account ?? null,
      scope: this.tokens?.scope ?? null,
      linkedAt: this.tokens ? new Date(this.tokens.linkedAt).toISOString() : null,
      accessTokenExpiresAt: this.tokens ? new Date(this.tokens.expiresAt).toISOString() : null,
      pendingAuthorizations: this.pending.size,
      cacheEntries: this.cache.size,
      requests: this.stats.requests,
      tokenRefreshes: this.stats.refreshes,
      lastError: this.lastError,
    };
  }

  /** Tells the apps (music state) and the health display where we stand. */
  private publish(message?: { status: 'degraded' | 'offline'; text: string }): void {
    if (this.stopped) return;
    this.deps.state.patchMusic({ spotify: { linked: this.tokens !== null, account: this.tokens?.account ?? null } });
    if (message) this.deps.state.setService('spotify', message.status, message.text);
    else if (this.tokens) this.deps.state.setService('spotify', 'ok', null);
    else this.deps.state.setService('spotify', 'degraded', NOT_LINKED_MESSAGE);
  }

  /** Background check: is the link still good? Refreshes the access token when needed. */
  private async checkLink(): Promise<void> {
    if (!this.tokens || this.stopped) return;
    try {
      const me = await this.call<Json>('/me');
      const account = str(me.display_name) || str(me.id) || null;
      if (this.tokens && account !== this.tokens.account) {
        this.tokens = { ...this.tokens, account };
        this.deps.settings.setInternal(TOKENS_KEY, this.tokens);
        this.publish();
      }
    } catch {
      // `call` has already recorded the health state; nothing else depends on this check.
    }
  }

  // --- Linking (Authorization Code + PKCE) ----------------------------------------------------------

  status(redirectUri: string): SpotifyStatus {
    return { configured: Boolean(this.settings.clientId), linked: this.tokens !== null, account: this.tokens?.account ?? null, redirectUri };
  }

  /** Starts the OAuth flow (Authorization Code + PKCE). Returns the URL the administrator's browser has to open. */
  beginAuth(redirectUri: string, userId: string): string {
    if (!this.settings.clientId) throw new HttpError(409, 'not_configured', 'Bitte trage zuerst die Client-ID ein und speichere.');
    const now = Date.now();
    for (const [key, entry] of this.pending) if (now - entry.createdAt > PENDING_TTL_MS) this.pending.delete(key);
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    // RFC 7636: 43–128 characters from the unreserved set; 64 random bytes give 86.
    const verifier = b64url(randomBytes(64));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(24));
    this.pending.set(state, { verifier, redirectUri, userId, createdAt: now });
    const query = new URLSearchParams({
      client_id: this.settings.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
      scope: SCOPES,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    return `${this.accounts}/authorize?${query.toString()}`;
  }

  /**
   * Completes the OAuth flow with the query parameters Spotify sent to the
   * redirect URI. Throws `HttpError` (German message) when `state` is unknown
   * or expired, Spotify reported an error, or the token exchange fails.
   */
  async finishAuth(params: { code?: string; state?: string; error?: string }, redirectUri: string): Promise<{ account: string | null }> {
    const entry = params.state ? this.pending.get(params.state) : undefined;
    // Single use: whatever happens next, this state value is spent.
    if (params.state) this.pending.delete(params.state);
    if (!entry || Date.now() - entry.createdAt > PENDING_TTL_MS || entry.redirectUri !== redirectUri) {
      throw new HttpError(400, 'invalid_state', 'Diese Anmeldung ist abgelaufen oder wurde nicht von hier gestartet. Bitte in der App erneut „Mit Spotify verbinden“ wählen.');
    }
    if (params.error) {
      throw new HttpError(
        400,
        'spotify_denied',
        params.error === 'access_denied' ? 'Du hast den Zugriff bei Spotify nicht erlaubt. Es wurde nichts verbunden.' : 'Spotify hat die Anmeldung abgelehnt. Bitte versuche es erneut.',
      );
    }
    if (!params.code) throw new HttpError(400, 'missing_code', 'Spotify hat keine Bestätigung mitgeschickt. Bitte versuche es erneut.');

    const granted = await this.tokenRequest(
      new URLSearchParams({ grant_type: 'authorization_code', code: params.code, redirect_uri: redirectUri, client_id: this.settings.clientId, code_verifier: entry.verifier }),
      'link',
    );
    if (!granted.refreshToken) throw new HttpError(502, 'spotify_error', 'Spotify hat keine dauerhafte Anmeldung ausgestellt. Bitte versuche es erneut.');

    const tokens: StoredTokens = {
      accessToken: granted.accessToken,
      refreshToken: granted.refreshToken,
      expiresAt: granted.expiresAt,
      scope: granted.scope,
      account: null,
      linkedAt: Date.now(),
      clientId: this.settings.clientId,
    };
    await this.refreshLock.run(async () => {
      this.tokens = tokens;
      this.deps.settings.setInternal(TOKENS_KEY, tokens);
    });
    this.cache.clear();
    this.failures = 0;
    this.lastError = null;
    try {
      const me = await this.call<Json>('/me');
      const account = str(me.display_name) || str(me.id) || null;
      if (this.tokens) {
        this.tokens = { ...this.tokens, account };
        this.deps.settings.setInternal(TOKENS_KEY, this.tokens);
      }
    } catch (err) {
      // Linked all the same; the name is cosmetic and is picked up by the next background check.
      this.deps.log.warn({ err: describeError(err) }, 'spotify: could not read the account name');
    }
    this.publish();
    this.deps.log.info('spotify: account linked');
    return { account: this.tokens?.account ?? null };
  }

  /** Forgets the stored tokens. */
  unlink(): void {
    this.tokens = null;
    this.deps.settings.setInternal(TOKENS_KEY, null);
    this.cache.clear();
    this.pending.clear();
    this.failures = 0;
    this.lastError = null;
    this.publish();
  }

  // --- Tokens -------------------------------------------------------------------------------

  private async tokenRequest(body: URLSearchParams, purpose: 'link' | 'refresh'): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: number; scope: string }> {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (this.settings.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${this.settings.clientId}:${this.settings.clientSecret}`).toString('base64')}`;
    }
    let response: Response;
    try {
      response = await fetch(`${this.accounts}/api/token`, { method: 'POST', headers, body, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(TIMEOUT_MS)]) });
    } catch (err) {
      this.lastError = `token ${purpose}: ${describeError(err)}`;
      throw new HttpError(502, 'spotify_unreachable', UNREACHABLE_MESSAGE);
    }
    let payload: Json = {};
    try {
      payload = obj(await response.json());
    } catch {
      /* an error page instead of JSON — handled by the status below */
    }
    if (response.ok && str(payload.access_token)) {
      const lifetime = num(payload.expires_in) ?? 3600;
      return {
        accessToken: str(payload.access_token),
        refreshToken: str(payload.refresh_token) || null,
        expiresAt: Date.now() + lifetime * 1000,
        scope: str(payload.scope),
      };
    }
    const error = str(payload.error);
    // Only Spotify's short error code is kept — never the request (it contains the code/verifier/refresh token).
    this.lastError = `token ${purpose}: HTTP ${response.status}${error ? ` ${error}` : ''}`;
    if (error === 'invalid_grant') {
      throw new HttpError(400, 'invalid_grant', purpose === 'link' ? 'Spotify hat die Bestätigung nicht angenommen (abgelaufen oder schon benutzt). Bitte erneut verbinden.' : EXPIRED_MESSAGE);
    }
    if (error === 'invalid_client' || error === 'unauthorized_client') {
      throw new HttpError(400, 'invalid_client', 'Spotify kennt diese Client-ID nicht (oder das Client-Secret passt nicht). Bitte prüfe die Angaben in den Einstellungen.');
    }
    if (response.status >= 500 || response.status === 429) throw new HttpError(502, 'spotify_unreachable', UNREACHABLE_MESSAGE);
    throw new HttpError(502, 'spotify_error', 'Spotify hat die Anmeldung nicht angenommen. Bitte versuche es erneut.');
  }

  /**
   * A valid access token. Refreshes when it is about to run out, or when
   * `rejected` (a token Spotify just answered with 401) is still the current one.
   * Single flight: concurrent callers wait for the same refresh.
   */
  private accessToken(rejected?: string): Promise<string> {
    return this.refreshLock.run(async () => {
      const tokens = this.tokens;
      if (!tokens) throw new HttpError(409, 'not_linked', 'Spotify ist noch nicht verbunden.');
      const stale = rejected !== undefined ? tokens.accessToken === rejected : tokens.expiresAt - Date.now() < REFRESH_MARGIN_MS;
      if (!stale) return tokens.accessToken;

      this.stats.refreshes++;
      let granted;
      try {
        granted = await this.tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: this.settings.clientId }), 'refresh');
      } catch (err) {
        if (err instanceof HttpError && (err.code === 'invalid_grant' || err.code === 'invalid_client')) {
          // The authorisation is gone for good (6 months unused, revoked, or another app): retrying cannot help.
          this.tokens = null;
          this.deps.settings.setInternal(TOKENS_KEY, null);
          this.cache.clear();
          this.publish({ status: 'degraded', text: err.code === 'invalid_grant' ? EXPIRED_MESSAGE : err.message });
          this.deps.log.warn({ reason: err.code }, 'spotify: link lost');
        }
        throw err;
      }
      // Spotify may rotate the refresh token: the new pair is stored before the new access token is used.
      const next: StoredTokens = {
        ...tokens,
        accessToken: granted.accessToken,
        refreshToken: granted.refreshToken ?? tokens.refreshToken,
        expiresAt: granted.expiresAt,
        scope: granted.scope || tokens.scope,
      };
      this.tokens = next;
      this.deps.settings.setInternal(TOKENS_KEY, next);
      return next.accessToken;
    });
  }

  // --- Calling the Web API -------------------------------------------------------------------------

  private async request(path: string, query: Record<string, string | number | undefined>, token: string): Promise<Response> {
    const url = new URL(`${this.api}${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    this.stats.requests++;
    return fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(TIMEOUT_MS)]) });
  }

  private noteFailure(detail: string): void {
    this.lastError = detail;
    // One hiccup is not an outage.
    if (++this.failures >= 2) this.publish({ status: 'offline', text: UNREACHABLE_MESSAGE });
  }

  private async call<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    let token = await this.accessToken();
    let response: Response;
    try {
      response = await this.request(path, query, token);
      if (response.status === 401) {
        token = await this.accessToken(token);
        response = await this.request(path, query, token);
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      this.noteFailure(`${path}: ${describeError(err)}`);
      throw new HttpError(502, 'spotify_unreachable', UNREACHABLE_MESSAGE);
    }

    if (response.ok) {
      if (this.failures > 0 || this.lastError) {
        this.failures = 0;
        this.lastError = null;
        this.publish();
      }
      try {
        return (await response.json()) as T;
      } catch {
        throw new HttpError(502, 'spotify_error', 'Spotify hat unverständlich geantwortet. Bitte später erneut versuchen.');
      }
    }

    this.lastError = `${path}: HTTP ${response.status}`;
    void response.body?.cancel().catch(() => {});
    switch (response.status) {
      case 429: {
        const wait = Math.min(3600, Math.max(1, Math.round(Number(response.headers.get('retry-after')) || 5)));
        throw new HttpError(429, 'rate_limited', `Spotify bremst gerade – bitte in ${wait} Sekunden erneut versuchen.`, wait);
      }
      case 401:
        throw new HttpError(502, 'spotify_error', EXPIRED_MESSAGE);
      case 403:
        throw new HttpError(
          403,
          'spotify_forbidden',
          'Spotify verweigert den Zugriff. Prüfe im Spotify-Entwicklerportal, ob dein Konto bei der App eingetragen ist und ob das Konto, dem die App gehört, Spotify Premium hat.',
        );
      case 404:
        throw new HttpError(404, 'not_found', 'Das gibt es bei Spotify nicht (mehr).');
      default:
        if (response.status >= 500) this.noteFailure(`${path}: HTTP ${response.status}`);
        throw new HttpError(502, 'spotify_error', 'Spotify hat einen Fehler gemeldet. Bitte später erneut versuchen.');
    }
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
    const value = await load();
    if (this.tokens) {
      this.cache.delete(key);
      this.cache.set(key, { at: Date.now(), value });
      while (this.cache.size > CACHE_MAX) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }
    return value;
  }

  // --- Mapping to the hub's media model ---------------------------------------------------------------

  private art(images: unknown): string | null {
    return this.deps.images.url(pickImage(images));
  }

  private item(type: MediaItem['type'], raw: Json, fields: Partial<MediaItem>): MediaItem | null {
    const uri = str(raw.uri);
    if (!uri.startsWith(`spotify:${type}:`)) return null;
    return {
      id: uri,
      type,
      title: str(raw.name) || 'Ohne Titel',
      subtitle: null,
      artUrl: null,
      browsable: false,
      playable: true,
      source: 'spotify',
      ...fields,
    };
  }

  private track(raw: Json, albumImages?: unknown): MediaItem | null {
    // Local files have no Spotify id and cannot be played on a speaker.
    if (raw.is_local === true) return null;
    if (str(raw.type) === 'episode') return this.episode(raw);
    return this.item('track', raw, { subtitle: names(raw.artists) || null, artUrl: this.art(albumImages ?? obj(raw.album).images), duration: seconds(raw.duration_ms) });
  }

  private album(raw: Json): MediaItem | null {
    return this.item('album', raw, { subtitle: names(raw.artists) || null, artUrl: this.art(raw.images), browsable: true });
  }

  private playlist(raw: Json): MediaItem | null {
    const owner = str(obj(raw.owner).display_name);
    // New responses carry the size under `items`, older ones under `tracks`.
    const total = num(obj(raw.items).total) ?? num(obj(raw.tracks).total);
    return this.item('playlist', raw, { subtitle: owner || (total !== null ? `${total} Titel` : null), artUrl: this.art(raw.images), browsable: true });
  }

  private artist(raw: Json): MediaItem | null {
    return this.item('artist', raw, { subtitle: 'Künstler', artUrl: this.art(raw.images), browsable: true, playable: false });
  }

  private show(raw: Json): MediaItem | null {
    return this.item('show', raw, { subtitle: str(raw.publisher) || 'Podcast', artUrl: this.art(raw.images), browsable: true });
  }

  private episode(raw: Json, showImages?: unknown): MediaItem | null {
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(raw.release_date));
    return this.item('episode', raw, {
      subtitle: date ? `${date[3]}.${date[2]}.${date[1]}` : null,
      artUrl: this.art(list(raw.images).length > 0 ? raw.images : showImages),
      duration: seconds(raw.duration_ms),
    });
  }

  private compact(items: (MediaItem | null)[]): MediaItem[] {
    return items.filter((item): item is MediaItem => item !== null);
  }

  // --- Search and browse ---------------------------------------------------------------------------

  async search(query: string): Promise<SpotifySearchResult> {
    const q = query.trim().slice(0, 200);
    if (q === '') return { tracks: [], albums: [], playlists: [], artists: [] };
    return this.cached(`search:${q.toLowerCase()}`, async () => {
      const result = await this.call<Json>('/search', { q, type: 'track,album,playlist,artist', limit: SMALL_PAGE, market: this.settings.market });
      // Spotify's result lists can contain `null` entries (e.g. playlists that were removed) — `list` skips them.
      return {
        tracks: this.compact(list(obj(result.tracks).items).map((raw) => this.track(raw))),
        albums: this.compact(list(obj(result.albums).items).map((raw) => this.album(raw))),
        playlists: this.compact(list(obj(result.playlists).items).map((raw) => this.playlist(raw))),
        artists: this.compact(list(obj(result.artists).items).map((raw) => this.artist(raw))),
      };
    });
  }

  /**
   * Browses the library and containers.
   * `id`: `home` | `playlists` | `albums` | `tracks` | `recent` | `top` | `shows`
   *       | `spotify:playlist:<id>` | `spotify:album:<id>` | `spotify:artist:<id>` | `spotify:show:<id>`
   */
  async browse(id: string, cursor: string | null): Promise<MediaPage> {
    if (cursor !== null && !/^\d{1,6}$/.test(cursor)) throw new HttpError(400, 'bad_cursor', 'Diese Seite gibt es nicht.');
    const offset = cursor === null ? 0 : Number(cursor);
    if (id === 'home') {
      // Fails with "not linked" before showing an empty library.
      await this.accessToken();
      return {
        title: 'Spotify',
        subtitle: this.tokens?.account ?? null,
        items: FOLDERS.map((folder) => ({ id: folder.id, type: 'folder', title: folder.title, subtitle: null, artUrl: null, browsable: true, playable: false, source: 'spotify' })),
        next: null,
      };
    }
    return this.cached(`browse:${id}:${offset}`, () => this.loadPage(id, offset));
  }

  private nextCursor(page: Json, offset: number, received: number): string | null {
    const total = num(page.total);
    const end = offset + received;
    if (received === 0) return null;
    if (total !== null) return end < total ? String(end) : null;
    return page.next ? String(end) : null;
  }

  private async loadPage(id: string, offset: number): Promise<MediaPage> {
    const market = this.settings.market;
    switch (id) {
      case 'playlists': {
        const page = await this.call<Json>('/me/playlists', { limit: PAGE, offset });
        const raw = Array.isArray(page.items) ? page.items : [];
        return { title: 'Playlists', items: this.compact(list(raw).map((entry) => this.playlist(entry))), next: this.nextCursor(page, offset, raw.length) };
      }
      case 'albums': {
        const page = await this.call<Json>('/me/albums', { limit: PAGE, offset, market });
        const raw = list(page.items);
        return { title: 'Alben', items: this.compact(raw.map((entry) => this.album(obj(entry.album)))), next: this.nextCursor(page, offset, raw.length) };
      }
      case 'shows': {
        const page = await this.call<Json>('/me/shows', { limit: PAGE, offset });
        const raw = list(page.items);
        return { title: 'Podcasts', items: this.compact(raw.map((entry) => this.show(obj(entry.show)))), next: this.nextCursor(page, offset, raw.length) };
      }
      case 'tracks': {
        const page = await this.call<Json>('/me/tracks', { limit: PAGE, offset, market });
        const raw = list(page.items);
        const total = num(page.total);
        return {
          title: 'Lieblingssongs',
          subtitle: total !== null ? `${total} Titel` : null,
          // Sonos cannot enqueue "liked songs" as one thing; the hub expands this pseudo container (see resolveTracks).
          self: { id: 'spotify:collection', type: 'playlist', title: 'Lieblingssongs', subtitle: null, artUrl: null, browsable: false, playable: true, source: 'spotify' },
          items: this.compact(raw.map((entry) => this.track(obj(entry.track)))),
          next: this.nextCursor(page, offset, raw.length),
        };
      }
      case 'top': {
        const page = await this.call<Json>('/me/top/tracks', { limit: PAGE, offset, time_range: 'medium_term' });
        const raw = list(page.items);
        return {
          title: 'Meine Top-Titel',
          self: { id: 'spotify:top', type: 'playlist', title: 'Meine Top-Titel', subtitle: null, artUrl: null, browsable: false, playable: true, source: 'spotify' },
          items: this.compact(raw.map((entry) => this.track(entry))),
          next: this.nextCursor(page, offset, raw.length),
        };
      }
      case 'recent': {
        if (offset > 0) return { title: 'Zuletzt gehört', items: [], next: null };
        const page = await this.call<Json>('/me/player/recently-played', { limit: PAGE });
        const seen = new Set<string>();
        const items = this.compact(list(page.items).map((entry) => this.track(obj(entry.track)))).filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)));
        return { title: 'Zuletzt gehört', items, next: null };
      }
      default:
        break;
    }

    const match = /^spotify:(playlist|album|artist|show):([A-Za-z0-9]+)$/.exec(id);
    // Checked strictly because the id becomes part of a URL path.
    if (!match || !SPOTIFY_ID.test(match[2]!)) throw new HttpError(404, 'not_found', 'Das gibt es bei Spotify nicht.');
    const [, kind, spotifyId] = match as unknown as [string, 'playlist' | 'album' | 'artist' | 'show', string];

    switch (kind) {
      case 'playlist': {
        const head = await this.cached(`head:${id}`, () => this.call<Json>(`/playlists/${spotifyId}`, { market }));
        const self = this.playlist(head);
        const description = str(head.description).replace(/<[^>]*>/g, '').trim();
        const base = { title: str(head.name) || 'Playlist', artUrl: this.art(head.images), self };
        try {
          const page = await this.call<Json>(`/playlists/${spotifyId}/items`, { limit: PAGE, offset, market, additional_types: 'track,episode' });
          const raw = Array.isArray(page.items) ? page.items : [];
          // Each entry carries the track under `item` (older responses: `track`).
          const items = this.compact(list(raw).map((entry) => this.track(obj(entry.item ?? entry.track))));
          return { ...base, subtitle: description || self?.subtitle || null, items, next: this.nextCursor(page, offset, raw.length) };
        } catch (err) {
          // Spotify only lists the tracks of playlists the user owns or collaborates on; the playlist still plays as a whole.
          if (err instanceof HttpError && err.statusCode === 403) {
            return { ...base, subtitle: 'Die Titelliste dieser Playlist gibt Spotify nicht preis – abspielen kannst du sie trotzdem.', items: [], next: null };
          }
          throw err;
        }
      }
      case 'album': {
        const head = await this.cached(`head:${id}`, () => this.call<Json>(`/albums/${spotifyId}`, { market }));
        const page = offset === 0 && isObject(head.tracks) ? head.tracks : await this.call<Json>(`/albums/${spotifyId}/tracks`, { limit: PAGE, offset, market });
        const raw = list(page.items);
        const year = /^\d{4}/.exec(str(head.release_date))?.[0];
        return {
          title: str(head.name) || 'Album',
          subtitle: [names(head.artists), year].filter(Boolean).join(' · ') || null,
          artUrl: this.art(head.images),
          self: this.album(head),
          items: this.compact(raw.map((entry) => this.track(entry, head.images))),
          next: this.nextCursor(page, offset, raw.length),
        };
      }
      case 'artist': {
        const head = await this.cached(`head:${id}`, () => this.call<Json>(`/artists/${spotifyId}`));
        const page = await this.call<Json>(`/artists/${spotifyId}/albums`, { limit: SMALL_PAGE, offset, market, include_groups: 'album,single' });
        const raw = list(page.items);
        return { title: str(head.name) || 'Künstler', subtitle: 'Alben & Singles', artUrl: this.art(head.images), self: null, items: this.compact(raw.map((entry) => this.album(entry))), next: this.nextCursor(page, offset, raw.length) };
      }
      case 'show': {
        const head = await this.cached(`head:${id}`, () => this.call<Json>(`/shows/${spotifyId}`, { market }));
        const page = offset === 0 && isObject(head.episodes) ? head.episodes : await this.call<Json>(`/shows/${spotifyId}/episodes`, { limit: PAGE, offset, market });
        const raw = Array.isArray(page.items) ? page.items : [];
        return {
          title: str(head.name) || 'Podcast',
          subtitle: str(head.publisher) || null,
          artUrl: this.art(head.images),
          self: this.show(head),
          items: this.compact(list(raw).map((entry) => this.episode(entry, head.images))),
          next: this.nextCursor(page, offset, raw.length),
        };
      }
    }
  }

  /**
   * Expands something Sonos cannot enqueue as one container (`spotify:collection`
   * = liked songs, `spotify:top`) into single tracks (at most ~100).
   */
  async resolveTracks(id: string): Promise<{ uri: string; title: string }[]> {
    if (id !== 'spotify:collection' && id !== 'spotify:top') throw new HttpError(400, 'unsupported', 'Das lässt sich nicht als Ganzes abspielen.');
    const folder = id === 'spotify:collection' ? 'tracks' : 'top';
    const tracks: { uri: string; title: string }[] = [];
    let cursor: string | null = null;
    do {
      const page: MediaPage = await this.browse(folder, cursor);
      for (const item of page.items) if (item.type === 'track') tracks.push({ uri: item.id, title: item.title });
      cursor = page.next;
    } while (cursor !== null && tracks.length < RESOLVE_MAX);
    return tracks.slice(0, RESOLVE_MAX);
  }

  /** Checks the client id / stored tokens. Never throws. */
  static async test(settings: SpotifySettings, endpoints: Partial<SpotifyEndpoints> = {}): Promise<TestResult> {
    try {
      const clientId = settings.clientId.trim();
      if (!clientId) return { ok: false, message: 'Die Client-ID fehlt.', details: ['Du findest sie im Spotify-Entwicklerportal in den Einstellungen deiner App.'] };
      if (!/^[0-9a-f]{32}$/i.test(clientId)) {
        return { ok: false, message: 'Die Client-ID sieht nicht richtig aus.', details: ['Sie besteht aus genau 32 Zeichen (Ziffern und die Buchstaben a–f). Bitte noch einmal aus dem Spotify-Entwicklerportal kopieren.'] };
      }
      const next = [
        'Nächster Schritt: speichern und „Mit Spotify verbinden“ wählen.',
        'Die oben angezeigte Redirect-Adresse muss in deiner Spotify-App eingetragen sein.',
        'Das Konto, dem die Spotify-App gehört, braucht Spotify Premium.',
      ];
      if (!settings.clientSecret) return { ok: true, message: 'Die Client-ID hat das richtige Format.', details: ['Ob Spotify sie annimmt, zeigt sich beim Verbinden.', ...next] };

      // With a secret the pair can really be verified (client-credentials grant, no user involved).
      const accounts = (endpoints.accountsBase ?? DEFAULT_ENDPOINTS.accountsBase).replace(/\/+$/, '');
      const response = await fetch(`${accounts}/api/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${clientId}:${settings.clientSecret}`).toString('base64')}` },
        body: new URLSearchParams({ grant_type: 'client_credentials' }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      void response.body?.cancel().catch(() => {});
      if (response.ok) return { ok: true, message: 'Spotify hat Client-ID und Client-Secret angenommen.', details: next };
      if (response.status === 400 || response.status === 401) return { ok: false, message: 'Spotify lehnt Client-ID oder Client-Secret ab.', details: ['Bitte beide Werte noch einmal aus dem Spotify-Entwicklerportal kopieren.'] };
      return { ok: false, message: 'Spotify ist gerade nicht erreichbar.', details: ['Bitte später noch einmal versuchen.'] };
    } catch {
      return { ok: false, message: 'Spotify ist gerade nicht erreichbar.', details: ['Hat der Hub eine Internetverbindung? Bitte später noch einmal versuchen.'] };
    }
  }
}
