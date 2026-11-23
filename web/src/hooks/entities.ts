import { useMemo } from 'react';
import { roomKey, shownRoom, slugify, sortByLayout, type Entity, type EntityKind, type EntityOf, type Floor, type HouseLayout, type MusicPlayer } from '@home-hub/shared';
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
 * Rooms as the user sees them: whatever room the devices are in — as the hub
 * recognised it (myGEKKO page, camera and speaker rooms; contacts go to the room
 * their name mentions) or as the household arranged it. Devices inside a room
 * follow the household's order, then their names.
 */
export function buildRooms(list: Iterable<Entity>, players: readonly MusicPlayer[], layout: HouseLayout): RoomSummary[] {
  const rooms = new Map<string, RoomSummary>();
  const room = (name: string): RoomSummary => {
    const id = slugify(name);
    let entry = rooms.get(id);
    if (!entry) rooms.set(id, (entry = emptyRoom(name)));
    return entry;
  };
  const closing: Map<string, number[]> = new Map();
  for (const entity of list) {
    if (!entity.room || ('isGroup' in entity && entity.isGroup)) continue;
    const entry = room(entity.room);
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
    if (player.room) room(shownRoom(player.room, layout)).players.push(player);
  }
  return [...rooms.values()]
    .map((entry) => {
      const values = closing.get(entry.id);
      return {
        ...entry,
        blindClosed: values && values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
        entities: sortByLayout(entry.entities, layout.order[roomKey(entry.name)]),
        players: entry.players.sort(byName),
      };
    })
    .sort(byName);
}

export function useRooms(): RoomSummary[] {
  const entities = useHub((state) => state.entities);
  const players = useHub((state) => state.music.players);
  const layout = useHub((state) => state.layout);
  return useMemo(() => buildRooms(Object.values(entities), players, layout), [entities, players, layout]);
}

/** Rooms nobody arranged yet land here. */
export const OTHER_ROOMS = 'Weitere Räume';

/**
 * Rooms grouped by area: as the household arranged them (in that order),
 * otherwise recognised from the names. With `empty`, areas and rooms of the
 * arrangement that hold nothing (yet) are listed too — for the editor.
 */
export function groupByFloor<T extends { name: string }>(rooms: T[], floors: readonly Floor[], empty?: (name: string) => T): { name: string; rooms: T[] }[] {
  const configured = new Map<string, { floor: string; index: number }>();
  for (const floor of floors) floor.rooms.forEach((name, index) => configured.has(fold(name)) || configured.set(fold(name), { floor: floor.name, index }));
  const groups = new Map<string, T[]>();
  const add = (floor: string, room: T) => groups.set(floor, [...(groups.get(floor) ?? []), room]);
  const present = new Set<string>();
  for (const room of rooms) {
    present.add(fold(room.name));
    const floor = configured.get(fold(room.name))?.floor ?? FLOOR_PATTERNS.find((entry) => entry.pattern.test(room.name.trim()))?.name ?? OTHER_ROOMS;
    add(floor, room);
  }
  if (empty) {
    for (const floor of floors) {
      if (!groups.has(floor.name)) groups.set(floor.name, []);
      for (const name of floor.rooms) if (!present.has(fold(name))) add(floor.name, empty(name));
    }
  }
  const position = (room: T) => configured.get(fold(room.name))?.index ?? Number.MAX_SAFE_INTEGER;
  const ordered = [...new Set([...floors.map((floor) => floor.name), ...FLOOR_PATTERNS.map((entry) => entry.name), OTHER_ROOMS])];
  const result = ordered
    .filter((name) => groups.has(name) && (empty || groups.get(name)!.length > 0))
    .map((name) => ({ name, rooms: [...groups.get(name)!].sort((a, b) => position(a) - position(b) || byName(a, b)) }));
  // A house without any recognisable areas is just "the rooms".
  if (result.length === 1 && result[0]!.name === OTHER_ROOMS && floors.length === 0) result[0]!.name = '';
  return result;
}

export function useFloors(options: { withEmpty?: boolean } = {}): FloorGroup[] {
  const rooms = useRooms();
  const floors = useHub((state) => state.floors);
  const withEmpty = options.withEmpty ?? false;
  return useMemo(() => groupByFloor(rooms, floors, withEmpty ? emptyRoom : undefined), [rooms, floors, withEmpty]);
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
