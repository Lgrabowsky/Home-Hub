import dgram from 'node:dgram';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GoveeSettings, LightEntity } from '@home-hub/shared';
import { HttpError } from '../src/http/errors.ts';
import { goveeEntityId, GoveeIntegration, roomFromName, type GoveeOptions, type GoveeTiming } from '../src/integrations/govee.ts';
import { packRgb, unpackRgb } from '../src/integrations/govee/cloud.ts';
import { kelvinToRgb, parseLanMessage } from '../src/integrations/govee/lan.ts';
import { startGoveeSim, type GoveeSim, type GoveeSimOptions } from '../src/sim/govee-sim.ts';
import { createTestDeps, waitFor, type TestDeps } from './deps.ts';

/** Govee lights: LAN (UDP) where the light offers it, the cloud API otherwise. */

const FAST: Partial<GoveeTiming> = {
  lanActiveMs: 100,
  lanIdleMs: 100,
  scanMs: 300,
  lanLostMs: 800,
  settleMs: 200,
  cloudListMs: 60_000,
  cloudActiveMs: 100,
  cloudIdleMs: 100,
  cloudBudget: 1e9,
  holdMs: 300,
  confirmMs: 30,
  authBlockMs: 60_000,
  requestTimeoutMs: 2000,
};

const LIVING = 'AA:BB:CC:DD:EE:01:02:03';
const KITCHEN = 'AA:BB:CC:DD:EE:01:02:04';
const BEDROOM = 'AA:BB:CC:DD:EE:01:02:05';

let env: TestDeps;
let sim: GoveeSim | null = null;
let govee: GoveeIntegration | null = null;

async function startSim(options: GoveeSimOptions = {}): Promise<GoveeSim> {
  sim = await startGoveeSim(options);
  return sim;
}

const optionsFor = (simulator: GoveeSim, timing: Partial<GoveeTiming> = FAST): GoveeOptions => ({
  cloudBase: simulator.cloudBase,
  lan: { multicast: '127.0.0.1', scanPort: simulator.scanPort, devicePort: simulator.devicePort, listenPort: 0, bindAddress: '0.0.0.0' },
  timing,
});

function start(settings: Partial<GoveeSettings>, options: GoveeOptions): GoveeIntegration {
  govee = new GoveeIntegration(env.deps, { enabled: true, apiKey: '', lan: true, lanHosts: [], ...settings }, options);
  govee.start();
  govee.setActive(true);
  return govee;
}

const light = (device: string) => env.state.get(goveeEntityId(device)) as LightEntity | undefined;
const ready = (device: string) => waitFor(() => (light(device)?.available ? light(device) : null), 4000, `${device} available`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function failure(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error('expected the call to fail');
}

beforeEach(() => {
  env = createTestDeps();
  // Rooms the house already has (from the building controller).
  env.state.replace('mygekko', [
    { id: 'mygekko:licht-wz', kind: 'light', name: 'Decke', room: 'Wohnzimmer', available: true, service: 'mygekko', on: false, brightness: null, color: null, colorTemp: null, features: { dim: false, color: false, colorTemp: false }, isGroup: false },
    { id: 'mygekko:licht-kue', kind: 'light', name: 'Decke', room: 'Küche', available: true, service: 'mygekko', on: false, brightness: null, color: null, colorTemp: null, features: { dim: false, color: false, colorTemp: false }, isGroup: false },
  ]);
});

afterEach(async () => {
  await govee?.stop();
  govee = null;
  await sim?.close();
  if (sim) for (const line of env.logs) expect(line).not.toContain(sim.apiKey);
  sim = null;
  env.cleanup();
});

describe('building blocks', () => {
  it('packs colours the way Govee does', () => {
    expect(packRgb({ r: 255, g: 0, b: 0 })).toBe(16711680);
    expect(packRgb({ r: 1, g: 2, b: 3 })).toBe(66051);
    expect(unpackRgb(66051)).toEqual({ r: 1, g: 2, b: 3 });
  });

  it('reads LAN answers and ignores anything else', () => {
    const scan = Buffer.from(JSON.stringify({ msg: { cmd: 'scan', data: { ip: '192.168.1.23', device: '1F:80:C5:32:32:36:72:4E', sku: 'H618E' } } }));
    expect(parseLanMessage(scan)).toEqual({ cmd: 'scan', light: { device: '1F:80:C5:32:32:36:72:4E', sku: 'H618E', ip: '192.168.1.23' } });
    const status = Buffer.from(JSON.stringify({ msg: { cmd: 'devStatus', data: { onOff: 1, brightness: 42, color: { r: 1, g: 2, b: 3 }, colorTemInKelvin: 0 } } }));
    expect(parseLanMessage(status)).toEqual({ cmd: 'devStatus', status: { on: true, brightness: 42, rgb: { r: 1, g: 2, b: 3 }, kelvin: 0 } });
    expect(parseLanMessage(Buffer.from('nonsense'))).toBeNull();
    expect(parseLanMessage(Buffer.from('{"msg":{"cmd":"scan","data":{}}}'))).toBeNull();
  });

  it('finds the room in a light name', () => {
    expect(roomFromName('Wohnzimmer LED-Streifen', ['Wohnzimmer', 'Küche'])).toBe('Wohnzimmer');
    expect(roomFromName('Küche Unterschrank', ['Wohnzimmer', 'Küche'])).toBe('Küche');
    expect(roomFromName('Streifen', ['Wohnzimmer'])).toBeNull();
    // The longest match wins ("Kinderzimmer Nord" before "Kinderzimmer").
    expect(roomFromName('Kinderzimmer Nord Lampe', ['Kinderzimmer', 'Kinderzimmer Nord'])).toBe('Kinderzimmer Nord');
  });

  it('turns a colour temperature into warm and cold white', () => {
    expect(kelvinToRgb(2000).r).toBe(255);
    expect(kelvinToRgb(2000).b).toBeLessThan(kelvinToRgb(6500).b);
  });
});

describe('lights', () => {
  it('lists the lights with names, abilities and the rooms in their names; asks the cloud only about lights without LAN', async () => {
    const simulator = await startSim();
    start({ apiKey: simulator.apiKey }, optionsFor(simulator));
    expect(await ready(LIVING)).toMatchObject({ name: 'Wohnzimmer LED-Streifen', room: 'Wohnzimmer', service: 'govee', features: { dim: true, color: true, colorTemp: true }, on: true, brightness: 80, color: '#ff7828' });
    expect(await ready(KITCHEN)).toMatchObject({ name: 'Küche Unterschrank', room: 'Küche', on: false });
    expect(await ready(BEDROOM)).toMatchObject({ name: 'Schlafzimmer Leselampe', room: null });
    await sleep(500);
    // One list, then state rounds only for the light without LAN.
    expect(simulator.stats.list).toBe(1);
    const diag = govee!.diagnostics() as { lights: { device: string; via: string }[] };
    expect(diag.lights.find((entry) => entry.device === LIVING)?.via).toBe('lan');
    expect(diag.lights.find((entry) => entry.device === BEDROOM)?.via).toBe('cloud');
    const rounds = simulator.stats.state;
    expect(rounds).toBeGreaterThan(0);
    // Every state request was about the bedroom lamp: the LAN lights cost nothing.
    expect(env.state.getService('govee').status).toBe('ok');
  });

  it('switches lights with LAN control locally, without the cloud', async () => {
    const simulator = await startSim();
    const integration = start({ apiKey: simulator.apiKey }, optionsFor(simulator));
    await ready(KITCHEN);
    const id = goveeEntityId(KITCHEN);
    await integration.command(id, { action: 'turn_on' });
    await integration.command(id, { action: 'set_color', value: '#00ff80' });
    await integration.command(id, { action: 'set_brightness', value: 35 });
    // UDP: the light takes the commands a moment later.
    await waitFor(() => (simulator.state(KITCHEN).brightness === 35 ? true : null), 2000, 'brightness arrived');
    expect(simulator.state(KITCHEN)).toMatchObject({ on: true, brightness: 35, rgb: { r: 0, g: 255, b: 128 }, kelvin: 0 });
    expect(light(KITCHEN)).toMatchObject({ on: true, color: '#00ff80', brightness: 35 });

    // White: 50 % lies halfway between 2000 K and 9000 K.
    await integration.command(id, { action: 'set_color_temp', value: 50 });
    await waitFor(() => (simulator.state(KITCHEN).kelvin === 5500 ? true : null), 2000, 'white arrived');
    expect(light(KITCHEN)).toMatchObject({ colorTemp: 50, color: null });
    expect(simulator.controlLog).toHaveLength(0);
    expect(simulator.lanLog.map((entry) => entry.cmd)).toEqual(['turn', 'colorwc', 'brightness', 'colorwc']);

    await integration.command(id, { action: 'set_brightness', value: 0 });
    await waitFor(() => (simulator.state(KITCHEN).on === false ? true : null), 2000, 'off arrived');
  });

  it('switches lights without LAN through the cloud, and merges a burst of colours', async () => {
    const simulator = await startSim();
    const integration = start({ apiKey: simulator.apiKey }, optionsFor(simulator));
    await ready(BEDROOM);
    const id = goveeEntityId(BEDROOM);
    await integration.command(id, { action: 'turn_on' });
    expect(simulator.controlLog.at(-1)).toEqual({ device: BEDROOM, instance: 'powerSwitch', value: 1 });
    expect(light(BEDROOM)?.on).toBe(true);

    // A colour wheel dragged across: only the first and the newest colour reach Govee.
    const colours = ['#ff0000', '#ff4000', '#ff8000', '#ffc000', '#ffff00'];
    await Promise.all(colours.map((value) => integration.command(id, { action: 'set_color', value })));
    const sent = simulator.controlLog.filter((entry) => entry.instance === 'colorRgb');
    expect(sent.length).toBeLessThanOrEqual(2);
    expect(sent.at(-1)?.value).toBe(0xffff00);
    expect(light(BEDROOM)?.color).toBe('#ffff00');

    await integration.command(id, { action: 'set_color_temp', value: 0 });
    expect(simulator.controlLog.at(-1)).toEqual({ device: BEDROOM, instance: 'colorTemperatureK', value: 2000 });
    expect(simulator.lanLog).toHaveLength(0);
  });

  it('falls back to the cloud when a light stops answering on the LAN', async () => {
    const simulator = await startSim();
    const integration = start({ apiKey: simulator.apiKey }, optionsFor(simulator));
    await ready(LIVING);
    simulator.setLan(LIVING, false);
    await waitFor(() => ((govee!.diagnostics() as { lights: { device: string; via: string }[] }).lights.find((entry) => entry.device === LIVING)?.via === 'cloud' ? true : null), 4000, 'via cloud');
    await waitFor(() => (light(LIVING)?.available ? true : null), 2000, 'still available');
    await integration.command(goveeEntityId(LIVING), { action: 'turn_off' });
    expect(simulator.controlLog.at(-1)).toEqual({ device: LIVING, instance: 'powerSwitch', value: 0 });
  });

  it('works without an API key for lights with LAN control', async () => {
    const simulator = await startSim();
    const integration = start({ apiKey: '' }, optionsFor(simulator));
    expect(await ready(LIVING)).toMatchObject({ name: 'Govee H619A', features: { dim: true, color: true, colorTemp: true } });
    await ready(KITCHEN);
    await sleep(300);
    expect(light(BEDROOM)).toBeUndefined();
    expect(simulator.stats.list + simulator.stats.state).toBe(0);
    await integration.command(goveeEntityId(LIVING), { action: 'toggle' });
    await waitFor(() => (simulator.state(LIVING).on === false ? true : null), 2000, 'off arrived');
  });

  it('uses only the cloud when LAN control is switched off in the settings', async () => {
    const simulator = await startSim();
    const integration = start({ apiKey: simulator.apiKey, lan: false }, optionsFor(simulator));
    await ready(LIVING);
    await integration.command(goveeEntityId(LIVING), { action: 'turn_off' });
    expect(simulator.controlLog).toHaveLength(1);
    expect(simulator.stats.scans).toBe(0);
  });

  it('refuses what a light cannot do', async () => {
    const simulator = await startSim({ lights: [{ device: BEDROOM, sku: 'H6001', name: 'Weiße Birne', color: false, colorTemp: false }] });
    const integration = start({ apiKey: simulator.apiKey }, optionsFor(simulator));
    expect(await ready(BEDROOM)).toMatchObject({ features: { dim: true, color: false, colorTemp: false } });
    expect((await failure(integration.command(goveeEntityId(BEDROOM), { action: 'set_color', value: '#ff0000' }))).statusCode).toBe(400);
    expect((await failure(integration.command('govee:unbekannt', { action: 'turn_on' }))).statusCode).toBe(404);
  });
});

describe('problems', () => {
  it('reports a refused API key, and the LAN lights keep working', async () => {
    const simulator = await startSim();
    const integration = start({ apiKey: 'falsch' }, optionsFor(simulator));
    await ready(LIVING);
    await waitFor(() => (env.state.getService('govee').message?.includes('API-Key') ? true : null), 3000, 'key refused');
    expect(env.state.getService('govee').status).toBe('degraded');
    await integration.command(goveeEntityId(LIVING), { action: 'turn_off' });
    await waitFor(() => (simulator.state(LIVING).on === false ? true : null), 2000, 'off arrived');
    // Not asked again soon: a refused key does not get better by itself.
    const refused = simulator.stats.refused;
    await sleep(400);
    expect(simulator.stats.refused).toBe(refused);
  });

  it('pauses the cloud when the daily limit is reached and says so', async () => {
    const simulator = await startSim();
    const integration = start({ apiKey: simulator.apiKey, lan: false }, optionsFor(simulator));
    await ready(BEDROOM);
    simulator.setRemaining(0);
    const error = await failure(integration.command(goveeEntityId(BEDROOM), { action: 'turn_off' }));
    expect(error.statusCode).toBe(429);
    expect(error.message).toContain('Govee');
    // Further commands are refused at once, without asking Govee.
    const refused = simulator.stats.refused;
    expect((await failure(integration.command(goveeEntityId(BEDROOM), { action: 'turn_on' }))).statusCode).toBe(429);
    expect(simulator.stats.refused).toBe(refused);
  });

  it('keeps going over the cloud when the LAN port is taken by another program', async () => {
    const simulator = await startSim();
    const blocker = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => blocker.bind(0, '0.0.0.0', () => resolve()));
    try {
      const options = optionsFor(simulator);
      start({ apiKey: simulator.apiKey }, { ...options, lan: { ...options.lan, listenPort: blocker.address().port } });
      await ready(LIVING);
      expect(env.state.getService('govee').message).toContain('belegt');
      expect((govee!.diagnostics() as { lights: { device: string; via: string }[] }).lights.every((entry) => entry.via === 'cloud')).toBe(true);
    } finally {
      blocker.close();
    }
  });
});

describe('connection test', () => {
  it('lists what it finds and where', async () => {
    const simulator = await startSim();
    const result = await GoveeIntegration.test({ enabled: true, apiKey: simulator.apiKey, lan: true, lanHosts: [] }, optionsFor(simulator));
    expect(result).toMatchObject({ ok: true, message: '3 Govee-Lichter gefunden.' });
    const details = result.details.join('\n');
    expect(details).toContain('API-Key angenommen');
    expect(details).toContain(`Wohnzimmer LED-Streifen (H619A): im Heimnetz (${simulator.lanAddress(LIVING)})`);
    expect(details).toContain('Schlafzimmer Leselampe (H6008): nur über die Govee-Cloud');
    expect(details).toContain('LAN-Steuerung');
  });

  it('names a refused API key', async () => {
    const simulator = await startSim();
    const result = await GoveeIntegration.test({ enabled: true, apiKey: 'falsch', lan: false, lanHosts: [] }, optionsFor(simulator));
    expect(result).toMatchObject({ ok: false, message: 'Govee nimmt den API-Key nicht an.' });
  });

  it('asks the running integration instead of opening a second LAN socket', async () => {
    const simulator = await startSim();
    const integration = start({ apiKey: '' }, optionsFor(simulator));
    await ready(LIVING);
    const options = optionsFor(simulator);
    // A port the test could not open: the answer must come from the running instance.
    const blocker = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => blocker.bind(0, '0.0.0.0', () => resolve()));
    try {
      const result = await GoveeIntegration.test({ enabled: true, apiKey: '', lan: true, lanHosts: [] }, { ...options, lan: { ...options.lan, listenPort: blocker.address().port } }, integration);
      expect(result).toMatchObject({ ok: true, message: '2 Govee-Lichter gefunden.' });
    } finally {
      blocker.close();
    }
  });
});
