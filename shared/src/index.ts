/**
 * Shared contract between the hub (server) and the clients (web / Android).
 *
 * The hub normalises everything it learns from MyGekko, DoorBird, Reolink,
 * Sonos and Spotify into the service-agnostic model below, so the UI never has
 * to know which vendor a tile belongs to.
 */

export const API_VERSION = 1;

// ---------------------------------------------------------------------------
// Users, roles, permissions
// ---------------------------------------------------------------------------

export const ROLES = ['admin', 'member', 'guest'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Fine grained permissions. Every signed-in user may *see* lights, blinds,
 * climate and what is playing; everything else is gated explicitly.
 */
export const PERMISSIONS = [
  'home.control', // switch lights, move blinds, run actions, change climate
  'music.control', // control Sonos / start playback
  'cameras.view', // live video + snapshots of cameras
  'cameras.control', // PTZ, talk through the camera speaker, spotlight / siren
  'doors.view', // door station video, history, intercom
  'doors.open', // trigger a door opener relay
  'security.view', // window / door contacts and alarm state
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_DEFAULT_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  member: PERMISSIONS,
  guest: ['home.control', 'music.control'],
};

export const PERMISSION_LABELS: Record<Permission, string> = {
  'home.control': 'Licht, Jalousien, Geräte und Automationen bedienen',
  'music.control': 'Musik steuern',
  'cameras.view': 'Kameras ansehen',
  'cameras.control': 'Kameras schwenken und gegensprechen',
  'doors.view': 'Türstationen ansehen, Verlauf und Gegensprechen',
  'doors.open': 'Türen öffnen',
  'security.view': 'Fenster-/Türkontakte und Alarmstatus einsehen',
};

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  member: 'Mitglied',
  guest: 'Gast',
};

export interface UserInfo {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  permissions: Permission[];
  totpEnabled: boolean;
  disabled: boolean;
  createdAt: number;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  client: 'web' | 'native';
  deviceName: string | null;
  userAgent: string | null;
  ip: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

/** Per-user preferences that follow the user across devices. */
export interface UserPrefs {
  /** Entity ids pinned to the overview. */
  favorites: string[];
  /** Room names in the order the user wants to see them. */
  roomOrder: string[];
  /** Rooms hidden from the overview. */
  hiddenRooms: string[];
  /** Last selected music group. */
  lastMusicPlayerId?: string | null;
}

export const DEFAULT_PREFS: UserPrefs = {
  favorites: [],
  roomOrder: [],
  hiddenRooms: [],
  lastMusicPlayerId: null,
};

// ---------------------------------------------------------------------------
// Services (integrations) and their health
// ---------------------------------------------------------------------------

export const SERVICE_IDS = ['mygekko', 'doorbird', 'reolink', 'sonos', 'spotify', 'media'] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

export const SERVICE_LABELS: Record<ServiceId, string> = {
  mygekko: 'myGEKKO',
  doorbird: 'DoorBird',
  reolink: 'Reolink',
  sonos: 'Sonos',
  spotify: 'Spotify',
  media: 'Video-Dienst',
};

export type ServiceStatus = 'unconfigured' | 'starting' | 'ok' | 'degraded' | 'offline';

export interface ServiceHealth {
  id: ServiceId;
  status: ServiceStatus;
  /** Short German description of the current problem (if any). */
  message: string | null;
  /** Timestamp (ms) of the last successful contact. */
  lastOkAt: number | null;
  /** Timestamp (ms) since when the status holds. */
  since: number;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export type EntityKind =
  | 'light'
  | 'blind'
  | 'switch'
  | 'climate'
  | 'action'
  | 'clock'
  | 'contact'
  | 'alarm'
  | 'sensor'
  | 'camera'
  | 'door';

interface BaseEntity {
  /** Globally unique, stable id, e.g. `gekko:lights/item3` or `cam:garten`. */
  id: string;
  kind: EntityKind;
  name: string;
  /** Room name used for grouping (null = no room / whole house). */
  room: string | null;
  /** false while the backing device is unreachable. */
  available: boolean;
  service: ServiceId;
}

export interface LightEntity extends BaseEntity {
  kind: 'light';
  on: boolean;
  /** 0–100, null when the light is not dimmable. */
  brightness: number | null;
  /** `#rrggbb`, null when the light has no colour. */
  color: string | null;
  /** Tunable-white level 0–100 (0 = warm, 100 = cold), null when unsupported. */
  colorTemp: number | null;
  features: { dim: boolean; color: boolean; colorTemp: boolean };
  /** True for a myGEKKO light group. */
  isGroup: boolean;
}

export interface BlindEntity extends BaseEntity {
  kind: 'blind';
  /** 0 = fully open (up), 100 = fully closed (down). null when unknown. */
  position: number | null;
  /** Slat angle in percent of the rotation range (0–100), null when unsupported. */
  tilt: number | null;
  motion: 'up' | 'down' | 'stopped';
  features: { position: boolean; tilt: boolean };
  isGroup: boolean;
  /** Blocked by wind/alarm/lock on the controller. */
  locked: boolean;
}

export interface SwitchEntity extends BaseEntity {
  kind: 'switch';
  on: boolean;
  /** Free-form hint for the icon: 'socket' | 'pump' | 'fan' | 'generic'. */
  variant: string;
  /** For impulse / push button loads the hub only offers "trigger". */
  momentary: boolean;
}

export interface ClimateEntity extends BaseEntity {
  kind: 'climate';
  temperature: number | null;
  target: number | null;
  humidity: number | null;
  /** Heating valve / output level in percent. */
  output: number | null;
  mode: 'off' | 'comfort' | 'reduced' | 'manual' | 'standby' | 'unknown';
  heating: boolean;
  cooling: boolean;
  /** Window-open detection reported by the controller. */
  windowOpen: boolean | null;
  targetRange: { min: number; max: number; step: number };
  features: { target: boolean; mode: boolean };
}

export interface ActionEntity extends BaseEntity {
  kind: 'action';
  /** Whether the action reports a running / active state. */
  active: boolean | null;
  features: { start: boolean; stop: boolean };
}

export interface ClockEntity extends BaseEntity {
  kind: 'clock';
  /** Timer enabled? null when the controller does not report it. */
  enabled: boolean | null;
  /** Output currently switched on by the clock. */
  active: boolean | null;
  features: { toggle: boolean };
}

export type ContactType = 'window' | 'door' | 'garage' | 'motion' | 'other';

export interface ContactEntity extends BaseEntity {
  kind: 'contact';
  open: boolean;
  contactType: ContactType;
  /** Alarm zone the contact belongs to, e.g. "Hülle". */
  zone: string | null;
  /** Tamper / fault reported for this detector. */
  fault: boolean;
  /** When the contact last changed (ms), if known. */
  changedAt: number | null;
}

export type AlarmMode = 'disarmed' | 'armed' | 'unknown';

/**
 * One zone of the controller's alarm system (e.g. "Hülle").
 * myGEKKO only reports a zone as a whole — individual detectors are modelled
 * as `ContactEntity` where the controller exposes them.
 */
export interface AlarmEntity extends BaseEntity {
  kind: 'alarm';
  /** Name of the alarm system the zone belongs to. */
  system: string;
  mode: AlarmMode;
  /** An alarm is being raised right now. */
  triggered: boolean;
  /** At least one detector of the zone is tripped (e.g. a window is open) without an alarm being raised. */
  breached: boolean;
  /** Short German state text, e.g. "Unscharf · mindestens ein Kontakt offen". */
  stateText: string;
}

export interface SensorEntity extends BaseEntity {
  kind: 'sensor';
  sensorType:
    | 'temperature'
    | 'humidity'
    | 'wind'
    | 'brightness'
    | 'rain'
    | 'power'
    | 'energy'
    | 'co2'
    | 'generic';
  value: number | string | null;
  unit: string | null;
}

export interface CameraEntity extends BaseEntity {
  kind: 'camera';
  model: string | null;
  features: {
    ptz: boolean;
    zoom: boolean;
    presets: boolean;
    /** Speaker available: talking through the camera is possible. */
    talk: boolean;
    /** Microphone available: listening is possible. */
    audio: boolean;
    light: boolean;
    siren: boolean;
  };
  /** Spotlight state if the camera has one. */
  lightOn: boolean | null;
}

export interface DoorRelay {
  id: string;
  name: string;
}

export interface DoorEntity extends BaseEntity {
  kind: 'door';
  model: string | null;
  relays: DoorRelay[];
  features: { talk: boolean; audio: boolean; light: boolean };
  /** Most recent ring. */
  lastRingAt: number | null;
  /** Most recent motion event. */
  lastMotionAt: number | null;
}

export type Entity =
  | LightEntity
  | BlindEntity
  | SwitchEntity
  | ClimateEntity
  | ActionEntity
  | ClockEntity
  | ContactEntity
  | AlarmEntity
  | SensorEntity
  | CameraEntity
  | DoorEntity;

export type EntityOf<K extends EntityKind> = Extract<Entity, { kind: K }>;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type EntityCommand =
  | { action: 'turn_on' }
  | { action: 'turn_off' }
  | { action: 'toggle' }
  | { action: 'set_brightness'; value: number }
  | { action: 'set_color'; value: string }
  | { action: 'set_color_temp'; value: number }
  | { action: 'up' }
  | { action: 'down' }
  | { action: 'stop' }
  | { action: 'set_position'; value: number }
  | { action: 'set_tilt'; value: number }
  | { action: 'set_target'; value: number }
  | { action: 'set_mode'; value: ClimateEntity['mode'] }
  | { action: 'run' }
  | { action: 'enable' }
  | { action: 'disable' };

export type EntityCommandAction = EntityCommand['action'];

// ---------------------------------------------------------------------------
// Cameras / doors
// ---------------------------------------------------------------------------

export const PTZ_OPS = [
  'left',
  'right',
  'up',
  'down',
  'left_up',
  'left_down',
  'right_up',
  'right_down',
  'zoom_in',
  'zoom_out',
  'stop',
] as const;
export type PtzOp = (typeof PTZ_OPS)[number];

export interface PtzPreset {
  id: number;
  name: string;
}

export type StreamQuality = 'main' | 'sub';

export type DoorEventType = 'doorbell' | 'motion' | 'open';

export interface DoorEvent {
  id: string;
  /** Device id of the door station (the entity id is `door:<doorId>`). */
  doorId: string;
  type: DoorEventType;
  ts: number;
  hasImage: boolean;
  /** Display name of the user who opened the door (type = open). */
  actor: string | null;
  /** Relay name (type = open). */
  detail: string | null;
}

export interface DoorHistoryPage {
  events: DoorEvent[];
  /** Pass as `before` to load older entries; null when there are none. */
  nextBefore: number | null;
}

/** ICE configuration handed to the browser for WebRTC. */
export interface MediaConfig {
  iceServers: { urls: string[]; username?: string; credential?: string }[];
  available: boolean;
}

// ---------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------

export type PlaybackState = 'playing' | 'paused' | 'stopped' | 'transitioning';

export type MusicSource = 'spotify' | 'radio' | 'tv' | 'line_in' | 'library' | 'airplay' | 'other';

export interface Track {
  title: string | null;
  artist: string | null;
  album: string | null;
  /** Hub-relative URL (already proxied), null when there is no artwork. */
  artUrl: string | null;
  /** Seconds, null for live streams. */
  duration: number | null;
  uri: string | null;
  source: MusicSource;
}

export interface MusicPlayer {
  /** Sonos player UUID, e.g. RINCON_xxx. */
  id: string;
  name: string;
  room: string | null;
  model: string | null;
  volume: number;
  muted: boolean;
  /** Id of the group this player currently belongs to. */
  groupId: string;
  isCoordinator: boolean;
  available: boolean;
}

export interface MusicGroup {
  /** Coordinator UUID. */
  id: string;
  coordinatorId: string;
  memberIds: string[];
  /** Display name, e.g. "Wohnzimmer + 2". */
  name: string;
  state: PlaybackState;
  track: Track | null;
  /** Playback position in seconds at `positionAt` (ms epoch). */
  position: number | null;
  positionAt: number;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  /** Average volume of all members. */
  volume: number;
  muted: boolean;
  canSkip: boolean;
  canSeek: boolean;
}

export interface MusicState {
  players: MusicPlayer[];
  groups: MusicGroup[];
  spotify: { linked: boolean; account: string | null };
}

export type MusicGroupCommand =
  | { action: 'play' }
  | { action: 'pause' }
  | { action: 'toggle' }
  | { action: 'next' }
  | { action: 'previous' }
  | { action: 'seek'; value: number }
  | { action: 'set_volume'; value: number }
  | { action: 'set_mute'; value: boolean }
  | { action: 'set_shuffle'; value: boolean }
  | { action: 'set_repeat'; value: 'off' | 'all' | 'one' };

export type MusicPlayerCommand =
  | { action: 'set_volume'; value: number }
  | { action: 'set_mute'; value: boolean }
  | { action: 'join'; groupId: string }
  | { action: 'leave' };

/** `folder` is a section of the library ("Playlists", "Lieblingssongs" …) that can only be opened. */
export type MediaItemType = 'track' | 'album' | 'playlist' | 'artist' | 'show' | 'episode' | 'favorite' | 'radio' | 'folder';

/** Something that can be browsed and/or played, regardless of where it comes from. */
export interface MediaItem {
  /** Opaque id understood by the hub (`spotify:playlist:…`, `sonos:fav:…`). */
  id: string;
  type: MediaItemType;
  title: string;
  subtitle: string | null;
  artUrl: string | null;
  /** Can be opened to list children (album, playlist, artist). */
  browsable: boolean;
  playable: boolean;
  source: 'spotify' | 'sonos';
  duration?: number | null;
}

export interface MediaPage {
  title: string;
  subtitle?: string | null;
  artUrl?: string | null;
  /** The container itself, when it can be played as a whole. */
  self?: MediaItem | null;
  items: MediaItem[];
  /** Opaque cursor for the next page. */
  next: string | null;
}

export interface SpotifySearchResult {
  tracks: MediaItem[];
  albums: MediaItem[];
  playlists: MediaItem[];
  artists: MediaItem[];
}

export interface PlayRequest {
  /** MediaItem id. */
  itemId: string;
  /** Replace the queue and play now, or queue after the current track / at the end. */
  mode: 'now' | 'next' | 'queue';
  /** For a track picked from an album/playlist: the container to continue with … */
  contextId?: string | null;
  /** … and the track's position inside it (0-based). */
  index?: number | null;
}

// ---------------------------------------------------------------------------
// Realtime protocol (WebSocket, JSON)
// ---------------------------------------------------------------------------

export interface Room {
  /** Slug used in URLs. */
  id: string;
  name: string;
}

export interface HubState {
  serverTime: number;
  hubName: string;
  services: Record<ServiceId, ServiceHealth>;
  entities: Record<string, Entity>;
  music: MusicState;
}

/** `doorId` is the device id of the door station (the entity id is `door:<doorId>`). */
export type HubEvent =
  | { type: 'doorbell'; doorId: string; doorName: string; ts: number; eventId: string | null }
  | { type: 'door_motion'; doorId: string; doorName: string; ts: number; eventId: string | null }
  | { type: 'door_opened'; doorId: string; doorName: string; ts: number; actor: string; relay: string }
  | { type: 'history_updated'; doorId: string };

export type ServerMessage =
  | { type: 'hello'; apiVersion: number; serverTime: number }
  | { type: 'snapshot'; state: HubState }
  | { type: 'entities'; changed: Entity[]; removed: string[] }
  | { type: 'music'; music: MusicState }
  | { type: 'services'; services: ServiceHealth[] }
  | { type: 'event'; event: HubEvent }
  | { type: 'pong'; t: number }
  | { type: 'session_ended'; reason: 'revoked' | 'expired' };

export type ClientMessage =
  | { type: 'ping'; t: number }
  /** Continuous PTZ: must be repeated at least once per second while held. */
  | { type: 'ptz'; cameraId: string; op: PtzOp; speed?: number };

// ---------------------------------------------------------------------------
// REST payloads
// ---------------------------------------------------------------------------

export interface ApiError {
  error: string;
  message: string;
  /** Seconds until the request may be retried (rate limits). */
  retryAfter?: number;
}

export interface BootstrapInfo {
  apiVersion: number;
  hubName: string;
  setupRequired: boolean;
  demo: boolean;
  version: string;
  /** State of the session the request was made with (so the app need not probe with a failing request). */
  session: 'none' | 'enroll' | 'full';
}

export interface LoginRequest {
  username: string;
  password: string;
  /** TOTP code or recovery code. */
  code?: string;
  client: 'web' | 'native';
  deviceName?: string;
}

export type LoginResponse =
  | { status: 'ok'; user: UserInfo; token?: string }
  | { status: 'totp_required' }
  /** Two-factor enrolment is mandatory and still pending for this user. */
  | { status: 'enroll_required'; user: UserInfo; token?: string };

export interface MeResponse {
  user: UserInfo;
  session: SessionInfo;
  prefs: UserPrefs;
  /** True while the session may only be used to finish 2FA enrolment. */
  enrollRequired: boolean;
}

export interface TotpSetupResponse {
  secret: string;
  otpauthUrl: string;
}

export interface TotpEnableResponse {
  recoveryCodes: string[];
  token?: string;
}

export interface AuditEntry {
  id: number;
  ts: number;
  username: string | null;
  action: string;
  detail: Record<string, unknown> | null;
  ip: string | null;
}

// --- Integration settings (admin) -------------------------------------------

/**
 * Secrets are write-only: the hub returns `SECRET_SET` when a value is stored
 * and accepts `SECRET_SET` back to mean "leave unchanged".
 */
export const SECRET_SET = '••••••••';

/** Tells the hub where the state of one window/door contact can be read on the controller. */
export interface ContactMapping {
  /** Stable id (slug), unique within the list. */
  id: string;
  /** `<system>/<item>`, e.g. `alarms_logics/item81`, `roomtemps/item3`, `accessdoors/item0`. */
  source: string;
  /** Index of the value inside the element's `sumstate` (0-based). */
  field: number;
  /** Which raw value means "open". */
  openWhen: 'nonzero' | 'zero';
  name: string;
  contactType: ContactType;
  room: string;
  /** Alarm zone shown with the contact, e.g. "Hülle". */
  zone: string;
}

/** An element on the controller that could be a contact (shown in the admin mapping / learn UI). */
export interface ContactCandidate {
  source: string;
  system: string;
  name: string;
  page: string | null;
  /** The element's raw sumstate fields right now. */
  fields: string[];
  /** Field labels where the controller documents them (same length as `fields`, '' when unknown). */
  fieldLabels: string[];
  /** What the hub would pick automatically, if anything. */
  suggestion: Pick<ContactMapping, 'field' | 'openWhen' | 'contactType' | 'name' | 'room'> | null;
  /** Ids of the contact entities currently fed from this element. */
  mappedIds: string[];
}

export interface MyGekkoSettings {
  enabled: boolean;
  mode: 'local' | 'cloud';
  /** Local: IP address or host name of the controller. */
  host: string;
  username: string;
  /** Local password, or the API key in cloud mode. */
  password: string;
  /** Cloud only. */
  gekkoId: string;
  /**
   * Derive contacts automatically from what the controller exposes (room
   * controllers with a window contact, access doors, logic elements matching
   * `contactKeywords`). Explicit `contacts` always win.
   */
  autoContacts: boolean;
  /** Comma separated keywords: logic elements whose name or page contains one are treated as contacts. */
  contactKeywords: string;
  /** Comma separated keywords that mark a contact as a door rather than a window. */
  doorKeywords: string;
  /** Name of the zone shown for automatically found contacts. */
  contactZone: string;
  contacts: ContactMapping[];
}

export interface DoorBirdDeviceSettings {
  id: string;
  name: string;
  host: string;
  username: string;
  password: string;
  room: string;
  /** Optional names for the relays, by relay id ("1", "2", "gggaaa@1"). */
  relayNames: Record<string, string>;
  /** Relay ids that must not be offered in the UI. */
  hiddenRelays: string[];
}

export interface DoorBirdSettings {
  enabled: boolean;
  devices: DoorBirdDeviceSettings[];
  /** Days to keep history images on the hub. */
  retentionDays: number;
}

export interface ReolinkDeviceSettings {
  id: string;
  name: string;
  host: string;
  /** HTTP(S) API port, 0 = default for the scheme. */
  port: number;
  https: boolean;
  username: string;
  password: string;
  /** Channel index (0 for stand-alone cameras, 0…n on an NVR). */
  channel: number;
  room: string;
  rtspPort: number;
  /** How the hub pulls video: RTSP (enables talk) or HTTP-FLV. */
  streamProtocol: 'rtsp' | 'flv';
}

export interface ReolinkSettings {
  enabled: boolean;
  devices: ReolinkDeviceSettings[];
}

export interface SonosSettings {
  enabled: boolean;
  /** Optional: IP addresses of speakers when discovery is not possible. */
  hosts: string[];
  /** Sonos' service region for Spotify. */
  spotifyRegion: 'EU' | 'US';
}

export interface SpotifySettings {
  enabled: boolean;
  clientId: string;
  /** Optional – only needed for confidential clients. */
  clientSecret: string;
  market: string;
}

export interface GeneralSettings {
  hubName: string;
  /** Force every user to set up two-factor authentication. */
  requireTotp: boolean;
  /** Days a session stays valid without being used. */
  sessionDays: number;
}

export interface IntegrationSettingsMap {
  general: GeneralSettings;
  mygekko: MyGekkoSettings;
  doorbird: DoorBirdSettings;
  reolink: ReolinkSettings;
  sonos: SonosSettings;
  spotify: SpotifySettings;
}

export type SettingsKey = keyof IntegrationSettingsMap;

export interface TestResult {
  ok: boolean;
  /** German summary. */
  message: string;
  /** Extra lines (device model, firmware, counts …). */
  details: string[];
}

export interface SpotifyStatus {
  configured: boolean;
  linked: boolean;
  account: string | null;
  /** Redirect URI that must be registered in the Spotify developer dashboard. */
  redirectUri: string;
}

export interface DiagnosticsReport {
  version: string;
  uptimeSec: number;
  node: string;
  services: ServiceHealth[];
  media: { running: boolean; version: string | null; streams: number; candidates: string[] };
  counts: Record<string, number>;
  /** Raw, credential-free debug information per integration. */
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Small helpers shared by both sides
// ---------------------------------------------------------------------------

export function slugify(input: string): string {
  return (
    input
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/ß/g, 'ss')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'x'
  );
}

export function hasPermission(user: Pick<UserInfo, 'role' | 'permissions'>, permission: Permission): boolean {
  return user.role === 'admin' || user.permissions.includes(permission);
}

/** Which permission is needed to see an entity at all (null = any signed-in user). */
export function viewPermissionFor(kind: EntityKind): Permission | null {
  switch (kind) {
    case 'camera':
      return 'cameras.view';
    case 'door':
      return 'doors.view';
    case 'contact':
    case 'alarm':
      return 'security.view';
    default:
      return null;
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
