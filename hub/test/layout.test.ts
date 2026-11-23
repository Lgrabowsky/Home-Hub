import { afterEach, describe, expect, it } from 'vitest';
import {
  EMPTY_LAYOUT,
  addArea,
  addRoom,
  applyLayout,
  moveArea,
  moveRoom,
  orderDevices,
  realRooms,
  removeArea,
  renameRoom,
  resetDevice,
  resetLayout,
  resetRoom,
  roomChanged,
  setCameraLights,
  setDevice,
  sortByLayout,
  withFloors,
  type ContactEntity,
  type Entity,
  type HouseLayout,
  type LightEntity,
} from '@home-hub/shared';
import { StateStore } from '../src/state.ts';
import { createTestHub, setupAdmin, type TestHub } from './helpers.ts';

function light(id: string, name: string, room: string | null): LightEntity {
  return { id, kind: 'light', name, room, available: true, service: 'mygekko', on: false, brightness: null, color: null, colorTemp: null, features: { dim: false, color: false, colorTemp: false }, isGroup: false };
}

function contact(id: string, name: string, room: string): ContactEntity {
  return { id, kind: 'contact', name, room, available: true, service: 'mygekko', open: false, contactType: 'window', zone: null, fault: false, changedAt: null };
}

const RAW: Entity[] = [
  light('l1', 'Deckenlicht', 'EG Kueche'),
  light('l2', 'Spots', 'EG Kueche'),
  light('l3', 'Stehlampe', 'Wohnen'),
  light('l4', 'Treppe oben', 'OG Flur'),
  contact('c1', 'Fenster EG Kueche', 'Türen und Fenster'),
];

/** The entities as the hub would send them with this layout. */
function shown(layout: HouseLayout): Entity[] {
  const real = realRooms(RAW);
  return RAW.map((entity) => applyLayout(entity, layout, real));
}

const byId = (entities: Entity[], id: string) => entities.find((entity) => entity.id === id)!;

describe('house layout', () => {
  it('leaves devices as recognised, contacts go to the room their name mentions', () => {
    const entities = shown(EMPTY_LAYOUT);
    expect(byId(entities, 'l1')).toEqual(RAW[0]);
    expect(byId(entities, 'c1')).toMatchObject({ room: 'EG Kueche' });
    expect(byId(entities, 'c1').auto).toBeUndefined();
  });

  it('renames and moves single devices, hides them, and keeps what was recognised', () => {
    let layout = setDevice(EMPTY_LAYOUT, RAW[0]!, { name: 'Küchenlicht', room: 'Treppenhaus' });
    layout = setDevice(layout, RAW[1]!, { hidden: true });
    let entities = shown(layout);
    expect(byId(entities, 'l1')).toMatchObject({ name: 'Küchenlicht', room: 'Treppenhaus', auto: { name: 'Deckenlicht', room: 'EG Kueche' } });
    expect(byId(entities, 'l2')).toMatchObject({ hidden: true, room: 'EG Kueche' });

    // Choosing the automatic values again stores nothing.
    layout = setDevice(layout, byId(entities, 'l1'), { name: 'Deckenlicht', room: 'EG Kueche' });
    layout = setDevice(layout, byId(entities, 'l2'), { hidden: false });
    expect(layout.devices).toEqual({});

    layout = setDevice(EMPTY_LAYOUT, RAW[2]!, { room: null });
    entities = shown(layout);
    expect(byId(entities, 'l3')).toMatchObject({ room: null, auto: { room: 'Wohnen' } });
    expect(resetDevice(layout, 'l3').devices).toEqual({});
  });

  it('renames a room with everything in it, and merges two rooms', () => {
    let layout = withFloors(EMPTY_LAYOUT, [
      { name: 'Erdgeschoss', rooms: ['EG Kueche', 'Wohnen'] },
      { name: 'Obergeschoss', rooms: ['OG Flur'] },
    ]);
    layout = orderDevices(layout, 'EG Kueche', ['l1', 'l2'], ['l2', 'l1']);
    layout = renameRoom(layout, { entities: shown(layout) }, 'EG Kueche', 'Küche');
    let entities = shown(layout);
    expect(entities.filter((entity) => entity.room === 'Küche').map((entity) => entity.id)).toEqual(['l1', 'l2', 'c1']);
    expect(layout.floors![0]!.rooms).toEqual(['Küche', 'Wohnen']);
    expect(layout.order).toEqual({ kuche: ['l2', 'l1'] });

    // "Wohnen" into "Küche": one room, in the place of the existing one.
    layout = renameRoom(layout, { entities }, 'Wohnen', 'Küche');
    entities = shown(layout);
    expect(byId(entities, 'l3')).toMatchObject({ room: 'Küche', auto: { room: 'Wohnen' } });
    expect(layout.floors![0]!.rooms).toEqual(['Küche']);
    expect(roomChanged(layout, { entities }, 'Küche')).toBe(true);
    expect(roomChanged(layout, { entities }, 'OG Flur')).toBe(false);

    // Back: both rooms return, where the merged room was.
    layout = resetRoom(layout, { entities }, 'Küche');
    entities = shown(layout);
    expect(layout.rooms).toEqual({});
    expect(layout.order).toEqual({});
    expect(layout.floors![0]!.rooms).toEqual(['EG Kueche', 'Wohnen']);
    expect(byId(entities, 'l3')).toMatchObject({ room: 'Wohnen' });
  });

  it('gives devices of a new room back to their own rooms when that room is reset', () => {
    let layout = withFloors(EMPTY_LAYOUT, [{ name: 'Erdgeschoss', rooms: ['EG Kueche', 'Wohnen', 'OG Flur'] }]);
    layout = addArea(layout, 'Treppenhaus');
    layout = addRoom(layout, 'Treppenhaus', 'Treppenhaus');
    layout = setDevice(layout, RAW[3]!, { room: 'Treppenhaus' });
    layout = moveRoom(layout, 'OG Flur', 'Treppenhaus');
    expect(layout.floors).toEqual([
      { name: 'Erdgeschoss', rooms: ['EG Kueche', 'Wohnen'] },
      { name: 'Treppenhaus', rooms: ['Treppenhaus', 'OG Flur'] },
    ]);
    let entities = shown(layout);
    expect(byId(entities, 'l4')).toMatchObject({ room: 'Treppenhaus' });

    layout = resetRoom(layout, { entities }, 'Treppenhaus');
    entities = shown(layout);
    expect(byId(entities, 'l4')).toMatchObject({ room: 'OG Flur' });
    expect(layout.floors![1]!.rooms).toEqual(['OG Flur']);

    layout = moveArea(layout, 'Treppenhaus', -1);
    expect(layout.floors!.map((floor) => floor.name)).toEqual(['Treppenhaus', 'Erdgeschoss']);
    layout = removeArea(layout, 'Treppenhaus');
    expect(layout.floors!.map((floor) => floor.name)).toEqual(['Erdgeschoss']);
  });

  it('resets everything except the lights of the cameras, and orders devices', () => {
    let layout = setDevice(EMPTY_LAYOUT, RAW[0]!, { name: 'X' });
    layout = setCameraLights(layout, 'cam:garten', ['l3', 'l3', 'l4']);
    expect(layout.cameraLights).toEqual({ 'cam:garten': ['l3', 'l4'] });
    expect(resetLayout(layout)).toEqual({ ...EMPTY_LAYOUT, cameraLights: { 'cam:garten': ['l3', 'l4'] } });

    // Only the lights of a room are moved; the contact keeps its place.
    layout = orderDevices(EMPTY_LAYOUT, 'EG Kueche', ['l1', 'c1', 'l2'], ['l2', 'l1']);
    expect(layout.order).toEqual({ 'eg-kueche': ['l2', 'c1', 'l1'] });
    expect(sortByLayout(shown(EMPTY_LAYOUT).filter((entity) => entity.room === 'EG Kueche'), layout.order['eg-kueche']).map((entity) => entity.id)).toEqual(['l2', 'c1', 'l1']);
  });

  it('applies a new layout to everything the store holds, and moves contacts when their room appears', () => {
    const state = new StateStore();
    const changes: Entity[][] = [];
    state.on('entities', (changed) => changes.push(changed));
    state.replace('gekko', [contact('c1', 'Fenster Bad', 'Türen und Fenster')]);
    expect(state.get('c1')!.room).toBe('Türen und Fenster');

    state.replace('gekko', [contact('c1', 'Fenster Bad', 'Türen und Fenster'), light('l9', 'Spiegel', 'Bad')]);
    expect(state.get('c1')!.room).toBe('Bad');

    state.setHouseLayout({ ...EMPTY_LAYOUT, rooms: { bad: 'Badezimmer' }, devices: { l9: { name: 'Spiegellicht' } } });
    expect(state.get('l9')).toMatchObject({ name: 'Spiegellicht', room: 'Badezimmer', auto: { name: 'Spiegel', room: 'Bad' } });
    expect(state.get('c1')).toMatchObject({ room: 'Badezimmer' });
    expect(state.snapshot().layout!.rooms).toEqual({ bad: 'Badezimmer' });

    // Updates from the integration keep the household's name.
    state.patch('l9', { on: true });
    expect(state.get('l9')).toMatchObject({ name: 'Spiegellicht', on: true });
    expect(changes.at(-1)![0]).toMatchObject({ name: 'Spiegellicht', on: true });
  });
});

describe('house layout over the API', () => {
  let hub: TestHub | null = null;
  afterEach(async () => {
    await hub?.destroy();
    hub = null;
  });

  it('is applied to the devices the apps see and recorded in the audit log', async () => {
    hub = await createTestHub();
    const { client } = await setupAdmin(hub);
    await hub.start();
    hub.ctx.state.replace('test', [light('test:l1', 'Lampe', 'Wohnen')]);
    const layout = { ...EMPTY_LAYOUT, devices: { 'test:l1': { name: 'Leselampe', room: 'Bibliothek' } } };
    expect((await client.put('/api/layout', { layout, change: 'Leselampe umbenannt' })).statusCode).toBe(200);
    const state = (await client.get('/api/state')).json() as { entities: Record<string, Entity> };
    expect(state.entities['test:l1']).toMatchObject({ name: 'Leselampe', room: 'Bibliothek', auto: { name: 'Lampe', room: 'Wohnen' } });
    const audit = (await client.get('/api/admin/audit')).json() as { entries: { action: string; detail: unknown }[] };
    expect(audit.entries.find((entry) => entry.action === 'layout.changed')?.detail).toEqual({ change: 'Leselampe umbenannt' });
    // Stored: a restarted hub has it again.
    expect(hub.ctx.settings.getInternal('layout')).toEqual(layout);
  });
});
