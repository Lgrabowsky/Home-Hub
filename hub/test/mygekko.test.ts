import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContactMapping, Entity, EntityCommand, EntityKind, EntityOf, MyGekkoSettings, ServiceHealth } from '@home-hub/shared';
import { HttpError } from '../src/http/errors.ts';
import { MyGekkoIntegration, type MyGekkoOptions, type MyGekkoTiming } from '../src/integrations/mygekko.ts';
import { forgetRejections } from '../src/integrations/mygekko/lockout.ts';
import { startMyGekkoSim, type MyGekkoSim, type MyGekkoSimOptions } from '../src/sim/mygekko-sim.ts';
import type { StateStore } from '../src/state.ts';
import { createTestDeps, waitFor, type TestDeps } from './deps.ts';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Passwords with everything that must be escaped in a query string; the first six characters mark them in the leak check. */
const PASSWORD = 'Xq7Zw9! geheim & 100%=ja+ä';
const WRONG_PASSWORD = 'Vb3Nm8? falsch & daneben';
const API_KEY = 'Kc5Lp2-cloud-key/+=';
const SECRET_MARKERS = ['Xq7Zw9', 'Vb3Nm8', 'Kc5Lp2'];
const CLOUD_USER = 'besitzer@example.org';
const GEKKO_ID = 'K7QM-0001-TEST-2345';

/** Everything shortened so that a test takes milliseconds; single tests override what they are about. */
const FAST: Partial<MyGekkoTiming> = {
  activeMs: 50,
  idleMs: 50,
  treeRefreshMs: 600_000,
  treeRetryMs: 50,
  requestTimeoutMs: 1500,
  authPauseMs: 60_000,
  rateLimitPauseMs: 60_000,
  errorPauseMs: 50,
  errorPauseMaxMs: 100,
  retryMs: 50,
  retryMaxMs: 100,
  commandKicksMs: [10, 60],
  cloudSettleMs: 50,
  commandGapMs: 0,
  minPollGapMs: 5,
  httpsRetryMs: 600_000,
};

/** Nothing is polled on its own after the first answer: for tests that count requests or plant a failure. */
const QUIET: Partial<MyGekkoTiming> = { activeMs: 60_000, idleMs: 60_000 };

const cleanups: (() => Promise<void> | void)[] = [];
const watched: { t: TestDeps; integrations: MyGekkoIntegration[] }[] = [];

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Shifts the wall clock while timers keep running — what NTP does when it corrects a wrong hardware clock. */
let clockOffset = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + clockOffset;

afterEach(async () => {
  try {
    // Whatever a test did: no credential may have reached the logs, the entities or the diagnostics.
    for (const { t, integrations } of watched) {
      const text = [t.logs.join('\n'), JSON.stringify(t.state.snapshot()), ...integrations.map((gekko) => JSON.stringify(gekko.diagnostics()))].join('\n');
      for (const marker of SECRET_MARKERS) expect(text.includes(marker), `credential marker ${marker} leaked`).toBe(false);
      expect(text).not.toMatch(/[?&](password|key)=/);
    }
  } finally {
    watched.length = 0;
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    forgetRejections();
    clockOffset = 0;
  }
});

async function startSim(options: MyGekkoSimOptions = {}): Promise<MyGekkoSim> {
  const sim = await startMyGekkoSim({ username: 'hub-api', password: PASSWORD, gekkoName: 'Musterhaus', ...options });
  cleanups.push(() => sim.close());
  return sim;
}

function newDeps(): TestDeps {
  const t = createTestDeps();
  watched.push({ t, integrations: [] });
  cleanups.push(() => t.cleanup());
  return t;
}

function settingsFor(target: { host: string; username?: string; password?: string }, overrides: Partial<MyGekkoSettings> = {}): MyGekkoSettings {
  return {
    enabled: true,
    mode: 'local',
    host: target.host,
    username: target.username ?? 'hub-api',
    password: target.password ?? PASSWORD,
    gekkoId: '',
    autoContacts: true,
    contactKeywords: 'fenster, tür, tuer, tor, kontakt, magnet, terrasse, balkon, hülle, huelle',
    doorKeywords: 'tür, tuer, tor, eingang, door',
    contactZone: 'Hülle',
    contacts: [],
    ...overrides,
  };
}

function launch(t: TestDeps, settings: MyGekkoSettings, options: MyGekkoOptions = {}): MyGekkoIntegration {
  const gekko = new MyGekkoIntegration(t.deps, settings, { ...options, timing: { ...FAST, ...options.timing } });
  watched.find((entry) => entry.t === t)?.integrations.push(gekko);
  cleanups.push(() => gekko.stop());
  gekko.start();
  return gekko;
}

/** What the integration manager does when the settings were saved: old entities greyed out, a new instance started. */
function relaunch(t: TestDeps, settings: MyGekkoSettings, options: MyGekkoOptions = {}): MyGekkoIntegration {
  t.state.setAvailable('mygekko', false);
  t.state.setService('mygekko', 'starting');
  return launch(t, settings, options);
}

const health = (state: StateStore): ServiceHealth => state.getService('mygekko');

async function online(state: StateStore): Promise<void> {
  await waitFor(() => health(state).status === 'ok', 5000, 'the myGEKKO service to be ok');
}

async function offline(state: StateStore): Promise<ServiceHealth> {
  await waitFor(() => health(state).status === 'offline', 5000, 'the myGEKKO service to be offline');
  return health(state);
}

interface Rig {
  sim: MyGekkoSim;
  t: TestDeps;
  state: StateStore;
  gekko: MyGekkoIntegration;
  settings: MyGekkoSettings;
}

async function boot(
  options: { sim?: MyGekkoSimOptions; settings?: Partial<MyGekkoSettings>; timing?: Partial<MyGekkoTiming>; active?: boolean } = {},
): Promise<Rig> {
  const sim = await startSim(options.sim);
  const t = newDeps();
  const settings = settingsFor(sim, options.settings);
  const gekko = launch(t, settings, { timing: options.timing });
  gekko.setActive(options.active ?? true);
  await online(t.state);
  return { sim, t, state: t.state, gekko, settings };
}

function entity<K extends EntityKind>(state: StateStore, id: string, kind: K): EntityOf<K> {
  const found = state.get(id);
  if (!found || found.kind !== kind) throw new Error(`expected a ${kind} with id ${id}, found ${found ? `a ${found.kind}` : 'nothing'}`);
  return found as EntityOf<K>;
}

const own = (state: StateStore): Entity[] => state.all().filter((candidate) => candidate.service === 'mygekko');

function countByKind(state: StateStore): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const candidate of own(state)) counts[candidate.kind] = (counts[candidate.kind] ?? 0) + 1;
  return counts;
}

/** The `HttpError` a call is rejected with. */
async function failure(promise: Promise<unknown>): Promise<HttpError> {
  let outcome: unknown = null;
  await promise.catch((err: unknown) => {
    outcome = err;
  });
  expect(outcome, 'the call should have been rejected').toBeInstanceOf(HttpError);
  const err = outcome as unknown as HttpError;
  for (const marker of SECRET_MARKERS) expect(err.message).not.toContain(marker);
  return err;
}

const totalRequests = (sim: MyGekkoSim): number => sim.requests.tree + sim.requests.status + sim.requests.command + sim.requests.other;

function mapping(id: string, source: string, overrides: Partial<ContactMapping> = {}): ContactMapping {
  return { id, source, field: 0, openWhen: 'nonzero', name: id, contactType: 'window', room: '', zone: '', ...overrides };
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

describe('entities', () => {
  it('publishes the whole household with the values the controller reports', async () => {
    const { state, gekko } = await boot();

    expect(countByKind(state)).toEqual({ light: 14, blind: 10, switch: 6, climate: 7, action: 6, clock: 3, alarm: 1, sensor: 10, contact: 11 });
    for (const candidate of own(state)) expect(candidate.available, candidate.id).toBe(true);

    // Lights: a dimmer, a switch-only light, RGB, tunable white, groups.
    expect(entity(state, 'gekko:lights/item0', 'light')).toEqual({
      id: 'gekko:lights/item0',
      kind: 'light',
      name: 'Wohnzimmer Decke',
      room: 'Wohnzimmer',
      available: true,
      service: 'mygekko',
      on: false,
      brightness: 80,
      color: null,
      colorTemp: null,
      features: { dim: true, color: false, colorTemp: false },
      isGroup: false,
    });
    expect(entity(state, 'gekko:lights/item3', 'light')).toMatchObject({ name: 'Küche Decke', room: 'Küche', on: true, brightness: null, features: { dim: false, color: false, colorTemp: false } });
    expect(entity(state, 'gekko:lights/item2', 'light')).toMatchObject({ name: 'LED-Band', brightness: 60, color: '#ff8a3d', features: { dim: true, color: true, colorTemp: false } });
    expect(entity(state, 'gekko:lights/item4', 'light')).toMatchObject({ name: 'Arbeitsplatte', colorTemp: 35, features: { dim: true, color: false, colorTemp: true } });
    expect(entity(state, 'gekko:lights/item12', 'light')).toMatchObject({ name: 'Terrasse', room: 'Außen' });
    expect(entity(state, 'gekko:lights/group0', 'light')).toMatchObject({ name: 'Alle Lichter', room: null, isGroup: true, on: true, brightness: null, features: { dim: false, color: false, colorTemp: false } });
    expect(entity(state, 'gekko:lights/group1', 'light')).toMatchObject({ name: 'Erdgeschoss', isGroup: true, on: true });

    // Blinds: 0 = open, 100 = closed; slats; a group has neither.
    expect(entity(state, 'gekko:blinds/item0', 'blind')).toMatchObject({ name: 'Jalousie Wohnzimmer links', room: 'Wohnzimmer', position: 0, tilt: 0, motion: 'stopped', locked: false, isGroup: false, features: { position: true, tilt: true } });
    expect(entity(state, 'gekko:blinds/item5', 'blind')).toMatchObject({ position: 100, tilt: 100, motion: 'stopped' });
    expect(entity(state, 'gekko:blinds/item7', 'blind')).toMatchObject({ position: 60, tilt: 45 });
    expect(entity(state, 'gekko:blinds/group0', 'blind')).toMatchObject({ name: 'Alle Jalousien', room: null, isGroup: true, position: null, tilt: null, motion: 'stopped', features: { position: false, tilt: false } });

    // Loads become switches; the icon hint comes from the name.
    expect(entity(state, 'gekko:loads/item0', 'switch')).toMatchObject({ name: 'Steckdose Terrasse', room: 'Außen', on: false, variant: 'socket', momentary: false });
    expect(entity(state, 'gekko:loads/item1', 'switch')).toMatchObject({ name: 'Gartenpumpe', variant: 'pump' });
    expect(entity(state, 'gekko:loads/item2', 'switch')).toMatchObject({ name: 'Lüfter Bad', variant: 'fan' });
    expect(entity(state, 'gekko:loads/item3', 'switch')).toMatchObject({ name: 'Steckdose Fernseher', on: true, variant: 'socket' });
    expect(entity(state, 'gekko:loads/item4', 'switch')).toMatchObject({ variant: 'generic' });
    expect(entity(state, 'gekko:loads/group0', 'switch')).toMatchObject({ name: 'Garten', room: null, on: false });

    // Room controllers (their group is skipped).
    expect(entity(state, 'gekko:roomtemps/item0', 'climate')).toEqual({
      id: 'gekko:roomtemps/item0',
      kind: 'climate',
      name: 'Wohnzimmer',
      room: 'Wohnzimmer',
      available: true,
      service: 'mygekko',
      temperature: 21.4,
      target: 21.5,
      humidity: 46,
      output: 6,
      mode: 'comfort',
      heating: true,
      cooling: false,
      windowOpen: false,
      targetRange: { min: 5, max: 30, step: 0.5 },
      features: { target: true, mode: true },
    });
    expect(entity(state, 'gekko:roomtemps/item1', 'climate')).toMatchObject({ name: 'Küche', temperature: 20.8, target: 20.5, output: 0, heating: false });
    expect(state.get('gekko:roomtemps/group0')).toBeUndefined();

    // Actions and clocks; elements that sit on no page ("...") have no room.
    expect(entity(state, 'gekko:actions/item1', 'action')).toMatchObject({ name: 'Gute Nacht', room: null, active: false, features: { start: true, stop: true } });
    expect(state.get('gekko:actions/group0')).toBeUndefined();
    expect(entity(state, 'gekko:clocks/item0', 'clock')).toMatchObject({ name: 'Gartenbewässerung', room: 'Außen', enabled: true, active: null, features: { toggle: true } });
    expect(entity(state, 'gekko:clocks/item2', 'clock')).toMatchObject({ name: 'Zirkulation', room: null, enabled: false });

    // The alarm system appears as one entity per zone.
    expect(entity(state, 'gekko:alarmsystem/item0#1', 'alarm')).toEqual({
      id: 'gekko:alarmsystem/item0#1',
      kind: 'alarm',
      name: 'Hülle',
      room: null,
      available: true,
      service: 'mygekko',
      system: 'Alarmanlage',
      mode: 'disarmed',
      triggered: false,
      breached: false,
      stateText: 'Unscharf · alles geschlossen',
    });
    expect(state.get('gekko:alarmsystem/item0#2')).toBeUndefined();

    // Weather with German names and the units of the format strings.
    expect(entity(state, 'gekko:meteo/temperature', 'sensor')).toMatchObject({ name: 'Außentemperatur', room: null, sensorType: 'temperature', value: 8.6, unit: '°C' });
    expect(entity(state, 'gekko:meteo/humidity', 'sensor')).toMatchObject({ name: 'Luftfeuchte außen', sensorType: 'humidity', value: 71, unit: '%' });
    expect(entity(state, 'gekko:meteo/wind', 'sensor')).toMatchObject({ name: 'Wind', sensorType: 'wind', value: 2.4, unit: 'm/s' });
    expect(entity(state, 'gekko:meteo/brightness', 'sensor')).toMatchObject({ name: 'Helligkeit', sensorType: 'brightness', value: 18, unit: 'kLx' });
    expect(entity(state, 'gekko:meteo/twilight', 'sensor')).toMatchObject({ name: 'Dämmerung', value: 6000, unit: 'lx' });
    expect(entity(state, 'gekko:meteo/rain', 'sensor')).toMatchObject({ name: 'Regen', sensorType: 'rain', value: 0, unit: 'l/h' });

    // Energy meters: current power with the unit the controller names in the value itself.
    expect(entity(state, 'gekko:energycosts/item0', 'sensor')).toMatchObject({ name: 'Stromzähler', sensorType: 'power', value: 0.75, unit: 'kW' });
    expect(entity(state, 'gekko:energycosts/item1', 'sensor')).toMatchObject({ name: 'Photovoltaik', value: 2.41, unit: 'kW' });

    // Everything else is listed for the administrator instead of being dropped silently.
    const diagnostics = gekko.diagnostics() as { unmapped: Record<string, number>; transport: string; controller: Record<string, string | null> };
    expect(diagnostics.unmapped).toEqual({ trends: 1, vents: 1, hotwater_systems: 1 });
    expect(diagnostics.transport).toBe('http');
    expect(diagnostics.controller).toMatchObject({ name: 'Musterhaus', firmware: '879015' });
  });

  it('derives window and door contacts from logic elements and access doors', async () => {
    const { state } = await boot();

    expect(entity(state, 'gekko:contact/auto-alarms-logics-item0', 'contact')).toEqual({
      id: 'gekko:contact/auto-alarms-logics-item0',
      kind: 'contact',
      name: 'Fenster Küche',
      room: 'Türen und Fenster',
      available: true,
      service: 'mygekko',
      open: false,
      contactType: 'window',
      zone: 'Hülle',
      fault: false,
      changedAt: null,
    });
    const types = Object.fromEntries(
      own(state)
        .filter((candidate) => candidate.kind === 'contact')
        .map((candidate) => [candidate.name, candidate.kind === 'contact' ? candidate.contactType : null]),
    );
    expect(types).toEqual({
      'Fenster Küche': 'window',
      'Fenster Bad': 'window',
      Terrassentür: 'door',
      Haustür: 'door',
      'Fenster Büro': 'window',
      Garagentor: 'door',
      'Fenster Wohnzimmer': 'window',
      'Fenster Esszimmer': 'window',
      Kellertür: 'door',
      'Dachfenster Flur': 'window',
      Gartentor: 'door',
    });
    expect(entity(state, 'gekko:contact/auto-accessdoors-item0', 'contact')).toMatchObject({ name: 'Gartentor', room: 'Außen', contactType: 'door', open: false });
    // Ordinary logic elements are not contacts.
    expect(state.get('gekko:contact/auto-alarms-logics-item20')).toBeUndefined();
    expect(state.get('gekko:contact/auto-alarms-logics-item21')).toBeUndefined();
  });

  it('follows contacts as they open and close, and the alarm zone with them', async () => {
    const { sim, state } = await boot();
    const kitchen = () => entity(state, 'gekko:contact/auto-alarms-logics-item0', 'contact');
    const zone = () => entity(state, 'gekko:alarmsystem/item0#1', 'alarm');

    const before = Date.now();
    sim.setContact('Fenster Küche', true);
    await waitFor(() => kitchen().open, 3000, 'the kitchen window to read open');
    const openedAt = kitchen().changedAt;
    expect(openedAt).toBeGreaterThanOrEqual(before);
    expect(openedAt).toBeLessThanOrEqual(Date.now());
    await waitFor(() => zone().breached, 3000, 'the zone to report an open contact');
    expect(zone()).toMatchObject({ mode: 'disarmed', triggered: false, breached: true, stateText: 'Unscharf · mindestens ein Kontakt offen' });
    // The other contacts did not move.
    expect(entity(state, 'gekko:contact/auto-alarms-logics-item1', 'contact')).toMatchObject({ open: false, changedAt: null });

    await pause(5);
    sim.setContact('Fenster Küche', false);
    await waitFor(() => !kitchen().open, 3000, 'the kitchen window to read closed');
    expect(kitchen().changedAt).toBeGreaterThan(openedAt ?? 0);
    await waitFor(() => !zone().breached, 3000, 'the zone to be quiet again');
    expect(zone().stateText).toBe('Unscharf · alles geschlossen');

    expect(sim.arm()).toBe(true);
    await waitFor(() => zone().mode === 'armed', 3000, 'the zone to read armed');
    expect(zone()).toMatchObject({ triggered: false, breached: false, stateText: 'Scharf' });

    sim.setContact('Haustür', true);
    await waitFor(() => zone().triggered, 3000, 'the alarm');
    expect(zone()).toMatchObject({ mode: 'armed', stateText: 'ALARM' });
    expect(entity(state, 'gekko:contact/auto-alarms-logics-item3', 'contact')).toMatchObject({ name: 'Haustür', open: true });

    sim.setContact('Gartentor', true);
    await waitFor(() => entity(state, 'gekko:contact/auto-accessdoors-item0', 'contact').open, 3000, 'the garden gate to read open');
  });

  it('shows the window contact of a room controller once it was seen open, and remembers it', async () => {
    const { sim, t, state, gekko, settings } = await boot();
    const id = 'gekko:contact/auto-roomtemps-item3';
    // Every room controller reports a window state, wired contact or not — "always closed" would be a lie.
    expect(state.get(id)).toBeUndefined();
    expect(entity(state, 'gekko:roomtemps/item3', 'climate').windowOpen).toBe(false);

    sim.setContact('Fenster Schlafzimmer', true);
    await waitFor(() => state.get(id), 3000, 'the bedroom window contact');
    expect(entity(state, id, 'contact')).toMatchObject({ name: 'Fenster Schlafzimmer', room: 'Schlafzimmer', contactType: 'window', zone: 'Hülle', open: true });
    expect(entity(state, 'gekko:roomtemps/item3', 'climate').windowOpen).toBe(true);
    expect(state.get('gekko:contact/auto-roomtemps-item0')).toBeUndefined();

    sim.setContact('Fenster Schlafzimmer', false);
    await waitFor(() => !entity(state, id, 'contact').open, 3000, 'the bedroom window to read closed');

    // A new instance (settings saved, hub restarted) knows the contact although the window is closed.
    await gekko.stop();
    const restarted = relaunch(t, settings);
    await online(state);
    expect(entity(state, id, 'contact')).toMatchObject({ open: false, available: true });
    expect((restarted.diagnostics() as { contacts: { provenWindowContacts: string[] } }).contacts.provenWindowContacts).toEqual(['roomtemps/item3']);
  });

  it('finds contacts that are only known as unnamed logic inputs — no teaching, they just have to open twice', async () => {
    const { sim, t, state, gekko, settings } = await boot({ sim: { contacts: 'unnamed' } });
    const id = 'gekko:contact/auto-alarms-logics-item7-13';
    const names = () => own(state).filter((candidate) => candidate.kind === 'contact').map((candidate) => candidate.name);
    await pause(250);
    // Nothing tells the hub that "Logik 7" holds the contacts.
    expect(names()).toEqual(['Gartentor']);

    const openAndClose = async () => {
      sim.setContact('Fenster Küche', true);
      await waitFor(() => entity(state, 'gekko:alarmsystem/item0#1', 'alarm').breached || null, 3000, 'the zone to report an open contact');
      await pause(150);
      sim.setContact('Fenster Küche', false);
      await waitFor(() => !entity(state, 'gekko:alarmsystem/item0#1', 'alarm').breached || null, 3000, 'the zone to report all closed');
      await pause(150);
    };
    await openAndClose();
    expect(state.get(id)).toBeUndefined();
    await openAndClose();
    await waitFor(() => state.get(id), 3000, 'the learned kitchen contact');
    expect(entity(state, id, 'contact')).toMatchObject({ name: 'Logik 7 · Kontakt 1.1', room: 'Logik', zone: 'Hülle', contactType: 'window', open: false, available: true });
    // The "any input open" output of the same logic followed the zone as well — it is not a contact.
    expect(state.get('gekko:contact/auto-alarms-logics-item7-0')).toBeUndefined();

    sim.setContact('Fenster Küche', true);
    await waitFor(() => entity(state, id, 'contact').open || null, 3000, 'the learned contact to read open');
    sim.setContact('Fenster Küche', false);
    await waitFor(() => !entity(state, id, 'contact').open || null, 3000, 'the learned contact to read closed');

    // Remembered across a restart of the hub.
    await gekko.stop();
    const restarted = relaunch(t, settings);
    await online(state);
    expect(entity(state, id, 'contact')).toMatchObject({ open: false, available: true });
    // Two values were learned (the input and the "any open" output); only the input is shown.
    expect((restarted.diagnostics() as { contacts: { discovery: { learned: number } } }).contacts.discovery.learned).toBe(2);
    expect(names().sort()).toEqual(['Gartentor', 'Logik 7 · Kontakt 1.1']);
  });

  it('exports everything the controller reports, readable and without credentials', async () => {
    const { gekko } = await boot();
    const data = gekko.rawExport();
    expect(data.controller.firmware).toBe('879015');
    expect(data.systems.alarmsystem?.item0).toMatchObject({ name: 'Alarmanlage', group: false, fields: { zone1AlarmState: '0' } });
    expect(data.systems.lights?.item0?.name).toBe('Wohnzimmer Decke');
    expect(data.contactZone).toMatchObject({ reading: 'closed', zones: [{ name: 'Hülle', alarmState: 0 }] });
    const text = JSON.stringify(data);
    for (const marker of SECRET_MARKERS) expect(text).not.toContain(marker);
    expect(text).not.toMatch(/password|username/i);
  });

  it('lets explicit contact mappings win over the automatic ones', async () => {
    const contacts: ContactMapping[] = [
      mapping('kueche', 'alarms_logics/item0', { name: 'Küchenfenster', room: 'Küche', zone: 'Erdgeschoss' }),
      mapping('haustuer', 'alarms_logics/item3', { name: 'Haustür (invertiert)', openWhen: 'zero', contactType: 'door' }),
      mapping('schlafzimmer', 'roomtemps/item3', { name: 'Schlafzimmerfenster', field: 12, room: 'Schlafzimmer' }),
      mapping('trend-text', 'trends/item0', { name: 'Trend-Text', field: 2 }),
      mapping('zu-kurz', 'alarms_logics/item1', { name: 'Feld fehlt', field: 60 }),
      mapping('verschwunden', 'alarms_logics/item99', { name: 'Gibt es nicht' }),
    ];
    const { sim, state, gekko } = await boot({ settings: { contacts } });

    expect(entity(state, 'gekko:contact/kueche', 'contact')).toMatchObject({ name: 'Küchenfenster', room: 'Küche', zone: 'Erdgeschoss', contactType: 'window', open: false, available: true });
    // Same element and field: the automatic contact steps back. Other fields of other elements are untouched.
    expect(state.get('gekko:contact/auto-alarms-logics-item0')).toBeUndefined();
    expect(state.get('gekko:contact/auto-alarms-logics-item3')).toBeUndefined();
    expect(state.get('gekko:contact/auto-alarms-logics-item1')).toBeDefined();

    // "open when zero": closed reed contact reports 1.
    expect(entity(state, 'gekko:contact/haustuer', 'contact')).toMatchObject({ open: true, contactType: 'door', room: null, zone: null });
    sim.setContact('Haustür', true);
    await waitFor(() => !entity(state, 'gekko:contact/haustuer', 'contact').open, 3000, 'the inverted contact to flip');

    // An explicitly mapped room controller needs no proof.
    expect(entity(state, 'gekko:contact/schlafzimmer', 'contact')).toMatchObject({ open: false, available: true });
    sim.setContact('Fenster Schlafzimmer', true);
    await waitFor(() => entity(state, 'gekko:contact/schlafzimmer', 'contact').open, 3000, 'the mapped room controller window');
    expect(state.get('gekko:contact/auto-roomtemps-item3')).toBeUndefined();

    // Unreadable values count as closed, a missing element as unavailable — and the administrator is told.
    expect(entity(state, 'gekko:contact/trend-text', 'contact')).toMatchObject({ open: false, available: true });
    expect(entity(state, 'gekko:contact/zu-kurz', 'contact')).toMatchObject({ open: false, available: true });
    expect(entity(state, 'gekko:contact/verschwunden', 'contact')).toMatchObject({ open: false, available: false });
    const { contacts: report, unmapped } = gekko.diagnostics() as { contacts: { explicit: number; automatic: number; notes: string[] }; unmapped: Record<string, number> };
    expect(report.explicit).toBe(6);
    expect(report.automatic).toBe(9);
    expect(report.notes).toHaveLength(3);
    expect(report.notes.join('\n')).toContain('Trend-Text');
    expect(report.notes.join('\n')).toContain('Feld fehlt');
    expect(report.notes.join('\n')).toContain('Gibt es nicht');
    // A system that feeds a contact no longer counts as unused.
    expect(unmapped).toEqual({ vents: 1, hotwater_systems: 1 });
  });

  it('creates no automatic contacts when the administrator switched them off', async () => {
    const { state } = await boot({ settings: { autoContacts: false, contacts: [mapping('nur-dieser', 'accessdoors/item0', { field: 2, contactType: 'garage' })] } });
    expect(own(state).filter((candidate) => candidate.kind === 'contact').map((candidate) => candidate.id)).toEqual(['gekko:contact/nur-dieser']);
    expect(entity(state, 'gekko:contact/nur-dieser', 'contact').contactType).toBe('garage');
  });

  it('matches contact keywords without regard to case and umlaut spelling', async () => {
    const { sim, state } = await boot({ settings: { contactKeywords: ' TUER , Dachfenster ', doorKeywords: 'Tür' } });
    const names = own(state)
      .filter((candidate) => candidate.kind === 'contact' && candidate.id.includes('alarms-logics'))
      .map((candidate) => `${candidate.name}:${candidate.kind === 'contact' ? candidate.contactType : ''}`);
    // The page "Türen und Fenster" matches "tuer" for every element on it; only names decide about the type.
    expect(names).toContain('Terrassentür:door');
    expect(names).toContain('Fenster Küche:window');
    expect(names).toContain('Dachfenster Flur:window');
    expect(names).toHaveLength(10);
    expect(sim.find('alarms_logics', 'Heizung Sommerbetrieb')).toBe('item20');
    expect(state.get('gekko:contact/auto-alarms-logics-item20')).toBeUndefined();
  });
});

describe('contactCandidates()', () => {
  it('lists what could be a contact with live raw values, labels and the suggestion', async () => {
    const { sim, gekko } = await boot();
    const candidates = gekko.contactCandidates();
    const find = (source: string) => {
      const candidate = gekko.contactCandidates().find((entry) => entry.source === source);
      if (!candidate) throw new Error(`no candidate ${source}`);
      return candidate;
    };

    // 12 logic elements, 7 room controllers, 1 access door, 1 trend — no groups.
    expect(candidates).toHaveLength(21);
    expect(candidates.some((candidate) => candidate.source.includes('group'))).toBe(false);

    const kitchen = find('alarms_logics/item0');
    expect(kitchen).toMatchObject({
      system: 'alarms_logics',
      name: 'Fenster Küche',
      page: 'Türen und Fenster',
      suggestion: { field: 0, openWhen: 'nonzero', contactType: 'window', name: 'Fenster Küche', room: 'Türen und Fenster' },
      mappedIds: ['gekko:contact/auto-alarms-logics-item0'],
    });
    expect(kitchen.fields).toHaveLength(25);
    expect(kitchen.fieldLabels).toHaveLength(25);
    expect(kitchen.fields[0]).toBe('0.00');
    expect(kitchen.fieldLabels[0]).toBe('outputGate1');
    expect(kitchen.fieldLabels[6]).toBe('outputGateA');
    expect(kitchen.fieldLabels[13]).toBe('inputValue1_1');

    expect(find('alarms_logics/item20')).toMatchObject({ name: 'Heizung Sommerbetrieb', page: 'Heizung', suggestion: null, mappedIds: [] });
    expect(find('alarms_logics/item21')).toMatchObject({ page: null, suggestion: null });

    const bedroom = find('roomtemps/item3');
    expect(bedroom.fieldLabels[12]).toBe('windowOpenStatus');
    expect(bedroom.fieldLabels[0]).toBe('temperatureValue');
    expect(bedroom.fields[12]).toBe('0');
    expect(bedroom.suggestion).toEqual({ field: 12, openWhen: 'nonzero', contactType: 'window', name: 'Fenster Schlafzimmer', room: 'Schlafzimmer' });
    expect(bedroom.mappedIds).toEqual([]);

    const gate = find('accessdoors/item0');
    expect(gate.fieldLabels[2]).toBe('accessState');
    expect(gate.suggestion).toMatchObject({ field: 2, contactType: 'door', name: 'Gartentor', room: 'Außen' });
    expect(gate.mappedIds).toEqual(['gekko:contact/auto-accessdoors-item0']);

    const trend = find('trends/item0');
    expect(trend.suggestion).toBeNull();
    expect(trend.fieldLabels[3]).toBe('variable1Value');
    expect(trend.fields[2]).toBe('Fenster Kueche');

    // "Teaching": the administrator opens a window and watches which value moves.
    sim.setContact('Fenster Küche', true);
    await waitFor(() => find('alarms_logics/item0').fields[0] === '1.00', 3000, 'the candidate to show the open window');
    expect(find('alarms_logics/item0').fields[13]).toBe('1.00');
    expect(find('trends/item0').fields[3]).toBe('1.00');
    sim.setContact('Fenster Schlafzimmer', true);
    await waitFor(() => find('roomtemps/item3').fields[12] === '1', 3000, 'the room controller to show the open window');
    await waitFor(() => find('roomtemps/item3').mappedIds.length === 1, 3000, 'the room controller to feed a contact');
    expect(find('roomtemps/item3').mappedIds).toEqual(['gekko:contact/auto-roomtemps-item3']);
  });

  it('includes the elements of explicit mappings and is empty before the first contact', async () => {
    const sim = await startSim();
    const t = newDeps();
    const gekko = launch(t, settingsFor(sim, { contacts: [mapping('licht', 'lights/item3'), mapping('gruppe', 'lights/group0')] }));
    expect(gekko.contactCandidates()).toEqual([]);
    await online(t.state);
    const sources = gekko.contactCandidates().map((candidate) => candidate.source);
    expect(sources).toContain('lights/item3');
    expect(sources).toContain('lights/group0');
    expect(sources).not.toContain('lights/group1');
    const lamp = gekko.contactCandidates().find((candidate) => candidate.source === 'lights/item3');
    expect(lamp).toMatchObject({ name: 'Küche Decke', mappedIds: ['gekko:contact/licht'], suggestion: null });
    expect(lamp?.fieldLabels.slice(0, 5)).toEqual(['currentState', 'dimLevel', 'rgbColor', 'tunableWhiteLevel', 'elementInfo']);
    expect(entity(t.state, 'gekko:contact/licht', 'contact').open).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

describe('commands', () => {
  const LAMP = 'gekko:lights/item0';

  /** Sends a command and returns the one call that arrived at the controller for it. */
  async function send(rig: Rig, id: string, command: EntityCommand): Promise<string> {
    const before = rig.sim.commands.length;
    await rig.gekko.command(id, command);
    expect(rig.sim.commands, `calls for ${JSON.stringify(command)}`).toHaveLength(before + 1);
    const call = rig.sim.commands[before]!;
    return `${call.system}/${call.element}=${call.value} → ${call.status}`;
  }

  it('translates every command into the documented scmd value', async () => {
    const rig = await boot();
    const cases: [id: string, command: EntityCommand, wire: string][] = [
      [LAMP, { action: 'turn_on' }, 'lights/item0=1'],
      [LAMP, { action: 'turn_off' }, 'lights/item0=0'],
      [LAMP, { action: 'toggle' }, 'lights/item0=T'],
      [LAMP, { action: 'set_brightness', value: 55.4 }, 'lights/item0=D55'],
      [LAMP, { action: 'set_brightness', value: 250 }, 'lights/item0=D100'],
      [LAMP, { action: 'set_brightness', value: 0 }, 'lights/item0=0'],
      [LAMP, { action: 'set_brightness', value: -5 }, 'lights/item0=0'],
      ['gekko:lights/item2', { action: 'set_color', value: '#00AAff' }, 'lights/item2=C43775'],
      ['gekko:lights/item4', { action: 'set_color_temp', value: 64.6 }, 'lights/item4=TW65'],
      ['gekko:blinds/item0', { action: 'down' }, 'blinds/item0=-2'],
      ['gekko:blinds/item0', { action: 'stop' }, 'blinds/item0=0'],
      ['gekko:blinds/item0', { action: 'up' }, 'blinds/item0=2'],
      ['gekko:blinds/item0', { action: 'set_position', value: 55.44 }, 'blinds/item0=P55.4'],
      ['gekko:blinds/item0', { action: 'set_position', value: 100 }, 'blinds/item0=P100.0'],
      ['gekko:blinds/item0', { action: 'set_tilt', value: 32 }, 'blinds/item0=S32.0'],
      ['gekko:blinds/group0', { action: 'down' }, 'blinds/group0=-2'],
      ['gekko:blinds/group0', { action: 'up' }, 'blinds/group0=2'],
      ['gekko:loads/item0', { action: 'turn_on' }, 'loads/item0=2'],
      ['gekko:loads/item0', { action: 'turn_off' }, 'loads/item0=0'],
      ['gekko:loads/item0', { action: 'toggle' }, 'loads/item0=T'],
      ['gekko:roomtemps/item0', { action: 'set_target', value: 22.5 }, 'roomtemps/item0=S22.5'],
      ['gekko:roomtemps/item0', { action: 'set_target', value: 21.26 }, 'roomtemps/item0=S21.3'],
      ['gekko:roomtemps/item0', { action: 'set_target', value: 99 }, 'roomtemps/item0=S30.0'],
      ['gekko:roomtemps/item0', { action: 'set_mode', value: 'off' }, 'roomtemps/item0=M1'],
      ['gekko:roomtemps/item0', { action: 'set_mode', value: 'comfort' }, 'roomtemps/item0=M8'],
      ['gekko:roomtemps/item0', { action: 'set_mode', value: 'reduced' }, 'roomtemps/item0=M16'],
      ['gekko:roomtemps/item0', { action: 'set_mode', value: 'manual' }, 'roomtemps/item0=M64'],
      ['gekko:roomtemps/item0', { action: 'set_mode', value: 'standby' }, 'roomtemps/item0=M256'],
      ['gekko:actions/item2', { action: 'run' }, 'actions/item2=1'],
      ['gekko:actions/item2', { action: 'stop' }, 'actions/item2=-1'],
      ['gekko:clocks/item2', { action: 'enable' }, 'clocks/item2=1'],
      ['gekko:clocks/item2', { action: 'disable' }, 'clocks/item2=0'],
    ];
    for (const [id, command, wire] of cases) expect(await send(rig, id, command), JSON.stringify(command)).toBe(`${wire} → 200`);

    // The controller did what was asked, and the polls bring it back.
    expect(rig.sim.sumstate('lights', 'item2')).toMatch(/^1;60\.00;43775;/);
    expect(rig.sim.sumstate('roomtemps', 'item0')).toMatch(/^21\.40;30\.00;[\d.]+;256;/);
    await waitFor(() => entity(rig.state, 'gekko:lights/item2', 'light').color === '#00aaff', 3000, 'the new colour');
    await waitFor(() => entity(rig.state, 'gekko:lights/item4', 'light').colorTemp === 65, 3000, 'the new colour temperature');
    await waitFor(() => entity(rig.state, 'gekko:roomtemps/item0', 'climate').mode === 'standby', 3000, 'the new mode');
    expect(entity(rig.state, 'gekko:roomtemps/item0', 'climate').target).toBe(30);
    await waitFor(() => entity(rig.state, 'gekko:blinds/item0', 'blind').tilt === 32, 3000, 'the new slat angle');
  });

  it('switches groups only with the values a group documents', async () => {
    const rig = await boot({ timing: QUIET, active: false });
    // "Alle Lichter" is on because two lights are: toggling means "off" …
    expect(await send(rig, 'gekko:lights/group0', { action: 'toggle' })).toBe('lights/group0=0 → 200');
    // … and what was just sent decides about the next toggle, without waiting for a poll.
    expect(await send(rig, 'gekko:lights/group0', { action: 'toggle' })).toBe('lights/group0=1 → 200');
    expect(await send(rig, 'gekko:lights/group0', { action: 'turn_off' })).toBe('lights/group0=0 → 200');
    expect(await send(rig, 'gekko:lights/group1', { action: 'turn_on' })).toBe('lights/group1=1 → 200');
    // Load groups know 0 and 2 only.
    expect(await send(rig, 'gekko:loads/group0', { action: 'toggle' })).toBe('loads/group0=2 → 200');
    expect(await send(rig, 'gekko:loads/group0', { action: 'toggle' })).toBe('loads/group0=0 → 200');
    expect(await send(rig, 'gekko:loads/group0', { action: 'turn_on' })).toBe('loads/group0=2 → 200');
    await waitFor(() => entity(rig.state, 'gekko:loads/item1', 'switch').on, 3000, 'the pump of the group');
  });

  it('refuses what does not fit the entity without bothering the controller', async () => {
    const rig = await boot({ timing: QUIET, active: false });
    rig.state.upsert('sonos', { ...entity(rig.state, LAMP, 'light'), id: 'fremd:lampe', service: 'sonos' });
    const cases: [id: string, command: EntityCommand, status: number, code: string][] = [
      ['gekko:lights/item3', { action: 'set_brightness', value: 50 }, 400, 'unsupported'],
      [LAMP, { action: 'set_color', value: '#ff0000' }, 400, 'unsupported'],
      [LAMP, { action: 'set_color_temp', value: 50 }, 400, 'unsupported'],
      [LAMP, { action: 'set_brightness', value: Number.NaN }, 400, 'bad_request'],
      [LAMP, { action: 'up' }, 400, 'unsupported'],
      [LAMP, { action: 'run' }, 400, 'unsupported'],
      ['gekko:lights/item2', { action: 'set_color', value: 'rot' }, 400, 'bad_request'],
      ['gekko:lights/group0', { action: 'set_brightness', value: 50 }, 400, 'unsupported'],
      ['gekko:blinds/group0', { action: 'stop' }, 400, 'unsupported'],
      ['gekko:blinds/group0', { action: 'set_position', value: 50 }, 400, 'unsupported'],
      ['gekko:blinds/group0', { action: 'set_tilt', value: 50 }, 400, 'unsupported'],
      ['gekko:blinds/item0', { action: 'turn_on' }, 400, 'unsupported'],
      ['gekko:blinds/item0', { action: 'set_position', value: Number.POSITIVE_INFINITY }, 400, 'bad_request'],
      ['gekko:loads/item0', { action: 'set_brightness', value: 10 }, 400, 'unsupported'],
      ['gekko:roomtemps/item0', { action: 'set_mode', value: 'unknown' }, 400, 'unsupported'],
      ['gekko:roomtemps/item0', { action: 'turn_off' }, 400, 'unsupported'],
      ['gekko:actions/item0', { action: 'toggle' }, 400, 'unsupported'],
      ['gekko:clocks/item0', { action: 'run' }, 400, 'unsupported'],
      ['gekko:contact/auto-alarms-logics-item0', { action: 'toggle' }, 400, 'unsupported'],
      // The alarm system is read-only for the hub, whatever is asked.
      ['gekko:alarmsystem/item0#1', { action: 'turn_on' }, 400, 'unsupported'],
      ['gekko:alarmsystem/item0#1', { action: 'enable' }, 400, 'unsupported'],
      ['gekko:alarmsystem/item0#1', { action: 'run' }, 400, 'unsupported'],
      ['gekko:meteo/temperature', { action: 'turn_on' }, 400, 'unsupported'],
      ['gekko:energycosts/item0', { action: 'run' }, 400, 'unsupported'],
      ['gekko:lights/item99', { action: 'turn_on' }, 404, 'not_found'],
      ['fremd:lampe', { action: 'turn_on' }, 404, 'not_found'],
    ];
    for (const [id, command, status, code] of cases) {
      const err = await failure(rig.gekko.command(id, command));
      expect(`${err.statusCode} ${err.code}`, `${id} ${JSON.stringify(command)}`).toBe(`${status} ${code}`);
      expect(err.message.length).toBeGreaterThan(10);
    }
    expect(rig.sim.requests.command).toBe(0);
    expect(rig.sim.commands).toEqual([]);
    expect(health(rig.state).status).toBe('ok');
  });

  it('shows the result of a command at once, before anything is read back', async () => {
    // No follow-up polls here: whatever the entities show after a command is what the hub assumes.
    const rig = await boot({ timing: { ...QUIET, commandKicksMs: [] }, active: false });
    const polls = rig.sim.requests.status;
    expect(entity(rig.state, 'gekko:lights/group1', 'light').on).toBe(true);

    await rig.gekko.command('gekko:lights/item3', { action: 'turn_off' });
    await rig.gekko.command(LAMP, { action: 'set_brightness', value: 33 });
    await rig.gekko.command('gekko:blinds/item3', { action: 'down' });
    await rig.gekko.command('gekko:roomtemps/item0', { action: 'set_target', value: 19 });
    await rig.gekko.command('gekko:roomtemps/item0', { action: 'set_mode', value: 'reduced' });
    await rig.gekko.command('gekko:actions/item4', { action: 'run' });
    await rig.gekko.command('gekko:clocks/item2', { action: 'enable' });
    await rig.gekko.command('gekko:loads/item0', { action: 'toggle' });
    expect(rig.sim.requests.status).toBe(polls);
    expect(entity(rig.state, 'gekko:lights/item3', 'light').on).toBe(false);
    expect(entity(rig.state, LAMP, 'light')).toMatchObject({ on: true, brightness: 33 });
    expect(entity(rig.state, 'gekko:blinds/item3', 'blind').motion).toBe('down');
    expect(entity(rig.state, 'gekko:roomtemps/item0', 'climate')).toMatchObject({ target: 19, mode: 'reduced', heating: true });
    expect(entity(rig.state, 'gekko:actions/item4', 'action').active).toBe(true);
    expect(entity(rig.state, 'gekko:clocks/item2', 'clock').enabled).toBe(true);
    expect(entity(rig.state, 'gekko:loads/item0', 'switch').on).toBe(true);

    // The next poll brings what really happened, including side effects the hub cannot know:
    // the valve closes, and the scene "Kino" switched the ceiling light off again.
    rig.gekko.setActive(true);
    await waitFor(() => rig.sim.requests.status > polls, 3000, 'the next poll');
    await waitFor(() => entity(rig.state, 'gekko:roomtemps/item0', 'climate').heating === false, 3000, 'the valve to close');
    expect(entity(rig.state, LAMP, 'light')).toMatchObject({ on: false, brightness: 33 });
    expect(entity(rig.state, 'gekko:lights/item1', 'light')).toMatchObject({ on: true, brightness: 20 });
    expect(entity(rig.state, 'gekko:blinds/item3', 'blind').motion).toBe('down');
    expect(entity(rig.state, 'gekko:loads/item0', 'switch').on).toBe(true);
  });

  it('reads the state back twice after a command, and only twice', async () => {
    const rig = await boot({ timing: { ...QUIET, commandKicksMs: [30, 90] }, active: false });
    const polls = rig.sim.requests.status;
    await rig.gekko.command('gekko:actions/item0', { action: 'run' });
    // "Alles aus" switched lights off the hub did not touch: the follow-up polls show it.
    await waitFor(() => !entity(rig.state, 'gekko:lights/item3', 'light').on, 3000, 'the scene to show');
    await waitFor(() => rig.sim.requests.status === polls + 2, 3000, 'the second follow-up poll');
    await pause(250);
    expect(rig.sim.requests.status).toBe(polls + 2);
    expect(rig.sim.requests.tree).toBe(1);
  });

  it('sends only the newest of several waiting commands of the same kind', async () => {
    const rig = await boot({ timing: QUIET, active: false });
    const sent = (from: number) => rig.sim.commands.slice(from).map((call) => call.value);

    // A slider being dragged: the first value is already on its way, of the rest only the last one counts.
    await Promise.all([10, 20, 30, 40, 50, 60].map((value) => rig.gekko.command(LAMP, { action: 'set_brightness', value })));
    expect(sent(0)).toEqual(['D10', 'D60']);
    expect(rig.sim.sumstate('lights', 'item0')).toMatch(/^1;60\.00;/);
    expect(entity(rig.state, LAMP, 'light').brightness).toBe(60);

    // The newest command also goes last: "dim, off, dim again" must end dimmed, not off.
    let from = rig.sim.commands.length;
    await Promise.all([
      rig.gekko.command(LAMP, { action: 'turn_on' }),
      rig.gekko.command(LAMP, { action: 'set_brightness', value: 30 }),
      rig.gekko.command(LAMP, { action: 'turn_off' }),
      rig.gekko.command(LAMP, { action: 'set_brightness', value: 70 }),
    ]);
    expect(sent(from)).toEqual(['1', '0', 'D70']);
    expect(rig.sim.sumstate('lights', 'item0')).toMatch(/^1;70\.00;/);

    // Every tap on a toggle counts, and other entities are not affected.
    from = rig.sim.commands.length;
    await Promise.all([
      rig.gekko.command(LAMP, { action: 'toggle' }),
      rig.gekko.command(LAMP, { action: 'toggle' }),
      rig.gekko.command('gekko:lights/item1', { action: 'set_brightness', value: 5 }),
      rig.gekko.command(LAMP, { action: 'toggle' }),
      rig.gekko.command('gekko:lights/item1', { action: 'set_brightness', value: 15 }),
    ]);
    expect(sent(from)).toEqual(['T', 'T', 'T', 'D15']);
    expect((rig.gekko.diagnostics() as { commands: Record<string, number> }).commands).toMatchObject({ sent: 9, failed: 0, superseded: 6, waiting: 0 });
  });

  it('turns the errors of the controller into German messages, sending each command once', async () => {
    const rig = await boot({ timing: QUIET, active: false });
    const { sim, gekko, state } = rig;
    const attempt = async (status: number) => {
      sim.failNext(status);
      return failure(gekko.command(LAMP, { action: 'turn_on' }));
    };

    const readOnly = await attempt(405);
    expect(readOnly).toMatchObject({ statusCode: 400, code: 'unsupported' });
    expect(readOnly.message).toContain('„Wohnzimmer Decke“ lässt sich nicht schalten');

    const notExecuted = await attempt(444);
    expect(notExecuted).toMatchObject({ statusCode: 409, code: 'not_executed' });
    expect(notExecuted.message).toBe('Der myGEKKO konnte den Befehl für „Wohnzimmer Decke“ nicht ausführen.');

    expect(await attempt(400)).toMatchObject({ statusCode: 502, code: 'device_error', message: 'Der myGEKKO hat den Befehl abgelehnt (HTTP 400).' });
    expect(await attempt(500)).toMatchObject({ statusCode: 502, code: 'device_error' });

    // An element that vanished: the list of elements is read again.
    const trees = sim.requests.tree;
    const gone = await attempt(404);
    expect(gone).toMatchObject({ statusCode: 404, code: 'not_found' });
    expect(gone.message).toContain('Wohnzimmer Decke');
    await waitFor(() => sim.requests.tree === trees + 1, 3000, 'the resource tree to be read again');

    expect(sim.commands.map((call) => call.status)).toEqual([405, 444, 400, 500, 404]);
    // None of this changed the light or is a connection problem.
    expect(entity(state, LAMP, 'light')).toMatchObject({ on: false, available: true });
    expect(health(state).status).toBe('ok');
    expect((gekko.diagnostics() as { commands: Record<string, number> }).commands).toMatchObject({ sent: 0, failed: 5 });
  });

  it('reports a blind the controller has locked and the command it refuses', async () => {
    const rig = await boot();
    rig.sim.lockBlind('Jalousie Küche', true);
    await waitFor(() => entity(rig.state, 'gekko:blinds/item3', 'blind').locked, 3000, 'the lock to show');
    const err = await failure(rig.gekko.command('gekko:blinds/item3', { action: 'down' }));
    expect(err).toMatchObject({ statusCode: 409, code: 'not_executed' });
    expect(rig.sim.commands).toEqual([{ system: 'blinds', element: 'item3', value: '-2', status: 444 }]);
    expect(entity(rig.state, 'gekko:blinds/item3', 'blind')).toMatchObject({ motion: 'stopped', position: 0 });
  });

  it('moves a blind over time', async () => {
    const rig = await boot({ sim: { blindTravelMs: 400 } });
    const id = 'gekko:blinds/item1';
    const positions = new Set<number>();
    rig.state.on('entities', (changed) => {
      for (const candidate of changed) if (candidate.id === id && candidate.kind === 'blind' && candidate.position !== null) positions.add(candidate.position);
    });
    await rig.gekko.command(id, { action: 'down' });
    expect(entity(rig.state, id, 'blind').motion).toBe('down');
    await waitFor(() => entity(rig.state, id, 'blind').position === 100, 3000, 'the blind to arrive at the bottom');
    // "Hold down" stays reported by the controller after the arrival — the blind is not moving any more.
    await waitFor(() => entity(rig.state, id, 'blind').motion === 'stopped', 3000, 'the blind to stop');
    expect(rig.sim.sumstate('blinds', 'item1')).toMatch(/^-2;100\.00;100\.00;/);
    expect([...positions].some((position) => position > 0 && position < 100)).toBe(true);

    await rig.gekko.command(id, { action: 'set_position', value: 25 });
    expect(entity(rig.state, id, 'blind').motion).toBe('up');
    await waitFor(() => entity(rig.state, id, 'blind').position === 25 && entity(rig.state, id, 'blind').motion === 'stopped', 3000, 'the blind to reach 25 %');
  });

  it('pauses after a rate limit instead of pushing on', async () => {
    const rig = await boot({ timing: QUIET, active: false });
    const { sim, gekko, state } = rig;
    sim.failNext(429);
    const err = await failure(gekko.command(LAMP, { action: 'turn_on' }));
    expect(err).toMatchObject({ statusCode: 429, code: 'rate_limited', retryAfter: 60 });
    expect(health(state).status).toBe('degraded');
    expect(health(state).message).toContain('zu viele Anfragen');

    const requests = totalRequests(sim);
    const again = await failure(gekko.command(LAMP, { action: 'turn_on' }));
    expect(again).toMatchObject({ statusCode: 429, code: 'rate_limited' });
    expect(again.retryAfter).toBeGreaterThan(50);
    // Opening the app must not break the pause either.
    gekko.setActive(true);
    await pause(250);
    expect(totalRequests(sim)).toBe(requests);
    expect(own(state).every((candidate) => candidate.available)).toBe(true);
  });

  it('treats a login rejected on a command like any rejected login: nothing more is sent', async () => {
    const rig = await boot({ timing: QUIET, active: false });
    const { sim, gekko, state } = rig;
    sim.failNext(403);
    const err = await failure(gekko.command(LAMP, { action: 'turn_on' }));
    expect(err).toMatchObject({ statusCode: 503, code: 'unavailable' });
    expect(err.message).toContain('lehnt die Anmeldung');

    const down = await offline(state);
    expect(down.message).toMatch(/^Der myGEKKO lehnt die Anmeldung ab\. Bitte Benutzername und Passwort prüfen\. Nächster Versuch gegen \d{2}:\d{2} Uhr\.$/);
    expect(own(state).every((candidate) => !candidate.available)).toBe(true);

    const requests = totalRequests(sim);
    expect(await failure(gekko.command(LAMP, { action: 'turn_on' }))).toMatchObject({ statusCode: 503 });
    gekko.setActive(true);
    await pause(250);
    expect(totalRequests(sim)).toBe(requests);
    expect(sim.commands).toHaveLength(1);
  });

  it('answers 503 when the controller cannot be reached, and finds out what happened', async () => {
    const rig = await boot({ timing: QUIET, active: false });
    await rig.sim.setOffline(true);
    const err = await failure(rig.gekko.command(LAMP, { action: 'turn_on' }));
    expect(err).toMatchObject({ statusCode: 503, code: 'unavailable', message: 'Der myGEKKO ist gerade nicht erreichbar.' });
    // The failed command makes the hub look at once instead of at the next regular poll.
    const down = await offline(rig.state);
    expect(down.message).toContain('nicht erreichbar');
    expect(await failure(rig.gekko.command(LAMP, { action: 'turn_on' }))).toMatchObject({ statusCode: 503 });
  });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

interface PollingReport {
  polling: { consecutiveFailures: number; failedPolls: number; pauseReason: string | null; pausedUntil: string | null; lastProblem: { kind: string; status: number | null } | null };
}

const AUTH_MESSAGE = /^Der myGEKKO lehnt die Anmeldung ab\. Bitte Benutzername und Passwort prüfen\. Nächster Versuch gegen \d{2}:\d{2} Uhr\.$/;

/** Collects the health states the service passes through from now on. */
function healthLog(state: StateStore): string[] {
  const seen: string[] = [];
  state.on('services', (list) => {
    for (const entry of list) if (entry.id === 'mygekko') seen.push(entry.status);
  });
  return seen;
}

describe('health', () => {
  it('stops after a rejected login instead of hammering the controller', async () => {
    // This controller locks the account after two wrong logins in a row.
    const sim = await startSim({ lockout: { attempts: 2, durationMs: 60_000 } });
    const t = newDeps();
    const wrong = settingsFor(sim, { password: WRONG_PASSWORD });
    const first = launch(t, wrong);
    first.setActive(true);

    expect((await offline(t.state)).message).toMatch(AUTH_MESSAGE);
    expect(sim.forbiddenCount).toBe(1);
    await pause(300);
    expect(sim.forbiddenCount).toBe(1);
    expect(totalRequests(sim)).toBe(1);
    expect(own(t.state)).toEqual([]);
    expect((first.diagnostics() as PollingReport).polling).toMatchObject({ pauseReason: 'auth', lastProblem: { kind: 'auth', status: 403 } });

    // Saving the same settings again starts a new instance — which does not try again …
    await first.stop();
    const second = relaunch(t, wrong);
    second.setActive(true);
    expect(health(t.state).status).toBe('offline');
    expect(health(t.state).message).toMatch(AUTH_MESSAGE);
    await pause(150);
    expect(sim.forbiddenCount).toBe(1);

    // … nor does the "test connection" button …
    const tested = await MyGekkoIntegration.test(wrong, { timing: FAST });
    expect(tested.ok).toBe(false);
    expect(tested.message).toContain('eben erst abgelehnt');
    expect(sim.forbiddenCount).toBe(1);

    // … nor a restarted hub: its memory is gone, but it stored a note.
    await second.stop();
    forgetRejections();
    const third = relaunch(t, wrong);
    expect(health(t.state).message).toMatch(AUTH_MESSAGE);
    await pause(150);
    expect(sim.forbiddenCount).toBe(1);
    await third.stop();

    // The corrected password is tried at once — and works, because the account was never locked.
    relaunch(t, settingsFor(sim));
    await online(t.state);
    expect(sim.forbiddenCount).toBe(1);
    expect(own(t.state).length).toBeGreaterThan(60);
  });

  it('allows one corrected attempt and then lets the account rest', async () => {
    const sim = await startSim({ lockout: { attempts: 3, durationMs: 60_000 } });
    const t = newDeps();
    const first = launch(t, settingsFor(sim, { password: WRONG_PASSWORD }));
    await offline(t.state);
    await first.stop();

    // A second, different wrong password: tried once.
    const second = relaunch(t, settingsFor(sim, { password: `${WRONG_PASSWORD} 2` }));
    await waitFor(() => sim.forbiddenCount === 2, 3000, 'the second attempt');
    await offline(t.state);
    await second.stop();

    // The third password is not sent — not even the right one — until the account has rested.
    const third = relaunch(t, settingsFor(sim));
    expect(health(t.state).status).toBe('offline');
    expect(health(t.state).message).toMatch(/^Der myGEKKO hat eben mehrere Anmeldungen abgelehnt\..+Nächster Versuch gegen \d{2}:\d{2} Uhr\.$/);
    const tested = await MyGekkoIntegration.test(settingsFor(sim), { timing: FAST });
    expect(tested).toMatchObject({ ok: false });
    expect(tested.message).toContain('Minute');
    await pause(150);
    expect(totalRequests(sim)).toBe(2);
    expect(sim.forbiddenCount).toBe(2);
    await third.stop();
  });

  it('tries again when the pause after a rejected login is over', async () => {
    const rig = await boot({ timing: { authPauseMs: 600 } });
    rig.sim.setCredentials('hub-api', 'inzwischen geändert');
    expect((await offline(rig.state)).message).toMatch(AUTH_MESSAGE);
    const rejectedAt = Date.now();
    expect(own(rig.state).every((candidate) => !candidate.available)).toBe(true);
    rig.sim.setCredentials('hub-api', PASSWORD);

    await online(rig.state);
    expect(Date.now() - rejectedAt).toBeGreaterThanOrEqual(450);
    expect(rig.sim.forbiddenCount).toBe(1);
    await waitFor(() => own(rig.state).every((candidate) => candidate.available), 3000, 'the entities to come back');
  });

  it('goes offline after two failed polls, keeps the entities greyed out and recovers', async () => {
    const rig = await boot();
    const { sim, state, gekko } = rig;
    const count = own(state).length;
    const seen = healthLog(state);

    await sim.setOffline(true);
    const down = await offline(state);
    expect(down.message).toBe('Der myGEKKO ist nicht erreichbar: Verbindung abgelehnt (Gerät aus oder falscher Port?).');
    expect(down.lastOkAt).not.toBeNull();
    expect(own(state)).toHaveLength(count);
    expect(own(state).every((candidate) => !candidate.available)).toBe(true);
    expect((gekko.diagnostics() as PollingReport).polling.consecutiveFailures).toBeGreaterThanOrEqual(2);
    // Values are kept: the app shows the last known state greyed out.
    expect(entity(state, 'gekko:lights/item3', 'light').on).toBe(true);

    await sim.setOffline(false);
    await online(state);
    await waitFor(() => own(state).every((candidate) => candidate.available), 3000, 'the entities to come back');
    expect(seen).toEqual(['offline', 'ok']);
    expect((gekko.diagnostics() as PollingReport).polling).toMatchObject({ consecutiveFailures: 0, pauseReason: null, pausedUntil: null });
  });

  it('does not raise an alarm about a single failed poll', async () => {
    const rig = await boot();
    const seen = healthLog(rig.state);
    const polls = rig.sim.requests.status;
    rig.sim.failNext(500);
    await waitFor(() => rig.sim.requests.status >= polls + 4, 3000, 'polling to go on');
    expect(seen).toEqual([]);
    expect(own(rig.state).every((candidate) => candidate.available)).toBe(true);
    expect((rig.gekko.diagnostics() as PollingReport).polling).toMatchObject({ failedPolls: 1, consecutiveFailures: 0, lastProblem: { kind: 'status', status: 500 } });
  });

  it('survives a controller that accepts connections but never answers', async () => {
    const rig = await boot({ timing: { requestTimeoutMs: 120 } });
    rig.sim.setStalled(true);
    const down = await offline(rig.state);
    expect(down.message).toContain('Der myGEKKO ist nicht erreichbar');
    rig.sim.setStalled(false);
    await online(rig.state);
  });

  it('pauses polling after a rate limit and resumes afterwards', async () => {
    const rig = await boot({ timing: { rateLimitPauseMs: 900 } });
    const { sim, state } = rig;
    sim.failNext(429);
    await waitFor(() => health(state).status === 'degraded', 3000, 'the rate limit to be noticed');
    const limitedAt = Date.now();
    expect(health(state).message).toBe('Der myGEKKO meldet zu viele Anfragen. Der Hub macht ein paar Minuten Pause.');
    const requests = totalRequests(sim);
    await pause(250);
    expect(totalRequests(sim)).toBe(requests);
    expect(own(state).every((candidate) => candidate.available)).toBe(true);

    await online(state);
    expect(Date.now() - limitedAt).toBeGreaterThanOrEqual(700);
  });

  it('keeps working when the system clock is set back', async () => {
    const rig = await boot({ timing: { rateLimitPauseMs: 300, commandGapMs: 20 } });
    const { sim, state, gekko } = rig;
    await gekko.command('gekko:lights/item0', { action: 'turn_on' });

    // The hardware clock was two hours ahead and gets corrected: nothing may fall asleep for those two hours.
    clockOffset = -2 * 3_600_000;
    const polls = sim.requests.status;
    await waitFor(() => sim.requests.status >= polls + 3, 3000, 'polling to go on');
    await gekko.command('gekko:lights/item0', { action: 'turn_off' });
    expect(sim.commands.map((call) => call.value)).toEqual(['1', '0']);
    sim.setContact('Fenster Bad', true);
    await waitFor(() => entity(state, 'gekko:contact/auto-alarms-logics-item1', 'contact').open, 3000, 'the contact to follow');

    // The same in the middle of a pause: it lasts as long as it was meant to, not two hours longer.
    sim.failNext(429);
    await waitFor(() => health(state).status === 'degraded', 3000, 'the rate limit to be noticed');
    clockOffset = -4 * 3_600_000;
    await online(state);
    expect(own(state).every((candidate) => candidate.available)).toBe(true);
  });

  it('reads the list of elements again as soon as the status shows an unknown one', async () => {
    const rig = await boot();
    expect(rig.sim.requests.tree).toBe(1);
    const key = rig.sim.addLight('Leselampe', 'Büro');
    await waitFor(() => rig.state.get(`gekko:lights/${key}`), 3000, 'the new light');
    expect(entity(rig.state, `gekko:lights/${key}`, 'light')).toMatchObject({ name: 'Leselampe', room: 'Büro', on: false, available: true });
    const polls = rig.sim.requests.status;
    await waitFor(() => rig.sim.requests.status >= polls + 3, 3000, 'polling to go on');
    expect(rig.sim.requests.tree).toBe(2);
  });

  it('picks up renamed elements with the regular refresh of the list', async () => {
    const rig = await boot({ timing: { treeRefreshMs: 150 } });
    rig.sim.rename('lights', 'item0', 'Deckenfluter');
    rig.sim.rename('alarms_logics', 'item20', 'Kontakt Briefkasten');
    await waitFor(() => entity(rig.state, 'gekko:lights/item0', 'light').name === 'Deckenfluter', 3000, 'the new name');
    await waitFor(() => rig.state.get('gekko:contact/auto-alarms-logics-item20'), 3000, 'the new contact');
  });

  it('polls quickly while an app is open and slowly otherwise', async () => {
    const rig = await boot({ timing: { activeMs: 50, idleMs: 60_000 }, active: false });
    const { sim, gekko } = rig;
    expect(sim.requests.status).toBe(1);
    await pause(250);
    expect(sim.requests.status).toBe(1);

    // Opening the app reads at once and then keeps up.
    gekko.setActive(true);
    await waitFor(() => sim.requests.status >= 4, 3000, 'fast polling');
    gekko.setActive(false);
    await pause(250);
    const idle = sim.requests.status;
    await pause(250);
    expect(sim.requests.status).toBe(idle);
    // Everything went over the scheme found at the start; no second look at the tree.
    expect(sim.requests).toMatchObject({ tree: 1, command: 0, other: 0 });
  });

  it('reports incomplete settings instead of trying anything', async () => {
    const cases: [overrides: Partial<MyGekkoSettings>, message: string][] = [
      [{ host: '' }, 'Die Adresse des myGEKKO fehlt.'],
      [{ host: '192.168.1.20/pfad' }, 'Die Adresse des myGEKKO fehlt oder ist ungültig.'],
      [{ host: 'benutzer:pw@192.168.1.20' }, 'Die Adresse des myGEKKO fehlt oder ist ungültig.'],
      [{ username: '  ' }, 'Der Benutzername für den myGEKKO fehlt.'],
      [{ password: '' }, 'Das Passwort für den myGEKKO fehlt.'],
      [{ mode: 'cloud', gekkoId: '' }, 'Die myGEKKO-ID fehlt.'],
      [{ mode: 'cloud', gekkoId: 'ABCD-1234', password: '' }, 'Der API-Schlüssel für die myGEKKO-Cloud fehlt.'],
    ];
    for (const [overrides, message] of cases) {
      const t = newDeps();
      const settings = settingsFor({ host: '127.0.0.1:9' }, overrides);
      const gekko = launch(t, settings);
      expect(health(t.state), JSON.stringify(overrides)).toMatchObject({ status: 'offline', message });
      expect(gekko.contactCandidates()).toEqual([]);
      expect((gekko.diagnostics() as { configProblem: string }).configProblem).toBe(message);
      expect(await MyGekkoIntegration.test(settings, { timing: FAST })).toEqual({ ok: false, message, details: [] });
      await gekko.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Other firmware generations and odd payloads (synthetic fixtures)
// ---------------------------------------------------------------------------

interface FixtureServer {
  /** `127.0.0.1:<port>` */
  host: string;
  tree: unknown;
  status: unknown;
  /** `system/element=value` of every command call received. */
  commands: string[];
  reads: { tree: number; status: number };
  /** Commands are received but never answered. */
  hangCommands: boolean;
  /** Answer of `/api/v1/var/status` instead of the status document. */
  rawStatus: { code: number; type: string; body: string } | null;
  /** HTTP status of `/api/v1/var` instead of the tree. */
  treeFailure: number | null;
  /** Calls rejected with 403. */
  forbidden: number;
  /** Connections that did not speak TLS although the server does (a client trying plain HTTP). */
  tlsErrors: number;
}

/**
 * One port that speaks plain HTTP and, depending on `https`, TLS as well — a controller whose HTTPS side
 * is switched off ('off': TLS connections are dropped), occupied by something that is not the Query API
 * (an answer with a status and a body), or fully working ('api').
 */
interface DualServer extends FixtureServer {
  https: 'off' | 'api' | { code: number; body: string };
  /** Requests received over TLS / over plain HTTP. */
  secureRequests: number;
  plainRequests: number;
}

async function startDualServer(tree: unknown, status: unknown): Promise<DualServer> {
  const backend = await startFixtureServer(tree, status);
  const dual = Object.assign(backend, { https: 'off' as DualServer['https'], secureRequests: 0, plainRequests: 0 });
  const forward = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const upstream = http.request({ host: '127.0.0.1', port: Number(backendHost.split(':')[1]), path: req.url, method: req.method }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    upstream.end();
  };
  const backendHost = backend.host;
  const plain = http.createServer((req, res) => {
    dual.plainRequests++;
    forward(req, res);
  });
  const secure = https.createServer(selfSignedCertificate(), (req, res) => {
    dual.secureRequests++;
    if (typeof dual.https === 'object') res.writeHead(dual.https.code, { 'Content-Type': 'text/html' }).end(dual.https.body);
    else forward(req, res);
  });
  const sockets = new Set<net.Socket>();
  const front = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    // A TLS connection starts with a handshake record (0x16), an HTTP request with a letter.
    socket.once('data', (first) => {
      socket.pause();
      socket.unshift(first);
      if (first[0] !== 0x16) plain.emit('connection', socket);
      else if (dual.https === 'off') socket.destroy();
      else secure.emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
  dual.host = `127.0.0.1:${(front.address() as AddressInfo).port}`;
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        front.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  );
  return dual;
}

/**
 * A throw-away self-signed certificate (ECDSA P-256, X.509 v1), put together by hand
 * so that no private key has to live in the repository.
 */
function selfSignedCertificate(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = (tag: number, ...parts: Buffer[]): Buffer => {
    const body = Buffer.concat(parts);
    const length = body.length < 0x80 ? [body.length] : body.length < 0x100 ? [0x81, body.length] : [0x82, body.length >> 8, body.length & 0xff];
    return Buffer.concat([Buffer.from([tag, ...length]), body]);
  };
  const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'));
  const ecdsaWithSha256 = der(0x30, oid('2a8648ce3d040302'));
  const name = der(0x30, der(0x31, der(0x30, oid('550403'), der(0x0c, Buffer.from('mygekko.test')))));
  const utcTime = (text: string) => der(0x17, Buffer.from(text));
  const tbs = der(
    0x30,
    der(0x02, Buffer.from([0x01])),
    ecdsaWithSha256,
    name,
    der(0x30, utcTime('200101000000Z'), utcTime('491231235959Z')),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const certificate = der(0x30, tbs, ecdsaWithSha256, der(0x03, Buffer.from([0x00]), sign('sha256', tbs, privateKey)));
  const lines = certificate.toString('base64').match(/.{1,64}/g) ?? [];
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`,
  };
}

/** A minimal Query API that serves two fixed documents — over plain HTTP, or over HTTPS when given a certificate. */
async function startFixtureServer(tree: unknown, status: unknown, tls?: { key: string; cert: string }): Promise<FixtureServer> {
  const fixture: FixtureServer = {
    host: '',
    tree,
    status,
    commands: [],
    reads: { tree: 0, status: 0 },
    hangCommands: false,
    rawStatus: null,
    treeFailure: null,
    forbidden: 0,
    tlsErrors: 0,
  };
  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const json = (body: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const command = /^\/api\/v1\/var\/([^/]+)\/([^/]+)\/scmd\/set$/.exec(url.pathname);
    const local = url.searchParams.get('username') === 'hub-api' && url.searchParams.get('password') === PASSWORD;
    const cloud = url.searchParams.get('username') === CLOUD_USER && url.searchParams.get('key') === API_KEY && url.searchParams.get('gekkoid') === GEKKO_ID;
    if (req.method !== 'GET' || (!local && !cloud)) {
      fixture.forbidden++;
      res.writeHead(403).end();
    } else if (command) {
      fixture.commands.push(`${command[1]}/${command[2]}=${url.searchParams.get('value') ?? ''}`);
      if (!fixture.hangCommands) res.writeHead(200).end('OK');
    } else if (url.pathname === '/api/v1/var/status') {
      fixture.reads.status++;
      if (fixture.rawStatus) res.writeHead(fixture.rawStatus.code, { 'Content-Type': fixture.rawStatus.type }).end(fixture.rawStatus.body);
      else json(fixture.status);
    } else if (url.pathname === '/api/v1/var') {
      fixture.reads.tree++;
      if (fixture.treeFailure) res.writeHead(fixture.treeFailure).end();
      else json(fixture.tree);
    } else {
      res.writeHead(404).end();
    }
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  server.on('tlsClientError', () => fixture.tlsErrors++);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixture.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return fixture;
}

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/mygekko/${name}`, import.meta.url), 'utf8')) as unknown;
}

async function bootFixture(
  tree: unknown,
  status: unknown,
  options: { settings?: Partial<MyGekkoSettings>; timing?: Partial<MyGekkoTiming>; tls?: { key: string; cert: string } } = {},
) {
  const server = await startFixtureServer(tree, status, options.tls);
  const t = newDeps();
  const settings = settingsFor(server, options.settings);
  const gekko = launch(t, settings, { timing: options.timing });
  gekko.setActive(true);
  await online(t.state);
  return { server, t, state: t.state, gekko, settings };
}

const LIGHT_SCMD = '1|0|D100|T|C44782|TW100 (On,Off|0-100[%]|1|24BitRGB|0-100[%])';
const BLIND_SCMD = '-2|-1|0|1|2|T|P55.4|S32.4 (Hold_down|Down|Stop|Up|Hold_up|Toggle|Position|Angle)';
const ROOM_SCMD = 'M1|M2|M8|M16|M64|M256|K2.4|S22.5 (ModeOff|ModeOn|ModeComfort|ModeReduced|ModeManual|ModeStandby|TempAdjustment[°C]|Setpoint[°C])';
const ALARM_SCMD = '1|2 (Zone 1 Sharp|Zone 2 Sharp)';

/** A tree entry in the style of firmware 680016 and later. */
function element(name: string, page: string | undefined, scmd: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    ...(page === undefined ? {} : { page }),
    ...extra,
    sumstate: { description: 'Summary of the states and their formats', format: 'currentState enum[0=off,1=on](); ', type: 'STRING', permission: 'READ' },
    ...(scmd === null ? {} : { scmd: { description: 'Summary of the commands and their formats', format: scmd, type: 'STRING', permission: 'WRITE', index: 100070 } }),
  };
}

const value = (sumstate: unknown) => ({ sumstate: { value: sumstate } });

describe('other firmware generations and odd payloads', () => {
  it('understands a legacy controller: no pages, no groups, documentation in "value"', async () => {
    const { server, state, gekko, settings } = await bootFixture(loadFixture('legacy-tree.json'), loadFixture('legacy-status.json'));

    expect(countByKind(state)).toEqual({ light: 3, blind: 2, switch: 2, climate: 2, action: 1, sensor: 5, contact: 1 });
    expect(own(state).every((candidate) => candidate.room === null && candidate.available)).toBe(true);

    // "state;dim;rgb;locked": the fourth field is the lock flag, not a tunable-white level.
    expect(entity(state, 'gekko:lights/item0', 'light')).toMatchObject({ name: 'Diele', on: false, brightness: null, color: null, colorTemp: null, features: { dim: false, color: false, colorTemp: false } });
    expect(entity(state, 'gekko:lights/item1', 'light')).toMatchObject({ on: true, brightness: 16, features: { dim: true, color: false, colorTemp: false } });
    expect(entity(state, 'gekko:lights/item4', 'light')).toMatchObject({ on: true, brightness: 100, color: '#00b1a4', features: { dim: true, color: true, colorTemp: false } });
    expect(entity(state, 'gekko:blinds/item0', 'blind')).toMatchObject({ position: 0, tilt: 0, motion: 'stopped', locked: false });
    expect(entity(state, 'gekko:blinds/item8', 'blind')).toMatchObject({ position: 100 });
    expect(entity(state, 'gekko:loads/item0', 'switch')).toMatchObject({ on: false, variant: 'socket' });
    expect(entity(state, 'gekko:loads/item1', 'switch')).toMatchObject({ on: true, variant: 'pump' });
    expect(entity(state, 'gekko:roomtemps/item0', 'climate')).toMatchObject({
      temperature: 21.5,
      target: 22,
      output: 99,
      mode: 'comfort',
      heating: true,
      cooling: false,
      humidity: null,
      windowOpen: null,
      // No setpoint command on this generation (only the adjustment "K").
      features: { target: false, mode: true },
    });
    expect(entity(state, 'gekko:roomtemps/item8', 'climate')).toMatchObject({ temperature: 19.1, target: 16, mode: 'reduced', heating: false });
    expect(entity(state, 'gekko:actions/item0', 'action')).toMatchObject({ name: 'Heimkommen', active: false, features: { start: true, stop: true } });
    // Units come from the separate "unit" property here.
    expect(entity(state, 'gekko:meteo/temperature', 'sensor')).toMatchObject({ value: 12, unit: '°C' });
    expect(entity(state, 'gekko:meteo/humidity', 'sensor')).toMatchObject({ value: 41, unit: '%rH' });
    expect(entity(state, 'gekko:meteo/brightness', 'sensor')).toMatchObject({ value: 0, unit: 'kLux' });
    expect(state.get('gekko:meteo/rain')).toBeUndefined();
    // A logic element is a single number on this generation.
    expect(entity(state, 'gekko:contact/auto-alarms-logics-item0', 'contact')).toMatchObject({ name: 'Fenster Werkstatt', open: true, contactType: 'window' });
    expect((gekko.diagnostics() as { unmapped: Record<string, number> }).unmapped).toEqual({ vents: 1, multirooms: 1 });

    // Commands are held against what this generation documents.
    await gekko.command('gekko:lights/item0', { action: 'turn_on' });
    await gekko.command('gekko:lights/item1', { action: 'set_brightness', value: 40 });
    await gekko.command('gekko:lights/item4', { action: 'set_color', value: '#102030' });
    await gekko.command('gekko:blinds/item0', { action: 'set_position', value: 30 });
    await gekko.command('gekko:loads/item0', { action: 'turn_on' });
    await gekko.command('gekko:roomtemps/item0', { action: 'set_mode', value: 'reduced' });
    await gekko.command('gekko:actions/item0', { action: 'run' });
    expect(server.commands).toEqual(['lights/item0=1', 'lights/item1=D40', 'lights/item4=C1056816', 'blinds/item0=P30.0', 'loads/item0=2', 'roomtemps/item0=M16', 'actions/item0=1']);
    expect(await failure(gekko.command('gekko:roomtemps/item0', { action: 'set_target', value: 21 }))).toMatchObject({ statusCode: 400, code: 'unsupported' });
    expect(await failure(gekko.command('gekko:lights/item1', { action: 'set_color_temp', value: 50 }))).toMatchObject({ statusCode: 400, code: 'unsupported' });
    expect(server.commands).toHaveLength(7);

    const tested = await MyGekkoIntegration.test(settings, { timing: FAST });
    expect(tested).toMatchObject({ ok: true, message: 'Verbunden mit „ALTBAU“.' });
    expect(tested.details.join('\n')).toContain('Keine Alarmanlage gefunden.');
    expect(tested.details.join('\n')).toContain('Noch nicht in der App: Lüftung (1), Multiroom (1).');
  });

  it('parses values by position, whatever their length, and ignores what it does not know', async () => {
    const tree = {
      globals: {
        network: { gekkoname: { format: 'string[name]()' } },
        meteo: { temperature: { format: 'float[-100.00,100.00](°C)' }, wind: { format: 'float[0.00,100000.00](m/s)' }, pollen: { format: 'float[0,10]()' } },
      },
      lights: {
        item0: element('Ohne Schlussstrich', 'Flur', LIGHT_SCMD),
        item1: element('Über den Rand', '  Flur  ', LIGHT_SCMD),
        item2: element('Leerer Wert', '', LIGHT_SCMD),
        item3: element('Fehlt im Status', '...', LIGHT_SCMD),
        item4: element('Glimmt', undefined, LIGHT_SCMD),
        item5: element('Nur lesbar', 'Flur', null),
        item6: element('', 'Flur', LIGHT_SCMD),
        item7: 'kein Objekt',
        zusatz: { name: 'kein Element' },
        group0: { name: 'Alle', sumstate: { format: 'State[0=Off|1=On]', type: 'AO', permission: 'READ', index: 1 }, scmd: { format: '0|1 (Off|On)', type: 'AV', permission: 'WRITE', index: 2 } },
      },
      blinds: {
        item0: element('Fährt hoch', 'Flur', BLIND_SCMD),
        item1: element('Oben angekommen', 'Flur', BLIND_SCMD),
        item2: element('Windalarm', 'Flur', BLIND_SCMD),
        item3: element('Gesperrt in Fahrt', 'Flur', BLIND_SCMD),
        item4: element('Unten angekommen', 'Flur', BLIND_SCMD),
        item5: element('Ohne Rückmeldung', 'Flur', BLIND_SCMD),
      },
      roomtemps: {
        item0: element('KNX Spar', 'Flur', ROOM_SCMD),
        item1: element('KNX Frostschutz', 'Flur', ROOM_SCMD),
        item2: element('Kühlt', 'Flur', ROOM_SCMD),
        item3: element('Modus zwei', 'Flur', ROOM_SCMD),
        item4: element('Von Hand', 'Flur', ROOM_SCMD),
        item5: element('Kaum Werte', 'Flur', ROOM_SCMD),
      },
      energycosts: {
        item0: element('Wasser', '...', 'RP (ResetPeriod)'),
        item1: element('Ohne Werte', '...', 'RP (ResetPeriod)'),
      },
      zukunft: { item0: element('Etwas Neues', 'Flur', null) },
      '0kaputt': { item0: element('Ungültiger Name', 'Flur', null) },
      liste: ['kein', 'System'],
    };
    const status = {
      globals: { network: { gekkoname: { value: 'Varianten' }, version: { value: 596610 } }, meteo: { temperature: { value: '-3.240000' }, wind: { value: '' }, pollen: { value: '3' } } },
      lights: {
        // Firmware 596610 ends the value without a separator.
        item0: value('1;100.00;;;0'),
        item1: value('1;100.4;16777215;55.5;0;;;;;;;;;;;;;;;;;;;100.00;'),
        item2: value(''),
        item4: value('1;0.40;;;0;'),
        item5: value('1;;;;0;'),
        item6: value('0;;;;0;'),
        // Only the status knows this one (the list of elements lags behind), and this is no element at all.
        item9: value('1;;;;0;'),
        item10: null,
        group0: value(1),
      },
      blinds: {
        item0: value('1;40.00;10.00;0;90;'),
        item1: value('2;0.00;0.00;0;180;'),
        item2: value('0;100.00;;4;90;'),
        item3: value('-1;60.00;;3;90;'),
        item4: value('-2;100.00;100.00;0;90;'),
        item5: value('-1;;;0;90;'),
      },
      roomtemps: {
        // Firmware 680016: twelve fields, no window state.
        item0: value('20.50;21.00;35.00;3;;0.00;0;0;;;;3;'),
        item1: value('20.50;21.00;0.00;4;;0.00;0;0;;;;3;0;0;'),
        item2: value('24.00;23.00;50.00;256;;0.00;1;0;55.40;;;0;1;0;'),
        item3: value('21.00;21.00;0.00;2;;0.00;0;0;'),
        item4: value('21,5;20,5;-0.00;64;;0.00;0;0;abc;;;0;;0;'),
        item5: value('-0.00'),
      },
      energycosts: {
        item0: value('0.00;30.00;3790.00;102847.01;10.00;l;l/h;1.00;29.00;'),
        item1: value(';;;;;;;'),
      },
      zukunft: { item0: value('1;2;3;') },
    };
    const { server, state, gekko } = await bootFixture(tree, status);

    expect(entity(state, 'gekko:lights/item0', 'light')).toMatchObject({ on: true, brightness: 100, color: null, colorTemp: null, room: 'Flur', features: { dim: true, color: false, colorTemp: false } });
    expect(entity(state, 'gekko:lights/item1', 'light')).toMatchObject({ on: true, brightness: 100, color: '#ffffff', colorTemp: 56, room: 'Flur', features: { dim: true, color: true, colorTemp: true } });
    // Known to the controller but without a value: shown, greyed out.
    expect(entity(state, 'gekko:lights/item2', 'light')).toMatchObject({ available: false, on: false, room: null });
    expect(entity(state, 'gekko:lights/item3', 'light')).toMatchObject({ available: false, room: null });
    // A light that barely glows is not "0 %".
    expect(entity(state, 'gekko:lights/item4', 'light')).toMatchObject({ on: true, brightness: 1, room: null });
    expect(entity(state, 'gekko:lights/item6', 'light').name).toBe('item6');
    expect(entity(state, 'gekko:lights/group0', 'light')).toMatchObject({ isGroup: true, on: true });
    expect(state.get('gekko:lights/item7')).toBeUndefined();
    expect(state.get('gekko:lights/item9')).toBeUndefined();
    expect(state.get('gekko:lights/item10')).toBeUndefined();
    expect(state.get('gekko:lights/zusatz')).toBeUndefined();

    expect(entity(state, 'gekko:blinds/item0', 'blind')).toMatchObject({ motion: 'up', position: 40, tilt: 10, locked: false, features: { position: true, tilt: true } });
    // Seen on a real controller: "hold up" stays set after the blind has arrived.
    expect(entity(state, 'gekko:blinds/item1', 'blind')).toMatchObject({ motion: 'stopped', position: 0 });
    expect(entity(state, 'gekko:blinds/item2', 'blind')).toMatchObject({ motion: 'stopped', position: 100, tilt: null, locked: true, features: { position: true, tilt: false } });
    expect(entity(state, 'gekko:blinds/item3', 'blind')).toMatchObject({ motion: 'down', position: 60, locked: true });
    expect(entity(state, 'gekko:blinds/item4', 'blind')).toMatchObject({ motion: 'stopped', position: 100, tilt: 100 });
    expect(entity(state, 'gekko:blinds/item5', 'blind')).toMatchObject({ motion: 'down', position: null, tilt: null, features: { position: false, tilt: false } });

    // KNX room controllers number their modes differently.
    expect(entity(state, 'gekko:roomtemps/item0', 'climate')).toMatchObject({ mode: 'reduced', temperature: 20.5, output: 35, heating: true, humidity: null, windowOpen: null });
    expect(entity(state, 'gekko:roomtemps/item1', 'climate')).toMatchObject({ mode: 'off', heating: false, windowOpen: false });
    expect(entity(state, 'gekko:roomtemps/item2', 'climate')).toMatchObject({ mode: 'standby', cooling: true, heating: false, humidity: 55, windowOpen: true });
    expect(entity(state, 'gekko:roomtemps/item3', 'climate')).toMatchObject({ mode: 'unknown', windowOpen: null });
    expect(entity(state, 'gekko:roomtemps/item4', 'climate')).toMatchObject({ mode: 'manual', temperature: 21.5, target: 20.5, output: 0, heating: false, humidity: null, windowOpen: null });
    expect(entity(state, 'gekko:roomtemps/item5', 'climate')).toMatchObject({ available: true, temperature: 0, target: null, output: null, mode: 'unknown', heating: false, cooling: false, humidity: null, windowOpen: null });

    expect(entity(state, 'gekko:energycosts/item0', 'sensor')).toMatchObject({ name: 'Wasser', room: null, value: 0, unit: 'l/h' });
    expect(entity(state, 'gekko:energycosts/item1', 'sensor')).toMatchObject({ value: null, unit: null, available: true });
    expect(entity(state, 'gekko:meteo/temperature', 'sensor')).toMatchObject({ value: -3.2, unit: '°C', available: true });
    // Offered by the controller but without a value yet.
    expect(entity(state, 'gekko:meteo/wind', 'sensor')).toMatchObject({ value: null, unit: 'm/s', available: false });
    expect(state.get('gekko:meteo/pollen')).toBeUndefined();

    const report = gekko.diagnostics() as { unmapped: Record<string, number>; controller: { firmware: string | null } };
    expect(report.unmapped).toEqual({ zukunft: 1 });
    expect(report.controller.firmware).toBe('596610');

    // An element without a command node takes no commands; a blind without position feedback no position.
    expect(await failure(gekko.command('gekko:lights/item5', { action: 'turn_off' }))).toMatchObject({ statusCode: 400, code: 'unsupported' });
    expect(await failure(gekko.command('gekko:blinds/item5', { action: 'set_position', value: 50 }))).toMatchObject({ statusCode: 400, code: 'unsupported' });
    expect(server.commands).toEqual([]);
    // An element that only the status knows is no reason to read the list of elements on every poll.
    await waitFor(() => server.reads.status >= 5, 3000, 'polling to go on');
    expect(server.reads.tree).toBe(1);
  });

  it('shows one alarm entity per zone and reads the zone triples by position', async () => {
    const tree = {
      globals: { network: {} },
      alarmsystem: {
        item0: element('Alarm Haus', 'Technik', ALARM_SCMD, { zone1: 'Erdgeschoss', zone2: 'Obergeschoss' }),
        item1: element('Alarm Anbau', '...', ALARM_SCMD, { zone1: 'Anbau', zone2: 'Schuppen' }),
        item2: element('Alarm Keller', '...', ALARM_SCMD, { zone1: 'Keller', zone2: '' }),
        item3: element('Alarm Garage', '...', ALARM_SCMD),
        item4: element('Alarm Aus', '...', ALARM_SCMD, { zone1: 'Abgeschaltet' }),
        item5: element('Alarm Offen', '...', ALARM_SCMD, { zone1: 'Hülle' }),
        group0: { name: 'Grp 1', sumstate: { format: 'State[0=Off|1=Sharp]' }, scmd: { format: '1 (Sharp)' } },
      },
    };
    const status = {
      globals: { network: { gekkoname: { value: 'Alarmtest' } } },
      alarmsystem: {
        item0: value('1;1;0;2;1;1;3;2;'),
        // Two zones without the trailing device model.
        item1: value('0;1;0;0;1;0;0;'),
        // A second zone is announced, but the value only covers the first.
        item2: value('0;1;1;0;1;'),
        item3: value('1;1;1;3;1;'),
        item4: value('0;0;0;0;1;'),
        // Real sample of a one-zone system: the last field is the device model, not a zone value.
        item5: value('0;1;0;2;1;'),
        group0: value('0'),
      },
    };
    const { server, state, gekko } = await bootFixture(tree, status);
    const zones = Object.fromEntries(
      own(state).map((candidate) => [candidate.id.replace('gekko:alarmsystem/', ''), candidate.kind === 'alarm' ? `${candidate.name} | ${candidate.system} | ${candidate.mode} | ${candidate.stateText}` : candidate.kind]),
    );
    expect(zones).toEqual({
      'item0#1': 'Erdgeschoss | Alarm Haus | disarmed | Unscharf · mindestens ein Kontakt offen',
      'item0#2': 'Obergeschoss | Alarm Haus | armed | ALARM',
      'item1#1': 'Anbau | Alarm Anbau | disarmed | Unscharf · alles geschlossen',
      'item1#2': 'Schuppen | Alarm Anbau | disarmed | Unscharf · alles geschlossen',
      'item2#1': 'Keller | Alarm Keller | armed | Scharf',
      'item2#2': 'Alarm Keller · Zone 2 | Alarm Keller | unknown | Status unbekannt',
      'item3#1': 'Alarm Garage | Alarm Garage | armed | ALARM',
      'item4#1': 'Abgeschaltet | Alarm Aus | disarmed | Ausgeschaltet',
      'item5#1': 'Hülle | Alarm Offen | disarmed | Unscharf · mindestens ein Kontakt offen',
    });
    expect(entity(state, 'gekko:alarmsystem/item0#1', 'alarm')).toMatchObject({ room: 'Technik', triggered: false, breached: true });
    expect(entity(state, 'gekko:alarmsystem/item0#2', 'alarm')).toMatchObject({ triggered: true, breached: false });
    expect(entity(state, 'gekko:alarmsystem/item5#1', 'alarm')).toMatchObject({ triggered: false, breached: true });

    // Read-only: whatever is asked, nothing is ever sent to an alarm system.
    for (const command of [{ action: 'turn_on' }, { action: 'turn_off' }, { action: 'enable' }, { action: 'disable' }, { action: 'run' }, { action: 'stop' }] satisfies EntityCommand[]) {
      expect(await failure(gekko.command('gekko:alarmsystem/item0#1', command))).toMatchObject({ statusCode: 400 });
    }
    expect(server.commands).toEqual([]);
  });

  it('keeps the known elements when refreshing the list fails', async () => {
    const tree = { globals: { network: {} }, lights: { item0: element('Lampe', 'Flur', LIGHT_SCMD) } };
    const status = { globals: { network: { gekkoname: { value: 'Baumtest' } } }, lights: { item0: value('1;;;;0;') } };
    const { server, state } = await bootFixture(tree, status, { timing: { treeRefreshMs: 100, treeRetryMs: 100 } });
    const seen = healthLog(state);

    server.treeFailure = 500;
    server.tree = { globals: { network: {} }, lights: { item0: element('Neue Lampe', 'Diele', LIGHT_SCMD) } };
    await waitFor(() => server.reads.tree >= 3, 3000, 'two failed refreshes');
    expect(entity(state, 'gekko:lights/item0', 'light')).toMatchObject({ name: 'Lampe', room: 'Flur', on: true, available: true });
    expect(seen).toEqual([]);

    server.treeFailure = null;
    await waitFor(() => entity(state, 'gekko:lights/item0', 'light').name === 'Neue Lampe', 3000, 'the refreshed list');
    expect(entity(state, 'gekko:lights/item0', 'light').room).toBe('Diele');
  });

  it('never sends a command twice, not even when the answer does not come', async () => {
    const tree = { globals: { network: {} }, lights: { item0: element('Lampe', 'Flur', LIGHT_SCMD) } };
    const status = { globals: { network: { gekkoname: { value: 'Hänger' } } }, lights: { item0: value('0;;;;0;') } };
    const { server, state, gekko } = await bootFixture(tree, status, { timing: { ...QUIET, requestTimeoutMs: 150 } });
    server.hangCommands = true;
    const err = await failure(gekko.command('gekko:lights/item0', { action: 'turn_on' }));
    expect(err).toMatchObject({ statusCode: 503, code: 'unavailable' });
    await pause(300);
    expect(server.commands).toEqual(['lights/item0=1']);
    // The light is not shown as switched on, and the status poll that followed found the controller alive.
    expect(entity(state, 'gekko:lights/item0', 'light').on).toBe(false);
    expect(health(state).status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

describe('transport', () => {
  const tree = { globals: { network: {} }, lights: { item0: element('Lampe', 'Flur', LIGHT_SCMD) } };
  const status = { globals: { network: { gekkoname: { value: 'Verschlüsselt' }, version: { value: '879015' } } }, lights: { item0: value('0;;;;0;') } };

  it('prefers HTTPS and accepts the self-signed certificate of the controller', async () => {
    const { server, state, gekko, settings } = await bootFixture(tree, status, { tls: selfSignedCertificate() });
    expect(gekko.diagnostics()).toMatchObject({ transport: 'https', online: true });
    expect(entity(state, 'gekko:lights/item0', 'light')).toMatchObject({ name: 'Lampe', on: false, available: true });

    await gekko.command('gekko:lights/item0', { action: 'turn_on' });
    expect(server.commands).toEqual(['lights/item0=1']);
    await waitFor(() => server.reads.status >= 4, 3000, 'polling to go on');
    // Nothing was ever tried without encryption.
    expect(server.tlsErrors).toBe(0);
    expect(server.forbidden).toBe(0);

    const tested = await MyGekkoIntegration.test(settings, { timing: FAST });
    expect(tested).toMatchObject({ ok: true, message: 'Verbunden mit „Verschlüsselt“ (Firmware 879015).' });
    expect(tested.details[0]).toBe('Verbindung: direkt im Heimnetz, verschlüsselt (HTTPS).');
  });

  it('does not send a rejected login a second time over plain HTTP', async () => {
    // Both schemes work on this controller; the password is wrong.
    const server = await startDualServer(tree, status);
    server.https = 'api';
    const t = newDeps();
    const gekko = launch(t, settingsFor(server, { password: WRONG_PASSWORD }));
    gekko.setActive(true);
    expect((await offline(t.state)).message).toMatch(AUTH_MESSAGE);
    await pause(200);
    expect(server.forbidden).toBe(1);
    expect(server.secureRequests).toBe(1);
    expect(server.plainRequests).toBe(0);
    expect(gekko.diagnostics()).toMatchObject({ transport: 'https', online: false });
  });

  it('finds the API on plain HTTP when something else answers on the HTTPS port', async () => {
    for (const answer of [
      { code: 404, body: 'Not Found' },
      { code: 200, body: '<html><body>Fernzugriff</body></html>' },
    ]) {
      const server = await startDualServer(tree, status);
      server.https = answer;
      const t = newDeps();
      const settings = settingsFor(server);
      const gekko = launch(t, settings);
      await online(t.state);
      expect(gekko.diagnostics(), JSON.stringify(answer)).toMatchObject({ transport: 'http', online: true });
      expect(server.secureRequests).toBe(1);
      const tested = await MyGekkoIntegration.test(settings, { timing: FAST });
      expect(tested.ok).toBe(true);
      expect(tested.details[0]).toContain('HTTP');
      await gekko.stop();
    }
  });

  it('says so when neither HTTPS nor HTTP offers the API', async () => {
    const server = await startDualServer(tree, status);
    server.https = { code: 200, body: '<html><body>Router</body></html>' };
    server.rawStatus = { code: 404, type: 'text/plain', body: 'Not Found' };
    const tested = await MyGekkoIntegration.test(settingsFor(server), { timing: FAST });
    expect(tested).toEqual({ ok: false, message: 'Unter dieser Adresse antwortet kein myGEKKO (die Antwort ist nicht lesbar).', details: [] });
    expect(server.secureRequests).toBe(1);
    expect(server.plainRequests).toBe(1);
  });

  it('moves from HTTP to HTTPS when it becomes available — but only for a proper answer', async () => {
    const server = await startDualServer(tree, status);
    const t = newDeps();
    const gekko = launch(t, settingsFor(server), { timing: { httpsRetryMs: 120 } });
    gekko.setActive(true);
    await online(t.state);
    const seen = healthLog(t.state);
    const transport = () => (gekko.diagnostics() as { transport: string | null }).transport;
    expect(transport()).toBe('http');

    // Something answers on the HTTPS port, but it rejects the login: the working connection is kept,
    // and the rejection is not mistaken for a wrong password.
    server.https = { code: 403, body: '' };
    await waitFor(() => server.secureRequests >= 2, 3000, 'two looks at the HTTPS port');
    expect(transport()).toBe('http');
    // Neither is a web page that is not the Query API.
    server.https = { code: 200, body: '<html><body>Anmeldung</body></html>' };
    const looks = server.secureRequests;
    await waitFor(() => server.secureRequests >= looks + 2, 3000, 'two more looks at the HTTPS port');
    expect(transport()).toBe('http');
    expect(seen).toEqual([]);

    // The controller now offers the API over HTTPS: from here on nothing goes unencrypted.
    server.https = 'api';
    await waitFor(() => transport() === 'https', 3000, 'the move to HTTPS');
    const plain = server.plainRequests;
    await gekko.command('gekko:lights/item0', { action: 'turn_on' });
    await waitFor(() => server.reads.status >= 3 && server.secureRequests >= looks + 6, 3000, 'polling over HTTPS');
    expect(server.plainRequests).toBe(plain);
    expect(server.commands).toEqual(['lights/item0=1']);
    expect(seen).toEqual([]);
    expect(entity(t.state, 'gekko:lights/item0', 'light').available).toBe(true);
  });

  it('falls back to plain HTTP when the controller offers no HTTPS, and says so', async () => {
    const { gekko, settings } = await bootFixture(tree, status);
    expect(gekko.diagnostics()).toMatchObject({ transport: 'http', online: true });
    const tested = await MyGekkoIntegration.test(settings, { timing: FAST });
    expect(tested.details[0]).toContain('unverschlüsselt');
  });
});

// ---------------------------------------------------------------------------
// Connection test of the admin UI
// ---------------------------------------------------------------------------

describe('MyGekkoIntegration.test()', () => {
  const run = (settings: MyGekkoSettings, options: MyGekkoOptions = {}) => MyGekkoIntegration.test(settings, { ...options, timing: { ...FAST, ...options.timing } });

  /** A port on which nothing listens. */
  async function deadHost(): Promise<string> {
    const sim = await startMyGekkoSim();
    const { host } = sim;
    await sim.close();
    return host;
  }

  it('describes the controller it found', async () => {
    const sim = await startSim();
    const result = await run(settingsFor(sim));
    expect(result).toEqual({
      ok: true,
      message: 'Verbunden mit „Musterhaus“ (Firmware 879015).',
      details: [
        'Verbindung: direkt im Heimnetz über HTTP – dieser myGEKKO bietet kein HTTPS an, die Zugangsdaten gehen unverschlüsselt durchs Heimnetz.',
        'Gerät: Slide 2 (AC0DFE30D3A0).',
        'Gefunden: 12 Lichter (+ 2 Gruppen), 9 Jalousien (+ 1 Gruppe), 5 Schaltgeräte (+ 1 Gruppe), 7 Raumregler, 6 Aktionen, 3 Zeitschaltuhren, 2 Energiezähler.',
        'Alarmanlage: 1 Zone (Hülle). Der Hub zeigt sie nur an und schaltet sie nie.',
        'Automatisch erkannte Kontakte: 11 (Gartentor, Fenster Küche, Fenster Bad, Terrassentür, Haustür, Fenster Büro und 5 weitere).',
        '7 Raumregler melden einen Fensterstatus. Als Kontakt erscheint ein Raumregler, sobald sein Fenster einmal geöffnet wurde.',
        'Noch nicht in der App: Analysen (1), Lüftung (1), Warmwasser (1).',
      ],
    });
    // One look at the values, one at the list of elements — and the connection is closed again.
    expect(sim.requests).toEqual({ tree: 1, status: 1, command: 0, other: 0 });
    await waitFor(() => sim.connections === 0, 3000, 'the test connection to be closed');
  });

  it('counts explicit mappings and respects switched-off automatic contacts', async () => {
    const sim = await startSim();
    const result = await run(settingsFor(sim, { autoContacts: false, contacts: [mapping('kueche', 'alarms_logics/item0'), mapping('trend', 'trends/item0', { field: 3 })] }));
    expect(result.ok).toBe(true);
    expect(result.details).toContain('Eigene Kontakt-Zuordnungen: 2.');
    expect(result.details).toContain('Die automatische Erkennung von Fenster- und Türkontakten ist ausgeschaltet.');
    expect(result.details).toContain('Noch nicht in der App: Zutritt (1), Lüftung (1), Warmwasser (1).');
  });

  it('explains a rejected login and does not repeat it', async () => {
    const sim = await startSim();
    const wrong = settingsFor(sim, { password: WRONG_PASSWORD });
    const first = await run(wrong);
    expect(first.ok).toBe(false);
    expect(first.message).toBe('Der myGEKKO lehnt die Anmeldung ab. Bitte Benutzername und Passwort prüfen.');
    expect(first.details.join(' ')).toContain('10 Minuten');

    const second = await run(wrong);
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/eben erst abgelehnt.*etwa 1 Minute /);
    expect(sim.forbiddenCount).toBe(1);

    // The corrected password is tried at once.
    const third = await run(settingsFor(sim));
    expect(third.ok).toBe(true);
    for (const result of [first, second, third]) for (const marker of SECRET_MARKERS) expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('names the cause when the controller cannot be read', async () => {
    const unreachable = await run(settingsFor({ host: await deadHost() }));
    expect(unreachable).toEqual({ ok: false, message: 'Der myGEKKO ist nicht erreichbar: Verbindung abgelehnt (Gerät aus oder falscher Port?).', details: [] });

    const sim = await startSim();
    sim.failNext(429);
    expect(await run(settingsFor(sim))).toMatchObject({ ok: false, message: 'Der myGEKKO meldet zu viele Anfragen. Der Hub macht ein paar Minuten Pause.' });
    sim.failNext(500);
    expect(await run(settingsFor(sim))).toMatchObject({ ok: false, message: 'Der myGEKKO antwortet mit einem Fehler (HTTP 500).' });
    sim.setStalled(true);
    const silent = await run(settingsFor(sim), { timing: { requestTimeoutMs: 150 } });
    expect(silent.ok).toBe(false);
    expect(silent.message).toContain('Der myGEKKO ist nicht erreichbar: Keine Antwort');
    sim.setStalled(false);

    // Something else answers at this address.
    const other = await startFixtureServer({}, {});
    const answers: [code: number, type: string, body: string, message: string][] = [
      [200, 'text/html', '<html><body>Router</body></html>', 'Unter dieser Adresse antwortet kein myGEKKO (die Antwort ist nicht lesbar).'],
      [200, 'application/json', '{"hello":"world"}', 'Unter dieser Adresse antwortet kein myGEKKO.'],
      [200, 'application/json', '[1,2,3]', 'Unter dieser Adresse antwortet kein myGEKKO.'],
      [404, 'text/plain', 'Not Found', 'Unter dieser Adresse antwortet kein myGEKKO.'],
    ];
    for (const [code, type, body, message] of answers) {
      other.rawStatus = { code, type, body };
      expect(await run(settingsFor(other)), body).toEqual({ ok: false, message, details: [] });
    }
  });

  it('still succeeds when only the list of elements cannot be read', async () => {
    const server = await startFixtureServer({}, { globals: { network: { gekkoname: { value: 'Halb da' }, version: { value: '879015' } } } });
    server.treeFailure = 500;
    const result = await run(settingsFor(server));
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Verbunden mit „Halb da“ (Firmware 879015).');
    expect(result.details.at(-1)).toBe('Die Liste der Elemente konnte nicht gelesen werden: Der myGEKKO antwortet mit einem Fehler (HTTP 500).');
  });
});

// ---------------------------------------------------------------------------
// Cloud (live.my-gekko.com)
// ---------------------------------------------------------------------------

describe('cloud mode', () => {
  const MESSAGE_GONE = 'Der myGEKKO ist über die Cloud nicht erreichbar (ausgeschaltet, ohne Internet oder falsche myGEKKO-ID).';

  function cloudSettings(overrides: Partial<MyGekkoSettings> = {}): MyGekkoSettings {
    return settingsFor({ host: '' }, { mode: 'cloud', username: CLOUD_USER, password: API_KEY, gekkoId: GEKKO_ID, ...overrides });
  }

  const startCloud = (incompleteAnswers = 0) => startSim({ username: CLOUD_USER, cloud: { key: API_KEY, gekkoId: GEKKO_ID, incompleteAnswers } });

  it('logs in with user, key and id, and waits for the values the cloud lacks at first', async () => {
    const sim = await startCloud(1);
    const t = newDeps();
    const gekko = launch(t, cloudSettings(), { cloudBaseUrl: sim.url, timing: { ...QUIET, cloudSettleMs: 500 } });
    await online(t.state);
    // The first answer named the elements but not their values: nothing is shown as "off" or "closed" on a guess.
    expect(own(t.state).length).toBeGreaterThan(60);
    expect(own(t.state).every((candidate) => !candidate.available)).toBe(true);

    await waitFor(() => own(t.state).every((candidate) => candidate.available), 3000, 'the values to arrive');
    // That was the extra poll shortly after the first one, not the regular rhythm.
    expect(sim.requests).toMatchObject({ status: 2, tree: 1 });
    expect(entity(t.state, 'gekko:lights/item3', 'light').on).toBe(true);
    expect(gekko.diagnostics()).toMatchObject({ mode: 'cloud', transport: 'cloud', online: true });

    await gekko.command('gekko:lights/item0', { action: 'turn_on' });
    expect(sim.commands).toEqual([{ system: 'lights', element: 'item0', value: '1', status: 200 }]);
    expect(sim.forbiddenCount).toBe(0);
  });

  it('tolerates a few empty answers of the cloud, but not forever', async () => {
    const tree = { globals: { network: {} }, lights: { item0: element('Lampe', 'Flur', LIGHT_SCMD) } };
    const status = { globals: { network: { gekkoname: { value: 'Wolke' } } }, lights: { item0: value('1;;;;0;') } };
    const server = await startFixtureServer(tree, status);
    server.rawStatus = { code: 200, type: 'application/json', body: '{}' };
    const t = newDeps();
    const seen = healthLog(t.state);
    launch(t, cloudSettings(), { cloudBaseUrl: `http://${server.host}`, timing: QUIET });

    await waitFor(() => server.reads.status >= 3, 3000, 'the hub to ask again');
    expect(seen).toEqual([]);
    const down = await offline(t.state);
    expect(down.message).toBe('Die Antwort der myGEKKO-Cloud ist nicht lesbar.');

    server.rawStatus = null;
    await online(t.state);
    expect(entity(t.state, 'gekko:lights/item0', 'light')).toMatchObject({ on: true, available: true });
  });

  it('reports a controller the cloud cannot reach, a wrong key and an expired service', async () => {
    const sim = await startCloud();
    const t = newDeps();
    const wrongId = cloudSettings({ gekkoId: 'FALSCH-0000' });
    launch(t, wrongId, { cloudBaseUrl: sim.url });
    expect((await offline(t.state)).message).toBe(MESSAGE_GONE);
    expect(sim.forbiddenCount).toBe(0);

    const options = { cloudBaseUrl: sim.url, timing: FAST };
    expect(await MyGekkoIntegration.test(wrongId, options)).toEqual({ ok: false, message: MESSAGE_GONE, details: [] });
    const wrongKey = await MyGekkoIntegration.test(cloudSettings({ password: WRONG_PASSWORD }), options);
    expect(wrongKey).toMatchObject({ ok: false, message: 'Die myGEKKO-Cloud lehnt die Anmeldung ab. Bitte Benutzername, API-Schlüssel und myGEKKO-ID prüfen.' });
    expect(sim.forbiddenCount).toBe(1);
    sim.failNext(470);
    expect(await MyGekkoIntegration.test(cloudSettings(), options)).toMatchObject({ ok: false, message: 'Der Fernzugriff (myGEKKO Plus) ist für diesen myGEKKO nicht freigeschaltet oder abgelaufen.' });

    const good = await MyGekkoIntegration.test(cloudSettings(), options);
    expect(good).toMatchObject({ ok: true, message: 'Verbunden mit „Musterhaus“ (Firmware 879015).' });
    expect(good.details[0]).toBe('Verbindung: über die myGEKKO-Cloud.');
  });
});

// ---------------------------------------------------------------------------
// Life cycle
// ---------------------------------------------------------------------------

describe('life cycle', () => {
  it('stop() answers what is waiting, closes every connection and silences every timer', async () => {
    const sim = await startSim();
    const t = newDeps();
    const gekko = new MyGekkoIntegration(t.deps, settingsFor(sim), { timing: FAST });
    watched[watched.length - 1]?.integrations.push(gekko);
    cleanups.push(() => gekko.stop());

    const before = Date.now();
    gekko.start();
    gekko.start();
    expect(Date.now() - before).toBeLessThan(100);
    gekko.setActive(true);
    await online(t.state);
    expect(sim.connections).toBeGreaterThan(0);

    // One command on its way (the controller does not answer), one waiting behind it, a poll in between.
    sim.setStalled(true);
    const inFlight = failure(gekko.command('gekko:lights/item0', { action: 'turn_on' }));
    const waiting = failure(gekko.command('gekko:lights/item1', { action: 'turn_on' }));
    await pause(80);
    const stopping = Date.now();
    await gekko.stop();
    // Did not sit out the request timeout of 1.5 s.
    expect(Date.now() - stopping).toBeLessThan(1000);
    expect(await inFlight).toMatchObject({ statusCode: 503, code: 'unavailable' });
    expect(await waiting).toMatchObject({ statusCode: 503, code: 'unavailable' });
    sim.setStalled(false);

    await waitFor(() => sim.connections === 0, 3000, 'all connections to be closed');
    const requests = totalRequests(sim);
    await pause(250);
    expect(totalRequests(sim)).toBe(requests);
    expect(sim.commands).toEqual([]);

    // A stopped instance stays stopped.
    await gekko.stop();
    gekko.start();
    gekko.setActive(true);
    expect(await failure(gekko.command('gekko:lights/item0', { action: 'turn_on' }))).toMatchObject({ statusCode: 503 });
    await pause(120);
    expect(totalRequests(sim)).toBe(requests);
    expect(sim.connections).toBe(0);
  });

  it('can be stopped while the very first connection attempt hangs', async () => {
    const sim = await startSim();
    sim.setStalled(true);
    const t = newDeps();
    const gekko = launch(t, settingsFor(sim), { timing: { requestTimeoutMs: 10_000 } });
    await pause(100);
    const stopping = Date.now();
    await gekko.stop();
    expect(Date.now() - stopping).toBeLessThan(1000);
    // Nothing was reported about a controller that was never judged.
    expect(health(t.state).status).toBe('unconfigured');
    sim.setStalled(false);
  });

  it('starts without the controller and finds it when it appears', async () => {
    const first = await startMyGekkoSim({ username: 'hub-api', password: PASSWORD });
    const { port, host } = first;
    await first.close();

    const t = newDeps();
    const gekko = launch(t, settingsFor({ host }));
    const down = await offline(t.state);
    expect(down.message).toContain('nicht erreichbar');
    expect(down.lastOkAt).toBeNull();
    expect(own(t.state)).toEqual([]);
    expect(await failure(gekko.command('gekko:lights/item0', { action: 'turn_on' }))).toMatchObject({ statusCode: 404 });

    await startSim({ port });
    await online(t.state);
    expect(own(t.state).length).toBeGreaterThan(60);
    expect(own(t.state).every((candidate) => candidate.available)).toBe(true);
  });
});
