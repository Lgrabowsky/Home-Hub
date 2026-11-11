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

/** A ring this recent still counts as "ringing" for somebody who opens the app or was just reconnecting. */
const RING_FRESH_MS = 45_000;
/**
 * Rings already shown, by door — so dismissing one does not bring it back with the next state update.
 * Kept for the browser session, so that a reload does not ring again either.
 */
const SHOWN_KEY = 'hh.rings';
const shownRings = new Map<string, number>();
try {
  for (const [doorId, ts] of Object.entries(JSON.parse(sessionStorage.getItem(SHOWN_KEY) ?? '{}') as Record<string, unknown>)) {
    if (typeof ts === 'number') shownRings.set(doorId, ts);
  }
} catch {
  /* no session storage (private mode): the memory lasts until the page is closed */
}

function rememberRing(doorId: string, ts: number): void {
  shownRings.set(doorId, Math.max(ts, shownRings.get(doorId) ?? 0));
  try {
    sessionStorage.setItem(SHOWN_KEY, JSON.stringify(Object.fromEntries(shownRings)));
  } catch {
    /* see above */
  }
}

/**
 * The doorbell must not depend on a single message arriving: besides the live
 * event, a ring is also recognised from the door's state. That covers the
 * moments when the event cannot arrive — the app is opened because the bell
 * was heard, or the connection was being re-established.
 */
function freshRing(entities: Iterable<Entity>, serverNow: number, current: ActiveRing | null): ActiveRing | null {
  let newest: ActiveRing | null = null;
  for (const entity of entities) {
    if (entity.kind !== 'door' || entity.lastRingAt === null) continue;
    const doorId = entity.id.slice('door:'.length);
    if (serverNow - entity.lastRingAt > RING_FRESH_MS) continue;
    // The live event and the state update describe the same ring with slightly different time stamps.
    if (entity.lastRingAt - (shownRings.get(doorId) ?? 0) < 5000) continue;
    if (current?.doorId === doorId) continue;
    if (!newest || entity.lastRingAt > newest.ts) newest = { doorId, doorName: entity.name, ts: entity.lastRingAt };
  }
  if (newest) rememberRing(newest.doorId, newest.ts);
  return newest;
}

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
    set((store) => {
      const ring = freshRing(Object.values(state.entities), state.serverTime, store.ring);
      return {
        loaded: true,
        hubName: state.hubName,
        clockOffset: state.serverTime - Date.now(),
        entities: state.entities,
        services: state.services,
        music: state.music,
        ...(ring ? { ring } : {}),
      };
    }),

  applyEntities: (changed, removed) =>
    set((store) => {
      const entities = { ...store.entities };
      for (const entity of changed) entities[entity.id] = entity;
      for (const id of removed) delete entities[id];
      const ring = freshRing(changed, Date.now() + store.clockOffset, store.ring);
      return ring ? { entities, ring } : { entities };
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

  setRing: (ring) => {
    if (ring) rememberRing(ring.doorId, ring.ts);
    set({ ring });
  },

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
