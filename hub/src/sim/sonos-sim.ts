import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { renderCover } from './art.ts';
import { albums, artistNames, findAlbum, findTrack, playlists, resolveSpotifyUri, shows, simId, type SimTrack } from './catalog.ts';

/**
 * Simulator of a Sonos household: one HTTP server per player (as in reality,
 * every speaker answers on its own address), all sharing one model of groups,
 * queues and playback. Speaks UPnP/SOAP the way the players do, including
 * proper SOAP faults.
 *
 * Spotify content is only accepted in the exact shapes the official apps (and
 * SoCo's share-link plugin) use, and only with the service number of the
 * region the simulated household is registered in.
 */

export interface SonosSimOptions {
  /** Region of the Spotify account linked in the "Sonos app": decides which service number is accepted. */
  spotifyRegion?: 'EU' | 'US';
  /** false: every Spotify enqueue fails with UPnP error 800, as when no account is linked. */
  spotifyLinked?: boolean;
  /** Rooms to create; default: the demo household. */
  rooms?: { name: string; model: string }[];
  /** Start with the first two rooms grouped and playing (default true). */
  playing?: boolean;
  /** Old firmware: the topology has `<ZoneGroups>` as its root. */
  legacyTopology?: boolean;
}

export interface SonosSimAction {
  /** UUID of the player that received the call. */
  player: string;
  service: string;
  action: string;
  args: Record<string, string>;
}

export interface SonosSimGroupView {
  coordinator: string;
  members: string[];
  state: 'PLAYING' | 'PAUSED_PLAYBACK' | 'STOPPED';
  /** Titles in the queue, in order. */
  queue: string[];
  /** 0-based position in the queue, −1 when the queue is not what plays. */
  trackIndex: number;
  /** What the transport plays: a queue URI or a stream. */
  transportUri: string;
  /** Title of what is audible right now. */
  nowPlaying: string | null;
  positionSec: number;
  playMode: string;
}

export interface SonosSim {
  readonly players: { uuid: string; name: string; model: string; host: string; port: number }[];
  /** `host:port` of every player — any one of them is enough as a seed. */
  readonly seedHosts: string[];
  /** Every SOAP action received, oldest first (the last 5000). */
  readonly actions: SonosSimAction[];
  close(): Promise<void>;
  /** UUID of the player in this room. */
  uuid(room: string): string;
  /** The group this player belongs to. */
  group(uuidOrRoom: string): SonosSimGroupView;
  player(uuidOrRoom: string): { volume: number; muted: boolean };
  setVolume(uuidOrRoom: string, volume: number): void;
  /** Takes a player off the network / brings it back. */
  setOffline(uuidOrRoom: string, offline: boolean): Promise<void>;
  /** Starts a radio station on a group, as somebody would from the Sonos app. */
  playRadio(uuidOrRoom: string, station?: string): void;
  /** Jumps to just before the end of the current track (to watch the queue advance). */
  skipToEndOfTrack(uuidOrRoom: string): void;
}

interface QueueItem {
  uri: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  artSeed: string;
}

interface Stream {
  uri: string;
  station: string;
  content: string;
}

interface Group {
  coordinator: string;
  members: string[];
  queue: QueueItem[];
  /** 'queue' or a stream. */
  stream: Stream | null;
  usesQueue: boolean;
  index: number;
  state: 'PLAYING' | 'PAUSED_PLAYBACK' | 'STOPPED';
  positionMs: number;
  startedAt: number;
  playMode: string;
  snapshot: Map<string, number> | null;
}

interface Player {
  uuid: string;
  name: string;
  model: string;
  port: number;
  volume: number;
  muted: boolean;
  server: http.Server;
  sockets: Set<Socket>;
  offline: boolean;
}

const DEMO_ROOMS = [
  { name: 'Wohnzimmer', model: 'Sonos Arc' },
  { name: 'Küche', model: 'Sonos One' },
  { name: 'Bad', model: 'Sonos Roam' },
  { name: 'Schlafzimmer', model: 'Sonos Era 100' },
  { name: 'Büro', model: 'Sonos Five' },
  { name: 'Terrasse', model: 'Sonos Move' },
];

const RADIO: Record<string, Stream> = {
  'Radio Küste': { uri: 'x-sonosapi-stream:s24896?sid=254&flags=8224&sn=0', station: 'Radio Küste', content: 'Hafenkante - Nebelhorn' },
  'Klassik am Morgen': { uri: 'x-rincon-mp3radio://stream.example.invalid/klassik.mp3', station: 'Klassik am Morgen', content: '' },
};

const SERVICE_NUMBERS = { EU: 2311, US: 3079 };
const NS = 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"';

const esc = (value: string): string => value.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!);
const unesc = (value: string): string => value.replace(/&(lt|gt|amp|quot|apos);/g, (_, name: string) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[name]!);
const time = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

class Fault extends Error {
  constructor(readonly code: number) {
    super(`UPnP ${code}`);
  }
}

function trackItem(track: SimTrack): QueueItem {
  const album = findAlbum(track.albumId);
  return {
    uri: `x-sonos-spotify:spotify%3atrack%3a${track.id}?sid=9&flags=8224&sn=7`,
    title: track.name,
    artist: artistNames(track.artistIds),
    album: album?.name ?? '',
    durationMs: track.durationMs,
    artSeed: `album-${track.albumId}`,
  };
}

export async function startSonosSim(options: SonosSimOptions = {}): Promise<SonosSim> {
  const region = options.spotifyRegion ?? 'EU';
  const linked = options.spotifyLinked ?? true;
  const rooms = options.rooms ?? DEMO_ROOMS;
  const players = new Map<string, Player>();
  const groups: Group[] = [];
  const actions: SonosSimAction[] = [];
  const covers = new Map<string, Buffer>();

  const uuidOf = (name: string) => `RINCON_${createHash('sha1').update(name).digest('hex').slice(0, 12).toUpperCase()}01400`;
  const resolve = (uuidOrRoom: string): Player => {
    const player = players.get(uuidOrRoom) ?? [...players.values()].find((entry) => entry.name === uuidOrRoom);
    if (!player) throw new Error(`No simulated player "${uuidOrRoom}"`);
    return player;
  };
  const groupOf = (uuid: string): Group => groups.find((group) => group.members.includes(uuid))!;

  // --- Playback clock ------------------------------------------------------------------------------

  /** Brings a group's position up to date and moves on through the queue as tracks end. */
  function settle(group: Group): void {
    if (group.state !== 'PLAYING') return;
    const now = Date.now();
    let position = group.positionMs + (now - group.startedAt);
    group.startedAt = now;
    if (!group.usesQueue) {
      group.positionMs = position;
      return;
    }
    for (;;) {
      const current = group.queue[group.index];
      if (!current) {
        group.state = 'STOPPED';
        group.index = 0;
        position = 0;
        break;
      }
      if (position < current.durationMs) break;
      position -= current.durationMs;
      if (group.playMode === 'REPEAT_ONE' || group.playMode === 'SHUFFLE_REPEAT_ONE') continue;
      group.index++;
      if (group.index >= group.queue.length && (group.playMode === 'REPEAT_ALL' || group.playMode === 'SHUFFLE')) group.index = 0;
    }
    group.positionMs = position;
  }

  function standalone(uuid: string): Group {
    return { coordinator: uuid, members: [uuid], queue: [], stream: null, usesQueue: true, index: 0, state: 'STOPPED', positionMs: 0, startedAt: Date.now(), playMode: 'NORMAL', snapshot: null };
  }

  function leave(uuid: string): void {
    const group = groupOf(uuid);
    if (group.members.length === 1) return;
    settle(group);
    group.members = group.members.filter((member) => member !== uuid);
    if (group.coordinator === uuid) {
      // The music stays with the remaining rooms; the leaving player starts empty.
      group.coordinator = group.members[0]!;
    }
    groups.push(standalone(uuid));
  }

  function join(uuid: string, coordinator: string): void {
    const target = groups.find((group) => group.coordinator === coordinator);
    if (!target) throw new Fault(701);
    if (target.members.includes(uuid)) return;
    const old = groupOf(uuid);
    if (old.members.length === 1) groups.splice(groups.indexOf(old), 1);
    else {
      old.members = old.members.filter((member) => member !== uuid);
      if (old.coordinator === uuid) old.coordinator = old.members[0]!;
    }
    target.members.push(uuid);
  }

  // --- Spotify enqueueing ----------------------------------------------------------------------------

  /** Turns an enqueue request into queue items, or refuses it like a household without a matching account. */
  function expand(uri: string, metadata: string): QueueItem[] {
    const bare = uri.replace(/\?.*$/, '');
    const match = /^(x-rincon-cpcontainer:1004206c|x-rincon-cpcontainer:1006206c|)spotify%3a(track|episode|album|playlist|show)%3a([A-Za-z0-9]+)$/.exec(bare);
    if (!match) throw new Fault(714);
    const [, prefix, kind, id] = match as unknown as [string, string, string, string];
    const expectedPrefix = kind === 'album' ? 'x-rincon-cpcontainer:1004206c' : kind === 'playlist' || kind === 'show' ? 'x-rincon-cpcontainer:1006206c' : '';
    const key = kind === 'album' ? '00040000' : kind === 'playlist' || kind === 'show' ? '1006206c' : '00032020';
    const meta = unesc(metadata);
    const itemId = /<item id="([^"]*)"/.exec(meta)?.[1] ?? '';
    const token = /<desc [^>]*>SA_RINCON(\d+)_X_#Svc(\d+)-0-Token<\/desc>/.exec(meta);
    // Wrong shape, no account, or the service number of another region: the player cannot resolve the content.
    if (!linked || prefix !== expectedPrefix || !itemId.startsWith(`${key}spotify%3a${kind}%3a${id}`) || !token || token[1] !== token[2] || Number(token[1]) !== SERVICE_NUMBERS[region]) {
      throw new Fault(800);
    }
    if (kind === 'show' || kind === 'episode') {
      const episodes = shows.flatMap((show) => show.episodes.map((episode) => ({ show, episode }))).filter((entry) => (kind === 'show' ? entry.show.id === id : entry.episode.id === id));
      if (episodes.length === 0) throw new Fault(800);
      return episodes.map(({ show, episode }) => ({ uri: `x-sonos-spotify:spotify%3aepisode%3a${episode.id}?sid=9&flags=8224&sn=7`, title: episode.name, artist: show.publisher, album: show.name, durationMs: episode.durationMs, artSeed: `show-${show.id}` }));
    }
    const found = resolveSpotifyUri(`spotify:${kind}:${id}`);
    if (found.length === 0) throw new Fault(800);
    return found.map(trackItem);
  }

  // --- DIDL ------------------------------------------------------------------------------------------

  function trackDidl(item: QueueItem): string {
    return (
      `<DIDL-Lite ${NS}><item id="-1" parentID="-1" restricted="true">` +
      `<res protocolInfo="sonos.com-spotify:*:audio/x-spotify:*" duration="${time(item.durationMs)}">${esc(item.uri)}</res>` +
      `<r:streamContent></r:streamContent><upnp:albumArtURI>${esc(`/getaa?s=1&u=${encodeURIComponent(item.uri)}&seed=${item.artSeed}`)}</upnp:albumArtURI>` +
      `<dc:title>${esc(item.title)}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><dc:creator>${esc(item.artist)}</dc:creator><upnp:album>${esc(item.album)}</upnp:album></item></DIDL-Lite>`
    );
  }

  function streamDidl(stream: Stream, forTrack: boolean): string {
    const seed = `radio-${simId('radio', stream.station)}`;
    return (
      `<DIDL-Lite ${NS}><item id="-1" parentID="-1" restricted="true">` +
      (forTrack ? `<res protocolInfo="sonos.com-http:*:*:*">${esc(stream.uri)}</res><r:streamContent>${esc(stream.content)}</r:streamContent>` : '') +
      `<upnp:albumArtURI>${esc(`/getaa?s=1&u=${encodeURIComponent(stream.uri)}&seed=${seed}`)}</upnp:albumArtURI>` +
      `<dc:title>${esc(forTrack ? stream.uri.split('/').pop()! : stream.station)}</dc:title><upnp:class>object.item.audioItem.audioBroadcast</upnp:class></item></DIDL-Lite>`
    );
  }

  const tokenDesc = `<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON${SERVICE_NUMBERS[region]}_X_#Svc${SERVICE_NUMBERS[region]}-0-Token</desc>`;

  function favorites(): string {
    const entries: string[] = [];
    let n = 0;
    const add = (title: string, description: string, res: string, art: string, resMD: string) => {
      entries.push(
        `<item id="FV:2/${++n}" parentID="FV:2" restricted="false"><dc:title>${esc(title)}</dc:title><upnp:class>object.itemobject.item.sonos-favorite</upnp:class><r:ordinal>${n}</r:ordinal>` +
          `<res protocolInfo="x-rincon-playlist:*:*:*">${esc(res)}</res><upnp:albumArtURI>${esc(art)}</upnp:albumArtURI><r:type>instantPlay</r:type><r:description>${esc(description)}</r:description><r:resMD>${esc(resMD)}</r:resMD></item>`,
      );
    };
    for (const playlist of playlists.slice(0, 2)) {
      const encoded = `spotify%3aplaylist%3a${playlist.id}`;
      add(
        playlist.name,
        'Spotify-Playlist',
        `x-rincon-cpcontainer:1006206c${encoded}?sid=9&flags=8300&sn=7`,
        `/getaa?s=1&u=${encoded}&seed=playlist-${playlist.id}`,
        `<DIDL-Lite ${NS}><item id="1006206c${encoded}" parentID="-1" restricted="true"><dc:title>${esc(playlist.name)}</dc:title><upnp:class>object.container.playlistContainer</upnp:class>${tokenDesc}</item></DIDL-Lite>`,
      );
    }
    const album = albums[4]!;
    const encodedAlbum = `spotify%3aalbum%3a${album.id}`;
    add(
      album.name,
      'Spotify-Album',
      `x-rincon-cpcontainer:1004206c${encodedAlbum}?sid=9&flags=8300&sn=7`,
      `/getaa?s=1&u=${encodedAlbum}&seed=album-${album.id}`,
      `<DIDL-Lite ${NS}><item id="00040000${encodedAlbum}" parentID="-1" restricted="true"><dc:title>${esc(album.name)}</dc:title><upnp:class>object.container.album.musicAlbum</upnp:class>${tokenDesc}</item></DIDL-Lite>`,
    );
    for (const stream of Object.values(RADIO)) {
      add(stream.station, 'Radiosender', stream.uri, `/getaa?s=1&u=${encodeURIComponent(stream.uri)}&seed=radio-${simId('radio', stream.station)}`, streamDidl(stream, false));
    }
    // A shortcut without a URI, as some services create them: must be skipped by clients.
    entries.push(`<item id="FV:2/${++n}" parentID="FV:2" restricted="false"><dc:title>Neuheiten</dc:title><upnp:class>object.itemobject.item.sonos-favorite</upnp:class><res></res><r:type>shortcut</r:type><r:description>Verknüpfung</r:description><r:resMD></r:resMD></item>`);
    return `<DIDL-Lite ${NS}>${entries.join('')}</DIDL-Lite>`;
  }

  // --- SOAP actions ------------------------------------------------------------------------------------

  function topology(): string {
    const groupXml = groups
      .map((group) => {
        const members = group.members
          .map((uuid) => {
            const player = players.get(uuid)!;
            return `<ZoneGroupMember UUID="${uuid}" Location="http://127.0.0.1:${player.port}/xml/device_description.xml" ZoneName="${esc(player.name)}" Icon="" Configuration="1" SoftwareVersion="79.1-53290" BootSeq="12" IdleState="0"/>`;
          })
          .join('');
        // A sub that belongs to the first room: present in the topology, never to be shown.
        const first = [...players.values()][0]!;
        const sub = group.members.includes(first.uuid) ? `<ZoneGroupMember UUID="RINCON_SUB00000000001400" Location="http://127.0.0.1:${first.port}/xml/device_description.xml" ZoneName="${esc(first.name)}" Invisible="1"/>` : '';
        return `<ZoneGroup Coordinator="${group.coordinator}" ID="${group.coordinator}:1">${members}${sub}</ZoneGroup>`;
      })
      .join('');
    const zoneGroups = `<ZoneGroups>${groupXml}</ZoneGroups>`;
    return options.legacyTopology ? zoneGroups : `<ZoneGroupState>${zoneGroups}<VanishedDevices/></ZoneGroupState>`;
  }

  function coordinatorOnly(player: Player): Group {
    const group = groupOf(player.uuid);
    // A grouped player follows its coordinator and refuses transport commands itself.
    if (group.coordinator !== player.uuid) throw new Fault(800);
    return group;
  }

  function avTransport(player: Player, action: string, args: Record<string, string>): Record<string, string | number> {
    if (action === 'BecomeCoordinatorOfStandaloneGroup') {
      leave(player.uuid);
      return { DelegatedGroupCoordinatorID: '', NewGroupID: `${player.uuid}:2` };
    }
    if (action === 'SetAVTransportURI' && (args.CurrentURI ?? '').startsWith('x-rincon:')) {
      join(player.uuid, args.CurrentURI!.slice('x-rincon:'.length));
      return {};
    }
    const group = coordinatorOnly(player);
    settle(group);
    const current = group.usesQueue ? group.queue[group.index] : undefined;
    switch (action) {
      case 'GetTransportInfo':
        return { CurrentTransportState: group.state, CurrentTransportStatus: 'OK', CurrentSpeed: '1' };
      case 'GetTransportSettings':
        return { PlayMode: group.playMode, RecQualityMode: 'NOT_IMPLEMENTED' };
      case 'GetPositionInfo':
        if (group.stream && !group.usesQueue) {
          return { Track: 1, TrackDuration: '0:00:00', TrackMetaData: streamDidl(group.stream, true), TrackURI: group.stream.uri, RelTime: time(group.positionMs), AbsTime: 'NOT_IMPLEMENTED', RelCount: 2147483647, AbsCount: 2147483647 };
        }
        if (!current) return { Track: 0, TrackDuration: 'NOT_IMPLEMENTED', TrackMetaData: 'NOT_IMPLEMENTED', TrackURI: '', RelTime: 'NOT_IMPLEMENTED', AbsTime: 'NOT_IMPLEMENTED', RelCount: 2147483647, AbsCount: 2147483647 };
        return { Track: group.index + 1, TrackDuration: time(current.durationMs), TrackMetaData: trackDidl(current), TrackURI: current.uri, RelTime: time(group.positionMs), AbsTime: 'NOT_IMPLEMENTED', RelCount: 2147483647, AbsCount: 2147483647 };
      case 'GetMediaInfo':
        if (group.stream && !group.usesQueue) return { NrTracks: 1, MediaDuration: 'NOT_IMPLEMENTED', CurrentURI: group.stream.uri, CurrentURIMetaData: streamDidl(group.stream, false), NextURI: '', NextURIMetaData: '', PlayMedium: 'NETWORK', RecordMedium: 'NOT_IMPLEMENTED', WriteStatus: 'NOT_IMPLEMENTED' };
        return { NrTracks: group.queue.length, MediaDuration: 'NOT_IMPLEMENTED', CurrentURI: `x-rincon-queue:${group.coordinator}#0`, CurrentURIMetaData: '', NextURI: '', NextURIMetaData: '', PlayMedium: 'NETWORK', RecordMedium: 'NOT_IMPLEMENTED', WriteStatus: 'NOT_IMPLEMENTED' };
      case 'Play':
        if (group.usesQueue ? !current : !group.stream) throw new Fault(701);
        group.state = 'PLAYING';
        group.startedAt = Date.now();
        return {};
      case 'Pause':
        // A live stream cannot be paused.
        if (!group.usesQueue) throw new Fault(701);
        if (group.state === 'PLAYING') group.state = 'PAUSED_PLAYBACK';
        return {};
      case 'Stop':
        group.state = 'STOPPED';
        if (group.usesQueue) group.positionMs = 0;
        return {};
      case 'Next':
        if (!group.usesQueue || group.index + 1 >= group.queue.length) throw new Fault(711);
        group.index++;
        group.positionMs = 0;
        group.startedAt = Date.now();
        return {};
      case 'Previous':
        if (!group.usesQueue || group.index === 0) throw new Fault(711);
        group.index--;
        group.positionMs = 0;
        group.startedAt = Date.now();
        return {};
      case 'Seek': {
        if (!group.usesQueue) throw new Fault(701);
        if (args.Unit === 'TRACK_NR') {
          const target = Number(args.Target);
          if (!Number.isInteger(target) || target < 1 || target > group.queue.length) throw new Fault(711);
          group.index = target - 1;
          group.positionMs = 0;
        } else if (args.Unit === 'REL_TIME') {
          const match = /^(\d+):(\d{2}):(\d{2})$/.exec(args.Target ?? '');
          if (!match || !current) throw new Fault(711);
          const ms = (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000;
          if (ms > current.durationMs) throw new Fault(711);
          group.positionMs = ms;
        } else throw new Fault(710);
        group.startedAt = Date.now();
        return {};
      }
      case 'SetPlayMode':
        if (!['NORMAL', 'REPEAT_ALL', 'REPEAT_ONE', 'SHUFFLE_NOREPEAT', 'SHUFFLE', 'SHUFFLE_REPEAT_ONE'].includes(args.NewPlayMode ?? '')) throw new Fault(712);
        group.playMode = args.NewPlayMode!;
        return {};
      case 'SetAVTransportURI': {
        const uri = args.CurrentURI ?? '';
        if (uri.startsWith('x-rincon-queue:')) {
          group.usesQueue = true;
          group.index = 0;
        } else {
          const stream = Object.values(RADIO).find((entry) => entry.uri === uri);
          if (!stream) throw new Fault(714);
          group.stream = stream;
          group.usesQueue = false;
        }
        group.state = 'STOPPED';
        group.positionMs = 0;
        return {};
      }
      case 'RemoveAllTracksFromQueue':
        if (group.queue.length === 0) throw new Fault(804);
        group.queue = [];
        group.index = 0;
        group.positionMs = 0;
        if (group.usesQueue) group.state = 'STOPPED';
        return {};
      case 'AddURIToQueue': {
        const items = expand(args.EnqueuedURI ?? '', args.EnqueuedURIMetaData ?? '');
        const at = args.EnqueueAsNext === '1' && group.queue.length > 0 ? group.index + 1 : group.queue.length;
        group.queue.splice(at, 0, ...items);
        return { FirstTrackNumberEnqueued: at + 1, NumTracksAdded: items.length, NewQueueLength: group.queue.length };
      }
      case 'AddMultipleURIsToQueue': {
        const uris = (args.EnqueuedURIs ?? '').split(' ').filter(Boolean);
        const metas = (args.EnqueuedURIsMetaData ?? '').split(/(?<=<\/DIDL-Lite>) /).filter(Boolean);
        if (uris.length === 0 || uris.length > 16 || uris.length !== metas.length || Number(args.NumberOfURIs) !== uris.length) throw new Fault(402);
        const items = uris.flatMap((uri, index) => expand(uri, metas[index]!));
        const at = args.EnqueueAsNext === '1' && group.queue.length > 0 ? group.index + 1 : group.queue.length;
        group.queue.splice(at, 0, ...items);
        return { FirstTrackNumberEnqueued: at + 1, NumTracksAdded: items.length, NewQueueLength: group.queue.length, NewUpdateID: 1 };
      }
      default:
        throw new Fault(401);
    }
  }

  function rendering(player: Player, action: string, args: Record<string, string>): Record<string, string | number> {
    switch (action) {
      case 'GetVolume':
        return { CurrentVolume: player.volume };
      case 'SetVolume': {
        const volume = Number(args.DesiredVolume);
        if (!Number.isInteger(volume) || volume < 0 || volume > 100 || args.Channel !== 'Master') throw new Fault(402);
        player.volume = volume;
        return {};
      }
      case 'GetMute':
        return { CurrentMute: player.muted ? 1 : 0 };
      case 'SetMute':
        if (args.Channel !== 'Master' || !['0', '1'].includes(args.DesiredMute ?? '')) throw new Fault(402);
        player.muted = args.DesiredMute === '1';
        return {};
      default:
        throw new Fault(401);
    }
  }

  function groupRendering(player: Player, action: string, args: Record<string, string>): Record<string, string | number> {
    const group = coordinatorOnly(player);
    const members = group.members.map((uuid) => players.get(uuid)!);
    const average = () => Math.round(members.reduce((sum, member) => sum + member.volume, 0) / members.length);
    switch (action) {
      case 'SnapshotGroupVolume':
        group.snapshot = new Map(members.map((member) => [member.uuid, member.volume]));
        return {};
      case 'GetGroupVolume':
        return { CurrentVolume: average() };
      case 'SetGroupVolume': {
        const desired = Number(args.DesiredVolume);
        if (!Number.isInteger(desired) || desired < 0 || desired > 100) throw new Fault(402);
        // Every room moves by the same amount, so the balance between the rooms stays.
        const delta = desired - average();
        for (const member of members) member.volume = Math.min(100, Math.max(0, member.volume + delta));
        return {};
      }
      case 'SetGroupMute':
        for (const member of members) member.muted = args.DesiredMute === '1';
        return {};
      case 'GetGroupMute':
        return { CurrentMute: members.every((member) => member.muted) ? 1 : 0 };
      default:
        throw new Fault(401);
    }
  }

  function contentDirectory(player: Player, action: string, args: Record<string, string>): Record<string, string | number> {
    if (action !== 'Browse') throw new Fault(401);
    if (args.ObjectID === 'FV:2') {
      const result = favorites();
      const count = (result.match(/<item /g) ?? []).length;
      return { Result: result, NumberReturned: count, TotalMatches: count, UpdateID: 1 };
    }
    if (args.ObjectID === 'Q:0') {
      const group = groupOf(player.uuid);
      const items = group.queue.map((item, index) => trackDidl(item).replace(/^<DIDL-Lite [^>]*>|<\/DIDL-Lite>$/g, '').replace('id="-1"', `id="Q:0/${index + 1}"`));
      return { Result: `<DIDL-Lite ${NS}>${items.join('')}</DIDL-Lite>`, NumberReturned: items.length, TotalMatches: items.length, UpdateID: 1 };
    }
    throw new Fault(701);
  }

  const ROUTES: Record<string, { type: string; run: (player: Player, action: string, args: Record<string, string>) => Record<string, string | number> }> = {
    '/MediaRenderer/AVTransport/Control': { type: 'urn:schemas-upnp-org:service:AVTransport:1', run: avTransport },
    '/MediaRenderer/RenderingControl/Control': { type: 'urn:schemas-upnp-org:service:RenderingControl:1', run: rendering },
    '/MediaRenderer/GroupRenderingControl/Control': { type: 'urn:schemas-upnp-org:service:GroupRenderingControl:1', run: groupRendering },
    '/ZoneGroupTopology/Control': {
      type: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1',
      run: (_player, action) => {
        if (action !== 'GetZoneGroupState') throw new Fault(401);
        return { ZoneGroupState: topology() };
      },
    },
    '/MediaServer/ContentDirectory/Control': { type: 'urn:schemas-upnp-org:service:ContentDirectory:1', run: contentDirectory },
  };

  // --- HTTP ------------------------------------------------------------------------------------------

  async function handle(player: Player, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${player.port}`);

    if (req.method === 'GET' && url.pathname === '/xml/device_description.xml') {
      const xml = `<?xml version="1.0" encoding="utf-8"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><device><deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType><friendlyName>127.0.0.1 - ${esc(player.model)}</friendlyName><manufacturer>Sonos, Inc.</manufacturer><modelNumber>S19</modelNumber><modelName>${esc(player.model)}</modelName><roomName>${esc(player.name)}</roomName><displayName>${esc(player.model.replace(/^Sonos /, ''))}</displayName><UDN>uuid:${player.uuid}</UDN></device></root>`;
      res.writeHead(200, { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) });
      return void res.end(xml);
    }

    if (req.method === 'GET' && url.pathname === '/getaa') {
      const seed = url.searchParams.get('seed') ?? 'cover';
      let png = covers.get(seed);
      if (!png) {
        const id = seed.replace(/^[a-z]+-/, '');
        png = renderCover(seed, findAlbum(id)?.name ?? playlists.find((playlist) => playlist.id === id)?.name ?? '');
        covers.set(seed, png);
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      return void res.end(png);
    }

    const route = ROUTES[url.pathname];
    if (req.method !== 'POST' || !route) {
      res.writeHead(404);
      return void res.end();
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const header = String(req.headers.soapaction ?? '').replace(/^"|"$/g, '');
    const [type, action = ''] = header.split('#');
    const send = (status: number, inner: string) => {
      const xml = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${inner}</s:Body></s:Envelope>`;
      res.writeHead(status, { 'Content-Type': 'text/xml; charset="utf-8"', 'Content-Length': Buffer.byteLength(xml) });
      res.end(xml);
    };
    const fault = (code: number) => send(500, `<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode></UPnPError></detail></s:Fault>`);

    // The action element of the body must match the SOAPACTION header, as real players insist.
    const element = new RegExp(`<u:${action}[^>]*>([\\s\\S]*)</u:${action}>`).exec(body);
    if (type !== route.type || !action || !element) return fault(401);
    const args: Record<string, string> = {};
    for (const match of element[1]!.matchAll(/<([A-Za-z0-9]+)>([\s\S]*?)<\/\1>/g)) args[match[1]!] = unesc(match[2]!);
    for (const match of element[1]!.matchAll(/<([A-Za-z0-9]+)\/>/g)) args[match[1]!] = '';
    actions.push({ player: player.uuid, service: type.split(':')[3] ?? type, action, args });
    if (actions.length > 5000) actions.splice(0, 2500);
    try {
      const out = route.run(player, action, args);
      const xml = Object.entries(out)
        .map(([name, value]) => `<${name}>${esc(String(value))}</${name}>`)
        .join('');
      send(200, `<u:${action}Response xmlns:u="${type}">${xml}</u:${action}Response>`);
    } catch (err) {
      if (err instanceof Fault) return fault(err.code);
      throw err;
    }
  }

  const listen = (player: Player, port: number) =>
    new Promise<void>((resolveListen, reject) => {
      player.server.once('error', reject);
      player.server.listen(port, '127.0.0.1', () => {
        player.server.off('error', reject);
        resolveListen();
      });
    });
  const shut = (player: Player) =>
    new Promise<void>((resolveClose) => {
      if (!player.server.listening) return resolveClose();
      player.server.close(() => resolveClose());
      for (const socket of player.sockets) socket.destroy();
    });

  for (const [index, room] of rooms.entries()) {
    const player: Player = { uuid: uuidOf(room.name), name: room.name, model: room.model, port: 0, volume: [28, 22, 15, 12, 30, 35][index] ?? 20, muted: false, server: http.createServer(), sockets: new Set(), offline: false };
    player.server.on('request', (req, res) => {
      void handle(player, req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    player.server.on('connection', (socket) => {
      player.sockets.add(socket);
      socket.once('close', () => player.sockets.delete(socket));
    });
    await listen(player, 0);
    player.port = (player.server.address() as AddressInfo).port;
    players.set(player.uuid, player);
    groups.push(standalone(player.uuid));
  }

  // The evening in the demo household: the first two rooms play an album together.
  const all = [...players.values()];
  if ((options.playing ?? true) && all.length >= 2) {
    join(all[1]!.uuid, all[0]!.uuid);
    const group = groupOf(all[0]!.uuid);
    group.queue = (findAlbum(albums[1]!.id)?.trackIds ?? []).map((id) => trackItem(findTrack(id)!));
    group.index = 1;
    group.positionMs = 42_000;
    group.startedAt = Date.now();
    group.state = 'PLAYING';
  }

  const view = (group: Group): SonosSimGroupView => {
    settle(group);
    const current = group.usesQueue ? group.queue[group.index] : undefined;
    return {
      coordinator: group.coordinator,
      members: [...group.members],
      state: group.state,
      queue: group.queue.map((item) => item.title),
      trackIndex: group.usesQueue ? group.index : -1,
      transportUri: group.usesQueue ? `x-rincon-queue:${group.coordinator}#0` : (group.stream?.uri ?? ''),
      nowPlaying: group.usesQueue ? (current?.title ?? null) : (group.stream?.station ?? null),
      positionSec: Math.floor(group.positionMs / 1000),
      playMode: group.playMode,
    };
  };

  return {
    players: all.map((player) => ({ uuid: player.uuid, name: player.name, model: player.model, host: '127.0.0.1', port: player.port })),
    seedHosts: all.map((player) => `127.0.0.1:${player.port}`),
    actions,
    async close() {
      await Promise.all(all.map((player) => shut(player)));
    },
    uuid: (room) => resolve(room).uuid,
    group: (uuidOrRoom) => view(groupOf(resolve(uuidOrRoom).uuid)),
    player(uuidOrRoom) {
      const player = resolve(uuidOrRoom);
      return { volume: player.volume, muted: player.muted };
    },
    setVolume(uuidOrRoom, volume) {
      resolve(uuidOrRoom).volume = volume;
    },
    async setOffline(uuidOrRoom, offline) {
      const player = resolve(uuidOrRoom);
      player.offline = offline;
      if (offline) await shut(player);
      else if (!player.server.listening) await listen(player, player.port);
    },
    playRadio(uuidOrRoom, station = 'Radio Küste') {
      const group = groupOf(resolve(uuidOrRoom).uuid);
      group.stream = RADIO[station] ?? RADIO['Radio Küste']!;
      group.usesQueue = false;
      group.state = 'PLAYING';
      group.positionMs = 0;
      group.startedAt = Date.now();
    },
    skipToEndOfTrack(uuidOrRoom) {
      const group = groupOf(resolve(uuidOrRoom).uuid);
      settle(group);
      const current = group.queue[group.index];
      if (current) {
        group.positionMs = current.durationMs - 300;
        group.startedAt = Date.now();
      }
    },
  };
}
