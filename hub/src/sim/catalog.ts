import { createHash } from 'node:crypto';

/**
 * A small invented music catalogue shared by the Sonos and Spotify
 * simulators, so that what you browse in "Spotify" is what "Sonos" then plays.
 * All names are fictitious.
 */

export interface SimArtist {
  id: string;
  name: string;
}

export interface SimTrack {
  id: string;
  name: string;
  artistIds: string[];
  albumId: string;
  durationMs: number;
  trackNumber: number;
}

export interface SimAlbum {
  id: string;
  name: string;
  artistIds: string[];
  trackIds: string[];
  year: number;
}

export interface SimPlaylist {
  id: string;
  name: string;
  description: string;
  /** `me` = owned by the signed-in user; anything else is a followed playlist whose track list Spotify does not expose. */
  owner: string;
  trackIds: string[];
}

export interface SimShow {
  id: string;
  name: string;
  publisher: string;
  episodes: { id: string; name: string; durationMs: number; releaseDate: string }[];
}

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Deterministic 22-character id in the style of Spotify's base62 ids. */
export function simId(kind: string, name: string): string {
  const digest = createHash('sha256').update(`${kind}:${name}`).digest();
  let id = '';
  for (let i = 0; i < 22; i++) id += BASE62[digest[i]! % 62];
  return id;
}

const ARTISTS = ['Nordlicht Ensemble', 'Mara Lindqvist', 'Die Dachbodenband', 'Kaffeehaus Trio', 'Sonnendeck', 'Lena & die Lokomotive', 'Hafenkante'] as const;

const ALBUMS: { name: string; artist: (typeof ARTISTS)[number]; year: number; tracks: [string, number][] }[] = [
  {
    name: 'Polarnacht',
    artist: 'Nordlicht Ensemble',
    year: 2023,
    tracks: [['Erstes Licht', 214], ['Fjordwind', 187], ['Schneefeld', 241], ['Nachtzug nach Norden', 263], ['Polarnacht', 305], ['Tauwetter', 198], ['Heimweg', 176]],
  },
  {
    name: 'Kleine Fluchten',
    artist: 'Mara Lindqvist',
    year: 2024,
    tracks: [['Montagmorgen', 201], ['Kleine Fluchten', 224], ['Fensterplatz', 189], ['Zwischen den Jahren', 247], ['Leuchtturm', 233], ['Bleib noch', 208], ['Sommer in der Stadt', 195], ['Letzte Bahn', 219]],
  },
  {
    name: 'Staub und Gold',
    artist: 'Die Dachbodenband',
    year: 2021,
    tracks: [['Kartons', 172], ['Staub und Gold', 226], ['Alte Briefe', 204], ['Treppenhaus', 183], ['Regen auf dem Dach', 251], ['Flohmarkt', 167]],
  },
  {
    name: 'Zweiter Aufguss',
    artist: 'Kaffeehaus Trio',
    year: 2022,
    tracks: [['Melange', 268], ['Zweiter Aufguss', 312], ['Zuckerwürfel', 244], ['Stammtisch', 289], ['Sperrstunde', 334], ['Kleiner Brauner', 221]],
  },
  {
    name: 'Auf Kurs',
    artist: 'Sonnendeck',
    year: 2025,
    tracks: [['Leinen los', 196], ['Auf Kurs', 203], ['Blaue Stunde', 228], ['Rückenwind', 185], ['Hafenlichter', 239], ['Ankern', 210], ['Morgen wieder', 192]],
  },
  {
    name: 'Alle einsteigen!',
    artist: 'Lena & die Lokomotive',
    year: 2024,
    tracks: [['Alle einsteigen!', 148], ['Der kleine Bagger', 132], ['Pfützenspringen', 141], ['Gute Nacht, Mond', 187], ['Zähneputz-Lied', 96], ['Tanz der Tiere', 155], ['Wackelzahn', 124], ['Schlaf gut', 201]],
  },
  {
    name: 'Kaimauer',
    artist: 'Hafenkante',
    year: 2020,
    tracks: [['Kaimauer', 232], ['Nebelhorn', 218], ['Containerblues', 276], ['Fischmarkt um fünf', 193], ['Sturmflut', 254], ['Landgang', 207]],
  },
  {
    name: 'Südwärts',
    artist: 'Sonnendeck',
    year: 2023,
    tracks: [['Südwärts', 211], ['Zitronenhain', 198], ['Mittagshitze', 224], ['Siesta', 242], ['Abendbrise', 189]],
  },
];

export const artists: SimArtist[] = ARTISTS.map((name) => ({ id: simId('artist', name), name }));
const artistId = (name: string): string => artists.find((a) => a.name === name)!.id;

export const albums: SimAlbum[] = [];
export const tracks: SimTrack[] = [];

for (const album of ALBUMS) {
  const albumId = simId('album', album.name);
  const trackIds: string[] = [];
  album.tracks.forEach(([name, seconds], index) => {
    const id = simId('track', `${album.name}/${name}`);
    trackIds.push(id);
    tracks.push({ id, name, artistIds: [artistId(album.artist)], albumId, durationMs: seconds * 1000, trackNumber: index + 1 });
  });
  albums.push({ id: albumId, name: album.name, artistIds: [artistId(album.artist)], trackIds, year: album.year });
}

const trackByName = (name: string): string => tracks.find((t) => t.name === name)!.id;
const albumTracks = (name: string): string[] => albums.find((a) => a.name === name)!.trackIds;

export const playlists: SimPlaylist[] = [
  {
    id: simId('playlist', 'Frühstück'),
    name: 'Frühstück',
    description: 'Sanft in den Tag',
    owner: 'me',
    trackIds: ['Montagmorgen', 'Erstes Licht', 'Melange', 'Leinen los', 'Fensterplatz', 'Zuckerwürfel', 'Blaue Stunde', 'Heimweg'].map(trackByName),
  },
  {
    id: simId('playlist', 'Abendessen mit Freunden'),
    name: 'Abendessen mit Freunden',
    description: 'Unaufgeregt und warm',
    owner: 'me',
    trackIds: ['Zweiter Aufguss', 'Staub und Gold', 'Hafenlichter', 'Stammtisch', 'Leuchtturm', 'Abendbrise', 'Sperrstunde', 'Alte Briefe', 'Siesta'].map(trackByName),
  },
  {
    id: simId('playlist', 'Kinderdisco'),
    name: 'Kinderdisco',
    description: 'Zum Toben',
    owner: 'me',
    trackIds: albumTracks('Alle einsteigen!').slice(0, 7),
  },
  {
    id: simId('playlist', 'Fokus'),
    name: 'Fokus',
    description: 'Konzentriert arbeiten',
    owner: 'me',
    trackIds: [...albumTracks('Polarnacht'), ...albumTracks('Zweiter Aufguss').slice(0, 3)],
  },
  {
    id: simId('playlist', 'Küstenradio Mix'),
    name: 'Küstenradio Mix',
    description: 'Von der Redaktion zusammengestellt',
    owner: 'kuestenradio',
    trackIds: [...albumTracks('Kaimauer'), ...albumTracks('Auf Kurs').slice(0, 4)],
  },
];

/** "Liked songs", newest first. */
export const likedTrackIds: string[] = ['Kleine Fluchten', 'Polarnacht', 'Auf Kurs', 'Kaimauer', 'Staub und Gold', 'Südwärts', 'Leuchtturm', 'Nachtzug nach Norden', 'Melange', 'Rückenwind', 'Regen auf dem Dach', 'Nebelhorn'].map(
  trackByName,
);

export const savedAlbumIds: string[] = ['Kleine Fluchten', 'Polarnacht', 'Auf Kurs', 'Alle einsteigen!'].map((name) => albums.find((a) => a.name === name)!.id);

export const recentTrackIds: string[] = ['Blaue Stunde', 'Montagmorgen', 'Der kleine Bagger', 'Sperrstunde', 'Fjordwind', 'Zitronenhain'].map(trackByName);

export const topTrackIds: string[] = ['Kleine Fluchten', 'Auf Kurs', 'Erstes Licht', 'Hafenlichter', 'Zweiter Aufguss', 'Treppenhaus', 'Südwärts', 'Kaimauer'].map(trackByName);

export const shows: SimShow[] = [
  {
    id: simId('show', 'Hausgemacht'),
    name: 'Hausgemacht – der Smart-Home-Podcast',
    publisher: 'Studio Dachgeschoss',
    episodes: [
      ['Folge 12: Jalousien, die mitdenken', 1840, '2026-10-28'],
      ['Folge 11: Wer klingelt da?', 2105, '2026-10-14'],
      ['Folge 10: Musik in jedem Raum', 1972, '2026-09-30'],
    ].map(([name, seconds, releaseDate]) => ({
      id: simId('episode', String(name)),
      name: String(name),
      durationMs: Number(seconds) * 1000,
      releaseDate: String(releaseDate),
    })),
  },
];

export const catalog = { artists, albums, tracks, playlists, likedTrackIds, savedAlbumIds, recentTrackIds, topTrackIds, shows };

export function findTrack(id: string): SimTrack | undefined {
  return tracks.find((t) => t.id === id);
}

export function findAlbum(id: string): SimAlbum | undefined {
  return albums.find((a) => a.id === id);
}

export function findArtist(id: string): SimArtist | undefined {
  return artists.find((a) => a.id === id);
}

export function findPlaylist(id: string): SimPlaylist | undefined {
  return playlists.find((p) => p.id === id);
}

/**
 * Resolves a Spotify URI (`spotify:track|album|playlist:<id>`) to the tracks
 * a player would end up with. Unknown ids resolve to an empty list.
 */
export function resolveSpotifyUri(uri: string): SimTrack[] {
  const [, kind, id] = uri.split(':');
  if (!kind || !id) return [];
  const byIds = (ids: string[]) => ids.map(findTrack).filter((t): t is SimTrack => Boolean(t));
  switch (kind) {
    case 'track': {
      const track = findTrack(id);
      return track ? [track] : [];
    }
    case 'album':
      return byIds(findAlbum(id)?.trackIds ?? []);
    case 'playlist':
      return byIds(findPlaylist(id)?.trackIds ?? []);
    default:
      return [];
  }
}

export function artistNames(ids: string[]): string {
  return ids.map((id) => findArtist(id)?.name ?? '').filter(Boolean).join(', ');
}
