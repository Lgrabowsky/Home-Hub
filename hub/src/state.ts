import { EventEmitter } from 'node:events';
import {
  SERVICE_IDS,
  type Entity,
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
}

const EMPTY_MUSIC: MusicState = { players: [], groups: [], spotify: { linked: false, account: null } };

export class StateStore extends EventEmitter<StateEvents> {
  private readonly entities = new Map<string, Entity>();
  private readonly fingerprints = new Map<string, string>();
  private readonly owners = new Map<string, Set<string>>();
  private readonly services = new Map<ServiceId, ServiceHealth>();
  private music: MusicState = EMPTY_MUSIC;
  private musicFingerprint = JSON.stringify(EMPTY_MUSIC);
  hubName = 'Zuhause';

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
      if (this.store(entity)) changed.push(entity);
    }
    const removed: Entity[] = [];
    for (const id of previous) {
      if (!next.has(id)) {
        const entity = this.entities.get(id);
        if (entity) removed.push(entity);
        this.entities.delete(id);
        this.fingerprints.delete(id);
      }
    }
    this.owners.set(owner, next);
    if (changed.length > 0 || removed.length > 0) this.emit('entities', changed, removed);
  }

  /** Adds or updates a single entity without touching the owner's other entities. */
  upsert(owner: string, entity: Entity): void {
    let set = this.owners.get(owner);
    if (!set) this.owners.set(owner, (set = new Set()));
    set.add(entity.id);
    if (this.store(entity)) this.emit('entities', [entity], []);
  }

  /** Applies a partial update to one entity. Returns false when it does not exist. */
  patch<E extends Entity>(id: string, partial: Partial<E>): boolean {
    const current = this.entities.get(id);
    if (!current) return false;
    const next = { ...current, ...partial } as Entity;
    if (this.store(next)) this.emit('entities', [next], []);
    return true;
  }

  /** Flags all entities of an owner (un)available, e.g. when its device drops off the network. */
  setAvailable(owner: string, available: boolean): void {
    const changed: Entity[] = [];
    for (const id of this.owners.get(owner) ?? []) {
      const entity = this.entities.get(id);
      if (entity && entity.available !== available) {
        const next = { ...entity, available } as Entity;
        if (this.store(next)) changed.push(next);
      }
    }
    if (changed.length > 0) this.emit('entities', changed, []);
  }

  private store(entity: Entity): boolean {
    const fingerprint = JSON.stringify(entity);
    if (this.fingerprints.get(entity.id) === fingerprint) return false;
    this.entities.set(entity.id, entity);
    this.fingerprints.set(entity.id, fingerprint);
    return true;
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

  publish(event: HubEvent): void {
    this.emit('event', event);
  }

  snapshot(): HubState {
    const entities: Record<string, Entity> = {};
    for (const [id, entity] of this.entities) entities[id] = entity;
    const services = {} as Record<ServiceId, ServiceHealth>;
    for (const [id, health] of this.services) services[id] = health;
    return { serverTime: Date.now(), hubName: this.hubName, services, entities, music: this.music };
  }
}
