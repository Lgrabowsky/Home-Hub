import type { MusicSource } from '@home-hub/shared';
import { node, nodes, parseXml, text, type Xml } from './soap.ts';

/** What a DIDL-Lite `<item>` says about a track or favourite. */
export interface DidlItem {
  id: string;
  title: string;
  creator: string;
  album: string;
  albumArt: string;
  /** Current song of a radio stream ("Artist - Title"), if the station sends it. */
  streamContent: string;
  description: string;
  itemClass: string;
  res: string;
  /** Metadata to send along when this favourite is played (already a DIDL document). */
  resMD: string;
}

function toItem(raw: Xml): DidlItem {
  return {
    id: text(raw['@_id']),
    title: text(raw.title),
    creator: text(raw.creator),
    album: text(raw.album),
    albumArt: text(raw.albumArtURI),
    streamContent: text(raw.streamContent),
    description: text(raw.description),
    itemClass: text(raw.class),
    res: text(raw.res),
    resMD: text(raw.resMD),
  };
}

/** All items (and containers) of a DIDL-Lite document; empty for "NOT_IMPLEMENTED" or broken input. */
export function parseDidl(didl: string | undefined): DidlItem[] {
  if (!didl || !didl.includes('<')) return [];
  const root = node(parseXml(didl)['DIDL-Lite']);
  return [...nodes(root.item), ...nodes(root.container)].map(toItem);
}

/** Where the music comes from, judged by the URI the player reports. */
export function sourceOf(uri: string): MusicSource {
  const lower = uri.toLowerCase();
  if (lower.startsWith('x-sonos-spotify:') || lower.includes('spotify')) return 'spotify';
  if (/^(x-sonosapi-stream:|x-sonosapi-radio:|x-rincon-mp3radio:|x-sonosapi-hls:|x-sonosapi-hls-static:|aac:|hls-radio:)/.test(lower)) return 'radio';
  if (lower.startsWith('x-sonos-htastream:')) return 'tv';
  if (lower.startsWith('x-rincon-stream:')) return 'line_in';
  if (lower.startsWith('x-file-cifs:') || lower.startsWith('x-rincon-playlist:')) return 'library';
  if (lower.startsWith('x-sonos-vli:') && lower.includes('airplay')) return 'airplay';
  return 'other';
}

/** URIs that are set directly on the transport instead of being queued (they have no end and no "next"). */
export function isStreamUri(uri: string): boolean {
  return /^(x-sonosapi-stream:|x-sonosapi-radio:|x-rincon-mp3radio:|x-sonosapi-hls:|x-sonosapi-hls-static:|aac:|hls-radio:|x-rincon-stream:|x-sonos-htastream:)/i.test(uri);
}

const SPOTIFY_SHARE: Record<string, { prefix: string; key: string; itemClass: string }> = {
  track: { prefix: '', key: '00032020', itemClass: 'object.item.audioItem.musicTrack' },
  episode: { prefix: '', key: '00032020', itemClass: 'object.item.audioItem.musicTrack' },
  album: { prefix: 'x-rincon-cpcontainer:1004206c', key: '00040000', itemClass: 'object.container.album.musicAlbum' },
  playlist: { prefix: 'x-rincon-cpcontainer:1006206c', key: '1006206c', itemClass: 'object.container.playlistContainer' },
  show: { prefix: 'x-rincon-cpcontainer:1006206c', key: '1006206c', itemClass: 'object.container.playlistContainer' },
};

/** Sonos' service numbers for Spotify, by the region the household's Spotify account was linked in. */
export const SPOTIFY_SERVICE_NUMBER = { EU: 2311, US: 3079 } as const;

/**
 * What to hand to `AddURIToQueue` so that a player streams a Spotify URI by
 * itself — exactly what SoCo's share-link plugin sends (the values are not
 * documented anywhere; they were found by observing the official apps).
 */
export function spotifyEnqueue(uri: string, title: string, region: keyof typeof SPOTIFY_SERVICE_NUMBER): { uri: string; metadata: string } | null {
  const match = /^spotify:(track|episode|album|playlist|show):([A-Za-z0-9]{10,40})$/.exec(uri);
  if (!match) return null;
  const share = SPOTIFY_SHARE[match[1]!]!;
  const encoded = uri.replace(/:/g, '%3a');
  const sn = SPOTIFY_SERVICE_NUMBER[region];
  const escapedTitle = title.replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[char]!);
  const metadata =
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
    `<item id="${share.key}${encoded}" parentID="-1" restricted="true"><dc:title>${escapedTitle}</dc:title><upnp:class>${share.itemClass}</upnp:class>` +
    `<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON${sn}_X_#Svc${sn}-0-Token</desc></item></DIDL-Lite>`;
  return { uri: share.prefix + encoded, metadata };
}
