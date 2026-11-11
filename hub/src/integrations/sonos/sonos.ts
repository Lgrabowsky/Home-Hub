import { createHash } from 'node:crypto';
import type { MediaItem, MusicGroup, MusicGroupCommand, MusicPlayer, MusicPlayerCommand, PlaybackState, SonosSettings, TestResult, Track } from '@home-hub/shared';
import { HttpError, notFound, unavailable } from '../../http/errors.ts';
import { describeError } from '../../util/http.ts';
import { Mutex, Poller } from '../../util/poller.ts';
import type { Integration, IntegrationDeps, SonosPlayRequest } from '../types.ts';
import { isStreamUri, parseDidl, sourceOf, spotifyEnqueue, SPOTIFY_SERVICE_NUMBER } from './didl.ts';
import { discoverPlayers } from './discovery.ts';
import { formatTime, node, nodes, parseTime, parseXml, SoapFault, SonosDevice, text, type SoapArgs } from './soap.ts';

/**
 * Sonos speakers (local UPnP/SOAP control on port 1400, no cloud).
 *
 * Writes `players` and `groups` of the music state via `state.patchMusic(…)`.
 *
 * How it works: one reachable player is enough to learn the whole household
 * (the "zone group topology"). Transport commands go to a group's coordinator,
 * volume and mute to each player. Spotify content is not streamed through the
 * hub: the hub tells a speaker which Spotify URI to play, and the speaker
 * fetches it itself with the account that is linked in the Sonos app.
 */

export interface SonosTiming {
  activeMs: number;
  idleMs: number;
  /** Re-read the topology at least this often while an app is open / while idle. */
  topologyActiveMs: number;
  topologyIdleMs: number;
  /** Play mode (shuffle/repeat) changes rarely; it is read this often and after commands. */
  settingsMs: number;
  requestTimeoutMs: number;
  /** Look for players again this often while none is known. */
  discoveryRetryMs: number;
  favoritesCacheMs: number;
}

export interface SonosOptions {
  timing?: Partial<SonosTiming>;
  /** Replaces SSDP discovery (tests). */
  discover?: () => Promise<string[]>;
}

const DEFAULT_TIMING: SonosTiming = {
  activeMs: 2000,
  idleMs: 20_000,
  topologyActiveMs: 10_000,
  topologyIdleMs: 60_000,
  settingsMs: 10_000,
  requestTimeoutMs: 5000,
  discoveryRetryMs: 60_000,
  favoritesCacheMs: 60_000,
};

const SERVICE = 'sonos';
/** `AddMultipleURIsToQueue` takes at most 16 entries per call. */
const ENQUEUE_CHUNK = 16;

const NOTHING_FOUND = 'Keine Sonos-Lautsprecher gefunden. Hängt der Hub im selben Netz? Sonst in den Einstellungen die IP-Adresse eines Lautsprechers eintragen – und prüfen, ob in der Sonos-App „UPnP“ eingeschaltet ist.';

interface Player {
  uuid: string;
  name: string;
  device: SonosDevice;
  model: string | null;
  modelAsked: boolean;
  volume: number;
  muted: boolean;
  available: boolean;
  failures: number;
}

interface Topology {
  /** Visible members per group, coordinator first. */
  groups: { coordinator: string; members: string[] }[];
}

interface GroupCache {
  playMode: string;
  playModeAt: number;
  /** Station name etc., looked up once per transport URI. */
  mediaFor: string | null;
  mediaTitle: string | null;
}

interface Favorite {
  item: MediaItem;
  uri: string;
  metadata: string;
}

function parseHost(entry: string): { host: string; port: number } {
  const match = /^(.*?)(?::(\d{1,5}))?$/.exec(entry.trim());
  return { host: match?.[1] ?? entry.trim(), port: Number(match?.[2] ?? 1400) };
}

function playbackState(raw: string): PlaybackState {
  switch (raw) {
    case 'PLAYING':
      return 'playing';
    case 'PAUSED_PLAYBACK':
      return 'paused';
    case 'TRANSITIONING':
      return 'transitioning';
    default:
      return 'stopped';
  }
}

const PLAY_MODES: Record<string, { shuffle: boolean; repeat: MusicGroup['repeat'] }> = {
  NORMAL: { shuffle: false, repeat: 'off' },
  REPEAT_ALL: { shuffle: false, repeat: 'all' },
  REPEAT_ONE: { shuffle: false, repeat: 'one' },
  SHUFFLE_NOREPEAT: { shuffle: true, repeat: 'off' },
  SHUFFLE: { shuffle: true, repeat: 'all' },
  SHUFFLE_REPEAT_ONE: { shuffle: true, repeat: 'one' },
};

function playModeFor(shuffle: boolean, repeat: MusicGroup['repeat']): string {
  return Object.entries(PLAY_MODES).find(([, mode]) => mode.shuffle === shuffle && mode.repeat === repeat)?.[0] ?? 'NORMAL';
}

/** Reads the household layout from a `GetZoneGroupState` answer. */
function parseTopology(state: string): { groups: { coordinator: string; members: { uuid: string; name: string; location: string; visible: boolean }[] }[] } {
  const root = node(parseXml(state));
  // Newer firmware wraps the groups in <ZoneGroupState>, older has <ZoneGroups> at the top.
  const zoneGroups = node(node(root.ZoneGroupState).ZoneGroups ?? root.ZoneGroups);
  return {
    groups: nodes(zoneGroups.ZoneGroup).map((group) => ({
      coordinator: text(group['@_Coordinator']),
      members: nodes(group.ZoneGroupMember).map((member) => ({
        uuid: text(member['@_UUID']),
        name: text(member['@_ZoneName']),
        location: text(member['@_Location']),
        // Stereo-pair partners, surrounds and subs follow their main player and are not shown.
        visible: text(member['@_Invisible']) !== '1',
      })),
    })),
  };
}

async function readModel(device: SonosDevice): Promise<string | null> {
  const response = await device.http.request('/xml/device_description.xml');
  if (response.status !== 200) return null;
  const description = node(node(node(parseXml(response.body.toString('utf8'))).root).device);
  return (text(description.modelName) || text(description.displayName)).replace(/^Sonos\s+/i, '') || null;
}

export class SonosIntegration implements Integration {
  private readonly timing: SonosTiming;
  private readonly discover: () => Promise<string[]>;
  private readonly poller: Poller;
  private readonly players = new Map<string, Player>();
  private readonly groupCache = new Map<string, GroupCache>();
  private readonly enqueueLock = new Mutex();
  private readonly background = new Set<Promise<void>>();
  private topology: Topology = { groups: [] };
  private groups: MusicGroup[] = [];
  private active = false;
  private stopped = false;
  private topologyAt = 0;
  private topologyDue = true;
  private lastDiscoveryAt = 0;
  private discovery: 'configured' | 'ssdp' = 'ssdp';
  private lastPollAt: number | null = null;
  private lastError: string | null = null;
  private failures = 0;
  /** Which Spotify service number the household accepted last (see `SPOTIFY_SERVICE_NUMBER`). */
  private spotifyRegion: keyof typeof SPOTIFY_SERVICE_NUMBER;
  private favoriteCache: { at: number; list: Favorite[] } | null = null;
  /**
   * Counts commands. A poll that was already under way when a command changed
   * something would overwrite the new value with what it read before — such a
   * poll notices the changed number and throws its readings away.
   */
  private epoch = 0;

  constructor(
    protected readonly deps: IntegrationDeps,
    protected readonly settings: SonosSettings,
    options: SonosOptions = {},
  ) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.discover = options.discover ?? (() => discoverPlayers());
    this.spotifyRegion = settings.spotifyRegion;
    this.poller = new Poller(
      (signal) => this.tick(signal),
      () => (this.players.size === 0 ? Math.min(this.timing.discoveryRetryMs, this.active ? 5000 : this.timing.discoveryRetryMs) : this.active ? this.timing.activeMs : this.timing.idleMs),
      (err) => this.failed(err),
      30_000,
    );
  }

  // --- Life cycle ---------------------------------------------------------------------------

  start(): void {
    this.stopped = false;
    this.discovery = this.settings.hosts.length > 0 ? 'configured' : 'ssdp';
    this.poller.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.poller.stop();
    await Promise.allSettled([...this.background]);
    for (const player of this.players.values()) player.device.destroy();
    this.players.clear();
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active) this.poller.kick();
  }

  diagnostics(): unknown {
    return {
      discovery: this.discovery,
      players: [...this.players.values()].map((player) => ({ room: player.name, uuid: player.uuid, address: `${player.device.host}:${player.device.port}`, model: player.model, available: player.available })),
      groups: this.groups.map((group) => ({ coordinator: group.coordinatorId, members: group.memberIds, state: group.state, source: group.track?.source ?? null })),
      lastPollAt: this.lastPollAt ? new Date(this.lastPollAt).toISOString() : null,
      spotifyRegion: this.spotifyRegion,
      lastError: this.lastError,
    };
  }

  // --- Finding the household ----------------------------------------------------------------------

  private device(host: string, port: number): SonosDevice {
    return new SonosDevice(host, port, this.timing.requestTimeoutMs);
  }

  /** Asks any player for the household layout. */
  private async readTopology(signal: AbortSignal): Promise<void> {
    const candidates: SonosDevice[] = [...this.players.values()].filter((player) => player.available).map((player) => player.device);
    const temporary: SonosDevice[] = [];
    if (candidates.length === 0) {
      // Nobody known (yet, or any more): start from the configured addresses or look around.
      let seeds = this.settings.hosts;
      if (seeds.length === 0) {
        if (Date.now() - this.lastDiscoveryAt < this.timing.discoveryRetryMs && this.lastDiscoveryAt > 0) throw new Error('no players');
        this.lastDiscoveryAt = Date.now();
        seeds = await this.discover();
      }
      for (const seed of seeds) {
        const { host, port } = parseHost(seed);
        temporary.push(this.device(host, port));
      }
      candidates.push(...temporary);
      // Players we knew but lost may be back.
      candidates.push(...[...this.players.values()].map((player) => player.device));
    }
    try {
      let lastErr: unknown = new Error('no players');
      for (const candidate of candidates) {
        try {
          const answer = await candidate.call('ZoneGroupTopology', 'GetZoneGroupState', {}, signal);
          this.applyTopology(answer.ZoneGroupState ?? '');
          this.topologyAt = Date.now();
          this.topologyDue = false;
          return;
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr;
    } finally {
      for (const device of temporary) device.destroy();
    }
  }

  private applyTopology(state: string): void {
    const parsed = parseTopology(state);
    const seen = new Set<string>();
    const groups: Topology['groups'] = [];
    for (const group of parsed.groups) {
      const visible = group.members.filter((member) => member.visible && member.uuid);
      if (visible.length === 0) continue;
      for (const member of visible) {
        seen.add(member.uuid);
        let host = '';
        let port = 1400;
        try {
          const url = new URL(member.location);
          host = url.hostname;
          port = Number(url.port || 1400);
        } catch {
          continue;
        }
        const known = this.players.get(member.uuid);
        if (known && known.device.host === host && known.device.port === port) {
          known.name = member.name || known.name;
          continue;
        }
        known?.device.destroy();
        // Cover art is served by the players themselves: allow the image proxy to fetch from them.
        this.deps.images.allowLanHost(host);
        this.players.set(member.uuid, {
          uuid: member.uuid,
          name: member.name || 'Lautsprecher',
          device: this.device(host, port),
          model: known?.model ?? null,
          modelAsked: known?.modelAsked ?? false,
          volume: known?.volume ?? 0,
          muted: known?.muted ?? false,
          available: known?.available ?? true,
          failures: 0,
        });
      }
      // The coordinator of a home-theatre set-up can be an invisible member; show the group under a visible one.
      const coordinator = visible.some((member) => member.uuid === group.coordinator) ? group.coordinator : visible[0]!.uuid;
      groups.push({ coordinator, members: [coordinator, ...visible.map((member) => member.uuid).filter((uuid) => uuid !== coordinator)] });
    }
    // Players that left the household (sold, renamed network) disappear; unreachable ones stay, greyed out.
    for (const [uuid, player] of this.players) {
      if (!seen.has(uuid)) {
        player.device.destroy();
        this.players.delete(uuid);
        this.groupCache.delete(uuid);
      }
    }
    this.topology = { groups: groups.filter((group) => group.members.every((uuid) => this.players.has(uuid))) };
  }

  // --- Polling ----------------------------------------------------------------------------------

  private async tick(signal: AbortSignal): Promise<void> {
    if (this.stopped) return;
    const maxAge = this.active ? this.timing.topologyActiveMs : this.timing.topologyIdleMs;
    if (this.topologyDue || this.players.size === 0 || Date.now() - this.topologyAt >= maxAge) await this.readTopology(signal);
    if (this.stopped) return;

    const epoch = this.epoch;
    await Promise.all([...this.players.values()].map((player) => this.readPlayer(player, signal, epoch)));
    const groups = await Promise.all(this.topology.groups.map((group) => this.readGroup(group, signal, epoch)));
    if (this.stopped || signal.aborted) return;
    // A command got in between: its follow-up poll brings the truth.
    if (epoch !== this.epoch) return;

    this.groups = groups.filter((group): group is MusicGroup => group !== null);
    this.lastPollAt = Date.now();
    this.failures = 0;
    this.lastError = null;
    this.publish();
    // Every player unreachable: the picture is stale — look at the household afresh next round.
    if (![...this.players.values()].some((player) => player.available)) this.topologyDue = true;
  }

  private failed(err: unknown): void {
    if (this.stopped) return;
    this.lastError = describeError(err);
    this.failures++;
    if (this.players.size === 0) {
      this.deps.state.patchMusic({ players: [], groups: [] });
      this.deps.state.setService(SERVICE, 'offline', NOTHING_FOUND);
      return;
    }
    if (this.failures >= 2) {
      for (const player of this.players.values()) player.available = false;
      this.topologyDue = true;
      this.publish();
    }
  }

  private async readPlayer(player: Player, signal: AbortSignal, epoch: number): Promise<void> {
    try {
      const [volume, mute] = await Promise.all([
        player.device.call('RenderingControl', 'GetVolume', { InstanceID: 0, Channel: 'Master' }, signal),
        player.device.call('RenderingControl', 'GetMute', { InstanceID: 0, Channel: 'Master' }, signal),
      ]);
      player.available = true;
      if (epoch === this.epoch) {
        const level = Number(volume.CurrentVolume);
        if (Number.isFinite(level)) player.volume = Math.min(100, Math.max(0, Math.round(level)));
        player.muted = mute.CurrentMute === '1';
      }
      player.failures = 0;
      if (!player.modelAsked) {
        player.modelAsked = true;
        player.model = await readModel(player.device).catch(() => null);
      }
    } catch (err) {
      if (signal.aborted) return;
      // One missed answer is not an outage.
      if (++player.failures >= 2) {
        if (player.available) this.deps.log.warn({ player: player.name, reason: describeError(err) }, 'speaker unreachable');
        player.available = false;
        this.topologyDue = true;
      }
    }
  }

  private async readGroup(group: Topology['groups'][number], signal: AbortSignal, epoch: number): Promise<MusicGroup | null> {
    const coordinator = this.players.get(group.coordinator);
    if (!coordinator) return null;
    const members = group.members.map((uuid) => this.players.get(uuid)).filter((player): player is Player => player !== undefined);
    const previous = this.groups.find((entry) => entry.id === coordinator.uuid);
    const base = {
      id: coordinator.uuid,
      coordinatorId: coordinator.uuid,
      memberIds: members.map((member) => member.uuid),
      name: members.length > 1 ? `${coordinator.name} + ${members.length - 1}` : coordinator.name,
      volume: Math.round(members.reduce((sum, member) => sum + member.volume, 0) / Math.max(1, members.length)),
      muted: members.every((member) => member.muted),
    };
    if (!coordinator.available) {
      return { ...base, state: 'stopped', track: previous?.track ?? null, position: null, positionAt: previous?.positionAt ?? Date.now(), shuffle: previous?.shuffle ?? false, repeat: previous?.repeat ?? 'off', canSkip: false, canSeek: false };
    }
    try {
      const cache = this.groupCache.get(coordinator.uuid) ?? { playMode: 'NORMAL', playModeAt: 0, mediaFor: null, mediaTitle: null };
      this.groupCache.set(coordinator.uuid, cache);
      const [transport, position] = await Promise.all([
        coordinator.device.call('AVTransport', 'GetTransportInfo', { InstanceID: 0 }, signal),
        coordinator.device.call('AVTransport', 'GetPositionInfo', { InstanceID: 0 }, signal),
      ]);
      if (Date.now() - cache.playModeAt >= this.timing.settingsMs) {
        const settings = await coordinator.device.call('AVTransport', 'GetTransportSettings', { InstanceID: 0 }, signal);
        if (epoch === this.epoch) {
          cache.playMode = settings.PlayMode ?? 'NORMAL';
          cache.playModeAt = Date.now();
        }
      }

      const uri = position.TrackURI ?? '';
      const source = sourceOf(uri);
      const didl = parseDidl(position.TrackMetaData)[0];
      let track: Track | null = null;
      if (uri && didl) {
        let title = didl.title || null;
        let artist = didl.creator || null;
        let album = didl.album || null;
        if (source === 'radio' || source === 'tv' || source === 'line_in') {
          // The transport's own metadata names the station; the track metadata only carries the current song.
          if (cache.mediaFor !== uri) {
            const media = await coordinator.device.call('AVTransport', 'GetMediaInfo', { InstanceID: 0 }, signal);
            cache.mediaFor = uri;
            cache.mediaTitle = parseDidl(media.CurrentURIMetaData)[0]?.title || null;
          }
          const station = cache.mediaTitle ?? (source === 'tv' ? 'Fernseher' : source === 'line_in' ? 'Line-In' : title);
          // "ZPSTR_CONNECTING" and the like are player status texts, not song titles.
          const song = /^ZPSTR_|^$/.test(didl.streamContent) ? null : didl.streamContent;
          title = song ?? station;
          artist = song ? station : null;
          album = null;
        }
        const art = didl.albumArt ? new URL(didl.albumArt, coordinator.device.baseUrl).toString() : null;
        const duration = parseTime(position.TrackDuration);
        track = { title, artist, album, artUrl: this.deps.images.url(art), duration: duration && duration > 0 ? duration : null, uri, source };
      }

      const state = playbackState(transport.CurrentTransportState ?? '');
      const seconds = parseTime(position.RelTime);
      const now = Date.now();
      // Keep the previous reading while it still predicts the position: otherwise every poll would be "news" for every app.
      let reading = { position: track ? seconds : null, positionAt: now };
      if (previous && previous.track?.uri === track?.uri && previous.state === state) {
        if (previous.position === null && reading.position === null) reading = { position: null, positionAt: previous.positionAt };
        else if (previous.position !== null && reading.position !== null) {
          const expected = previous.position + (state === 'playing' ? (now - previous.positionAt) / 1000 : 0);
          if (Math.abs(expected - reading.position) < 2) reading = { position: previous.position, positionAt: previous.positionAt };
        }
      }
      const live = source === 'radio' || source === 'tv' || source === 'line_in';
      const mode = PLAY_MODES[cache.playMode] ?? PLAY_MODES.NORMAL!;
      return { ...base, state, track, ...reading, shuffle: mode.shuffle, repeat: mode.repeat, canSkip: track !== null && !live, canSeek: track !== null && !live && track.duration !== null };
    } catch (err) {
      if (signal.aborted) return previous ?? null;
      this.lastError = describeError(err);
      return previous ? { ...previous, ...base } : { ...base, state: 'stopped', track: null, position: null, positionAt: Date.now(), shuffle: false, repeat: 'off', canSkip: false, canSeek: false };
    }
  }

  private publish(): void {
    if (this.stopped) return;
    const groupOf = new Map<string, string>();
    for (const group of this.topology.groups) for (const uuid of group.members) groupOf.set(uuid, group.coordinator);
    const players: MusicPlayer[] = [...this.players.values()]
      .map((player) => ({
        id: player.uuid,
        name: player.name,
        room: player.name,
        model: player.model,
        volume: player.volume,
        muted: player.muted,
        groupId: groupOf.get(player.uuid) ?? player.uuid,
        isCoordinator: (groupOf.get(player.uuid) ?? player.uuid) === player.uuid,
        available: player.available,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
    this.deps.state.patchMusic({ players, groups: this.groups });
    const reachable = players.filter((player) => player.available).length;
    if (players.length === 0) this.deps.state.setService(SERVICE, 'offline', NOTHING_FOUND);
    else if (reachable === 0) this.deps.state.setService(SERVICE, 'offline', 'Die Lautsprecher sind gerade nicht erreichbar.');
    else if (reachable < players.length) {
      const missing = players.filter((player) => !player.available).map((player) => player.name);
      this.deps.state.setService(SERVICE, 'degraded', `Nicht erreichbar: ${missing.join(', ')}`);
    } else this.deps.state.setService(SERVICE, 'ok', null);
  }

  /** Shows a change at once and reads the truth shortly after. */
  private refreshSoon(topology = false): void {
    this.epoch++;
    if (topology) this.topologyDue = true;
    this.publish();
    this.poller.kick(300);
    this.poller.kick(1200);
  }

  // --- Commands -------------------------------------------------------------------------------

  private group(groupId: string): { group: MusicGroup; coordinator: Player } {
    const group = this.groups.find((entry) => entry.id === groupId);
    const coordinator = this.players.get(groupId);
    if (!group || !coordinator) throw notFound('Diese Lautsprecher-Gruppe gibt es nicht (mehr).');
    if (!coordinator.available) throw unavailable(`„${coordinator.name}“ ist gerade nicht erreichbar.`);
    return { group, coordinator };
  }

  /** Runs a SOAP action and turns failures into errors a person can read. */
  private async send(player: Player, service: Parameters<SonosDevice['call']>[0], action: string, args: SoapArgs): Promise<Record<string, string>> {
    try {
      return await player.device.call(service, action, args);
    } catch (err) {
      this.lastError = describeError(err);
      if (err instanceof SoapFault) {
        if (err.code === 701 || err.code === 711 || err.code === 714) throw new HttpError(409, 'not_possible', 'Das geht bei der aktuellen Wiedergabe nicht.');
        throw err;
      }
      throw unavailable(`„${player.name}“ antwortet gerade nicht.`);
    }
  }

  private fault(err: unknown): never {
    if (err instanceof HttpError) throw err;
    if (err instanceof SoapFault) throw new HttpError(502, 'device_error', 'Der Lautsprecher hat das abgelehnt.');
    throw err;
  }

  /** Transport / volume command for a group (id = coordinator UUID). Throws `HttpError` on failure. */
  async groupCommand(groupId: string, command: MusicGroupCommand): Promise<void> {
    const { group, coordinator } = this.group(groupId);
    const members = group.memberIds.map((uuid) => this.players.get(uuid)).filter((player): player is Player => player !== undefined);
    // What the app should show at once. Applied after the player confirmed, to whatever object
    // describes the group by then (a poll may have replaced it while we were waiting).
    const shown: Partial<MusicGroup> = {};
    try {
      switch (command.action) {
        case 'play':
          await this.send(coordinator, 'AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
          shown.state = 'playing';
          break;
        case 'pause':
          await this.pause(coordinator);
          shown.state = 'paused';
          break;
        case 'toggle':
          if (group.state === 'playing' || group.state === 'transitioning') {
            await this.pause(coordinator);
            shown.state = 'paused';
          } else {
            await this.send(coordinator, 'AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
            shown.state = 'playing';
          }
          break;
        case 'next':
          await this.send(coordinator, 'AVTransport', 'Next', { InstanceID: 0 });
          break;
        case 'previous':
          await this.send(coordinator, 'AVTransport', 'Previous', { InstanceID: 0 });
          break;
        case 'seek':
          await this.send(coordinator, 'AVTransport', 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: formatTime(command.value) });
          shown.position = Math.max(0, command.value);
          shown.positionAt = Date.now();
          break;
        case 'set_volume': {
          const volume = Math.min(100, Math.max(0, Math.round(command.value)));
          if (members.length > 1) {
            // The snapshot makes the group volume keep the balance between the rooms.
            await this.send(coordinator, 'GroupRenderingControl', 'SnapshotGroupVolume', { InstanceID: 0 });
            await this.send(coordinator, 'GroupRenderingControl', 'SetGroupVolume', { InstanceID: 0, DesiredVolume: volume });
            const average = Math.round(members.reduce((sum, member) => sum + member.volume, 0) / members.length);
            for (const member of members) member.volume = Math.min(100, Math.max(0, member.volume + volume - average));
          } else {
            await this.send(coordinator, 'RenderingControl', 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: volume });
            coordinator.volume = volume;
          }
          shown.volume = volume;
          break;
        }
        case 'set_mute':
          if (members.length > 1) await this.send(coordinator, 'GroupRenderingControl', 'SetGroupMute', { InstanceID: 0, DesiredMute: command.value });
          else await this.send(coordinator, 'RenderingControl', 'SetMute', { InstanceID: 0, Channel: 'Master', DesiredMute: command.value });
          for (const member of members) member.muted = command.value;
          shown.muted = command.value;
          break;
        case 'set_shuffle':
        case 'set_repeat': {
          const shuffle = command.action === 'set_shuffle' ? command.value : group.shuffle;
          const repeat = command.action === 'set_repeat' ? command.value : group.repeat;
          const mode = playModeFor(shuffle, repeat);
          await this.send(coordinator, 'AVTransport', 'SetPlayMode', { InstanceID: 0, NewPlayMode: mode });
          const cache = this.groupCache.get(coordinator.uuid);
          if (cache) {
            cache.playMode = mode;
            cache.playModeAt = Date.now();
          }
          shown.shuffle = shuffle;
          shown.repeat = repeat;
          break;
        }
      }
    } catch (err) {
      this.fault(err);
    }
    const current = this.groups.find((entry) => entry.id === groupId);
    if (current) Object.assign(current, shown);
    this.refreshSoon();
  }

  /** Radio streams cannot be paused; stopping is what "pause" means there. */
  private async pause(coordinator: Player): Promise<void> {
    try {
      await coordinator.device.call('AVTransport', 'Pause', { InstanceID: 0 });
    } catch (err) {
      if (err instanceof SoapFault && (err.code === 701 || err.code === 711)) {
        await this.send(coordinator, 'AVTransport', 'Stop', { InstanceID: 0 });
        return;
      }
      this.lastError = describeError(err);
      if (err instanceof SoapFault) throw err;
      throw unavailable(`„${coordinator.name}“ antwortet gerade nicht.`);
    }
  }

  /** Volume, mute and grouping for a single player. */
  async playerCommand(playerId: string, command: MusicPlayerCommand): Promise<void> {
    const player = this.players.get(playerId);
    if (!player) throw notFound('Diesen Lautsprecher gibt es nicht (mehr).');
    if (!player.available) throw unavailable(`„${player.name}“ ist gerade nicht erreichbar.`);
    let topologyChanged = false;
    try {
      switch (command.action) {
        case 'set_volume': {
          const volume = Math.min(100, Math.max(0, Math.round(command.value)));
          await this.send(player, 'RenderingControl', 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: volume });
          player.volume = volume;
          break;
        }
        case 'set_mute':
          await this.send(player, 'RenderingControl', 'SetMute', { InstanceID: 0, Channel: 'Master', DesiredMute: command.value });
          player.muted = command.value;
          break;
        case 'join': {
          const target = this.players.get(command.groupId);
          if (!target || !this.topology.groups.some((group) => group.coordinator === command.groupId)) throw notFound('Diese Lautsprecher-Gruppe gibt es nicht (mehr).');
          if (target.uuid === player.uuid) break;
          await this.send(player, 'AVTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: `x-rincon:${target.uuid}`, CurrentURIMetaData: '' });
          topologyChanged = true;
          break;
        }
        case 'leave':
          await this.send(player, 'AVTransport', 'BecomeCoordinatorOfStandaloneGroup', { InstanceID: 0 });
          topologyChanged = true;
          break;
      }
    } catch (err) {
      this.fault(err);
    }
    // Keep the group's average in step with what was just set.
    for (const group of this.groups) {
      const members = group.memberIds.map((uuid) => this.players.get(uuid)).filter((member): member is Player => member !== undefined);
      if (members.length === 0) continue;
      group.volume = Math.round(members.reduce((sum, member) => sum + member.volume, 0) / members.length);
      group.muted = members.every((member) => member.muted);
    }
    this.refreshSoon(topologyChanged);
  }

  // --- Favourites ---------------------------------------------------------------------------------

  private async loadFavorites(): Promise<Favorite[]> {
    if (this.favoriteCache && Date.now() - this.favoriteCache.at < this.timing.favoritesCacheMs) return this.favoriteCache.list;
    const player = [...this.players.values()].find((entry) => entry.available);
    if (!player) throw unavailable('Die Lautsprecher sind gerade nicht erreichbar.');
    const answer = await this.send(player, 'ContentDirectory', 'Browse', { ObjectID: 'FV:2', BrowseFlag: 'BrowseDirectChildren', Filter: '*', StartingIndex: 0, RequestedCount: 100, SortCriteria: '' });
    const list: Favorite[] = [];
    for (const entry of parseDidl(answer.Result)) {
      // Favourites without a URI are shortcuts into a service's menus; they cannot be played directly.
      if (!entry.res || !entry.title) continue;
      const art = entry.albumArt ? new URL(entry.albumArt, player.device.baseUrl).toString() : null;
      list.push({
        uri: entry.res,
        metadata: entry.resMD,
        item: {
          // Stable across restarts and re-ordering: derived from what the favourite plays.
          id: `sonos:fav:${createHash('sha256').update(entry.res).digest('hex').slice(0, 16)}`,
          type: isStreamUri(entry.res) ? 'radio' : 'favorite',
          title: entry.title,
          subtitle: entry.description || null,
          artUrl: this.deps.images.url(art),
          browsable: false,
          playable: true,
          source: 'sonos',
        },
      });
    }
    this.favoriteCache = { at: Date.now(), list };
    return list;
  }

  /** The household's Sonos favourites as playable items (`sonos:fav:<id>`). */
  async favorites(): Promise<MediaItem[]> {
    try {
      return (await this.loadFavorites()).map((favorite) => favorite.item);
    } catch (err) {
      this.fault(err);
    }
  }

  // --- Playing ------------------------------------------------------------------------------------

  private enqueueError(err: unknown): never {
    if (err instanceof HttpError) throw err;
    if (err instanceof SoapFault) {
      throw new HttpError(502, 'not_playable', 'Sonos konnte den Inhalt nicht laden. Ist Spotify in der Sonos-App verbunden (und UPnP in der Sonos-App aktiviert)?');
    }
    throw err;
  }

  private async addToQueue(coordinator: Player, uri: string, metadata: string, asNext: boolean): Promise<number> {
    const answer = await this.send(coordinator, 'AVTransport', 'AddURIToQueue', { InstanceID: 0, EnqueuedURI: uri, EnqueuedURIMetaData: metadata, DesiredFirstTrackNumberEnqueued: 0, EnqueueAsNext: asNext });
    return Number(answer.FirstTrackNumberEnqueued) || 1;
  }

  /** Adds Spotify content, trying the other region's service number when the household refuses the first. */
  private async addSpotify(coordinator: Player, uri: string, title: string, asNext: boolean): Promise<number> {
    const regions = [this.spotifyRegion, ...(Object.keys(SPOTIFY_SERVICE_NUMBER) as (keyof typeof SPOTIFY_SERVICE_NUMBER)[]).filter((region) => region !== this.spotifyRegion)];
    let lastErr: unknown;
    for (const region of regions) {
      const enqueue = spotifyEnqueue(uri, title, region);
      if (!enqueue) throw new HttpError(400, 'unsupported', 'Dieser Inhalt kann nicht abgespielt werden.');
      try {
        const first = await this.addToQueue(coordinator, enqueue.uri, enqueue.metadata, asNext);
        if (region !== this.spotifyRegion) {
          this.deps.log.info({ region }, 'sonos: the household uses the other Spotify region');
          this.spotifyRegion = region;
        }
        return first;
      } catch (err) {
        lastErr = err;
        // Only "the player refused the content" is worth a second try with the other service number.
        if (!(err instanceof SoapFault)) throw err;
      }
    }
    throw lastErr;
  }

  private async clearQueue(coordinator: Player): Promise<void> {
    try {
      await coordinator.device.call('AVTransport', 'RemoveAllTracksFromQueue', { InstanceID: 0 });
    } catch (err) {
      // "Queue is already empty" is not a problem.
      if (!(err instanceof SoapFault)) throw unavailable(`„${coordinator.name}“ antwortet gerade nicht.`);
    }
  }

  private async playQueue(coordinator: Player, trackNumber: number): Promise<void> {
    await this.send(coordinator, 'AVTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: `x-rincon-queue:${coordinator.uuid}#0`, CurrentURIMetaData: '' });
    if (trackNumber > 1) await this.send(coordinator, 'AVTransport', 'Seek', { InstanceID: 0, Unit: 'TRACK_NR', Target: trackNumber });
    await this.send(coordinator, 'AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
  }

  /** Starts / queues a favourite or Spotify content on a group. */
  async play(groupId: string, request: SonosPlayRequest): Promise<void> {
    const { coordinator } = this.group(groupId);
    // One "play this" at a time per household: two interleaved queue rebuilds would mix their tracks.
    await this.enqueueLock.run(async () => {
      try {
        switch (request.kind) {
          case 'favorite': {
            const favorite = (await this.loadFavorites()).find((entry) => entry.item.id === request.favoriteId);
            if (!favorite) throw notFound('Diesen Favoriten gibt es nicht (mehr).');
            if (isStreamUri(favorite.uri)) {
              await this.send(coordinator, 'AVTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: favorite.uri, CurrentURIMetaData: favorite.metadata });
              await this.send(coordinator, 'AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
            } else if (request.mode === 'now') {
              await this.clearQueue(coordinator);
              // The favourite's own metadata carries the household's real service token — the most reliable way to start service content.
              await this.addToQueue(coordinator, favorite.uri, favorite.metadata, false);
              await this.playQueue(coordinator, 1);
            } else {
              await this.addToQueue(coordinator, favorite.uri, favorite.metadata, request.mode === 'next');
            }
            break;
          }
          case 'spotify': {
            if (request.mode === 'now') {
              await this.clearQueue(coordinator);
              await this.addSpotify(coordinator, request.uri, request.title, false);
              await this.playQueue(coordinator, Math.max(0, request.startIndex ?? 0) + 1);
            } else {
              await this.addSpotify(coordinator, request.uri, request.title, request.mode === 'next');
            }
            break;
          }
          case 'spotify_tracks': {
            const [first, ...rest] = request.tracks;
            if (!first) throw new HttpError(400, 'empty', 'Diese Liste enthält keine Titel.');
            if (request.mode === 'now') {
              await this.clearQueue(coordinator);
              await this.addSpotify(coordinator, first.uri, first.title, false);
              // Music starts with the first track; the rest follows while it already plays.
              await this.playQueue(coordinator, 1);
              this.inBackground(() => this.addMany(coordinator, rest, false));
            } else if (request.mode === 'next') {
              // One batch, so the tracks keep their order behind the current one.
              await this.addMany(coordinator, request.tracks.slice(0, ENQUEUE_CHUNK), true);
            } else {
              await this.addSpotify(coordinator, first.uri, first.title, false);
              this.inBackground(() => this.addMany(coordinator, rest, false));
            }
            break;
          }
        }
      } catch (err) {
        this.enqueueError(err);
      }
    });
    this.refreshSoon();
  }

  private async addMany(coordinator: Player, tracks: { uri: string; title: string }[], asNext: boolean): Promise<void> {
    for (let offset = 0; offset < tracks.length; offset += ENQUEUE_CHUNK) {
      if (this.stopped) return;
      const chunk = tracks
        .slice(offset, offset + ENQUEUE_CHUNK)
        .map((track) => spotifyEnqueue(track.uri, track.title, this.spotifyRegion))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      if (chunk.length === 0) continue;
      await this.send(coordinator, 'AVTransport', 'AddMultipleURIsToQueue', {
        InstanceID: 0,
        UpdateID: 0,
        NumberOfURIs: chunk.length,
        EnqueuedURIs: chunk.map((entry) => entry.uri).join(' '),
        EnqueuedURIsMetaData: chunk.map((entry) => entry.metadata).join(' '),
        ContainerURI: '',
        ContainerMetaData: '',
        DesiredFirstTrackNumberEnqueued: 0,
        EnqueueAsNext: asNext,
      });
    }
  }

  /** Work that may outlive the request that started it; failures are logged, `stop()` waits for it. */
  private inBackground(work: () => Promise<void>): void {
    const task = work()
      .catch((err: unknown) => this.deps.log.warn({ reason: describeError(err) }, 'sonos: could not add the remaining tracks'))
      .finally(() => this.background.delete(task));
    this.background.add(task);
  }

  /** Connection test for (possibly unsaved) settings. Never throws. */
  static async test(settings: SonosSettings, options: SonosOptions = {}): Promise<TestResult> {
    const timeoutMs = options.timing?.requestTimeoutMs ?? 4000;
    try {
      const configured = settings.hosts.length > 0;
      const seeds = configured ? settings.hosts : await (options.discover ?? (() => discoverPlayers()))();
      if (seeds.length === 0) {
        return { ok: false, message: 'Es wurden keine Lautsprecher gefunden.', details: ['Hängt der Hub im selben Netz wie die Lautsprecher?', 'Sonst oben die IP-Adresse eines Lautsprechers eintragen.', 'In der Sonos-App muss unter „Konto › Datenschutz & Sicherheit“ der Schalter „UPnP“ eingeschaltet sein.'] };
      }
      for (const seed of seeds) {
        const { host, port } = parseHost(seed);
        const device = new SonosDevice(host, port, timeoutMs);
        try {
          const answer = await device.call('ZoneGroupTopology', 'GetZoneGroupState');
          const members = parseTopology(answer.ZoneGroupState ?? '').groups.flatMap((group) => group.members.filter((member) => member.visible));
          if (members.length === 0) continue;
          const details: string[] = [];
          for (const member of members) {
            let address = '';
            let model: string | null = null;
            try {
              const url = new URL(member.location);
              address = url.hostname;
              const probe = new SonosDevice(url.hostname, Number(url.port || 1400), timeoutMs);
              model = await readModel(probe).catch(() => null);
              probe.destroy();
            } catch {
              /* a member without a usable address is still listed */
            }
            details.push([member.name, model, address].filter(Boolean).join(' · '));
          }
          const rooms = members.map((member) => member.name).join(', ');
          return { ok: true, message: `${members.length} Lautsprecher gefunden: ${rooms}.`, details: [configured ? 'Über die eingetragene Adresse gefunden.' : 'Automatisch im Netz gefunden.', ...details] };
        } catch {
          /* try the next address */
        } finally {
          device.destroy();
        }
      }
      return { ok: false, message: 'Unter dieser Adresse antwortet kein Sonos-Lautsprecher.', details: ['Stimmt die IP-Adresse?', 'In der Sonos-App muss unter „Konto › Datenschutz & Sicherheit“ der Schalter „UPnP“ eingeschaltet sein.'] };
    } catch (err) {
      return { ok: false, message: 'Der Test konnte nicht abgeschlossen werden.', details: [describeError(err)] };
    }
  }
}
