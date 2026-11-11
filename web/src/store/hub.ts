import { create } from 'zustand';
import type { Entity, HubEvent, HubState, MusicState, ServiceHealth, ServiceId } from '@home-hub/shared';

/**
 * Live picture of the house as pushed by the hub. Components read from here;
 * the realtime client (lib/realtime.ts) is the only writer besides optimistic
 * updates after a command.
 */

export type LinkState = 'connecting' | 'online' | 'offline';

export interface ActiveRing {
  doorId: string;
  doorName: string;
  ts: number;
}

interface HubStore {
  link: LinkState;
  /** A snapshot has been received at least once since signing in. */
  loaded: boolean;
  hubName: string;
  /** Hub clock minus device clock (ms) — used to extrapolate playback positions. */
  clockOffset: number;
  entities: Record<string, Entity>;
  services: Partial<Record<ServiceId, ServiceHealth>>;
  music: MusicState;
  /** A doorbell that is ringing right now (drives the full-screen overlay). */
  ring: ActiveRing | null;

  setLink(link: LinkState): void;
  applySnapshot(state: HubState): void;
  applyEntities(changed: Entity[], removed: string[]): void;
  setMusic(music: MusicState): void;
  setServices(services: ServiceHealth[]): void;
  /** Optimistic local change right after the user acted; the hub's next update replaces it. */
  patchEntity(id: string, partial: Partial<Entity>): void;
  patchMusic(update: (music: MusicState) => MusicState): void;
  setRing(ring: ActiveRing | null): void;
  reset(): void;
}

const EMPTY_MUSIC: MusicState = { players: [], groups: [], spotify: { linked: false, account: null } };

export const useHub = create<HubStore>((set) => ({
  link: 'connecting',
  loaded: false,
  hubName: 'Zuhause',
  clockOffset: 0,
  entities: {},
  services: {},
  music: EMPTY_MUSIC,
  ring: null,

  setLink: (link) => set({ link }),

  applySnapshot: (state) =>
    set({
      loaded: true,
      hubName: state.hubName,
      clockOffset: state.serverTime - Date.now(),
      entities: state.entities,
      services: state.services,
      music: state.music,
    }),

  applyEntities: (changed, removed) =>
    set((store) => {
      const entities = { ...store.entities };
      for (const entity of changed) entities[entity.id] = entity;
      for (const id of removed) delete entities[id];
      return { entities };
    }),

  setMusic: (music) => set({ music }),

  setServices: (services) =>
    set((store) => {
      const next = { ...store.services };
      for (const service of services) next[service.id] = service;
      return { services: next };
    }),

  patchEntity: (id, partial) =>
    set((store) => {
      const current = store.entities[id];
      if (!current) return store;
      return { entities: { ...store.entities, [id]: { ...current, ...partial } as Entity } };
    }),

  patchMusic: (update) => set((store) => ({ music: update(store.music) })),

  setRing: (ring) => set({ ring }),

  reset: () => set({ link: 'connecting', loaded: false, entities: {}, services: {}, music: EMPTY_MUSIC, ring: null }),
}));

// --- Transient events (doorbell, door opened, history changed) ----------------------

type EventListener = (event: HubEvent) => void;
const listeners = new Set<EventListener>();

export function emitHubEvent(event: HubEvent): void {
  for (const listener of listeners) listener(event);
}

/** Subscribes to hub events. Returns the unsubscribe function. */
export function onHubEvent(listener: EventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
