import { afterEach, describe, expect, it } from 'vitest';
import type { AccessEntity, EntityCommand, LightEntity, LoginResponse, TimersResponse } from '@home-hub/shared';
import { localDate, nextOccurrence, occurrenceOn, sunOn, TimerService, zonedTime, type Place } from '../src/automation/timers.ts';
import { Client, createTestHub, setupAdmin, type TestHub } from './helpers.ts';

const hubs: TestHub[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.destroy();
});

const BERLIN: Place = { timeZone: 'Europe/Berlin', latitude: 52.52, longitude: 13.4, located: true };

const light: LightEntity = {
  id: 'test:lights/1',
  kind: 'light',
  name: 'Terrasse',
  room: 'Außen',
  available: true,
  service: 'mygekko',
  on: false,
  brightness: null,
  color: null,
  colorTemp: null,
  features: { dim: false, color: false, colorTemp: false },
  isGroup: false,
};

const door: AccessEntity = {
  id: 'test:accessdoors/1',
  kind: 'access',
  name: 'Garagentor',
  room: 'Außen',
  available: true,
  service: 'mygekko',
  open: false,
  action: 'closed',
  level: 0,
  accessType: 'gate_operation',
  features: { open: true, holdOpen: true, close: true, lock: true, stop: true },
};

describe('time zone and sun', () => {
  it('turns wall-clock times into instants, across daylight saving changes', () => {
    // Winter: UTC+1, summer: UTC+2; 29 March 2026 is the day the clocks go forward.
    expect(new Date(zonedTime({ year: 2026, month: 1, day: 15 }, 7, 0, 'Europe/Berlin')).toISOString()).toBe('2026-01-15T06:00:00.000Z');
    expect(new Date(zonedTime({ year: 2026, month: 3, day: 29 }, 7, 0, 'Europe/Berlin')).toISOString()).toBe('2026-03-29T05:00:00.000Z');
    expect(new Date(zonedTime({ year: 2026, month: 7, day: 1 }, 22, 30, 'Europe/Berlin')).toISOString()).toBe('2026-07-01T20:30:00.000Z');
    expect(localDate(Date.parse('2026-12-31T23:30:00Z'), 'Europe/Berlin')).toEqual({ year: 2027, month: 1, day: 1 });
  });

  it('knows sunrise and sunset in Berlin to a few minutes', () => {
    const summer = sunOn({ year: 2026, month: 6, day: 21 }, BERLIN);
    // Published times for Berlin: 04:43 and 21:33 (summer time).
    expect(Math.abs(summer.rise! - Date.parse('2026-06-21T02:43:00Z'))).toBeLessThan(5 * 60_000);
    expect(Math.abs(summer.set! - Date.parse('2026-06-21T19:33:00Z'))).toBeLessThan(5 * 60_000);
    const winter = sunOn({ year: 2026, month: 12, day: 21 }, BERLIN);
    expect(Math.abs(winter.rise! - Date.parse('2026-12-21T07:15:00Z'))).toBeLessThan(5 * 60_000);
  });

  it('fires only on the chosen weekdays, at sunset with an offset', () => {
    const weekdays = { days: [1, 2, 3, 4, 5], at: { kind: 'time' as const, time: '07:00' } };
    // 21 November 2026 is a Saturday.
    expect(occurrenceOn(weekdays, { year: 2026, month: 11, day: 21 }, BERLIN)).toBeNull();
    const next = nextOccurrence({ ...weekdays, enabled: true }, Date.parse('2026-11-21T10:00:00Z'), BERLIN);
    expect(new Date(next!).toISOString()).toBe('2026-11-23T06:00:00.000Z');
    expect(nextOccurrence({ ...weekdays, enabled: false }, Date.now(), BERLIN)).toBeNull();

    const sunset = sunOn({ year: 2026, month: 11, day: 21 }, BERLIN).set!;
    expect(occurrenceOn({ days: [6], at: { kind: 'sunset', offset: -30 } }, { year: 2026, month: 11, day: 21 }, BERLIN)).toBe(sunset - 30 * 60_000);
  });
});

describe('time switches of the hub', () => {
  it('fires once when due, catches up after a short outage, and records what happened', async () => {
    const hub = await createTestHub();
    hubs.push(hub);
    hub.ctx.state.upsert('test', light);
    const sent: { id: string; command: EntityCommand }[] = [];
    let failing = false;
    const service = new TimerService({
      settings: hub.ctx.settings,
      state: hub.ctx.state,
      log: hub.ctx.log,
      integrations: {
        async entityCommand(id, command) {
          if (failing) throw new Error('nicht erreichbar');
          sent.push({ id, command });
        },
      },
    });
    const created = service.create({ name: 'Licht an', days: [1, 2, 3, 4, 5, 6, 7], at: { kind: 'time', time: '18:00' }, actions: [{ entityId: light.id, command: { action: 'turn_on' } }] }, 'erika');
    // Created at a time after today's 18:00 would not fire for it: pretend it was made in the morning.
    (service as unknown as { timers: { lastRunAt: number | null }[] }).timers[0]!.lastRunAt = Date.parse('2026-11-23T08:00:00Z');

    await service.tick(Date.parse('2026-11-23T16:59:00Z')); // 17:59 in Berlin
    expect(sent).toHaveLength(0);
    await service.tick(Date.parse('2026-11-23T17:04:00Z')); // 18:04: the hub was busy for four minutes
    expect(sent).toEqual([{ id: light.id, command: { action: 'turn_on' } }]);
    await service.tick(Date.parse('2026-11-23T17:05:00Z'));
    expect(sent).toHaveLength(1);
    expect(service.get(created.id)).toMatchObject({ lastOk: true, lastResult: 'Ausgeführt' });

    // Next day the hub was off until 18:30: too late, it does not fire belatedly.
    await service.tick(Date.parse('2026-11-24T17:30:00Z'));
    expect(sent).toHaveLength(1);

    // A failure is recorded in words.
    failing = true;
    await service.tick(Date.parse('2026-11-25T17:00:30Z'));
    expect(service.get(created.id)).toMatchObject({ lastOk: false, lastResult: 'Terrasse: nicht erreichbar' });

    // Paused switches stay quiet.
    service.update(created.id, { name: 'Licht an', enabled: false, days: [1, 2, 3, 4, 5, 6, 7], at: { kind: 'time', time: '18:00' }, actions: [{ entityId: light.id, command: { action: 'turn_on' } }] }, 'erika');
    failing = false;
    await service.tick(Date.parse('2026-11-26T17:00:30Z'));
    expect(sent).toHaveLength(1);
    expect(service.list()[0]!.nextRunAt).toBeNull();
  });

  it('lets members set them up, keeps guests out, and never switches doors', async () => {
    const hub = await createTestHub();
    hubs.push(hub);
    const { client: admin } = await setupAdmin(hub);
    await admin.put('/api/admin/settings/general', { hubName: 'Zuhause', requireTotp: false, sessionDays: 30, timeZone: 'Europe/Berlin', latitude: 52.52, longitude: 13.4 });
    hub.ctx.state.upsert('test', light);
    hub.ctx.state.upsert('test', door);
    await admin.post('/api/users', { username: 'gast', role: 'guest', password: 'a long guest password' });
    const guest = new Client(hub);
    expect(((await guest.post('/api/auth/login', { username: 'gast', password: 'a long guest password', client: 'web' })).json() as LoginResponse).status).toBe('ok');

    const body = { name: 'Abends', days: [1, 2, 3, 4, 5], at: { kind: 'sunset', offset: 15 }, actions: [{ entityId: light.id, command: { action: 'turn_on' } }] };
    expect((await guest.post('/api/timers', body)).statusCode).toBe(403);
    const listed = (await guest.get('/api/timers')).json() as TimersResponse;
    expect(listed).toMatchObject({ timers: [], timeZone: 'Europe/Berlin', located: true, canEdit: false });
    expect(listed.sunset).toBeGreaterThan(listed.sunrise!);

    const created = await admin.post('/api/timers', body);
    expect(created.statusCode).toBe(200);
    const { timer } = created.json() as { timer: { id: string; nextRunAt: number } };
    expect(timer.nextRunAt).toBeGreaterThan(Date.now());

    const withDoor = await admin.post('/api/timers', { ...body, actions: [{ entityId: door.id, command: { action: 'open' } }] });
    expect(withDoor.statusCode).toBe(400);
    expect(withDoor.json()).toMatchObject({ message: '„Garagentor“ kann nicht von einer Zeitschaltuhr geschaltet werden.' });
    expect((await admin.post('/api/timers', { ...body, at: { kind: 'time', time: '25:00' } })).statusCode).toBe(400);

    expect((await guest.delete(`/api/timers/${timer.id}`)).statusCode).toBe(403);
    expect((await admin.delete(`/api/timers/${timer.id}`)).statusCode).toBe(200);
    const audit = (await admin.get('/api/admin/audit')).json() as { entries: { action: string }[] };
    expect(audit.entries.filter((entry) => entry.action === 'timer.changed')).toHaveLength(2);
  });

  it('opens doors only for people who may, and writes it down', async () => {
    const hub = await createTestHub();
    hubs.push(hub);
    const { client: admin } = await setupAdmin(hub);
    await admin.put('/api/admin/settings/general', { hubName: 'Zuhause', requireTotp: false, sessionDays: 30 });
    hub.ctx.state.upsert('test', door);
    await admin.post('/api/users', { username: 'mia', role: 'member', password: 'a long member password', permissions: ['home.control', 'security.view'] });
    const member = new Client(hub);
    expect(((await member.post('/api/auth/login', { username: 'mia', password: 'a long member password', client: 'web' })).json() as LoginResponse).status).toBe('ok');
    const commands: string[] = [];
    (hub.ctx.integrations as unknown as { entityCommand(id: string, command: EntityCommand): Promise<void> }).entityCommand = async (id, command) => {
      commands.push(`${id} ${command.action}`);
    };

    // Sees the gate, may not open it.
    expect(((await member.get('/api/state')).json() as { entities: Record<string, unknown> }).entities[door.id]).toBeDefined();
    expect((await member.post(`/api/entities/${encodeURIComponent(door.id)}/command`, { action: 'open' })).statusCode).toBe(403);
    expect(commands).toEqual([]);

    expect((await admin.post(`/api/entities/${encodeURIComponent(door.id)}/command`, { action: 'hold_open' })).statusCode).toBe(200);
    expect(commands).toEqual([`${door.id} hold_open`]);
    const audit = (await admin.get('/api/admin/audit')).json() as { entries: { action: string; detail: Record<string, unknown> | null }[] };
    expect(audit.entries[0]).toMatchObject({ action: 'access.command', detail: { door: 'Garagentor', action: 'hold_open', text: 'dauerhaft geöffnet' } });
  });
});
