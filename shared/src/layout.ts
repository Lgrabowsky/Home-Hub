import type { Entity, Floor } from './index.ts';
import { slugify } from './text.ts';

/**
 * The household's own arrangement of the house: names, rooms, areas, order.
 *
 * The hub recognises rooms and storeys by itself (myGEKKO pages, camera and
 * speaker rooms, names like "OG Bad"). The layout only stores what someone
 * changed on top of that, so the automatic arrangement keeps working for
 * everything else — new devices, new rooms — and every change can be undone
 * on its own ("zurücksetzen"). Rooms are identified by name, compared without
 * case and accents (`roomKey`).
 */

export interface DeviceLayout {
  /** Own name; absent = the name the device reports. */
  name?: string;
  /** Own room ('' = no room); absent = the room recognised automatically. */
  room?: string;
  /** Not shown in the app (time switches can still switch it). */
  hidden?: boolean;
}

export interface HouseLayout {
  /** Areas (storeys, staircase, outside …) in order, each with its rooms in order; null = recognised from the room names. */
  floors: Floor[] | null;
  /** Rooms renamed or merged: recognised room (key) → room as shown. */
  rooms: Record<string, string>;
  /** Own name, room or visibility of single devices, by entity id. */
  devices: Record<string, DeviceLayout>;
  /** Order of the devices inside a room: room as shown (key) → entity ids. */
  order: Record<string, string[]>;
  /** Lights switched from the page of a camera or door station: its entity id → light entity ids. */
  cameraLights: Record<string, string[]>;
}

export const EMPTY_LAYOUT: HouseLayout = { floors: null, rooms: {}, devices: {}, order: {}, cameraLights: {} };

export const LAYOUT_LIMITS = { name: 60, floors: 40, roomsPerFloor: 200, entries: 5000, cameraLights: 40 } as const;

/** Rooms are the same when their names only differ in case, accents or punctuation. */
export const roomKey = (name: string): string => slugify(name);

const clone = (layout: HouseLayout): HouseLayout => JSON.parse(JSON.stringify(layout)) as HouseLayout;
const isGroup = (entity: Entity): boolean => 'isGroup' in entity && entity.isGroup === true;

// --- Applying the layout (hub) ---------------------------------------------------------------------

/** Rooms that hold more than door and window contacts, and the speakers' rooms: key → name. */
export function realRooms(entities: Iterable<Entity>, playerRooms: Iterable<string | null> = []): Map<string, string> {
  const rooms = new Map<string, string>();
  for (const entity of entities) if (entity.room && entity.kind !== 'contact' && !isGroup(entity)) rooms.set(roomKey(entity.room), entity.room);
  for (const room of playerRooms) if (room) rooms.set(roomKey(room), room);
  return rooms;
}

/**
 * The room the app suggests by itself: the device's own. Contacts often live on
 * a page of their own on the controller ("Türen und Fenster"); a contact whose
 * name mentions a real room ("Fenster Küche") goes to that room.
 */
export function suggestedRoom(entity: Entity, real: ReadonlyMap<string, string>): string | null {
  const own = entity.room;
  if (!own || entity.kind !== 'contact' || real.has(roomKey(own))) return own;
  const name = roomKey(entity.name);
  let best: string | null = null;
  for (const candidate of real.values()) {
    if (name.includes(roomKey(candidate)) && (!best || candidate.length > best.length)) best = candidate;
  }
  return best ?? own;
}

/** How a recognised room is shown (after renames and merges). */
export function shownRoom(room: string, layout: HouseLayout): string {
  return layout.rooms[roomKey(room)] ?? room;
}

/** A device as the app shows it: own name and room, `auto` keeps what was recognised. */
export function applyLayout<E extends Entity>(entity: E, layout: HouseLayout, real: ReadonlyMap<string, string>): E {
  const suggested = suggestedRoom(entity, real);
  const own = layout.devices[entity.id];
  const room = own?.room !== undefined ? own.room.trim() || null : suggested === null ? null : shownRoom(suggested, layout);
  const name = own?.name?.trim() || entity.name;
  const { auto: _auto, hidden: _hidden, ...base } = entity;
  const shown = { ...base, name, room } as E;
  if (name !== entity.name || room !== suggested) shown.auto = { name: entity.name, room: suggested };
  if (own?.hidden) shown.hidden = true;
  return shown;
}

/** Items in the household's order; the rest after them, by name. */
export function sortByLayout<T extends { id: string; name: string }>(items: readonly T[], order: readonly string[] | undefined): T[] {
  const position = new Map((order ?? []).map((id, index) => [id, index]));
  const at = (item: T) => position.get(item.id) ?? Number.MAX_SAFE_INTEGER;
  return [...items].sort((a, b) => at(a) - at(b) || a.name.localeCompare(b.name, 'de', { numeric: true, sensitivity: 'base' }));
}

// --- Editing (apps) ------------------------------------------------------------------------------------

/** What the editing functions need to know about the house as it is now. */
export interface LayoutContext {
  /** All devices as the hub sends them (hidden ones included). */
  entities: readonly Entity[];
  /** Rooms of the speakers (they are rooms of their own on the Sonos side). */
  playerRooms?: readonly (string | null)[];
}

/** The room a device would be in without own changes (before renames). */
export const recognisedRoomOf = (entity: Entity): string | null => (entity.auto ? entity.auto.room : entity.room);
/** The name a device reports. */
export const recognisedNameOf = (entity: Entity): string => (entity.auto ? entity.auto.name : entity.name);

function recognisedRooms(context: LayoutContext): string[] {
  const rooms = new Map<string, string>();
  for (const entity of context.entities) {
    const room = recognisedRoomOf(entity);
    if (room) rooms.set(`${roomKey(room)}\u0000${room}`, room);
  }
  for (const room of context.playerRooms ?? []) if (room) rooms.set(`${roomKey(room)}\u0000${room}`, room);
  return [...rooms.values()];
}

const cleanName = (name: string): string => name.trim().replace(/\s+/g, ' ').slice(0, LAYOUT_LIMITS.name);

function tidy(layout: HouseLayout): HouseLayout {
  for (const [id, device] of Object.entries(layout.devices)) {
    if (device.name === undefined && device.room === undefined && !device.hidden) delete layout.devices[id];
    else if (device.hidden === false) delete device.hidden;
  }
  for (const [key, ids] of Object.entries(layout.order)) if (ids.length === 0) delete layout.order[key];
  for (const [key, ids] of Object.entries(layout.cameraLights)) if (ids.length === 0) delete layout.cameraLights[key];
  return layout;
}

/** Turns the automatic arrangement into an own one, so it can be changed (no-op when there already is one). */
export function withFloors(layout: HouseLayout, shown: readonly { name: string; rooms: readonly string[] }[]): HouseLayout {
  if (layout.floors) return layout;
  const next = clone(layout);
  next.floors = shown.map((floor) => ({ name: floor.name || 'Räume', rooms: [...floor.rooms] }));
  return next;
}

/**
 * Gives a room another name. When a room of that name exists already, the two
 * become one ("zusammenführen"). Devices, areas and order follow.
 */
export function renameRoom(layout: HouseLayout, context: LayoutContext, from: string, to: string): HouseLayout {
  const target = cleanName(to);
  const fromKey = roomKey(from);
  const targetKey = roomKey(target);
  if (!target || target === from) return layout;
  const next = clone(layout);
  const recognised = recognisedRooms(context);
  for (const room of recognised) if (roomKey(shownRoom(room, layout)) === fromKey) next.rooms[roomKey(room)] = target;
  for (const [key, value] of Object.entries(next.rooms)) if (roomKey(value) === fromKey) next.rooms[key] = target;
  // A recognised room that gets exactly its own name back needs no entry.
  for (const room of recognised) if (next.rooms[roomKey(room)] === room) delete next.rooms[roomKey(room)];
  for (const device of Object.values(next.devices)) if (device.room !== undefined && device.room !== '' && roomKey(device.room) === fromKey) device.room = target;

  if (next.floors) {
    const exists = targetKey !== fromKey && next.floors.some((floor) => floor.rooms.some((room) => roomKey(room) === targetKey));
    for (const floor of next.floors) {
      floor.rooms = exists ? floor.rooms.filter((room) => roomKey(room) !== fromKey) : floor.rooms.map((room) => (roomKey(room) === fromKey ? target : room));
    }
  }
  if (targetKey !== fromKey && next.order[fromKey]) {
    next.order[targetKey] = [...new Set([...(next.order[targetKey] ?? []), ...next.order[fromKey]!])];
    delete next.order[fromKey];
  }
  return tidy(next);
}

/**
 * Back to what was recognised for this room: its name, its devices (also the
 * ones moved away or moved in) and its area. A room someone created dissolves;
 * its devices return to their own rooms.
 */
export function resetRoom(layout: HouseLayout, context: LayoutContext, room: string): HouseLayout {
  const key = roomKey(room);
  const next = clone(layout);
  const sourceRooms = recognisedRooms(context).filter((candidate) => roomKey(shownRoom(candidate, layout)) === key);
  const sources = new Set(sourceRooms.map(roomKey));
  for (const source of sources) delete next.rooms[source];
  for (const [entry, value] of Object.entries(next.rooms)) if (roomKey(value) === key) delete next.rooms[entry];
  for (const entity of context.entities) {
    const device = next.devices[entity.id];
    if (!device || device.room === undefined) continue;
    const recognised = recognisedRoomOf(entity);
    const movedIn = device.room !== '' && roomKey(device.room) === key;
    const movedOut = recognised !== null && sources.has(roomKey(recognised));
    if (movedIn || movedOut) delete device.room;
  }
  for (const device of Object.values(next.devices)) if (device.room !== undefined && device.room !== '' && roomKey(device.room) === key) delete device.room;
  if (next.floors) {
    // The recognised rooms take the place of the room in its area; a room someone created disappears.
    const listed = new Set(next.floors.flatMap((floor) => floor.rooms.map(roomKey)));
    const back = [...new Map(sourceRooms.filter((source) => roomKey(source) === key || !listed.has(roomKey(source))).map((source) => [roomKey(source), source])).values()];
    for (const floor of next.floors) floor.rooms = floor.rooms.flatMap((entry) => (roomKey(entry) === key ? back : [entry]));
  }
  delete next.order[key];
  return tidy(next);
}

/** Changes one device: own name, own room (null = no room), shown or hidden. Values equal to the automatic ones are not stored. */
export function setDevice(layout: HouseLayout, entity: Entity, change: { name?: string; room?: string | null; hidden?: boolean }): HouseLayout {
  const next = clone(layout);
  const device: DeviceLayout = { ...(next.devices[entity.id] ?? {}) };
  if (change.name !== undefined) {
    const name = cleanName(change.name);
    if (!name || name === recognisedNameOf(entity)) delete device.name;
    else device.name = name;
  }
  if (change.room !== undefined) {
    const recognised = recognisedRoomOf(entity);
    const automatic = recognised === null ? null : shownRoom(recognised, layout);
    const wanted = change.room === null ? null : cleanName(change.room) || null;
    if (wanted === automatic) delete device.room;
    else device.room = wanted ?? '';
  }
  if (change.hidden !== undefined) {
    if (change.hidden) device.hidden = true;
    else delete device.hidden;
  }
  next.devices[entity.id] = device;
  return tidy(next);
}

/** Forgets every own change of one device. */
export function resetDevice(layout: HouseLayout, entityId: string): HouseLayout {
  const next = clone(layout);
  delete next.devices[entityId];
  return next;
}

/** Back to the automatic arrangement for everything; the lights of the cameras stay. */
export function resetLayout(layout: HouseLayout): HouseLayout {
  return { ...clone(EMPTY_LAYOUT), cameraLights: clone(layout).cameraLights };
}

/** Puts a room into an area (created when missing), at the end or at `index`. */
export function moveRoom(layout: HouseLayout, room: string, area: string, index?: number): HouseLayout {
  const next = clone(layout);
  const key = roomKey(room);
  next.floors ??= [];
  for (const floor of next.floors) floor.rooms = floor.rooms.filter((entry) => roomKey(entry) !== key);
  let target = next.floors.find((floor) => floor.name === area);
  if (!target) next.floors.push((target = { name: cleanName(area), rooms: [] }));
  target.rooms.splice(index ?? target.rooms.length, 0, room);
  return next;
}

/** A new, empty room in an area. */
export function addRoom(layout: HouseLayout, area: string, room: string): HouseLayout {
  const name = cleanName(room);
  if (!name || (layout.floors ?? []).some((floor) => floor.rooms.some((entry) => roomKey(entry) === roomKey(name)))) return layout;
  return moveRoom(layout, name, area);
}

export function addArea(layout: HouseLayout, name: string): HouseLayout {
  const clean = cleanName(name);
  if (!clean || (layout.floors ?? []).some((floor) => floor.name === clean)) return layout;
  const next = clone(layout);
  next.floors = [...(next.floors ?? []), { name: clean, rooms: [] }];
  return next;
}

export function renameArea(layout: HouseLayout, from: string, to: string): HouseLayout {
  const clean = cleanName(to);
  if (!clean || !layout.floors || layout.floors.some((floor) => floor.name === clean)) return layout;
  const next = clone(layout);
  for (const floor of next.floors!) if (floor.name === from) floor.name = clean;
  return next;
}

/** Removes an area; its rooms are grouped automatically again. */
export function removeArea(layout: HouseLayout, name: string): HouseLayout {
  if (!layout.floors) return layout;
  const next = clone(layout);
  next.floors = next.floors!.filter((floor) => floor.name !== name);
  return next;
}

/** Moves an area up (-1) or down (+1). */
export function moveArea(layout: HouseLayout, name: string, delta: -1 | 1): HouseLayout {
  if (!layout.floors) return layout;
  const next = clone(layout);
  const floors = next.floors!;
  const index = floors.findIndex((floor) => floor.name === name);
  const to = index + delta;
  if (index < 0 || to < 0 || to >= floors.length) return layout;
  [floors[index], floors[to]] = [floors[to]!, floors[index]!];
  return next;
}

/** New order of the rooms of an area. */
export function orderRooms(layout: HouseLayout, area: string, rooms: readonly string[]): HouseLayout {
  const next = clone(layout);
  const floor = next.floors?.find((entry) => entry.name === area);
  if (!floor) return layout;
  const keys = new Set(rooms.map(roomKey));
  floor.rooms = [...rooms, ...floor.rooms.filter((room) => !keys.has(roomKey(room)))];
  return next;
}

/**
 * New order of some devices of a room (e.g. only its lights): they take the
 * places those devices had, the others stay where they are.
 */
export function orderDevices(layout: HouseLayout, room: string, current: readonly string[], moved: readonly string[]): HouseLayout {
  const next = clone(layout);
  const set = new Set(moved);
  const queue = [...moved];
  next.order[roomKey(room)] = current.map((id) => (set.has(id) ? queue.shift()! : id));
  return tidy(next);
}

export function setCameraLights(layout: HouseLayout, cameraId: string, lights: readonly string[]): HouseLayout {
  const next = clone(layout);
  next.cameraLights[cameraId] = [...new Set(lights)].slice(0, LAYOUT_LIMITS.cameraLights);
  return tidy(next);
}

/** True when the room differs from what was recognised: its name, its devices or their order. */
export function roomChanged(layout: HouseLayout, context: LayoutContext, room: string): boolean {
  const key = roomKey(room);
  if (layout.order[key]) return true;
  if (Object.values(layout.rooms).some((value) => roomKey(value) === key)) return true;
  if (!recognisedRooms(context).some((candidate) => roomKey(candidate) === key)) return true;
  return context.entities.some((entity) => {
    const device = layout.devices[entity.id];
    if (device?.room === undefined) return false;
    const recognised = recognisedRoomOf(entity);
    return (device.room !== '' && roomKey(device.room) === key) || (recognised !== null && roomKey(shownRoom(recognised, layout)) === key);
  });
}
