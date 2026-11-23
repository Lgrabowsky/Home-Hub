import { EventEmitter } from 'node:events';
import {
  EMPTY_LAYOUT,
  SERVICE_IDS,
  applyLayout,
  realRooms,
  type Entity,
  type Floor,
  type HouseLayout,
  type HubEvent,
  type HubState,
  type MusicState,
  type ServiceHealth,
  type ServiceId,
  type ServiceStatus,
} from '@home-hub/shared';

/**
 * The hub's live picture of the house. Integrations write into it, the
 * realtime layer fans changes out to the connected apps.
 */

export interface StateEvents {
  entities: [changed: Entity[], removed: Entity[]];
  music: [music: MusicState];
  services: [services: ServiceHealth[]];
  event: [event: HubEvent];
  layout: [];
}

const EMPTY_MUSIC: MusicState = { players: [], groups: [], spotify: { linked: false, account: null } };

export class StateStore extends EventEmitter<StateEvents> {
  /** As the integrations report them. */
  private readonly raw = new Map<string, Entity>();
  /** As the apps see them: with the household's names, rooms and visibility (see HouseLayout). */
  private readonly entities = new Map<string, Entity>();
  private readonly fingerprints = new Map<string, string>();
  private readonly owners = new Map<string, Set<string>>();
  private readonly services = new Map<ServiceId, ServiceHealth>();
  private music: MusicState = EMPTY_MUSIC;
  private musicFingerprint = JSON.stringify(EMPTY_MUSIC);
  hubName = 'Zuhause';
  private layout: HouseLayout = EMPTY_LAYOUT;
  /** Areas used while the household has not arranged its own (from the general settings of earlier versions, or the demo). */
  private baseFloors: Floor[] = [];
  /** Rooms with more than contacts (key → name); contacts on a collective page go to the room their name mentions. */
  private rooms = new Map<string, string>();
  private roomsFingerprint = '';

  constructor() {
    super();
    this.setMaxListeners(50);
    const now = Date.now();
    for (const id of SERVICE_IDS) {
      this.services.set(id, { id, status: 'unconfigured', message: null, lastOkAt: null, since: now });
    }
  }

  // --- Entities ----------------------------------------------------------------

  /**
   * Replaces everything `owner` contributed before by `list`. Only real
   * differences are broadcast.
   */
  replace(owner: string, list: Entity[]): void {
    const previous = this.owners.get(owner) ?? new Set<string>();
    const next = new Set<string>();
    const changed: Entity[] = [];
    for (const entity of list) {
      next.add(entity.id);
      if (this.store(entity)) changed.push(this.entities.get(entity.id)!);
    }
    const removed: Entity[] = [];
    for (const id of previous) {
      if (!next.has(id)) {
        const entity = this.entities.get(id);
        if (entity) removed.push(entity);
        this.entities.delete(id);
        this.raw.delete(id);
        this.fingerprints.delete(id);
      }
    }
    this.owners.set(owner, next);
    changed.push(...this.refreshRooms());
    if (changed.length > 0 || removed.length > 0) this.emit('entities', changed, removed);
  }

  /** Adds or updates a single entity without touching the owner's other entities. */
  upsert(owner: string, entity: Entity): void {
    let set = this.owners.get(owner);
    if (!set) this.owners.set(owner, (set = new Set()));
    set.add(entity.id);
    const changed = this.store(entity) ? [this.entities.get(entity.id)!] : [];
    changed.push(...this.refreshRooms());
    if (changed.length > 0) this.emit('entities', changed, []);
  }

  /** Applies a partial update to one entity. Returns false when it does not exist. */
  patch<E extends Entity>(id: string, partial: Partial<E>): boolean {
    const current = this.raw.get(id);
    if (!current) return false;
    const next = { ...current, ...partial } as Entity;
    if (this.store(next)) this.emit('entities', [this.entities.get(id)!], []);
    return true;
  }

  /** Flags all entities of an owner (un)available, e.g. when its device drops off the network. */
  setAvailable(owner: string, available: boolean): void {
    const changed: Entity[] = [];
    for (const id of this.owners.get(owner) ?? []) {
      const entity = this.raw.get(id);
      if (entity && entity.available !== available) {
        const next = { ...entity, available } as Entity;
        if (this.store(next)) changed.push(this.entities.get(id)!);
      }
    }
    if (changed.length > 0) this.emit('entities', changed, []);
  }

  /** Keeps the reported entity and stores it as the apps see it. True when that changed. */
  private store(entity: Entity): boolean {
    this.raw.set(entity.id, entity);
    const shown = applyLayout(entity, this.layout, this.rooms);
    const fingerprint = JSON.stringify(shown);
    if (this.fingerprints.get(entity.id) === fingerprint) return false;
    this.entities.set(entity.id, shown);
    this.fingerprints.set(entity.id, fingerprint);
    return true;
  }

  /** Applies the layout to everything again; returns what changed. */
  private restore(): Entity[] {
    const changed: Entity[] = [];
    for (const entity of this.raw.values()) if (this.store(entity)) changed.push(this.entities.get(entity.id)!);
    return changed;
  }

  /** When rooms appear or disappear, contacts may belong elsewhere now. */
  private refreshRooms(): Entity[] {
    const rooms = realRooms(this.raw.values(), this.music.players.map((player) => player.room));
    const fingerprint = [...rooms.keys()].sort().join('|');
    if (fingerprint === this.roomsFingerprint) return [];
    this.rooms = rooms;
    this.roomsFingerprint = fingerprint;
    return this.restore();
  }

  get(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  all(): Entity[] {
    return [...this.entities.values()];
  }

  // --- Music -------------------------------------------------------------------

  getMusic(): MusicState {
    return this.music;
  }

  setMusic(music: MusicState): void {
    const fingerprint = JSON.stringify(music);
    if (fingerprint === this.musicFingerprint) return;
    this.music = music;
    this.musicFingerprint = fingerprint;
    this.emit('music', music);
    const changed = this.refreshRooms();
    if (changed.length > 0) this.emit('entities', changed, []);
  }

  /** Updates only the given parts (players/groups come from Sonos, the link status from Spotify). */
  patchMusic(partial: Partial<MusicState>): void {
    this.setMusic({ ...this.music, ...partial });
  }

  // --- Services ------------------------------------------------------------------

  getService(id: ServiceId): ServiceHealth {
    return this.services.get(id)!;
  }

  allServices(): ServiceHealth[] {
    return [...this.services.values()];
  }

  setService(id: ServiceId, status: ServiceStatus, message: string | null = null): void {
    const current = this.services.get(id)!;
    const now = Date.now();
    const lastOkAt = status === 'ok' ? now : current.lastOkAt;
    if (current.status === status && current.message === message) {
      // Same state: only remember the latest successful contact, without broadcasting.
      current.lastOkAt = lastOkAt;
      return;
    }
    const next: ServiceHealth = { id, status, message, lastOkAt, since: now };
    this.services.set(id, next);
    this.emit('services', [next]);
  }

  // --- Events / snapshot -----------------------------------------------------------

  /** Name of the house; every app receives a fresh snapshot when it changes. */
  setHubName(hubName: string): void {
    if (hubName === this.hubName) return;
    this.hubName = hubName;
    this.emit('layout');
  }

  /** The household's arrangement of the house; applied to every device, and every app receives a fresh snapshot. */
  setHouseLayout(layout: HouseLayout, baseFloors: Floor[] = this.baseFloors): void {
    this.layout = layout;
    this.baseFloors = baseFloors;
    const changed = this.restore();
    if (changed.length > 0) this.emit('entities', changed, []);
    this.emit('layout');
  }

  getHouseLayout(): HouseLayout {
    return this.layout;
  }

  publish(event: HubEvent): void {
    this.emit('event', event);
  }

  snapshot(): HubState {
    const entities: Record<string, Entity> = {};
    for (const [id, entity] of this.entities) entities[id] = entity;
    const services = {} as Record<ServiceId, ServiceHealth>;
    for (const [id, health] of this.services) services[id] = health;
    return { serverTime: Date.now(), hubName: this.hubName, floors: this.layout.floors ?? this.baseFloors, layout: this.layout, services, entities, music: this.music };
  }
}
