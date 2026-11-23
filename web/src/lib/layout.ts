import { withFloors, type Entity, type HouseLayout, type LayoutContext } from '@home-hub/shared';
import { toast } from '../components/toast.tsx';
import { buildRooms, groupByFloor } from '../hooks/entities.ts';
import { useHub } from '../store/hub.ts';
import { put } from './api.ts';

/**
 * Editing the household's arrangement of the house (names, rooms, areas,
 * order). Every change is saved at once; the app shows it right away and the
 * hub confirms it with the next snapshot. Only administrators may save.
 */

/** Everything the editing functions need, hidden devices included. */
export function layoutContext(): LayoutContext {
  const { entities, hidden, music } = useHub.getState();
  return { entities: [...Object.values(entities), ...Object.values(hidden)], playerRooms: music.players.map((player) => player.room) };
}

/** Every device the hub knows, hidden ones included. */
export function everyEntity(): Entity[] {
  const { entities, hidden } = useHub.getState();
  return [...Object.values(entities), ...Object.values(hidden)];
}

/** Areas with their rooms as shown now (hidden devices and empty rooms included). */
export function shownAreas(): { name: string; rooms: string[] }[] {
  const { music, layout, floors } = useHub.getState();
  const rooms = buildRooms(everyEntity(), music.players, layout);
  return groupByFloor(rooms, floors, (name) => ({ name })).map((floor) => ({ name: floor.name, rooms: floor.rooms.map((room) => room.name) }));
}

/** The current layout, with the automatic areas turned into own ones (needed before moving rooms around). */
export function editableLayout(): HouseLayout {
  return withFloors(useHub.getState().layout, shownAreas());
}

export async function saveLayout(next: HouseLayout, change: string): Promise<boolean> {
  const store = useHub.getState();
  const before = store.layout;
  store.setLayout(next);
  try {
    const { layout } = await put<{ layout: HouseLayout }>('/api/layout', { layout: next, change });
    useHub.getState().setLayout(layout);
    return true;
  } catch (err) {
    useHub.getState().setLayout(before);
    toast.fromError(err);
    return false;
  }
}
