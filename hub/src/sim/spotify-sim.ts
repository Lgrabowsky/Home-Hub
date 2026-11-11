import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderCover } from './art.ts';
import { albums, artists, findAlbum, findArtist, findPlaylist, findTrack, likedTrackIds, playlists, recentTrackIds, savedAlbumIds, shows, topTrackIds, tracks, type SimAlbum, type SimPlaylist, type SimShow, type SimTrack } from './catalog.ts';

/**
 * Simulator of Spotify's accounts service and Web API, serving the fictitious
 * catalogue. It enforces the rules for apps created from 2025/26 on, so the
 * integration cannot silently rely on behaviour that no longer exists:
 * PKCE is verified for real, search and artist albums are capped at 10 per
 * request, `/playlists/{id}/tracks` is gone, `/playlists/{id}/items` is refused
 * for playlists of other users, and result lists may contain `null`.
 */

export interface SpotifySimOptions {
  port?: number;
  clientId?: string;
  /** When set, the token endpoint also accepts (and for client credentials requires) HTTP Basic client authentication. */
  clientSecret?: string;
  accountName?: string;
  /** Lifetime of access tokens in seconds (as reported in `expires_in`). */
  tokenLifetime?: number;
}

export interface SpotifySimRequest {
  method: string;
  path: string;
  query: Record<string, string>;
}

export interface SpotifySim {
  port: number;
  /** e.g. `http://127.0.0.1:41234/v1` */
  apiBase: string;
  /** e.g. `http://127.0.0.1:41234` */
  accountsBase: string;
  clientId: string;
  accountName: string;
  /** Every request received, oldest first. */
  requests: SpotifySimRequest[];
  /** Plays the user's part of the consent screen: follows the authorize URL and returns the parameters Spotify would send to the redirect URI. */
  authorize(authorizeUrl: string): Promise<{ code?: string; state?: string; error?: string }>;
  /** The next visit of the consent screen ends with `error=access_denied`. */
  denyNextAuthorization(): void;
  /** Makes every access token handed out so far invalid (as if an hour had passed). */
  expireAccessTokens(): void;
  /** Makes every refresh token invalid (as if the user had removed the app, or six months had passed). */
  revokeRefreshTokens(): void;
  /** The next Web API request is answered with this status (e.g. 429 with a Retry-After, or 500). */
  failNext(status: number, retryAfterSeconds?: number): void;
  /** Number of refresh-token grants served. */
  refreshCount(): number;
  close(): Promise<void>;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scope: string;
}

const DEFAULT_CLIENT_ID = '0123456789abcdef0123456789abcdef';

export async function startSpotifySim(options: SpotifySimOptions = {}): Promise<SpotifySim> {
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID;
  const accountName = options.accountName ?? 'Familie Demo';
  const lifetime = options.tokenLifetime ?? 3600;

  const codes = new Map<string, PendingCode>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Map<string, { scope: string }>();
  const requests: SpotifySimRequest[] = [];
  let denyNext = false;
  let failure: { status: number; retryAfter?: number } | null = null;
  let refreshes = 0;
  let origin = '';

  const token = (): string => randomBytes(48).toString('base64url');

  // --- Object shapes (as in Spotify's OpenAPI description) ---------------------------------------

  const image = (seed: string) => [
    { url: `${origin}/img/${seed}.png?s=640`, width: 640, height: 640 },
    { url: `${origin}/img/${seed}.png?s=300`, width: 300, height: 300 },
    { url: `${origin}/img/${seed}.png?s=64`, width: 64, height: 64 },
  ];
  const artistRef = (id: string) => ({ id, name: findArtist(id)?.name ?? '', type: 'artist', uri: `spotify:artist:${id}`, href: `${origin}/v1/artists/${id}` });
  const artistObject = (id: string) => ({ ...artistRef(id), images: image(`artist-${id}`), genres: [], popularity: 50 });
  const albumObject = (album: SimAlbum, withTracks = false) => ({
    id: album.id,
    name: album.name,
    type: 'album',
    album_type: 'album',
    uri: `spotify:album:${album.id}`,
    href: `${origin}/v1/albums/${album.id}`,
    artists: album.artistIds.map(artistRef),
    images: image(`album-${album.id}`),
    release_date: `${album.year}-03-01`,
    release_date_precision: 'day',
    total_tracks: album.trackIds.length,
    ...(withTracks ? { tracks: paging(album.trackIds.map((id) => simplifiedTrack(findTrack(id)!)), 50, 0, `/v1/albums/${album.id}/tracks`) } : {}),
  });
  const simplifiedTrack = (track: SimTrack) => ({
    id: track.id,
    name: track.name,
    type: 'track',
    uri: `spotify:track:${track.id}`,
    href: `${origin}/v1/tracks/${track.id}`,
    artists: track.artistIds.map(artistRef),
    duration_ms: track.durationMs,
    track_number: track.trackNumber,
    disc_number: 1,
    explicit: false,
    is_local: false,
    is_playable: true,
  });
  const trackObject = (track: SimTrack) => ({ ...simplifiedTrack(track), album: albumObject(findAlbum(track.albumId)!), popularity: 40 });
  const playlistObject = (playlist: SimPlaylist) => ({
    id: playlist.id,
    name: playlist.name,
    description: playlist.description,
    type: 'playlist',
    uri: `spotify:playlist:${playlist.id}`,
    href: `${origin}/v1/playlists/${playlist.id}`,
    collaborative: false,
    public: playlist.owner !== 'me',
    images: image(`playlist-${playlist.id}`),
    owner: playlist.owner === 'me' ? { id: 'demo', display_name: accountName, type: 'user', uri: 'spotify:user:demo' } : { id: playlist.owner, display_name: 'Küstenradio', type: 'user', uri: `spotify:user:${playlist.owner}` },
    // New name of the reference to the playlist's content (formerly `tracks`).
    items: { href: `${origin}/v1/playlists/${playlist.id}/items`, total: playlist.trackIds.length },
  });
  const episodeObject = (show: SimShow, episode: SimShow['episodes'][number]) => ({
    id: episode.id,
    name: episode.name,
    type: 'episode',
    uri: `spotify:episode:${episode.id}`,
    href: `${origin}/v1/episodes/${episode.id}`,
    duration_ms: episode.durationMs,
    release_date: episode.releaseDate,
    release_date_precision: 'day',
    images: image(`show-${show.id}`),
    description: '',
    is_playable: true,
  });
  const showObject = (show: SimShow, withEpisodes = false) => ({
    id: show.id,
    name: show.name,
    publisher: show.publisher,
    type: 'show',
    uri: `spotify:show:${show.id}`,
    href: `${origin}/v1/shows/${show.id}`,
    images: image(`show-${show.id}`),
    total_episodes: show.episodes.length,
    description: '',
    ...(withEpisodes ? { episodes: paging(show.episodes.map((episode) => episodeObject(show, episode)), 50, 0, `/v1/shows/${show.id}/episodes`) } : {}),
  });

  function paging<T>(all: T[], limit: number, offset: number, path: string) {
    const items = all.slice(offset, offset + limit);
    const end = offset + items.length;
    return {
      href: `${origin}${path}?offset=${offset}&limit=${limit}`,
      items,
      limit,
      offset,
      total: all.length,
      next: end < all.length ? `${origin}${path}?offset=${end}&limit=${limit}` : null,
      previous: offset > 0 ? `${origin}${path}?offset=${Math.max(0, offset - limit)}&limit=${limit}` : null,
    };
  }

  const byIds = (ids: string[]): SimTrack[] => ids.map(findTrack).filter((track): track is SimTrack => Boolean(track));

  // --- HTTP plumbing ------------------------------------------------------------------------------

  function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers });
    res.end(text);
  }
  const apiError = (res: http.ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void => send(res, status, { error: { status, message } }, headers);

  async function readBody(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 64 * 1024) throw new Error('body too large');
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  function basicClient(req: http.IncomingMessage): { id: string; secret: string } | null {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Basic ')) return null;
    const [id = '', secret = ''] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
    return { id, secret };
  }

  // --- Accounts service -----------------------------------------------------------------------------

  function authorize(url: URL, res: http.ServerResponse): void {
    const q = url.searchParams;
    const redirectUri = q.get('redirect_uri') ?? '';
    // Like the real service: problems with the client or the redirect URI are shown to the user, not redirected.
    if (q.get('client_id') !== clientId) return send(res, 400, { error: 'invalid_client', error_description: 'INVALID_CLIENT: Invalid client' });
    if (!/^https?:\/\//.test(redirectUri)) return send(res, 400, { error: 'invalid_request', error_description: 'INVALID_CLIENT: Invalid redirect URI' });
    const back = new URL(redirectUri);
    const state = q.get('state');
    if (state) back.searchParams.set('state', state);
    const challenge = q.get('code_challenge') ?? '';
    if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      back.searchParams.set('error', 'invalid_request');
    } else if (denyNext) {
      denyNext = false;
      back.searchParams.set('error', 'access_denied');
    } else {
      const code = token();
      codes.set(code, { clientId, redirectUri, challenge, scope: q.get('scope') ?? '' });
      back.searchParams.set('code', code);
    }
    res.writeHead(302, { location: back.toString() });
    res.end();
  }

  async function tokenEndpoint(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const form = new URLSearchParams(await readBody(req));
    const basic = basicClient(req);
    if (basic && (basic.id !== clientId || basic.secret !== (options.clientSecret ?? ''))) return send(res, 400, { error: 'invalid_client', error_description: 'Invalid client secret' });
    const grant = form.get('grant_type');

    if (grant === 'client_credentials') {
      if (!basic || !options.clientSecret) return send(res, 400, { error: 'invalid_client', error_description: 'Invalid client' });
      const access = token();
      accessTokens.add(access);
      return send(res, 200, { access_token: access, token_type: 'Bearer', expires_in: lifetime });
    }

    if ((basic?.id ?? form.get('client_id')) !== clientId) return send(res, 400, { error: 'invalid_client', error_description: 'Invalid client' });

    if (grant === 'authorization_code') {
      const code = form.get('code') ?? '';
      const pending = codes.get(code);
      // Single use, whatever the outcome.
      codes.delete(code);
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (!pending || pending.redirectUri !== form.get('redirect_uri')) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || challenge !== pending.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'code_verifier was incorrect' });
      const access = token();
      const refresh = token();
      accessTokens.add(access);
      refreshTokens.set(refresh, { scope: pending.scope });
      return send(res, 200, { access_token: access, token_type: 'Bearer', expires_in: lifetime, refresh_token: refresh, scope: pending.scope });
    }

    if (grant === 'refresh_token') {
      const presented = form.get('refresh_token') ?? '';
      const known = refreshTokens.get(presented);
      if (!known) return send(res, 400, { error: 'invalid_grant', error_description: 'Refresh token revoked' });
      refreshes++;
      // PKCE clients get a new refresh token with every refresh; the old one stops working.
      refreshTokens.delete(presented);
      const access = token();
      const refresh = token();
      accessTokens.add(access);
      refreshTokens.set(refresh, known);
      return send(res, 200, { access_token: access, token_type: 'Bearer', expires_in: lifetime, refresh_token: refresh, scope: known.scope });
    }

    send(res, 400, { error: 'unsupported_grant_type', error_description: 'grant_type parameter is missing' });
  }

  // --- Web API ------------------------------------------------------------------------------------

  function webApi(path: string, q: URLSearchParams, res: http.ServerResponse): void {
    const limitRaw = q.get('limit');
    const limit = limitRaw === null ? 20 : Number(limitRaw);
    const offset = Number(q.get('offset') ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return apiError(res, 400, 'Invalid limit');
    if (!Number.isInteger(offset) || offset < 0) return apiError(res, 400, 'Invalid offset');

    if (path === '/me') return send(res, 200, { id: 'demo', display_name: accountName, type: 'user', uri: 'spotify:user:demo', country: 'DE', product: 'premium' });

    if (path === '/search') {
      // Since the 2026 changes a search page holds at most 10 results per type.
      if (limit > 10) return apiError(res, 400, 'Invalid limit');
      const needle = (q.get('q') ?? '').toLowerCase();
      if (!needle) return apiError(res, 400, 'No search query');
      const types = (q.get('type') ?? '').split(',');
      const has = (text: string) => text.toLowerCase().includes(needle);
      const out: Record<string, unknown> = {};
      if (types.includes('track')) {
        out.tracks = paging(tracks.filter((track) => has(track.name) || track.artistIds.some((id) => has(findArtist(id)?.name ?? ''))).map(trackObject), limit, offset, '/v1/search');
      }
      if (types.includes('album')) out.albums = paging(albums.filter((album) => has(album.name) || album.artistIds.some((id) => has(findArtist(id)?.name ?? ''))).map((album) => albumObject(album)), limit, offset, '/v1/search');
      if (types.includes('artist')) out.artists = paging(artists.filter((artist) => has(artist.name)).map((artist) => artistObject(artist.id)), limit, offset, '/v1/search');
      if (types.includes('playlist')) {
        const page = paging<unknown>(playlists.filter((playlist) => has(playlist.name) || has(playlist.description)).map(playlistObject), limit, offset, '/v1/search');
        // Real result lists contain `null` for playlists that are no longer available.
        if (page.items.length > 0) page.items.splice(1, 0, null);
        out.playlists = page;
      }
      return send(res, 200, out);
    }

    if (path === '/me/playlists') return send(res, 200, paging(playlists.map(playlistObject), limit, offset, '/v1/me/playlists'));
    if (path === '/me/tracks') return send(res, 200, paging(byIds(likedTrackIds).map((track, index) => ({ added_at: new Date(Date.UTC(2026, 9, 28 - index)).toISOString(), track: trackObject(track) })), limit, offset, '/v1/me/tracks'));
    if (path === '/me/albums') {
      return send(res, 200, paging(savedAlbumIds.map((id) => ({ added_at: '2026-09-01T10:00:00Z', album: albumObject(findAlbum(id)!, true) })), limit, offset, '/v1/me/albums'));
    }
    if (path === '/me/shows') return send(res, 200, paging(shows.map((show) => ({ added_at: '2026-08-15T10:00:00Z', show: showObject(show) })), limit, offset, '/v1/me/shows'));
    if (path === '/me/top/tracks') return send(res, 200, paging(byIds(topTrackIds).map(trackObject), limit, offset, '/v1/me/top/tracks'));
    if (path === '/me/top/artists') return send(res, 200, paging(artists.slice(0, 5).map((artist) => artistObject(artist.id)), limit, offset, '/v1/me/top/artists'));
    if (path === '/me/player/recently-played') {
      // The same track can appear several times (it was simply played again).
      const history = byIds([...recentTrackIds, recentTrackIds[0]!, recentTrackIds[2]!]);
      const items = history.slice(0, limit).map((track, index) => ({ track: trackObject(track), played_at: new Date(Date.UTC(2026, 10, 10, 20, 0) - index * 600_000).toISOString(), context: null }));
      return send(res, 200, { href: `${origin}/v1/me/player/recently-played`, items, limit, next: null, cursors: { after: '0', before: '0' } });
    }

    let match = /^\/playlists\/([A-Za-z0-9]+)(\/items|\/tracks)?$/.exec(path);
    if (match) {
      const playlist = findPlaylist(match[1]!);
      if (!playlist) return apiError(res, 404, 'Resource not found');
      // Removed in 2026 in favour of /items.
      if (match[2] === '/tracks') return apiError(res, 404, 'Not found');
      if (match[2] === '/items') {
        if (playlist.owner !== 'me') return apiError(res, 403, 'Forbidden');
        const entries = byIds(playlist.trackIds).map((track) => ({ added_at: '2026-06-01T08:00:00Z', added_by: { id: 'demo', type: 'user', uri: 'spotify:user:demo' }, is_local: false, item: trackObject(track) }));
        return send(res, 200, paging(entries, limit, offset, `/v1/playlists/${playlist.id}/items`));
      }
      return send(res, 200, playlistObject(playlist));
    }

    match = /^\/albums\/([A-Za-z0-9]+)(\/tracks)?$/.exec(path);
    if (match) {
      const album = findAlbum(match[1]!);
      if (!album) return apiError(res, 404, 'Resource not found');
      if (match[2]) return send(res, 200, paging(byIds(album.trackIds).map(simplifiedTrack), limit, offset, `/v1/albums/${album.id}/tracks`));
      return send(res, 200, albumObject(album, true));
    }

    match = /^\/artists\/([A-Za-z0-9]+)(\/albums|\/top-tracks)?$/.exec(path);
    if (match) {
      const artist = findArtist(match[1]!);
      if (!artist) return apiError(res, 404, 'Resource not found');
      // No longer available to new apps.
      if (match[2] === '/top-tracks') return apiError(res, 403, 'Forbidden');
      if (match[2] === '/albums') {
        if (limit > 10) return apiError(res, 400, 'Invalid limit');
        return send(res, 200, paging(albums.filter((album) => album.artistIds.includes(artist.id)).map((album) => albumObject(album)), limit, offset, `/v1/artists/${artist.id}/albums`));
      }
      return send(res, 200, artistObject(artist.id));
    }

    match = /^\/shows\/([A-Za-z0-9]+)(\/episodes)?$/.exec(path);
    if (match) {
      const show = shows.find((entry) => entry.id === match![1]);
      if (!show) return apiError(res, 404, 'Resource not found');
      if (match[2]) return send(res, 200, paging(show.episodes.map((episode) => episodeObject(show, episode)), limit, offset, `/v1/shows/${show.id}/episodes`));
      return send(res, 200, showObject(show, true));
    }

    // Everything else was removed for new apps (browse categories, featured playlists, batch look-ups …).
    apiError(res, 404, 'Service not found');
  }

  // --- Server ---------------------------------------------------------------------------------------

  const covers = new Map<string, Buffer>();

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin || 'http://127.0.0.1');
      requests.push({ method: req.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams) });
      if (requests.length > 2000) requests.splice(0, 1000);

      if (req.method === 'GET' && url.pathname === '/authorize') return authorize(url, res);
      if (req.method === 'POST' && url.pathname === '/api/token') return tokenEndpoint(req, res);

      const cover = /^\/img\/([A-Za-z0-9-]{1,80})\.png$/.exec(url.pathname);
      if (req.method === 'GET' && cover) {
        const seed = cover[1]!;
        let png = covers.get(seed);
        if (!png) {
          const id = seed.replace(/^[a-z]+-/, '');
          const title = findAlbum(id)?.name ?? findPlaylist(id)?.name ?? findArtist(id)?.name ?? shows.find((show) => show.id === id)?.name ?? '';
          png = renderCover(seed, title);
          covers.set(seed, png);
        }
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'public, max-age=86400' });
        return void res.end(png);
      }

      if (url.pathname.startsWith('/v1/')) {
        if (req.method !== 'GET') return apiError(res, 405, 'Method not allowed');
        const header = req.headers.authorization ?? '';
        if (!header.startsWith('Bearer ') || !accessTokens.has(header.slice(7))) return apiError(res, 401, header ? 'The access token expired' : 'No token provided');
        if (failure) {
          const { status, retryAfter } = failure;
          failure = null;
          return apiError(res, status, status === 429 ? 'API rate limit exceeded' : 'Server error', retryAfter !== undefined ? { 'retry-after': String(retryAfter) } : {});
        }
        return webApi(url.pathname.slice(3), url.searchParams, res);
      }

      apiError(res, 404, 'Not found');
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;

  return {
    port,
    apiBase: `${origin}/v1`,
    accountsBase: origin,
    clientId,
    accountName,
    requests,
    async authorize(authorizeUrl) {
      const response = await fetch(authorizeUrl, { redirect: 'manual' });
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error(`The simulated consent screen answered ${response.status} instead of redirecting`);
      const params = new URL(location).searchParams;
      return { code: params.get('code') ?? undefined, state: params.get('state') ?? undefined, error: params.get('error') ?? undefined };
    },
    denyNextAuthorization() {
      denyNext = true;
    },
    expireAccessTokens() {
      accessTokens.clear();
    },
    revokeRefreshTokens() {
      refreshTokens.clear();
    },
    failNext(status, retryAfterSeconds) {
      failure = { status, retryAfter: retryAfterSeconds };
    },
    refreshCount: () => refreshes,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
