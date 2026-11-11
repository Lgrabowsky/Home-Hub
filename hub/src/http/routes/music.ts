import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  MediaItem,
  MediaPage,
  MusicGroupCommand,
  MusicPlayerCommand,
  SpotifySearchResult,
  SpotifyStatus,
} from '@home-hub/shared';
import type { HubContext } from '../../context.ts';
import type { SonosPlayRequest } from '../../integrations/types.ts';
import { HttpError, badRequest, notFound } from '../errors.ts';
import { actor, auth, parseBody } from '../server.ts';

const volume = z.number().min(0).max(100);

const groupCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('play') }),
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('toggle') }),
  z.object({ action: z.literal('next') }),
  z.object({ action: z.literal('previous') }),
  z.object({ action: z.literal('seek'), value: z.number().min(0).max(24 * 3600) }),
  z.object({ action: z.literal('set_volume'), value: volume }),
  z.object({ action: z.literal('set_mute'), value: z.boolean() }),
  z.object({ action: z.literal('set_shuffle'), value: z.boolean() }),
  z.object({ action: z.literal('set_repeat'), value: z.enum(['off', 'all', 'one']) }),
]);

const playerCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set_volume'), value: volume }),
  z.object({ action: z.literal('set_mute'), value: z.boolean() }),
  z.object({ action: z.literal('join'), groupId: z.string().min(1).max(100) }),
  z.object({ action: z.literal('leave') }),
]);

const playSchema = z.object({
  itemId: z.string().min(1).max(300),
  mode: z.enum(['now', 'next', 'queue']).default('now'),
  contextId: z.string().max(300).nullish(),
  index: z.number().int().min(0).max(10_000).nullish(),
  /** Title shown on the speaker while the first track loads. */
  title: z.string().max(200).optional(),
});

const SPOTIFY_URI = /^spotify:(track|album|playlist|show|episode):[A-Za-z0-9]{10,40}$/;

/** The address under which Spotify sends the browser back to the hub. */
export function spotifyRedirectUri(ctx: HubContext, request: FastifyRequest): string {
  const base = ctx.config.publicUrl?.origin ?? `${request.protocol}://${request.host}`;
  return `${base}/api/spotify/callback`;
}

function htmlPage(title: string, text: string): string {
  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(
    title,
  )}</title><style>body{font-family:system-ui,sans-serif;background:#0b0f14;color:#e6edf3;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:26rem;padding:2rem;text-align:center}h1{font-size:1.4rem}a{color:#7cc4ff}</style></head><body><main><h1>${escape(
    title,
  )}</h1><p>${escape(text)}</p><p><a href="/einstellungen/dienste">Zurück zu Home Hub</a></p></main></body></html>`;
}

export function registerMusicRoutes(app: FastifyInstance, ctx: HubContext): void {
  const control = { config: { permission: 'music.control' as const } };
  const { integrations } = ctx;

  // --- Sonos ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>('/api/music/groups/:id/command', control, async (request) => {
    const command = parseBody(groupCommand, request.body) as MusicGroupCommand;
    await integrations.need('sonos').groupCommand(request.params.id, command);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/music/players/:id/command', control, async (request) => {
    const command = parseBody(playerCommand, request.body) as MusicPlayerCommand;
    await integrations.need('sonos').playerCommand(request.params.id, command);
    return { ok: true };
  });

  app.get('/api/music/favorites', async (): Promise<{ items: MediaItem[] }> => ({
    items: await integrations.need('sonos').favorites(),
  }));

  app.post<{ Params: { id: string } }>('/api/music/groups/:id/play', control, async (request) => {
    const body = parseBody(playSchema, request.body);
    const sonos = integrations.need('sonos');
    let play: SonosPlayRequest;

    if (body.itemId.startsWith('sonos:fav:')) {
      play = { kind: 'favorite', favoriteId: body.itemId, mode: body.mode };
    } else if (body.itemId === 'spotify:collection' || body.itemId === 'spotify:top') {
      const tracks = await integrations.need('spotify').resolveTracks(body.itemId);
      if (tracks.length === 0) throw new HttpError(404, 'empty', 'Diese Liste enthält keine Titel.');
      const start = Math.min(body.index ?? 0, tracks.length - 1);
      play = { kind: 'spotify_tracks', tracks: tracks.slice(start), mode: body.mode };
    } else if (SPOTIFY_URI.test(body.itemId)) {
      const context = body.contextId && SPOTIFY_URI.test(body.contextId) ? body.contextId : null;
      const listContext = body.contextId === 'spotify:collection' || body.contextId === 'spotify:top' ? body.contextId : null;
      if (listContext && body.mode === 'now') {
        // A track picked from the liked songs: continue with the songs after it.
        const tracks = await integrations.need('spotify').resolveTracks(listContext);
        const start = Math.max(0, tracks.findIndex((t) => t.uri === body.itemId));
        play = { kind: 'spotify_tracks', tracks: tracks.slice(start), mode: 'now' };
      } else if (context && body.mode === 'now' && /^spotify:(album|playlist|show):/.test(context)) {
        // A track picked from an album/playlist: play the container, starting at that track.
        play = { kind: 'spotify', uri: context, title: body.title ?? '', mode: 'now', startIndex: body.index ?? 0 };
      } else {
        play = { kind: 'spotify', uri: body.itemId, title: body.title ?? '', mode: body.mode };
      }
    } else {
      throw badRequest('Dieser Inhalt kann nicht abgespielt werden.');
    }

    await sonos.play(request.params.id, play);
    ctx.log.info({ user: actor(request).username, group: request.params.id, item: body.itemId, mode: body.mode }, 'play');
    return { ok: true };
  });

  // --- Artwork ---------------------------------------------------------------------------

  app.get('/api/img', async (request, reply) => {
    const query = parseBody(z.object({ u: z.string().min(1).max(3000), s: z.string().min(10).max(100) }), request.query);
    const image = await ctx.images.fetch(query.u, query.s);
    if (!image) throw notFound('Bild nicht verfügbar.');
    return reply.header('Cache-Control', 'private, max-age=604800, immutable').type(image.contentType).send(image.body);
  });

  // --- Spotify -----------------------------------------------------------------------------

  app.get('/api/spotify/status', async (request): Promise<SpotifyStatus> => {
    const redirectUri = spotifyRedirectUri(ctx, request);
    const spotify = integrations.spotify;
    if (!spotify) return { configured: false, linked: false, account: null, redirectUri };
    const status = spotify.status(redirectUri);
    // Only administrators need (and get) to see which account is linked in detail.
    return auth(request).user.role === 'admin' ? status : { ...status, redirectUri: '' };
  });

  app.post('/api/spotify/auth/start', { config: { access: 'admin' } }, async (request) => {
    const redirectUri = spotifyRedirectUri(ctx, request);
    if (!redirectUri.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|\[::1\])(:\d+)?\//.test(redirectUri)) {
      throw new HttpError(
        409,
        'https_required',
        'Spotify akzeptiert nur HTTPS-Adressen. Rufe den Hub über seine https://-Adresse auf (oder setze HUB_PUBLIC_URL) und versuche es erneut.',
      );
    }
    return { url: integrations.need('spotify').beginAuth(redirectUri, auth(request).user.id), redirectUri };
  });

  /**
   * Spotify sends the browser here after the consent screen. This is a
   * cross-site navigation, so the (SameSite=Strict) session cookie is not
   * present: the one-time `state` value created in /auth/start is the proof
   * that the flow was started by an administrator of this hub.
   */
  app.get('/api/spotify/callback', { config: { access: 'public', sensitive: true } }, async (request, reply) => {
    const query = parseBody(
      z.object({ code: z.string().max(2000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() }),
      request.query,
    );
    reply.type('text/html; charset=utf-8');
    const spotify = integrations.spotify;
    if (!spotify) return reply.code(503).send(htmlPage('Spotify ist nicht eingerichtet', 'Bitte trage zuerst die Client-ID in den Einstellungen ein.'));
    try {
      const result = await spotify.finishAuth(query, spotifyRedirectUri(ctx, request));
      ctx.audit.record('spotify.linked', { ip: request.ip }, { account: result.account });
      return reply.send(htmlPage('Spotify ist verbunden', 'Du kannst dieses Fenster schließen und in der App weitermachen.'));
    } catch (err) {
      const message = err instanceof HttpError ? err.message : 'Die Verbindung mit Spotify ist fehlgeschlagen.';
      if (!(err instanceof HttpError)) ctx.log.warn({ err }, 'spotify callback failed');
      return reply.code(400).send(htmlPage('Spotify konnte nicht verbunden werden', message));
    }
  });

  app.post('/api/spotify/unlink', { config: { access: 'admin' } }, async (request) => {
    integrations.need('spotify').unlink();
    ctx.audit.record('spotify.unlinked', actor(request));
    return { ok: true };
  });

  app.get('/api/spotify/search', async (request): Promise<SpotifySearchResult> => {
    const query = parseBody(z.object({ q: z.string().trim().min(1).max(100) }), request.query);
    return integrations.need('spotify').search(query.q);
  });

  app.get('/api/spotify/browse', async (request): Promise<MediaPage> => {
    const query = parseBody(z.object({ id: z.string().min(1).max(300), cursor: z.string().max(500).optional() }), request.query);
    return integrations.need('spotify').browse(query.id, query.cursor ?? null);
  });
}
