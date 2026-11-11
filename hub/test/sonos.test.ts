import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MusicGroup, MusicPlayer } from '@home-hub/shared';
import { HttpError } from '../src/http/errors.ts';
import { spotifyEnqueue } from '../src/integrations/sonos/didl.ts';
import { SonosIntegration, type SonosOptions, type SonosTiming } from '../src/integrations/sonos/sonos.ts';
import { parseTime } from '../src/integrations/sonos/soap.ts';
import { albums, likedTrackIds, playlists, shows, simId, tracks } from '../src/sim/catalog.ts';
import { startSonosSim, type SonosSim, type SonosSimOptions } from '../src/sim/sonos-sim.ts';
import { createTestDeps, waitFor, type TestDeps } from './deps.ts';

const FAST: Partial<SonosTiming> = { activeMs: 60, idleMs: 60, topologyActiveMs: 150, topologyIdleMs: 150, settingsMs: 100, requestTimeoutMs: 1500, discoveryRetryMs: 200, favoritesCacheMs: 200 };

let env: TestDeps;
let sim: SonosSim;
let sonos: SonosIntegration | null = null;

async function start(simOptions: SonosSimOptions = {}, options: SonosOptions = {}, region: 'EU' | 'US' = 'EU'): Promise<SonosIntegration> {
  sim = await startSonosSim(simOptions);
  sonos = new SonosIntegration(env.deps, { enabled: true, hosts: [sim.seedHosts[Math.min(2, sim.seedHosts.length - 1)]!], spotifyRegion: region }, { timing: FAST, ...options });
  sonos.start();
  sonos.setActive(true);
  await waitFor(() => env.state.getMusic().players.length === sim.players.length && env.state.getMusic().players.every((player) => player.model !== null), 5000, 'players');
  return sonos;
}

const music = () => env.state.getMusic();
const player = (room: string): MusicPlayer => music().players.find((entry) => entry.name === room)!;
const groupOf = (room: string): MusicGroup => music().groups.find((entry) => entry.memberIds.includes(sim.uuid(room)))!;
const health = () => env.state.allServices().find((service) => service.id === 'sonos');
const sent = (action: string) => sim.actions.filter((entry) => entry.action === action);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function failure(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error('expected the call to fail');
}

beforeEach(() => {
  env = createTestDeps();
});

afterEach(async () => {
  await sonos?.stop();
  sonos = null;
  await sim?.close();
  env.cleanup();
});

describe('the household', () => {
  it('finds every room from a single address and hides invisible members', async () => {
    await start();
    expect(music().players.map((entry) => entry.name)).toEqual(['Bad', 'Büro', 'Küche', 'Schlafzimmer', 'Terrasse', 'Wohnzimmer']);
    expect(player('Wohnzimmer')).toMatchObject({ id: sim.uuid('Wohnzimmer'), room: 'Wohnzimmer', model: 'Arc', volume: 28, muted: false, isCoordinator: true, available: true });
    expect(player('Küche')).toMatchObject({ model: 'One', groupId: sim.uuid('Wohnzimmer'), isCoordinator: false });
    // The simulated sub (Invisible="1") is neither a player nor a member.
    expect(JSON.stringify(music())).not.toContain('RINCON_SUB');
    expect(health()?.status).toBe('ok');
  });

  it('describes groups and what they play', async () => {
    await start();
    expect(music().groups).toHaveLength(5);
    const group = groupOf('Wohnzimmer');
    expect(group).toMatchObject({
      id: sim.uuid('Wohnzimmer'),
      coordinatorId: sim.uuid('Wohnzimmer'),
      memberIds: [sim.uuid('Wohnzimmer'), sim.uuid('Küche')],
      name: 'Wohnzimmer + 1',
      state: 'playing',
      volume: 25,
      muted: false,
      shuffle: false,
      repeat: 'off',
      canSkip: true,
      canSeek: true,
    });
    expect(group.track).toMatchObject({ title: 'Kleine Fluchten', artist: 'Mara Lindqvist', album: 'Kleine Fluchten', duration: 224, source: 'spotify' });
    expect(group.track?.uri).toMatch(/^x-sonos-spotify:spotify%3atrack%3a/);
    // The relative cover address of the player becomes a signed address of the hub.
    expect(group.track?.artUrl).toMatch(/^\/api\/img\?u=/);
    expect(group.position).toBeGreaterThanOrEqual(42);
    expect(groupOf('Bad')).toMatchObject({ name: 'Bad', state: 'stopped', track: null, position: null, canSkip: false, canSeek: false });
  });

  it('does not report every poll as news while a track simply plays on', async () => {
    await start();
    let publishes = 0;
    env.state.on('music', () => publishes++);
    await sleep(600);
    expect(publishes).toBeLessThanOrEqual(1);
    const group = groupOf('Wohnzimmer');
    // The position still predicts where the track is.
    const expected = group.position! + (Date.now() - group.positionAt) / 1000;
    expect(Math.abs(expected - sim.group('Wohnzimmer').positionSec)).toBeLessThan(2.5);
  });

  it('follows the queue to the next track', async () => {
    await start();
    sim.skipToEndOfTrack('Wohnzimmer');
    await waitFor(() => groupOf('Wohnzimmer').track?.title === 'Fensterplatz', 4000, 'next track');
    expect(groupOf('Wohnzimmer').position).toBeLessThan(5);
  });

  it('shows radio with station and current song, and offers neither skip nor seek', async () => {
    await start();
    sim.playRadio('Bad');
    await waitFor(() => groupOf('Bad').state === 'playing', 3000, 'radio playing');
    expect(groupOf('Bad')).toMatchObject({ canSkip: false, canSeek: false });
    expect(groupOf('Bad').track).toMatchObject({ title: 'Hafenkante - Nebelhorn', artist: 'Radio Küste', album: null, duration: null, source: 'radio' });
    sim.playRadio('Büro', 'Klassik am Morgen');
    await waitFor(() => groupOf('Büro').track?.title === 'Klassik am Morgen', 3000, 'station without song info');
    expect(groupOf('Büro').track?.artist).toBeNull();
  });

  it('understands the topology of old firmware', async () => {
    await start({ legacyTopology: true });
    expect(music().players).toHaveLength(6);
    expect(groupOf('Wohnzimmer').memberIds).toHaveLength(2);
  });

  it('greys out a speaker that went away and notices when it is back', async () => {
    await start();
    await sim.setOffline('Terrasse', true);
    await waitFor(() => player('Terrasse').available === false, 5000, 'unavailable');
    expect(health()).toMatchObject({ status: 'degraded', message: 'Nicht erreichbar: Terrasse' });
    expect(player('Bad').available).toBe(true);
    expect((await failure(sonos!.playerCommand(sim.uuid('Terrasse'), { action: 'set_volume', value: 10 }))).statusCode).toBe(503);
    await sim.setOffline('Terrasse', false);
    await waitFor(() => player('Terrasse').available === true, 5000, 'back');
    expect(health()?.status).toBe('ok');
  });

  it('reports the whole household as unreachable and recovers', async () => {
    await start({ rooms: [{ name: 'Küche', model: 'Sonos One' }], playing: false });
    await sim.setOffline('Küche', true);
    await waitFor(() => health()?.status === 'offline', 6000, 'offline');
    expect(player('Küche').available).toBe(false);
    await sim.setOffline('Küche', false);
    await waitFor(() => health()?.status === 'ok', 20_000, 'recovered');
    expect(player('Küche').available).toBe(true);
  }, 30_000);

  it('says what to do when no speaker can be found, and keeps looking', async () => {
    sim = await startSonosSim({ playing: false });
    let searches = 0;
    let found: string[] = [];
    sonos = new SonosIntegration(env.deps, { enabled: true, hosts: [], spotifyRegion: 'EU' }, { timing: FAST, discover: async () => (searches++, found) });
    sonos.start();
    sonos.setActive(true);
    await waitFor(() => health()?.status === 'offline', 3000, 'offline');
    expect(health()?.message).toMatch(/Keine Sonos-Lautsprecher gefunden/);
    expect(music().players).toEqual([]);
    found = [sim.seedHosts[0]!];
    await waitFor(() => music().players.length === 6, 8000, 'found later');
    expect(health()?.status).toBe('ok');
    expect(searches).toBeGreaterThanOrEqual(2);
  }, 15_000);
});

describe('transport and volume', () => {
  it('pauses, resumes and toggles on the coordinator', async () => {
    const integration = await start();
    const id = sim.uuid('Wohnzimmer');
    await integration.groupCommand(id, { action: 'pause' });
    expect(sim.group('Wohnzimmer').state).toBe('PAUSED_PLAYBACK');
    expect(groupOf('Wohnzimmer').state).toBe('paused');
    await integration.groupCommand(id, { action: 'toggle' });
    expect(sim.group('Wohnzimmer').state).toBe('PLAYING');
    await integration.groupCommand(id, { action: 'toggle' });
    expect(sim.group('Wohnzimmer').state).toBe('PAUSED_PLAYBACK');
    await integration.groupCommand(id, { action: 'play' });
    expect(sim.group('Wohnzimmer').state).toBe('PLAYING');
    // Transport commands never go to a member.
    expect(sim.actions.filter((entry) => ['Play', 'Pause'].includes(entry.action)).every((entry) => entry.player === id)).toBe(true);
  });

  it('skips, goes back and seeks', async () => {
    const integration = await start();
    const id = sim.uuid('Wohnzimmer');
    await integration.groupCommand(id, { action: 'next' });
    expect(sim.group('Wohnzimmer').nowPlaying).toBe('Fensterplatz');
    await integration.groupCommand(id, { action: 'previous' });
    expect(sim.group('Wohnzimmer').nowPlaying).toBe('Kleine Fluchten');
    await integration.groupCommand(id, { action: 'seek', value: 125 });
    expect(sent('Seek').at(-1)?.args).toMatchObject({ Unit: 'REL_TIME', Target: '0:02:05' });
    expect(sim.group('Wohnzimmer').positionSec).toBeGreaterThanOrEqual(125);
    await waitFor(() => (groupOf('Wohnzimmer').position ?? 0) >= 125, 3000, 'position after seek');
  });

  it('explains what a player refuses', async () => {
    const integration = await start();
    const err = await failure(integration.groupCommand(sim.uuid('Bad'), { action: 'next' }));
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('Das geht bei der aktuellen Wiedergabe nicht.');
    expect((await failure(integration.groupCommand('RINCON_UNBEKANNT', { action: 'play' }))).statusCode).toBe(404);
    // A member is not a group.
    expect((await failure(integration.groupCommand(sim.uuid('Küche'), { action: 'play' }))).statusCode).toBe(404);
  });

  it('stops a radio stream when asked to pause it', async () => {
    const integration = await start();
    sim.playRadio('Bad');
    await waitFor(() => groupOf('Bad').state === 'playing', 3000, 'radio');
    await integration.groupCommand(sim.uuid('Bad'), { action: 'pause' });
    expect(sim.group('Bad').state).toBe('STOPPED');
  });

  it('changes the group volume without losing the balance between rooms', async () => {
    const integration = await start();
    await integration.groupCommand(sim.uuid('Wohnzimmer'), { action: 'set_volume', value: 35 });
    expect(sent('SnapshotGroupVolume')).toHaveLength(1);
    // Was 28 and 22 (average 25): both move up by 10.
    expect(sim.player('Wohnzimmer').volume).toBe(38);
    expect(sim.player('Küche').volume).toBe(32);
    expect(groupOf('Wohnzimmer').volume).toBe(35);
    await waitFor(() => player('Küche').volume === 32, 3000, 'member volume');
    // A room on its own is set directly.
    await integration.groupCommand(sim.uuid('Bad'), { action: 'set_volume', value: 250 });
    expect(sim.player('Bad').volume).toBe(100);
    expect(sent('SnapshotGroupVolume')).toHaveLength(1);
  });

  it('mutes a group and single rooms', async () => {
    const integration = await start();
    await integration.groupCommand(sim.uuid('Wohnzimmer'), { action: 'set_mute', value: true });
    expect(sim.player('Wohnzimmer').muted).toBe(true);
    expect(sim.player('Küche').muted).toBe(true);
    expect(groupOf('Wohnzimmer').muted).toBe(true);
    await integration.playerCommand(sim.uuid('Küche'), { action: 'set_mute', value: false });
    expect(sim.player('Küche').muted).toBe(false);
    expect(groupOf('Wohnzimmer').muted).toBe(false);
    await integration.playerCommand(sim.uuid('Küche'), { action: 'set_volume', value: 40 });
    expect(sim.player('Küche').volume).toBe(40);
    expect(player('Küche').volume).toBe(40);
    expect(groupOf('Wohnzimmer').volume).toBe(34);
  });

  it('switches shuffle and repeat independently', async () => {
    const integration = await start();
    const id = sim.uuid('Wohnzimmer');
    await integration.groupCommand(id, { action: 'set_shuffle', value: true });
    expect(sim.group('Wohnzimmer').playMode).toBe('SHUFFLE_NOREPEAT');
    await integration.groupCommand(id, { action: 'set_repeat', value: 'all' });
    expect(sim.group('Wohnzimmer').playMode).toBe('SHUFFLE');
    await integration.groupCommand(id, { action: 'set_shuffle', value: false });
    expect(sim.group('Wohnzimmer').playMode).toBe('REPEAT_ALL');
    await integration.groupCommand(id, { action: 'set_repeat', value: 'one' });
    expect(sim.group('Wohnzimmer').playMode).toBe('REPEAT_ONE');
    expect(groupOf('Wohnzimmer')).toMatchObject({ shuffle: false, repeat: 'one' });
    await sleep(300);
    expect(groupOf('Wohnzimmer')).toMatchObject({ shuffle: false, repeat: 'one' });
  });

  it('notices changes made in another app', async () => {
    await start();
    sim.setVolume('Büro', 77);
    await waitFor(() => player('Büro').volume === 77, 3000, 'volume from outside');
  });
});

describe('grouping', () => {
  it('lets a room join a group and leave it again', async () => {
    const integration = await start();
    await integration.playerCommand(sim.uuid('Bad'), { action: 'join', groupId: sim.uuid('Wohnzimmer') });
    expect(sent('SetAVTransportURI').at(-1)).toMatchObject({ player: sim.uuid('Bad'), args: { CurrentURI: `x-rincon:${sim.uuid('Wohnzimmer')}` } });
    await waitFor(() => groupOf('Wohnzimmer').memberIds.length === 3, 4000, 'joined');
    expect(groupOf('Wohnzimmer').name).toBe('Wohnzimmer + 2');
    expect(player('Bad')).toMatchObject({ groupId: sim.uuid('Wohnzimmer'), isCoordinator: false });
    expect(music().groups).toHaveLength(4);

    await integration.playerCommand(sim.uuid('Bad'), { action: 'leave' });
    await waitFor(() => music().groups.length === 5, 4000, 'left');
    expect(player('Bad')).toMatchObject({ groupId: sim.uuid('Bad'), isCoordinator: true });
  });

  it('keeps the music with the others when the coordinator leaves', async () => {
    const integration = await start();
    await integration.playerCommand(sim.uuid('Wohnzimmer'), { action: 'leave' });
    await waitFor(() => player('Küche').isCoordinator, 4000, 'new coordinator');
    expect(groupOf('Küche')).toMatchObject({ id: sim.uuid('Küche'), state: 'playing', name: 'Küche' });
    expect(groupOf('Wohnzimmer').state).toBe('stopped');
  });

  it('refuses to join something that is not a group', async () => {
    const integration = await start();
    expect((await failure(integration.playerCommand(sim.uuid('Bad'), { action: 'join', groupId: sim.uuid('Küche') }))).statusCode).toBe(404);
    expect((await failure(integration.playerCommand('RINCON_UNBEKANNT', { action: 'leave' }))).statusCode).toBe(404);
  });
});

describe('favourites', () => {
  it('lists what can be played and skips shortcuts', async () => {
    const integration = await start();
    const items = await integration.favorites();
    expect(items.map((item) => [item.title, item.type, item.subtitle])).toEqual([
      ['Frühstück', 'favorite', 'Spotify-Playlist'],
      ['Abendessen mit Freunden', 'favorite', 'Spotify-Playlist'],
      ['Auf Kurs', 'favorite', 'Spotify-Album'],
      ['Radio Küste', 'radio', 'Radiosender'],
      ['Klassik am Morgen', 'radio', 'Radiosender'],
    ]);
    for (const item of items) {
      expect(item).toMatchObject({ playable: true, browsable: false, source: 'sonos' });
      expect(item.id).toMatch(/^sonos:fav:[0-9a-f]{16}$/);
      expect(item.artUrl).toMatch(/^\/api\/img\?u=/);
    }
    // Ids stay the same from call to call (they are what the app sends back to play).
    expect((await integration.favorites()).map((item) => item.id)).toEqual(items.map((item) => item.id));
  });

  it('starts a radio station directly, without touching the queue', async () => {
    const integration = await start();
    const radio = (await integration.favorites()).find((item) => item.title === 'Radio Küste')!;
    const queueBefore = sim.group('Bad').queue;
    await integration.play(sim.uuid('Bad'), { kind: 'favorite', favoriteId: radio.id, mode: 'now' });
    expect(sim.group('Bad')).toMatchObject({ state: 'PLAYING', nowPlaying: 'Radio Küste', queue: queueBefore });
    expect(sent('SetAVTransportURI').at(-1)?.args.CurrentURIMetaData).toContain('Radio Küste');
    expect(sent('AddURIToQueue')).toHaveLength(0);
  });

  it('plays a playlist favourite with the favourite\'s own metadata', async () => {
    const integration = await start({ spotifyRegion: 'US' });
    const favourite = (await integration.favorites()).find((item) => item.title === 'Frühstück')!;
    await integration.play(sim.uuid('Büro'), { kind: 'favorite', favoriteId: favourite.id, mode: 'now' });
    // The household is "US" while the hub is set to "EU": the favourite's own token makes it work at the first attempt.
    expect(sent('AddURIToQueue')).toHaveLength(1);
    expect(sim.group('Büro')).toMatchObject({ state: 'PLAYING', nowPlaying: 'Montagmorgen' });
    expect(sim.group('Büro').queue).toHaveLength(8);
    expect((await failure(integration.play(sim.uuid('Büro'), { kind: 'favorite', favoriteId: 'sonos:fav:0000000000000000', mode: 'now' }))).statusCode).toBe(404);
  });
});

describe('playing from Spotify', () => {
  const album = albums[0]!;
  const albumUri = `spotify:album:${album.id}`;

  it('replaces the queue with an album and starts it', async () => {
    const integration = await start();
    const id = sim.uuid('Wohnzimmer');
    sim.actions.length = 0;
    await integration.play(id, { kind: 'spotify', uri: albumUri, title: 'Polarnacht', mode: 'now' });
    const steps = sim.actions.filter((entry) => entry.player === id && ['RemoveAllTracksFromQueue', 'AddURIToQueue', 'SetAVTransportURI', 'Seek', 'Play'].includes(entry.action));
    expect(steps.map((entry) => entry.action)).toEqual(['RemoveAllTracksFromQueue', 'AddURIToQueue', 'SetAVTransportURI', 'Play']);
    expect(steps[1]!.args).toMatchObject({
      EnqueuedURI: `x-rincon-cpcontainer:1004206cspotify%3aalbum%3a${album.id}`,
      DesiredFirstTrackNumberEnqueued: '0',
      EnqueueAsNext: '0',
    });
    const metadata = steps[1]!.args.EnqueuedURIMetaData!;
    expect(metadata).toContain(`<item id="00040000spotify%3aalbum%3a${album.id}" parentID="-1" restricted="true">`);
    expect(metadata).toContain('<upnp:class>object.container.album.musicAlbum</upnp:class>');
    expect(metadata).toContain('SA_RINCON2311_X_#Svc2311-0-Token');
    expect(steps[2]!.args.CurrentURI).toBe(`x-rincon-queue:${id}#0`);
    expect(sim.group('Wohnzimmer')).toMatchObject({ state: 'PLAYING', nowPlaying: 'Erstes Licht', trackIndex: 0 });
    expect(sim.group('Wohnzimmer').queue).toHaveLength(7);
    await waitFor(() => groupOf('Wohnzimmer').track?.title === 'Erstes Licht', 3000, 'state follows');
  });

  it('starts an album or playlist at the chosen track', async () => {
    const integration = await start();
    await integration.play(sim.uuid('Bad'), { kind: 'spotify', uri: albumUri, title: 'Polarnacht', mode: 'now', startIndex: 3 });
    expect(sent('Seek').at(-1)?.args).toMatchObject({ Unit: 'TRACK_NR', Target: '4' });
    expect(sim.group('Bad')).toMatchObject({ state: 'PLAYING', nowPlaying: 'Nachtzug nach Norden', trackIndex: 3 });
    const playlist = playlists[0]!;
    await integration.play(sim.uuid('Büro'), { kind: 'spotify', uri: `spotify:playlist:${playlist.id}`, title: playlist.name, mode: 'now', startIndex: 1 });
    expect(sent('AddURIToQueue').at(-1)?.args.EnqueuedURI).toBe(`x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a${playlist.id}`);
    expect(sim.group('Büro').nowPlaying).toBe('Erstes Licht');
  });

  it('plays single tracks, podcasts and episodes', async () => {
    const integration = await start();
    const track = tracks[10]!;
    await integration.play(sim.uuid('Bad'), { kind: 'spotify', uri: `spotify:track:${track.id}`, title: track.name, mode: 'now' });
    expect(sent('AddURIToQueue').at(-1)?.args).toMatchObject({ EnqueuedURI: `spotify%3atrack%3a${track.id}` });
    expect(sent('AddURIToQueue').at(-1)?.args.EnqueuedURIMetaData).toContain(`<item id="00032020spotify%3atrack%3a${track.id}"`);
    expect(sim.group('Bad').nowPlaying).toBe(track.name);
    const show = shows[0]!;
    await integration.play(sim.uuid('Bad'), { kind: 'spotify', uri: `spotify:show:${show.id}`, title: show.name, mode: 'now' });
    expect(sim.group('Bad').queue).toHaveLength(3);
    await integration.play(sim.uuid('Bad'), { kind: 'spotify', uri: `spotify:episode:${show.episodes[1]!.id}`, title: 'x', mode: 'now' });
    expect(sim.group('Bad').nowPlaying).toBe(show.episodes[1]!.name);
  });

  it('queues after the current track or at the end without interrupting', async () => {
    const integration = await start();
    const id = sim.uuid('Wohnzimmer');
    const before = sim.group('Wohnzimmer');
    const track = tracks[20]!;
    await integration.play(id, { kind: 'spotify', uri: `spotify:track:${track.id}`, title: track.name, mode: 'next' });
    expect(sent('AddURIToQueue').at(-1)?.args.EnqueueAsNext).toBe('1');
    let after = sim.group('Wohnzimmer');
    expect(after.nowPlaying).toBe(before.nowPlaying);
    expect(after.queue[before.trackIndex + 1]).toBe(track.name);
    await integration.play(id, { kind: 'spotify', uri: albumUri, title: 'Polarnacht', mode: 'queue' });
    after = sim.group('Wohnzimmer');
    expect(after.queue).toHaveLength(before.queue.length + 1 + 7);
    expect(after.queue.at(-1)).toBe('Heimweg');
    expect(after.state).toBe('PLAYING');
    expect(sent('RemoveAllTracksFromQueue')).toHaveLength(0);
  });

  it('finds out by itself which Spotify region the household uses, and remembers it', async () => {
    const integration = await start({ spotifyRegion: 'US' });
    await integration.play(sim.uuid('Bad'), { kind: 'spotify', uri: albumUri, title: 'Polarnacht', mode: 'now' });
    const attempts = sent('AddURIToQueue');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.args.EnqueuedURIMetaData).toContain('SA_RINCON2311_X_');
    expect(attempts[1]!.args.EnqueuedURIMetaData).toContain('SA_RINCON3079_X_');
    expect(sim.group('Bad').state).toBe('PLAYING');
    await integration.play(sim.uuid('Bad'), { kind: 'spotify', uri: albumUri, title: 'Polarnacht', mode: 'queue' });
    expect(sent('AddURIToQueue')).toHaveLength(3);
    expect((integration.diagnostics() as { spotifyRegion: string }).spotifyRegion).toBe('US');
  });

  it('explains what to check when the speakers cannot load Spotify content', async () => {
    const integration = await start({ spotifyLinked: false });
    const err = await failure(integration.play(sim.uuid('Bad'), { kind: 'spotify', uri: albumUri, title: 'Polarnacht', mode: 'now' }));
    expect(err.statusCode).toBe(502);
    expect(err.message).toMatch(/Ist Spotify in der Sonos-App verbunden/);
    expect((await failure(integration.play(sim.uuid('Bad'), { kind: 'spotify', uri: 'spotify:artist:0123456789abcdefghijkl', title: '', mode: 'now' }))).statusCode).toBe(400);
  });

  it('starts a long list at once and adds the rest in batches', async () => {
    const integration = await start();
    const list = tracks.slice(0, 36).map((track) => ({ uri: `spotify:track:${track.id}`, title: track.name }));
    await integration.play(sim.uuid('Büro'), { kind: 'spotify_tracks', tracks: list, mode: 'now' });
    // Music is on with the first track …
    expect(sim.group('Büro')).toMatchObject({ state: 'PLAYING', nowPlaying: tracks[0]!.name });
    // … and the other 35 follow in batches of at most 16.
    await waitFor(() => sim.group('Büro').queue.length === 36, 4000, 'rest of the list');
    expect(sent('AddMultipleURIsToQueue').map((entry) => entry.args.NumberOfURIs)).toEqual(['16', '16', '3']);
    expect(sim.group('Büro').queue).toEqual(list.map((track) => track.title));
  });

  it('plays the liked songs in order', async () => {
    const integration = await start();
    const liked = likedTrackIds.map((id) => ({ uri: `spotify:track:${id}`, title: tracks.find((track) => track.id === id)!.name }));
    await integration.play(sim.uuid('Bad'), { kind: 'spotify_tracks', tracks: liked, mode: 'now' });
    await waitFor(() => sim.group('Bad').queue.length === liked.length, 4000, 'liked songs');
    expect(sim.group('Bad').queue).toEqual(liked.map((track) => track.title));
    expect((await failure(integration.play(sim.uuid('Bad'), { kind: 'spotify_tracks', tracks: [], mode: 'now' }))).statusCode).toBe(400);
  });
});

describe('helpers', () => {
  it('builds the enqueue data exactly as the reference client does', () => {
    const id = simId('playlist', 'Frühstück');
    expect(spotifyEnqueue(`spotify:playlist:${id}`, 'Früh & <munter>', 'US')).toEqual({
      uri: `x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a${id}`,
      metadata:
        '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
        `<item id="1006206cspotify%3aplaylist%3a${id}" parentID="-1" restricted="true"><dc:title>Früh &amp; &lt;munter&gt;</dc:title><upnp:class>object.container.playlistContainer</upnp:class>` +
        '<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON3079_X_#Svc3079-0-Token</desc></item></DIDL-Lite>',
    });
    expect(spotifyEnqueue('spotify:artist:0123456789abcdefghijkl', '', 'EU')).toBeNull();
    expect(spotifyEnqueue('spotify:track:../../etc', '', 'EU')).toBeNull();
  });

  it('reads the time format of the players', () => {
    expect(parseTime('0:03:44')).toBe(224);
    expect(parseTime('1:00:05')).toBe(3605);
    expect(parseTime('NOT_IMPLEMENTED')).toBeNull();
    expect(parseTime(undefined)).toBeNull();
  });
});

describe('connection test', () => {
  it('lists the rooms it found', async () => {
    sim = await startSonosSim();
    const result = await SonosIntegration.test({ enabled: true, hosts: [sim.seedHosts[4]!], spotifyRegion: 'EU' });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^6 Lautsprecher gefunden: /);
    expect(result.details).toContain('Küche · One · 127.0.0.1');
    expect(result.details.join('\n')).not.toContain('RINCON_SUB');
  });

  it('uses discovery when no address is entered', async () => {
    sim = await startSonosSim({ rooms: [{ name: 'Bad', model: 'Sonos Roam' }] });
    const found = await SonosIntegration.test({ enabled: true, hosts: [], spotifyRegion: 'EU' }, { discover: async () => [sim.seedHosts[0]!] });
    expect(found).toMatchObject({ ok: true, message: '1 Lautsprecher gefunden: Bad.' });
    const nothing = await SonosIntegration.test({ enabled: true, hosts: [], spotifyRegion: 'EU' }, { discover: async () => [] });
    expect(nothing.ok).toBe(false);
    expect(nothing.details.join(' ')).toMatch(/UPnP/);
  });

  it('never throws when nothing answers', async () => {
    sim = await startSonosSim({ rooms: [{ name: 'Bad', model: 'Sonos Roam' }] });
    const seed = sim.seedHosts[0]!;
    await sim.close();
    const result = await SonosIntegration.test({ enabled: true, hosts: [seed], spotifyRegion: 'EU' }, { timing: { requestTimeoutMs: 800 } });
    expect(result).toMatchObject({ ok: false, message: 'Unter dieser Adresse antwortet kein Sonos-Lautsprecher.' });
  });
});
