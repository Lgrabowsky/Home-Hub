import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '../src/http/errors.ts';
import { SpotifyIntegration } from '../src/integrations/spotify.ts';
import { playlists, shows, simId } from '../src/sim/catalog.ts';
import { startSpotifySim, type SpotifySim } from '../src/sim/spotify-sim.ts';
import { createTestDeps, type TestDeps } from './deps.ts';

const REDIRECT = 'https://hub.example.test/api/spotify/callback';

let sim: SpotifySim;
let env: TestDeps;
let spotify: SpotifyIntegration;

function create(overrides: Partial<{ clientId: string; clientSecret: string }> = {}): SpotifyIntegration {
  return new SpotifyIntegration(env.deps, { enabled: true, clientId: sim.clientId, clientSecret: '', market: 'DE', ...overrides }, { apiBase: sim.apiBase, accountsBase: sim.accountsBase });
}

/** Runs the whole consent round trip against the simulator. */
async function link(instance = spotify): Promise<{ account: string | null }> {
  const url = instance.beginAuth(REDIRECT, 'user-1');
  return instance.finishAuth(await sim.authorize(url), REDIRECT);
}

async function failure(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error('expected the call to fail');
}

beforeEach(async () => {
  sim = await startSpotifySim();
  env = createTestDeps();
  spotify = create();
  spotify.start();
});

afterEach(async () => {
  await spotify.stop();
  await sim.close();
  env.cleanup();
});

describe('linking an account', () => {
  it('starts unlinked and says so', () => {
    expect(env.state.getMusic().spotify).toEqual({ linked: false, account: null });
    const health = env.state.allServices().find((service) => service.id === 'spotify');
    expect(health?.status).toBe('degraded');
    expect(health?.message).toMatch(/Noch nicht/);
    expect(spotify.status(REDIRECT)).toEqual({ configured: true, linked: false, account: null, redirectUri: REDIRECT });
  });

  it('completes the PKCE flow and remembers the account', async () => {
    const url = new URL(spotify.beginAuth(REDIRECT, 'user-1'));
    expect(url.origin + url.pathname).toBe(`${sim.accountsBase}/authorize`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('scope')).toContain('user-library-read');

    const result = await spotify.finishAuth(await sim.authorize(url.toString()), REDIRECT);
    expect(result.account).toBe('Familie Demo');
    expect(env.state.getMusic().spotify).toEqual({ linked: true, account: 'Familie Demo' });
    expect(env.state.allServices().find((service) => service.id === 'spotify')?.status).toBe('ok');
    expect(spotify.status(REDIRECT).linked).toBe(true);
  });

  it('accepts a state value only once, only for its redirect address, and never an unknown one', async () => {
    const params = await sim.authorize(spotify.beginAuth(REDIRECT, 'user-1'));
    expect((await failure(spotify.finishAuth(params, 'https://evil.example/api/spotify/callback'))).code).toBe('invalid_state');
    // The failed attempt has used the state up.
    expect((await failure(spotify.finishAuth(params, REDIRECT))).code).toBe('invalid_state');
    expect((await failure(spotify.finishAuth({ code: 'x', state: 'made-up' }, REDIRECT))).code).toBe('invalid_state');
    expect((await failure(spotify.finishAuth({ code: 'x' }, REDIRECT))).code).toBe('invalid_state');
    expect(env.state.getMusic().spotify?.linked).toBe(false);
  });

  it('reports a refused consent in plain German', async () => {
    sim.denyNextAuthorization();
    const params = await sim.authorize(spotify.beginAuth(REDIRECT, 'user-1'));
    expect(params.error).toBe('access_denied');
    const err = await failure(spotify.finishAuth(params, REDIRECT));
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/nicht erlaubt/);
  });

  it('keeps at most five consent screens open', () => {
    const states = Array.from({ length: 7 }, () => new URL(spotify.beginAuth(REDIRECT, 'user-1')).searchParams.get('state'));
    expect(new Set(states).size).toBe(7);
    expect((spotify.diagnostics() as { pendingAuthorizations: number }).pendingAuthorizations).toBe(5);
  });

  it('explains a client id that Spotify does not know', async () => {
    await spotify.stop();
    spotify = create({ clientId: 'ffffffffffffffffffffffffffffffff' });
    spotify.start();
    // The real consent screen would show an error page instead of redirecting; a forged callback must fail at the token exchange.
    const state = new URL(spotify.beginAuth(REDIRECT, 'user-1')).searchParams.get('state')!;
    const err = await failure(spotify.finishAuth({ code: 'anything', state }, REDIRECT));
    expect(err.message).toMatch(/Client-ID/);
  });

  it('forgets everything on unlink', async () => {
    await link();
    spotify.unlink();
    expect(env.state.getMusic().spotify).toEqual({ linked: false, account: null });
    expect((await failure(spotify.search('Polarnacht'))).code).toBe('not_linked');
    expect(env.deps.settings.getInternal('spotify.tokens')).toBeNull();
  });

  it('stays linked across a restart of the hub', async () => {
    await link();
    await spotify.stop();
    spotify = create();
    spotify.start();
    expect(env.state.getMusic().spotify).toEqual({ linked: true, account: 'Familie Demo' });
    expect((await spotify.search('Polarnacht')).albums).toHaveLength(1);
  });

  it('drops tokens that belong to another developer app', async () => {
    await link();
    await spotify.stop();
    spotify = create({ clientId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    spotify.start();
    expect(env.state.getMusic().spotify?.linked).toBe(false);
  });
});

describe('searching and browsing', () => {
  beforeEach(async () => {
    await link();
  });

  it('searches within the limit new apps are allowed and skips empty entries', async () => {
    const result = await spotify.search('  fr  ');
    const request = sim.requests.find((entry) => entry.path === '/v1/search');
    expect(request?.query).toMatchObject({ q: 'fr', limit: '10', market: 'DE', type: 'track,album,playlist,artist' });
    // "Frühstück" plus "Abendessen mit Freunden" — with a `null` between them in Spotify's answer.
    expect(result.playlists.map((item) => item.title)).toEqual(['Frühstück', 'Abendessen mit Freunden']);
    expect(result.playlists[0]).toMatchObject({ id: `spotify:playlist:${simId('playlist', 'Frühstück')}`, type: 'playlist', browsable: true, playable: true, source: 'spotify', subtitle: 'Familie Demo' });
  });

  it('maps tracks, albums and artists', async () => {
    const result = await spotify.search('Sonnendeck');
    expect(result.artists).toEqual([expect.objectContaining({ type: 'artist', title: 'Sonnendeck', playable: false, browsable: true })]);
    expect(result.albums.map((item) => item.title).sort()).toEqual(['Auf Kurs', 'Südwärts']);
    const track = result.tracks.find((item) => item.title === 'Leinen los');
    expect(track).toMatchObject({ type: 'track', subtitle: 'Sonnendeck', duration: 196, playable: true, browsable: false });
    expect(track?.id).toMatch(/^spotify:track:[A-Za-z0-9]{22}$/);
    // Pictures are only ever handed out as signed addresses of the hub itself.
    expect(track?.artUrl).toMatch(/^\/api\/img\?u=/);
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
  });

  it('answers an empty query without asking Spotify', async () => {
    const before = sim.requests.length;
    expect(await spotify.search('   ')).toEqual({ tracks: [], albums: [], playlists: [], artists: [] });
    expect(sim.requests.length).toBe(before);
  });

  it('offers the library sections', async () => {
    const home = await spotify.browse('home', null);
    expect(home.items.map((item) => [item.id, item.title, item.type])).toEqual([
      ['playlists', 'Playlists', 'folder'],
      ['tracks', 'Lieblingssongs', 'folder'],
      ['albums', 'Alben', 'folder'],
      ['recent', 'Zuletzt gehört', 'folder'],
      ['top', 'Meine Top-Titel', 'folder'],
      ['shows', 'Podcasts', 'folder'],
    ]);
    expect(home.items.every((item) => item.browsable && !item.playable)).toBe(true);
  });

  it('lists playlists, saved albums and podcasts', async () => {
    expect((await spotify.browse('playlists', null)).items.map((item) => item.title)).toEqual(playlists.map((playlist) => playlist.name));
    const albums = await spotify.browse('albums', null);
    expect(albums.items.map((item) => item.title)).toEqual(['Kleine Fluchten', 'Polarnacht', 'Auf Kurs', 'Alle einsteigen!']);
    expect(albums.items[0]).toMatchObject({ type: 'album', subtitle: 'Mara Lindqvist', browsable: true, playable: true });
    const podcasts = await spotify.browse('shows', null);
    expect(podcasts.items).toEqual([expect.objectContaining({ type: 'show', title: shows[0]!.name, subtitle: 'Studio Dachgeschoss' })]);
  });

  it('opens an own playlist through the items endpoint', async () => {
    const id = simId('playlist', 'Frühstück');
    const page = await spotify.browse(`spotify:playlist:${id}`, null);
    expect(page.title).toBe('Frühstück');
    expect(page.subtitle).toBe('Sanft in den Tag');
    expect(page.self).toMatchObject({ id: `spotify:playlist:${id}`, playable: true });
    expect(page.items.map((item) => item.title)).toEqual(['Montagmorgen', 'Erstes Licht', 'Melange', 'Leinen los', 'Fensterplatz', 'Zuckerwürfel', 'Blaue Stunde', 'Heimweg']);
    expect(page.next).toBeNull();
    expect(sim.requests.some((entry) => entry.path === `/v1/playlists/${id}/items`)).toBe(true);
    expect(sim.requests.some((entry) => entry.path.endsWith('/tracks') && entry.path.startsWith('/v1/playlists/'))).toBe(false);
  });

  it('still offers a playlist of someone else, without its track list', async () => {
    const id = simId('playlist', 'Küstenradio Mix');
    const page = await spotify.browse(`spotify:playlist:${id}`, null);
    expect(page.title).toBe('Küstenradio Mix');
    expect(page.items).toEqual([]);
    expect(page.subtitle).toMatch(/abspielen kannst du sie trotzdem/);
    expect(page.self).toMatchObject({ id: `spotify:playlist:${id}`, playable: true });
  });

  it('opens albums, artists and podcasts', async () => {
    const albumId = simId('album', 'Polarnacht');
    const album = await spotify.browse(`spotify:album:${albumId}`, null);
    expect(album).toMatchObject({ title: 'Polarnacht', subtitle: 'Nordlicht Ensemble · 2023' });
    expect(album.items).toHaveLength(7);
    // Tracks inside an album carry no picture of their own: they get the album's.
    expect(album.items[0]).toMatchObject({ title: 'Erstes Licht', subtitle: 'Nordlicht Ensemble', duration: 214 });
    expect(album.items[0]?.artUrl).toBe(album.artUrl);

    const artist = await spotify.browse(`spotify:artist:${simId('artist', 'Sonnendeck')}`, null);
    expect(artist.title).toBe('Sonnendeck');
    expect(artist.self).toBeNull();
    expect(artist.items.map((item) => item.title).sort()).toEqual(['Auf Kurs', 'Südwärts']);
    expect(sim.requests.find((entry) => entry.path.endsWith('/albums') && entry.path.startsWith('/v1/artists/'))?.query.limit).toBe('10');

    const show = await spotify.browse(`spotify:show:${shows[0]!.id}`, null);
    expect(show.self).toMatchObject({ type: 'show', playable: true });
    expect(show.items[0]).toMatchObject({ type: 'episode', title: 'Folge 12: Jalousien, die mitdenken', subtitle: '28.10.2026', duration: 1840 });
  });

  it('lists liked songs, top tracks and the recent history without repeats', async () => {
    const liked = await spotify.browse('tracks', null);
    expect(liked.self).toMatchObject({ id: 'spotify:collection', playable: true });
    expect(liked.items).toHaveLength(12);
    expect(liked.subtitle).toBe('12 Titel');
    const top = await spotify.browse('top', null);
    expect(top.self?.id).toBe('spotify:top');
    expect(top.items[0]?.title).toBe('Kleine Fluchten');
    const recent = await spotify.browse('recent', null);
    expect(recent.items.map((item) => item.title)).toEqual(['Blaue Stunde', 'Montagmorgen', 'Der kleine Bagger', 'Sperrstunde', 'Fjordwind', 'Zitronenhain']);
  });

  it('expands the containers a speaker cannot queue as one', async () => {
    const liked = await spotify.resolveTracks('spotify:collection');
    expect(liked).toHaveLength(12);
    expect(liked[0]).toEqual({ uri: expect.stringMatching(/^spotify:track:/), title: 'Kleine Fluchten' });
    expect(await spotify.resolveTracks('spotify:top')).toHaveLength(8);
    expect((await failure(spotify.resolveTracks(`spotify:album:${simId('album', 'Polarnacht')}`))).statusCode).toBe(400);
  });

  it('rejects ids and cursors it does not know before they reach a URL', async () => {
    const before = sim.requests.length;
    for (const id of ['nonsense', 'spotify:playlist:../../me', 'spotify:track:0123456789abcdef', 'spotify:album:short', 'spotify:playlist:']) {
      expect((await failure(spotify.browse(id, null))).statusCode).toBe(404);
    }
    expect((await failure(spotify.browse('playlists', '-1'))).statusCode).toBe(400);
    expect((await failure(spotify.browse('playlists', '5; drop'))).statusCode).toBe(400);
    expect(sim.requests.length).toBe(before);
  });

  it('reports something that no longer exists', async () => {
    expect((await failure(spotify.browse('spotify:album:0000000000000000000000', null))).statusCode).toBe(404);
  });

  it('does not ask twice for what it has just fetched', async () => {
    await spotify.browse('playlists', null);
    const before = sim.requests.length;
    await spotify.browse('playlists', null);
    expect(sim.requests.length).toBe(before);
  });
});

describe('tokens and trouble', () => {
  beforeEach(async () => {
    await link();
  });

  it('renews an expired access token without anyone noticing, and keeps the rotated refresh token', async () => {
    sim.expireAccessTokens();
    expect((await spotify.search('Kaimauer')).albums).toHaveLength(1);
    expect(sim.refreshCount()).toBe(1);
    // The simulator rotates refresh tokens: only the new one works after a restart.
    await spotify.stop();
    sim.expireAccessTokens();
    spotify = create();
    spotify.start();
    expect((await spotify.search('Melange')).tracks).toHaveLength(1);
    expect(env.state.getMusic().spotify?.linked).toBe(true);
  });

  it('refreshes once even when several requests find the token expired', async () => {
    sim.expireAccessTokens();
    const before = sim.refreshCount();
    const results = await Promise.all([spotify.search('Polarnacht'), spotify.browse('playlists', null), spotify.browse('albums', null), spotify.browse('top', null)]);
    expect(results).toHaveLength(4);
    expect(sim.refreshCount() - before).toBe(1);
  });

  it('asks to link again when the authorisation is gone, without retrying', async () => {
    sim.expireAccessTokens();
    sim.revokeRefreshTokens();
    const err = await failure(spotify.search('Polarnacht'));
    expect(err.message).toMatch(/abgelaufen/);
    expect(env.state.getMusic().spotify).toEqual({ linked: false, account: null });
    const health = env.state.allServices().find((service) => service.id === 'spotify');
    expect(health).toMatchObject({ status: 'degraded', message: expect.stringMatching(/neu verbinden/) });
    const tokenRequests = sim.requests.filter((entry) => entry.path === '/api/token').length;
    expect((await failure(spotify.search('Polarnacht'))).code).toBe('not_linked');
    expect(sim.requests.filter((entry) => entry.path === '/api/token').length).toBe(tokenRequests);
    expect(env.deps.settings.getInternal('spotify.tokens')).toBeNull();
  });

  it('passes on how long Spotify wants us to wait', async () => {
    sim.failNext(429, 7);
    const err = await failure(spotify.search('Polarnacht'));
    expect(err).toMatchObject({ statusCode: 429, code: 'rate_limited', retryAfter: 7 });
    expect(err.message).toContain('7 Sekunden');
    // The failed answer is not cached: the next attempt works.
    expect((await spotify.search('Polarnacht')).albums).toHaveLength(1);
  });

  it('goes offline only after repeated failures and recovers by itself', async () => {
    const status = () => env.state.allServices().find((service) => service.id === 'spotify')?.status;
    sim.failNext(500);
    await failure(spotify.search('a1'));
    expect(status()).toBe('ok');
    sim.failNext(503);
    await failure(spotify.search('a2'));
    expect(status()).toBe('offline');
    await spotify.search('Polarnacht');
    expect(status()).toBe('ok');
  });

  it('reports an unreachable Spotify as such', async () => {
    await spotify.stop();
    await sim.close();
    spotify = create();
    spotify.start();
    const err = await failure(spotify.search('Polarnacht'));
    expect(err.statusCode).toBe(502);
    expect(err.message).toMatch(/nicht erreichbar/);
    // Still linked: a network problem is no reason to throw the authorisation away.
    expect(env.state.getMusic().spotify?.linked).toBe(true);
    sim = await startSpotifySim();
  });

  it('never writes tokens, codes or verifiers to the log, the diagnostics or the database in clear', async () => {
    sim.expireAccessTokens();
    await spotify.search('Polarnacht');
    const stored = env.deps.settings.getInternal<{ accessToken: string; refreshToken: string }>('spotify.tokens')!;
    expect(stored.accessToken.length).toBeGreaterThan(20);
    const haystack = [...env.logs, JSON.stringify(spotify.diagnostics())].join('\n');
    expect(haystack).not.toContain(stored.accessToken);
    expect(haystack).not.toContain(stored.refreshToken);
    const rows = env.deps.db.all<{ value: string }>('SELECT value FROM settings');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.value).not.toContain(stored.accessToken);
      expect(row.value).not.toContain(stored.refreshToken);
    }
    expect(spotify.diagnostics()).toMatchObject({ linked: true, account: 'Familie Demo', pendingAuthorizations: 0 });
  });
});

describe('connection test', () => {
  it('checks the shape of the client id and says what to do next', async () => {
    expect(await SpotifyIntegration.test({ enabled: true, clientId: '', clientSecret: '', market: 'DE' })).toMatchObject({ ok: false, message: 'Die Client-ID fehlt.' });
    expect((await SpotifyIntegration.test({ enabled: true, clientId: 'abc', clientSecret: '', market: 'DE' })).ok).toBe(false);
    const fine = await SpotifyIntegration.test({ enabled: true, clientId: sim.clientId, clientSecret: '', market: 'DE' });
    expect(fine.ok).toBe(true);
    expect(fine.details.join(' ')).toMatch(/Mit Spotify verbinden/);
    expect(fine.details.join(' ')).toMatch(/Premium/);
  });

  it('verifies a client secret with Spotify when one is given', async () => {
    await sim.close();
    sim = await startSpotifySim({ clientSecret: 'correct-secret' });
    const endpoints = { apiBase: sim.apiBase, accountsBase: sim.accountsBase };
    expect((await SpotifyIntegration.test({ enabled: true, clientId: sim.clientId, clientSecret: 'correct-secret', market: 'DE' }, endpoints)).ok).toBe(true);
    const wrong = await SpotifyIntegration.test({ enabled: true, clientId: sim.clientId, clientSecret: 'wrong', market: 'DE' }, endpoints);
    expect(wrong.ok).toBe(false);
    expect(JSON.stringify(wrong)).not.toContain('wrong');
  });

  it('never throws, even without a network', async () => {
    const result = await SpotifyIntegration.test({ enabled: true, clientId: sim.clientId, clientSecret: 'x', market: 'DE' }, { accountsBase: 'http://127.0.0.1:1' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/nicht erreichbar/);
  });
});
