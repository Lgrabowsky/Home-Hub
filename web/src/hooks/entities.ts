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
  target: number | null;
  heating: boolean;
  openContacts: number;
  blindCount: number;
  /** Average closing of the blinds (0 = all open), null without position feedback. */
  blindClosed: number | null;
  blindsMoving: boolean;
}

export interface FloorGroup {
  /** Empty when the house has a single, unnamed group of rooms. */
  name: string;
  rooms: RoomSummary[];
}

const fold = (text: string) => slugify(text);

/**
 * Storeys recognised from the room names when the administrator did not
 * arrange the rooms (myGEKKO pages are often named "EG Wohnen", "OG Bad" …).
 */
const FLOOR_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'Dachgeschoss', pattern: /^(dg|dachgeschoss|dachboden|spitzboden)\b/i },
  { name: 'Obergeschoss', pattern: /^(\d\.?\s*)?(og|obergeschoss|1\. ?og|2\. ?og)\b/i },
  { name: 'Erdgeschoss', pattern: /^(eg|erdgeschoss)\b/i },
  { name: 'Untergeschoss', pattern: /^(ug|kg|keller|untergeschoss|kellergeschoss)\b/i },
  { name: 'Außen', pattern: /^(außen|aussen|garten|terrasse|balkon|einfahrt|hof|carport|garage)\b/i },
];

function emptyRoom(name: string): RoomSummary {
  return { id: slugify(name), name, entities: [], players: [], lightCount: 0, lightsOn: 0, temperature: null, target: null, heating: false, openContacts: 0, blindCount: 0, blindClosed: null, blindsMoving: false };
}

/**
 * Rooms as the user sees them. A room is whatever name the devices agree on:
 * the myGEKKO page of lights and blinds, the room configured for a camera or
 * door, the Sonos room of a speaker — matched ignoring case and accents.
 *
 * Contacts often live on a page of their own on the controller ("Türen und
 * Fenster"); when such a contact names a real room ("Fenster Küche") it is
 * shown in that room.
 */
export function useRooms(): RoomSummary[] {
  const entities = useHub((state) => state.entities);
  const players = useHub((state) => state.music.players);
  const order = useSession((state) => state.prefs.roomOrder);
  return useMemo(() => {
    const all = Object.values(entities).filter((entity) => entity.room && !('isGroup' in entity && entity.isGroup));
    // Rooms that have something besides contacts are "real" rooms.
    const realRooms = new Map<string, string>();
    for (const entity of all) if (entity.kind !== 'contact') realRooms.set(fold(entity.room!), entity.room!);
    for (const player of players) if (player.room) realRooms.set(fold(player.room), player.room);

    const rooms = new Map<string, RoomSummary>();
    const room = (name: string): RoomSummary => {
      const id = slugify(name);
      let entry = rooms.get(id);
      if (!entry) rooms.set(id, (entry = emptyRoom(name)));
      return entry;
    };
    const roomFor = (entity: Entity): string => {
      const own = entity.room!;
      if (entity.kind !== 'contact' || realRooms.has(fold(own))) return own;
      const name = fold(entity.name);
      const match = [...realRooms.values()].filter((candidate) => name.includes(fold(candidate))).sort((a, b) => b.length - a.length)[0];
      return match ?? own;
    };
    const closing: Map<string, number[]> = new Map();
    for (const entity of all) {
      const entry = room(roomFor(entity));
      entry.entities.push(entity);
      if (entity.kind === 'light') {
        entry.lightCount++;
        if (entity.on) entry.lightsOn++;
      } else if (entity.kind === 'blind') {
        entry.blindCount++;
        if (entity.motion !== 'stopped') entry.blindsMoving = true;
        if (entity.position !== null) closing.set(entry.id, [...(closing.get(entry.id) ?? []), entity.position]);
      } else if (entity.kind === 'climate' && entry.temperature === null) {
        entry.temperature = entity.temperature;
        entry.target = entity.target;
        entry.heating = entity.heating;
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
      .map((entry) => {
        const values = closing.get(entry.id);
        return {
          ...entry,
          blindClosed: values && values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
          entities: entry.entities.sort(byName),
          players: entry.players.sort(byName),
        };
      })
      .sort((a, b) => position(a.id) - position(b.id) || byName(a, b));
  }, [entities, players, order]);
}

/** Rooms grouped by storey: as configured on the hub, otherwise recognised from the names. */
export function groupByFloor<T extends { name: string }>(rooms: T[], floors: { name: string; rooms: string[] }[]): { name: string; rooms: T[] }[] {
  const groups = new Map<string, T[]>();
  const add = (floor: string, room: T) => groups.set(floor, [...(groups.get(floor) ?? []), room]);
  const configured = new Map<string, string>();
  for (const floor of floors) for (const name of floor.rooms) configured.set(fold(name), floor.name);
  const rest: T[] = [];
  for (const room of rooms) {
    const floor = configured.get(fold(room.name)) ?? FLOOR_PATTERNS.find((entry) => entry.pattern.test(room.name.trim()))?.name;
    if (floor) add(floor, room);
    else rest.push(room);
  }
  const ordered = [...floors.map((floor) => floor.name), ...FLOOR_PATTERNS.map((entry) => entry.name)];
  const result = [...new Set(ordered)].filter((name) => groups.has(name)).map((name) => ({ name, rooms: groups.get(name)! }));
  if (rest.length > 0) result.push({ name: result.length > 0 ? 'Weitere Räume' : '', rooms: rest });
  return result;
}

export function useFloors(): FloorGroup[] {
  const rooms = useRooms();
  const floors = useHub((state) => state.floors);
  return useMemo(() => groupByFloor(rooms, floors), [rooms, floors]);
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
