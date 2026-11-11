import { useMemo } from 'react';
import { slugify, type Entity, type EntityKind, type EntityOf, type MusicPlayer } from '@home-hub/shared';
import { useHub } from '../store/hub.ts';
import { useSession } from '../store/session.ts';

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'de', { numeric: true, sensitivity: 'base' });

export function useEntity<K extends EntityKind = EntityKind>(id: string | undefined): EntityOf<K> | undefined {
  return useHub((state) => (id ? (state.entities[id] as EntityOf<K> | undefined) : undefined));
}

/** All entities of one kind, sorted by name. */
export function useEntities<K extends EntityKind>(kind: K): EntityOf<K>[] {
  const entities = useHub((state) => state.entities);
  return useMemo(
    () =>
      Object.values(entities)
        .filter((entity): entity is EntityOf<K> => entity.kind === kind)
        .sort(byName),
    [entities, kind],
  );
}

export function useAllEntities(): Entity[] {
  const entities = useHub((state) => state.entities);
  return useMemo(() => Object.values(entities).sort(byName), [entities]);
}

export interface RoomSummary {
  id: string;
  name: string;
  entities: Entity[];
  players: MusicPlayer[];
  lightCount: number;
  lightsOn: number;
  temperature: number | null;
  openContacts: number;
  blindCount: number;
}

/**
 * Rooms as the user sees them. A room is whatever name the devices agree on:
 * the myGEKKO page of lights and blinds, the room configured for a camera or
 * door, the Sonos room of a speaker — matched ignoring case and accents.
 */
export function useRooms(): RoomSummary[] {
  const entities = useHub((state) => state.entities);
  const players = useHub((state) => state.music.players);
  const order = useSession((state) => state.prefs.roomOrder);
  return useMemo(() => {
    const rooms = new Map<string, RoomSummary>();
    const room = (name: string): RoomSummary => {
      const id = slugify(name);
      let entry = rooms.get(id);
      if (!entry) {
        entry = { id, name, entities: [], players: [], lightCount: 0, lightsOn: 0, temperature: null, openContacts: 0, blindCount: 0 };
        rooms.set(id, entry);
      }
      return entry;
    };
    for (const entity of Object.values(entities)) {
      if (!entity.room || ('isGroup' in entity && entity.isGroup)) continue;
      const entry = room(entity.room);
      entry.entities.push(entity);
      if (entity.kind === 'light') {
        entry.lightCount++;
        if (entity.on) entry.lightsOn++;
      } else if (entity.kind === 'blind') {
        entry.blindCount++;
      } else if (entity.kind === 'climate' && entry.temperature === null) {
        entry.temperature = entity.temperature;
      } else if (entity.kind === 'contact' && entity.open) {
        entry.openContacts++;
      }
    }
    for (const player of players) {
      if (player.room) room(player.room).players.push(player);
    }
    const position = (id: string) => {
      const index = order.indexOf(id);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    return [...rooms.values()]
      .map((entry) => ({ ...entry, entities: entry.entities.sort(byName), players: entry.players.sort(byName) }))
      .sort((a, b) => position(a.id) - position(b.id) || byName(a, b));
  }, [entities, players, order]);
}

/** Entities the user pinned to the overview, in the order they were pinned. */
export function useFavorites(): Entity[] {
  const entities = useHub((state) => state.entities);
  const favorites = useSession((state) => state.prefs.favorites);
  return useMemo(() => favorites.map((id) => entities[id]).filter((entity): entity is Entity => Boolean(entity)), [entities, favorites]);
}

export function useIsFavorite(id: string): [boolean, () => void] {
  const isFavorite = useSession((state) => state.prefs.favorites.includes(id));
  const toggle = () => {
    const { prefs, savePrefs } = useSession.getState();
    const favorites = prefs.favorites.includes(id) ? prefs.favorites.filter((entry) => entry !== id) : [...prefs.favorites, id];
    void savePrefs({ favorites }).catch(() => {});
  };
  return [isFavorite, toggle];
}
