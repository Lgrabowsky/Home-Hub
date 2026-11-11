import { mkdirSync, readFileSync, statSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DoorBirdDeviceSettings, DoorBirdSettings, DoorEntity, HubEvent } from '@home-hub/shared';
import { HttpError } from '../src/http/errors.ts';
import { DoorBirdIntegration, type DoorBirdOptions } from '../src/integrations/doorbird.ts';
import {
  EdgeDetector,
  MonitorParser,
  parseInfo,
  parseTimestampHeader,
  streamSources,
  visibleRelays,
  type MonitorReport,
} from '../src/integrations/doorbird/protocol.ts';
import type { Actor } from '../src/integrations/types.ts';
import { DOORBIRD_DEMO_STATIONS, startDoorBirdSim, type DoorBirdSim, type DoorBirdSimOptions } from '../src/sim/doorbird-sim.ts';
import { createTestDeps, waitFor, type TestDeps } from './deps.ts';

/**
 * The real integration against the simulated door station, over real sockets.
 * All waiting times are shortened through the constructor options; the
 * production values live in `doorbird/timings.ts`.
 */
const FAST: DoorBirdOptions = {
  requestTimeoutMs: 1_500,
  imageTimeoutMs: 1_500,
  historyTimeoutMs: 1_500,
  busyRetryMs: 30,
  infoRetryMs: 60,
  probeMs: 150,
  offlineAfterMs: 80,
  // Long on purpose: after a refused login nothing may be sent again during a test.
  authRetryMinMs: 60_000,
  authRetryMaxMs: 120_000,
  deniedCooldownMs: 60_000,
  monitorBackoffMinMs: 40,
  monitorBackoffMaxMs: 160,
  monitorGraceMs: 150,
  monitorBusyWaitMs: 60_000,
  ringDebounceMs: 150,
  motionIntervalMs: 300,
  eventImageMaxAgeMs: 0,
  snapshotCacheMs: 400,
  snapshotErrorCacheMs: 100,
  openGuardMs: 300,
  historyStartDelayMs: 20,
  historyEventDelayMs: 60,
  historyRetryMs: 500,
  historyGapMs: 15,
};

/** Contains everything that breaks naive URL building. */
const PASSWORD = 'S3cr3t&Pass#42 %x';
const ANNA: Actor = { userId: 'u1', username: 'anna', displayName: 'Anna Berger', ip: '192.168.1.50' };
const HOUR = 3_600_000;

interface DeviceDiagnostics {
  id: string;
  reachable: boolean;
  available: boolean;
  login: string;
  authentication: string;
  model: string | null;
  firmware: string | null;
  relays: string[];
  monitor: { state: string; connectedSince: string | null; lastHeartbeatAt: string | null; connects: number; problem: string | null };
  lastEvent: { type: string; at: string | null; source: string } | null;
  historySync: { at: string | null; imported: number; attached: number; complete: boolean; error: string | null } | null;
  lastError: { at: string | null; message: string } | null;
}

interface Rig extends TestDeps {
  sims: DoorBirdSim[];
  integration: DoorBirdIntegration;
  events: HubEvent[];
  door(id: string): DoorEntity | undefined;
}

let rigs: Rig[] = [];
let strays: DoorBirdSim[] = [];

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The device password in every form it could leak in: plain, URL-escaped (once and twice), inside a Basic header. */
function secretForms(sim: DoorBirdSim): string[] {
  const escaped = encodeURIComponent(sim.password);
  return [sim.password, escaped, encodeURIComponent(escaped), Buffer.from(`${sim.username}:${sim.password}`).toString('base64')];
}

afterEach(async () => {
  const leaks: string[] = [];
  for (const rig of rigs) {
    const diagnostics = JSON.stringify(rig.integration.diagnostics());
    await rig.integration.stop();
    const logs = rig.logs.join('\n');
    for (const sim of rig.sims) {
      for (const secret of secretForms(sim)) {
        if (logs.includes(secret)) leaks.push('log');
        if (diagnostics.includes(secret)) leaks.push('diagnostics');
      }
      if (diagnostics.includes(sim.username)) leaks.push('diagnostics (user name)');
      if (logs.includes(sim.username)) leaks.push('log (user name)');
      await sim.close();
    }
    rig.cleanup();
  }
  for (const sim of strays) await sim.close();
  rigs = [];
  strays = [];
  // No test may leave a credential in the log or in the diagnostics.
  expect(leaks).toEqual([]);
});

async function startSim(options: DoorBirdSimOptions = {}): Promise<DoorBirdSim> {
  const sim = await startDoorBirdSim({ password: PASSWORD, heartbeatMs: 100, pulseMs: 60, historyDelayMs: 10, history: { doorbell: 0, motionsensor: 0 }, ...options });
  strays.push(sim);
  return sim;
}

interface HubOptions {
  /** Per simulator: overrides of the device settings. */
  devices?: Partial<DoorBirdDeviceSettings>[];
  /** Devices that no simulator stands behind. */
  extraDevices?: DoorBirdDeviceSettings[];
  timings?: DoorBirdOptions;
  retentionDays?: number;
  /** Reuse the data directory, database and state of an earlier hub (a restart). */
  base?: TestDeps;
}

/** Starts the integration against the given simulators (door ids `haustuer`, `seite`, `garage`). */
function startHub(sims: DoorBirdSim[], options: HubOptions = {}): Rig {
  const base = options.base ?? createTestDeps();
  const ids = ['haustuer', 'seite', 'garage'];
  const names = ['Haustür', 'Seiteneingang', 'Garage'];
  const settings: DoorBirdSettings = {
    enabled: true,
    retentionDays: options.retentionDays ?? 90,
    devices: [...sims.map((sim, index) => sim.settings({ id: ids[index]!, name: names[index]!, ...options.devices?.[index] })), ...(options.extraDevices ?? [])],
  };
  const events: HubEvent[] = [];
  base.state.on('event', (event) => events.push(event));
  const integration = new DoorBirdIntegration(base.deps, settings, { ...FAST, ...options.timings });
  const rig: Rig = {
    deps: base.deps,
    state: base.state,
    logs: base.logs,
    dataDir: base.dataDir,
    cleanup: () => base.cleanup(),
    sims,
    integration,
    events,
    door: (id) => {
      const entity = base.state.get(`door:${id}`);
      return entity?.kind === 'door' ? entity : undefined;
    },
  };
  strays = strays.filter((sim) => !sims.includes(sim));
  rigs.push(rig);
  integration.start();
  return rig;
}

/** Stops the hub and starts a new instance on the same data, the way the manager does after a settings change. */
async function restartHub(rig: Rig, options: HubOptions = {}): Promise<Rig> {
  await rig.integration.stop();
  rigs = rigs.filter((candidate) => candidate !== rig);
  rig.state.setAvailable('doorbird', false);
  return startHub(rig.sims, { ...options, base: rig });
}

const serviceOf = (rig: Rig) => rig.state.getService('doorbird');
const diagnosticsOf = (rig: Rig, index = 0): DeviceDiagnostics => (rig.integration.diagnostics() as { devices: DeviceDiagnostics[] }).devices[index]!;
const count = (rig: Rig, type: HubEvent['type']): number => rig.events.filter((event) => event.type === type).length;
const requestsTo = (sim: DoorBirdSim, cgi: string) => sim.requests.filter((request) => request.path.startsWith(`/bha-api/${cgi}`));
const audit = (rig: Rig) =>
  rig.deps.db
    .all<{ action: string; user_id: string | null; username: string | null; ip: string | null; detail: string | null }>('SELECT action, user_id, username, ip, detail FROM audit ORDER BY id')
    .map((row) => ({ ...row, detail: row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : null }));

async function online(rig: Rig, id = 'haustuer'): Promise<DoorEntity> {
  return waitFor(() => (rig.door(id)?.available ? rig.door(id) : undefined), 5000, `door ${id} to become available`);
}

/** Door is available and its current event stream has delivered the initial state. */
async function listening(rig: Rig, index = 0): Promise<void> {
  await online(rig, ['haustuer', 'seite', 'garage'][index]);
  await waitFor(
    () => {
      const { monitor } = diagnosticsOf(rig, index);
      return monitor.state === 'connected' && monitor.lastHeartbeatAt !== null && rig.sims[index]?.monitorStreams === 1;
    },
    5000,
    'event stream',
  );
}

/** Waits for a history sync that started after `since` and ran to its end. */
async function synced(rig: Rig, since = 0, index = 0): Promise<NonNullable<DeviceDiagnostics['historySync']>> {
  return waitFor(
    () => {
      const sync = diagnosticsOf(rig, index).historySync;
      return sync && (sync.complete || sync.error !== null) && sync.at !== null && Date.parse(sync.at) >= since ? sync : undefined;
    },
    5000,
    'history sync',
  );
}

async function failure(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error('expected the call to fail');
}

function failureOf(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error('expected the call to fail');
}

// ---------------------------------------------------------------------------------------

describe('start-up', () => {
  it('publishes one door entity per device with model, relays and health', async () => {
    const front = await startSim({ name: 'Haustür', model: 'DoorBird D2101V', relays: ['1', '2', 'ghchdi@1'] });
    const side = await startSim({ name: 'Seiteneingang', scene: 'side-door', model: 'DoorBird D1101V', relays: ['1'] });
    const rig = startHub([front, side], {
      devices: [{ room: 'Eingang', relayNames: { '2': 'Gartentor' }, hiddenRelays: ['ghchdi@1'] }, { room: '  ' }],
    });

    // Shown at once, greyed out, before any device has answered.
    expect(rig.door('haustuer')).toMatchObject({ available: false, relays: [], model: null });
    expect(serviceOf(rig).status).toBe('starting');

    const door = await online(rig);
    expect(door).toEqual({
      id: 'door:haustuer',
      kind: 'door',
      name: 'Haustür',
      room: 'Eingang',
      available: true,
      service: 'doorbird',
      model: 'DoorBird D2101V',
      relays: [
        { id: '1', name: 'Türöffner' },
        { id: '2', name: 'Gartentor' },
      ],
      features: { talk: true, audio: true, light: true },
      lastRingAt: null,
      lastMotionAt: null,
    });
    const second = await online(rig, 'seite');
    expect(second).toMatchObject({ name: 'Seiteneingang', room: null, model: 'DoorBird D1101V', relays: [{ id: '1', name: 'Türöffner' }] });
    await waitFor(() => serviceOf(rig).status === 'ok', 5000, 'service ok');
    expect(serviceOf(rig).message).toBeNull();
    expect(serviceOf(rig).lastOkAt).not.toBeNull();

    // The login went through the device's Digest challenge, and the event stream is up.
    await waitFor(() => front.monitorStreams === 1 && side.monitorStreams === 1, 5000, 'event streams');
    expect(front.requests.filter((request) => request.status === 200).every((request) => request.auth === 'digest')).toBe(true);
    expect(requestsTo(front, 'monitor.cgi')[0]?.path).toBe('/bha-api/monitor.cgi?ring=doorbell,motionsensor');
    expect(front.stats.failedLogins).toBe(0);

    const diagnostics = diagnosticsOf(rig);
    expect(diagnostics).toMatchObject({ id: 'haustuer', reachable: true, available: true, login: 'verified', authentication: 'auto', model: 'DoorBird D2101V', firmware: '000125' });
    // The log the leak check (see afterEach) looks at is really being written.
    expect(rig.logs.some((line) => line.includes('door station connected'))).toBe(true);
    expect(diagnostics.relays).toEqual(['1', '2', 'ghchdi@1']);
    await waitFor(() => diagnosticsOf(rig).monitor.state === 'connected' && diagnosticsOf(rig).monitor.connectedSince !== null, 5000, 'monitor diagnostics');
  });

  it('works with Basic authentication and with firmware that reports neither relays nor a model', async () => {
    const sim = await startSim({ auth: 'basic', relays: null });
    const rig = startHub([sim]);
    const door = await online(rig);
    expect(door.model).toBeNull();
    expect(door.relays).toEqual([{ id: '1', name: 'Türöffner' }]);
    expect(sim.requests.filter((request) => request.status === 200).every((request) => request.auth === 'basic')).toBe(true);
    await rig.integration.openDoor('haustuer', '1', ANNA);
    expect(sim.opened.map((entry) => entry.relay)).toEqual(['1']);
  });

  it('checks once with Basic when the device refuses the answer to its Digest challenge', async () => {
    const sim = await startSim({ rejectDigest: true });
    const rig = startHub([sim]);
    await online(rig);
    expect(diagnosticsOf(rig)).toMatchObject({ login: 'verified', authentication: 'basic' });
    expect(requestsTo(sim, 'info.cgi').at(-1)).toMatchObject({ auth: 'basic', status: 200 });
    // From here on the credentials go along with every request: no further refused Digest answers.
    const refused = sim.stats.failedLogins;
    await listening(rig);
    await rig.integration.openDoor('haustuer', '1', ANNA);
    expect(requestsTo(sim, 'open-door.cgi').map((request) => [request.auth, request.status])).toEqual([['basic', 200]]);
    sim.ring();
    await waitFor(() => count(rig, 'doorbell') === 1, 5000, 'ring');
    expect(sim.stats.failedLogins).toBe(refused);
    expect(serviceOf(rig).status).toBe('ok');
  });

  it('renews an expired Digest nonce without it counting as a failed login', async () => {
    const sim = await startSim({ nonceLifetimeMs: 60 });
    const rig = startHub([sim]);
    await online(rig);
    await pause(120);
    await rig.integration.light('haustuer');
    await pause(120);
    expect((await rig.integration.snapshot('haustuer')).length).toBeGreaterThan(100);
    expect(sim.lightOn).toBe(1);
    expect(sim.stats.failedLogins).toBe(0);
    expect(rig.door('haustuer')?.available).toBe(true);
    expect(diagnosticsOf(rig).login).toBe('verified');
  });

  it('reports a hub without door stations as not set up', () => {
    const rig = startHub([]);
    expect(serviceOf(rig)).toMatchObject({ status: 'unconfigured', message: 'Es ist noch keine Türstation eingetragen.' });
    expect(rig.integration.streams()).toEqual([]);
    expect(failureOf(() => rig.integration.history('haustuer', {})).statusCode).toBe(404);
  });

  it('keeps the other door stations working when one has an unusable address', async () => {
    const sim = await startSim();
    const rig = startHub([sim], {
      extraDevices: [{ id: 'keller', name: 'Kellertür', host: 'tuer.lan:99999', username: 'ghkell0001', password: 'x', room: '', relayNames: {}, hiddenRelays: [] }],
    });
    await online(rig);
    await waitFor(() => serviceOf(rig).status === 'degraded', 5000, 'degraded');
    expect(serviceOf(rig).message).toBe('Kellertür: Die Adresse der Türstation ist ungültig.');
    expect(rig.door('keller')).toMatchObject({ available: false, name: 'Kellertür', relays: [] });
    expect((await failure(rig.integration.snapshot('keller'))).statusCode).toBe(503);
    expect(rig.integration.streams().map((spec) => spec.name)).toEqual(['door_haustuer_main', 'door_haustuer_talk']);
    expect((await rig.integration.snapshot('haustuer')).length).toBeGreaterThan(100);
  });
});

describe('doorbell and motion', () => {
  it('announces a ring at once, stores it with an encrypted picture and updates the entity', async () => {
    const sim = await startSim();
    const rig = startHub([sim]);
    await listening(rig);

    const before = Date.now();
    sim.ring();
    const ring = await waitFor(() => rig.events.find((event) => event.type === 'doorbell'), 5000, 'doorbell event');
    if (ring.type !== 'doorbell') throw new Error('unreachable');
    expect(ring).toMatchObject({ doorId: 'haustuer', doorName: 'Haustür' });
    expect(ring.ts).toBeGreaterThanOrEqual(before);
    expect(ring.ts).toBeLessThanOrEqual(Date.now());
    const eventId = ring.eventId;
    expect(eventId).toEqual(expect.any(String));

    await waitFor(() => count(rig, 'history_updated') >= 1, 5000, 'history_updated');
    expect(rig.integration.history('haustuer', {})).toEqual({
      events: [{ id: eventId, doorId: 'haustuer', type: 'doorbell', ts: ring.ts, hasImage: true, actor: null, detail: null }],
      nextBefore: null,
    });
    expect(rig.door('haustuer')?.lastRingAt).toBe(ring.ts);
    expect(rig.door('haustuer')?.lastMotionAt).toBeNull();

    // The picture comes back decrypted; on disk it is unreadable and private.
    const image = rig.integration.historyImage(eventId!);
    expect(image?.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const directory = join(rig.dataDir, 'history', 'haustuer');
    const file = join(directory, `${eventId}.bin`);
    const stored = readFileSync(file);
    expect(stored.includes(image!.subarray(0, 32))).toBe(false);
    expect(rig.deps.vault.decryptFile(stored, `door-event/${eventId}`).equals(image!)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(rig.integration.historyImage('gibt-es-nicht')).toBeNull();

    // The device files its own picture of the ring a moment later: still one event, not two.
    await synced(rig, ring.ts);
    expect(requestsTo(sim, 'history.cgi').some((request) => request.at >= ring.ts)).toBe(true);
    expect(rig.integration.history('haustuer', {}).events).toHaveLength(1);
    expect(diagnosticsOf(rig).lastEvent).toMatchObject({ type: 'doorbell', source: 'hub' });
  });

  it('treats a quick second press as the same ring and records motion at most once per interval', async () => {
    const sim = await startSim({ pulseMs: 10 });
    const rig = startHub([sim], { timings: { ringDebounceMs: 700, motionIntervalMs: 700 } });
    await listening(rig);

    sim.ring();
    sim.motion();
    await waitFor(() => count(rig, 'doorbell') === 1 && count(rig, 'door_motion') === 1, 5000, 'first events');
    const first = Date.now();
    // The signals have gone back to "L": the next "H" is a real edge, but still the same visitor.
    await pause(60);
    sim.ring();
    sim.motion();
    await pause(150);
    expect(count(rig, 'doorbell')).toBe(1);
    expect(count(rig, 'door_motion')).toBe(1);

    await pause(Math.max(0, first + 800 - Date.now()));
    sim.ring();
    sim.motion();
    await waitFor(() => count(rig, 'doorbell') === 2 && count(rig, 'door_motion') === 2, 5000, 'second events');
    const motion = rig.events.findLast((event) => event.type === 'door_motion');
    expect(motion).toMatchObject({ doorId: 'haustuer', doorName: 'Haustür', eventId: expect.any(String) });
    await waitFor(() => rig.door('haustuer')?.lastMotionAt === (motion?.type === 'door_motion' ? motion.ts : -1), 5000, 'lastMotionAt');
    expect(rig.integration.history('haustuer', { type: 'motion' }).events).toHaveLength(2);
    expect(rig.integration.history('haustuer', { type: 'doorbell' }).events).toHaveLength(2);
  });

  it('does not announce a ring again when the event stream reconnects while the button still reads "H"', async () => {
    const sim = await startSim({ pulseMs: 500 });
    const rig = startHub([sim], { timings: { monitorGraceMs: 2_000 } });
    await listening(rig);

    sim.ring();
    await waitFor(() => count(rig, 'doorbell') === 1, 5000, 'ring');
    const rangAt = Date.now();
    sim.dropMonitorStreams();
    // The new stream starts with the current state: "doorbell:H" — the ring that was announced already.
    await waitFor(() => sim.stats.monitorOpened >= 2 && diagnosticsOf(rig).monitor.connects >= 2 && diagnosticsOf(rig).monitor.lastHeartbeatAt !== null, 5000, 'reconnect');
    await pause(150);
    expect(count(rig, 'doorbell')).toBe(1);

    // Once the signal has gone back to "L", the next press counts again.
    await pause(Math.max(0, rangAt + 650 - Date.now()));
    sim.ring();
    await waitFor(() => count(rig, 'doorbell') === 2, 5000, 'second ring');
    expect(rig.door('haustuer')?.available).toBe(true);
  });

  it('reconnects by itself when the event stream goes silent', async () => {
    const sim = await startSim({ heartbeatMs: 0 });
    const rig = startHub([sim], { timings: { monitorIdleMs: 300 } });
    await online(rig);
    await waitFor(() => sim.stats.monitorOpened >= 3, 8000, 'reconnects after silence');
    // A silent stream alone is no reason to grey out the door: every reconnect is answered.
    expect(rig.door('haustuer')?.available).toBe(true);
    // Ring right after a fresh stream came up, so it is certainly open.
    const opened = sim.stats.monitorOpened;
    await waitFor(() => sim.stats.monitorOpened > opened && sim.monitorStreams === 1, 5000, 'next stream');
    sim.ring();
    await waitFor(() => count(rig, 'doorbell') === 1, 5000, 'ring after reconnect');
  });

  it('reports when the device has no free event stream (HTTP 509) and does not keep asking', async () => {
    const sim = await startSim({ maxMonitorStreams: 0 });
    const rig = startHub([sim]);
    await online(rig);
    await waitFor(() => serviceOf(rig).status === 'degraded', 5000, 'degraded');
    expect(serviceOf(rig).message).toContain('Haustür');
    expect(serviceOf(rig).message).toContain('zu viele Verbindungen');
    expect(diagnosticsOf(rig).monitor.problem).toBe('too_many');
    await pause(300);
    expect(requestsTo(sim, 'monitor.cgi').filter((request) => request.status === 509)).toHaveLength(1);
    // Everything else keeps working.
    expect(rig.door('haustuer')?.available).toBe(true);
    await rig.integration.light('haustuer');
    expect(sim.lightOn).toBe(1);
  });
});

describe('history', () => {
  it('imports what happened while the hub was not listening, once', async () => {
    const sim = await startSim();
    const now = Date.now();
    sim.addHistory('doorbell', now - 1 * HOUR);
    sim.addHistory('doorbell', now - 5 * HOUR);
    sim.addHistory('doorbell', now - 26 * HOUR);
    sim.addHistory('motionsensor', now - 2 * HOUR);
    sim.addHistory('motionsensor', now - 3 * HOUR);
    const seconds = (ms: number): number => Math.floor(ms / 1000) * 1000;

    const rig = startHub([sim]);
    await online(rig);
    const sync = await synced(rig);
    expect(sync).toMatchObject({ imported: 5, attached: 0, complete: true, error: null });
    expect(count(rig, 'history_updated')).toBeGreaterThanOrEqual(1);

    // Wire format and order: index 1 is the newest; the walk ends at the first 404.
    expect(requestsTo(sim, 'history.cgi').map((request) => `${request.path} ${request.status}`)).toEqual([
      '/bha-api/history.cgi?index=1&event=doorbell 200',
      '/bha-api/history.cgi?index=2&event=doorbell 200',
      '/bha-api/history.cgi?index=3&event=doorbell 200',
      '/bha-api/history.cgi?index=4&event=doorbell 404',
      '/bha-api/history.cgi?index=1&event=motionsensor 200',
      '/bha-api/history.cgi?index=2&event=motionsensor 200',
      '/bha-api/history.cgi?index=3&event=motionsensor 404',
    ]);
    // The device accepts about one request per second: downloads keep their distance.
    const times = requestsTo(sim, 'history.cgi').map((request) => request.at);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(13);

    const all = rig.integration.history('haustuer', {});
    expect(all.events.map((event) => [event.type, event.ts])).toEqual([
      ['doorbell', seconds(now - 1 * HOUR)],
      ['motion', seconds(now - 2 * HOUR)],
      ['motion', seconds(now - 3 * HOUR)],
      ['doorbell', seconds(now - 5 * HOUR)],
      ['doorbell', seconds(now - 26 * HOUR)],
    ]);
    expect(all.events.every((event) => event.hasImage && event.doorId === 'haustuer' && event.actor === null)).toBe(true);
    expect(all.nextBefore).toBeNull();
    expect(rig.integration.historyImage(all.events[0]!.id)?.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(rig.door('haustuer')).toMatchObject({ lastRingAt: seconds(now - 1 * HOUR), lastMotionAt: seconds(now - 2 * HOUR) });

    // Paging: newest first, `before` is exclusive, `nextBefore` continues where the page ended.
    const page1 = rig.integration.history('haustuer', { limit: 2 });
    expect(page1.events.map((event) => event.ts)).toEqual([seconds(now - 1 * HOUR), seconds(now - 2 * HOUR)]);
    expect(page1.nextBefore).toBe(seconds(now - 2 * HOUR));
    const page2 = rig.integration.history('haustuer', { limit: 2, before: page1.nextBefore });
    expect(page2.events.map((event) => event.ts)).toEqual([seconds(now - 3 * HOUR), seconds(now - 5 * HOUR)]);
    const page3 = rig.integration.history('haustuer', { limit: 2, before: page2.nextBefore });
    expect(page3.events.map((event) => event.ts)).toEqual([seconds(now - 26 * HOUR)]);
    expect(page3.nextBefore).toBeNull();
    expect(rig.integration.history('haustuer', { type: 'motion' }).events).toHaveLength(2);
    expect(rig.integration.history('haustuer', { type: 'open' }).events).toEqual([]);
    expect(failureOf(() => rig.integration.history('unbekannt', {})).statusCode).toBe(404);

    // After a restart only the newest picture of each type is looked at: nothing is new, nothing is imported twice.
    sim.requests.length = 0;
    const again = await restartHub(rig);
    await online(again);
    expect(await synced(again)).toMatchObject({ imported: 0, complete: true });
    expect(requestsTo(sim, 'history.cgi').map((request) => request.path)).toEqual([
      '/bha-api/history.cgi?index=1&event=doorbell',
      '/bha-api/history.cgi?index=1&event=motionsensor',
    ]);
    expect(again.integration.history('haustuer', {}).events).toHaveLength(5);
    expect(again.door('haustuer')?.lastRingAt).toBe(seconds(now - 1 * HOUR));

    // A ring the hub missed completely (no event stream) is picked up by the next sync.
    sim.addHistory('doorbell', Date.now() - 60_000);
    const third = await restartHub(again);
    await online(third);
    expect(await synced(third)).toMatchObject({ imported: 1 });
    expect(third.integration.history('haustuer', { type: 'doorbell' }).events).toHaveLength(4);
  });

  it('lets a door opening pass a running history download, which then carries on without duplicates', async () => {
    const sim = await startSim();
    const now = Date.now();
    for (let i = 1; i <= 6; i++) sim.addHistory('doorbell', now - i * HOUR);
    const rig = startHub([sim], { timings: { historyGapMs: 150 } });
    await online(rig);
    await waitFor(() => requestsTo(sim, 'history.cgi').length >= 2, 5000, 'download in progress');

    await rig.integration.openDoor('haustuer', '1', ANNA);
    expect(sim.opened).toHaveLength(1);
    // The door did not wait for the remaining downloads (at most the one that was on its way got through).
    const interruptedAfter = requestsTo(sim, 'history.cgi').length;
    expect(interruptedAfter).toBeLessThanOrEqual(3);

    // The download starts over a moment later and runs to its end: every picture exactly once in the history.
    await waitFor(() => rig.integration.history('haustuer', { type: 'doorbell' }).events.length === 6, 8000, 'all pictures');
    await waitFor(() => diagnosticsOf(rig).historySync?.complete === true, 8000, 'complete sync');
    expect(requestsTo(sim, 'history.cgi').length).toBe(interruptedAfter + 8);
    expect(rig.integration.history('haustuer', { type: 'doorbell' }).events).toHaveLength(6);
    expect(rig.integration.history('haustuer', { type: 'open' }).events).toHaveLength(1);
  });

  it('adds the device picture to a live event that could not get one', async () => {
    const sim = await startSim({ permissions: { watchAlways: false } });
    const rig = startHub([sim], { timings: { historyEventDelayMs: 500 } });
    await listening(rig);
    // The sync at start is over: the next one is the one that follows the ring.
    await synced(rig);

    sim.ring();
    const ring = await waitFor(() => rig.events.find((event) => event.type === 'doorbell'), 5000, 'doorbell event');
    if (ring.type !== 'doorbell') throw new Error('unreachable');
    // image.cgi answers 204 (no "watch always"): the ring is recorded all the same …
    await waitFor(() => count(rig, 'history_updated') >= 1, 5000, 'history_updated');
    expect(rig.integration.history('haustuer', {}).events).toMatchObject([{ id: ring.eventId, hasImage: false }]);
    // … and gets the picture the device filed itself.
    await waitFor(() => rig.integration.history('haustuer', {}).events[0]?.hasImage === true, 5000, 'attached picture');
    expect(rig.integration.history('haustuer', {}).events).toHaveLength(1);
    expect(rig.integration.historyImage(ring.eventId!)).not.toBeNull();
  });

  it('falls back to comparing pictures when the device sends no X-Timestamp', async () => {
    const sim = await startSim({ timestampHeader: false });
    const now = Date.now();
    sim.addHistory('doorbell', now - 2 * HOUR);
    sim.addHistory('doorbell', now - 4 * HOUR);
    const rig = startHub([sim]);
    await online(rig);
    expect(await synced(rig)).toMatchObject({ imported: 2, complete: true });
    const first = rig.integration.history('haustuer', {}).events;
    expect(first).toHaveLength(2);
    // Without a time from the device the events are dated "about now", newest first.
    expect(first[0]!.ts).toBeGreaterThan(first[1]!.ts);
    expect(first[1]!.ts).toBeGreaterThan(now - 60_000);

    const again = await restartHub(rig);
    await online(again);
    expect(await synced(again)).toMatchObject({ imported: 0, complete: true });
    expect(again.integration.history('haustuer', {}).events).toHaveLength(2);
  });

  it('copes with a user who may not read the history', async () => {
    const sim = await startSim({ permissions: { history: false } });
    sim.addHistory('doorbell', Date.now() - HOUR);
    const rig = startHub([sim]);
    await online(rig);
    expect(await synced(rig)).toMatchObject({ imported: 0, complete: false, error: 'no permission to read the history' });
    await pause(150);
    // One refusal is enough: the hub does not ask again and again.
    expect(requestsTo(sim, 'history.cgi')).toHaveLength(1);
    // Live events are recorded regardless.
    await listening(rig);
    sim.ring();
    await waitFor(() => rig.integration.history('haustuer', {}).events.length === 1, 5000, 'live event');
    expect(serviceOf(rig).status).toBe('ok');
  });

  it('deletes events older than the retention period together with their pictures', async () => {
    const base = createTestDeps();
    const directory = join(base.dataDir, 'history', 'haustuer');
    mkdirSync(directory, { recursive: true });
    const now = Date.now();
    const insert = (id: string, ageMs: number, withFile: boolean): void => {
      if (withFile) writeFileSync(join(directory, `${id}.bin`), base.deps.vault.encryptFile(Buffer.from('picture'), `door-event/${id}`));
      base.deps.db.run(
        'INSERT INTO door_events (id, door_id, type, ts, image_file, image_hash, source, actor, detail) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL)',
        id,
        'haustuer',
        'doorbell',
        now - ageMs,
        withFile ? `haustuer/${id}.bin` : null,
        'hub',
      );
    };
    insert('old-with-picture', 50 * HOUR, true);
    insert('old-without', 49 * HOUR, false);
    insert('recent', 2 * HOUR, true);
    // Left behind by a crash long ago / written a moment ago for an event whose row is not updated yet.
    writeFileSync(join(directory, 'orphan-old.bin'), 'x');
    utimesSync(join(directory, 'orphan-old.bin'), new Date(now - HOUR), new Date(now - HOUR));
    writeFileSync(join(directory, 'orphan-fresh.bin'), 'x');

    const sim = await startSim();
    const rig = startHub([sim], { base, retentionDays: 2 });
    await waitFor(() => !existsSync(join(directory, 'orphan-old.bin')), 5000, 'clean-up');
    expect(rig.integration.history('haustuer', {}).events.map((event) => event.id)).toEqual(['recent']);
    expect(existsSync(join(directory, 'old-with-picture.bin'))).toBe(false);
    expect(existsSync(join(directory, 'recent.bin'))).toBe(true);
    expect(existsSync(join(directory, 'orphan-fresh.bin'))).toBe(true);
    expect(rig.integration.historyImage('recent')?.toString()).toBe('picture');
    expect(rig.integration.historyImage('old-with-picture')).toBeNull();
    await online(rig);
    expect(rig.door('haustuer')?.lastRingAt).toBe(now - 2 * HOUR);
  });

  it('returns no picture when the stored file is damaged', async () => {
    const sim = await startSim();
    const rig = startHub([sim]);
    await listening(rig);
    sim.ring();
    await waitFor(() => rig.integration.history('haustuer', {}).events[0]?.hasImage === true, 5000, 'picture');
    const eventId = rig.integration.history('haustuer', {}).events[0]!.id;
    const file = join(rig.dataDir, 'history', 'haustuer', `${eventId}.bin`);
    const bytes = readFileSync(file);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    writeFileSync(file, bytes);
    expect(rig.integration.historyImage(eventId)).toBeNull();
  });
});

describe('door opener, light and snapshot', () => {
  it('opens a door, records who did it and refuses an accidental double tap', async () => {
    const sim = await startSim({ relays: ['1', '2', 'ghchdi@1'] });
    const rig = startHub([sim], { devices: [{ relayNames: { '1': 'Haustür', 'ghchdi@1': 'Garagentor' }, hiddenRelays: ['2'] }] });
    await online(rig);

    const before = Date.now();
    await rig.integration.openDoor('haustuer', '1', ANNA);
    expect(sim.opened).toHaveLength(1);
    expect(sim.opened[0]).toMatchObject({ relay: '1' });
    expect(requestsTo(sim, 'open-door.cgi').filter((request) => request.status === 200).map((request) => request.path)).toEqual(['/bha-api/open-door.cgi?r=1']);

    const opened = rig.events.find((event) => event.type === 'door_opened');
    expect(opened).toMatchObject({ doorId: 'haustuer', doorName: 'Haustür', actor: 'Anna Berger', relay: 'Haustür' });
    expect(count(rig, 'history_updated')).toBeGreaterThanOrEqual(1);
    const events = rig.integration.history('haustuer', { type: 'open' }).events;
    expect(events).toMatchObject([{ doorId: 'haustuer', type: 'open', hasImage: false, actor: 'Anna Berger', detail: 'Haustür' }]);
    expect(events[0]!.ts).toBeGreaterThanOrEqual(before);
    expect(audit(rig)).toEqual([{ action: 'door.opened', user_id: 'u1', username: 'anna', ip: '192.168.1.50', detail: { door: 'Haustür', relay: 'Haustür' } }]);

    // A second tap right away is refused without bothering the device; another relay is not affected.
    const tooFast = await failure(rig.integration.openDoor('haustuer', '1', ANNA));
    expect(tooFast).toMatchObject({ statusCode: 429, code: 'too_fast' });
    expect(tooFast.retryAfter).toBeGreaterThanOrEqual(1);
    await rig.integration.openDoor('haustuer', 'ghchdi@1', ANNA);
    expect(sim.opened.map((entry) => entry.relay)).toEqual(['1', 'ghchdi@1']);
    // Relay ids of door controllers contain an "@": escaped on the wire.
    expect(requestsTo(sim, 'open-door.cgi').at(-1)?.path).toBe('/bha-api/open-door.cgi?r=ghchdi%401');
    await pause(320);
    await rig.integration.openDoor('haustuer', '1', ANNA);
    expect(sim.opened).toHaveLength(3);

    // Hidden and unknown relays, unknown doors: 404, nothing is sent, the attempt is on record.
    const sent = requestsTo(sim, 'open-door.cgi').length;
    expect(await failure(rig.integration.openDoor('haustuer', '2', ANNA))).toMatchObject({ statusCode: 404 });
    expect(await failure(rig.integration.openDoor('haustuer', '9', ANNA))).toMatchObject({ statusCode: 404 });
    expect(await failure(rig.integration.openDoor('kellertuer', '1', ANNA))).toMatchObject({ statusCode: 404 });
    expect(requestsTo(sim, 'open-door.cgi')).toHaveLength(sent);
    expect(audit(rig).slice(-3)).toEqual([
      { action: 'door.open_failed', user_id: 'u1', username: 'anna', ip: '192.168.1.50', detail: { door: 'Haustür', relay: '2', reason: 'unknown_relay' } },
      { action: 'door.open_failed', user_id: 'u1', username: 'anna', ip: '192.168.1.50', detail: { door: 'Haustür', relay: '9', reason: 'unknown_relay' } },
      { action: 'door.open_failed', user_id: 'u1', username: 'anna', ip: '192.168.1.50', detail: { door: 'kellertuer', relay: '1', reason: 'unknown_door' } },
    ]);
    expect(rig.integration.history('haustuer', { type: 'open' }).events).toHaveLength(3);
  });

  it.each(['returncode', 'http'] as const)('explains a missing permission on the device (%s 204) and allows a retry at once', async (denyStyle) => {
    const sim = await startSim({ denyStyle, permissions: { watchAlways: false } });
    const rig = startHub([sim]);
    await online(rig);

    const denied = await failure(rig.integration.openDoor('haustuer', '1', ANNA));
    expect(denied).toMatchObject({ statusCode: 503, code: 'device_permission' });
    expect(denied.message).toContain('Haustür');
    expect(denied.message).toContain('Berechtigung');
    expect(sim.opened).toEqual([]);
    expect(count(rig, 'door_opened')).toBe(0);
    expect(rig.integration.history('haustuer', {}).events).toEqual([]);
    expect(audit(rig)).toMatchObject([{ action: 'door.open_failed', username: 'anna', detail: { door: 'Haustür', relay: 'Türöffner', reason: 'permission' } }]);

    const light = await failure(rig.integration.light('haustuer'));
    expect(light).toMatchObject({ statusCode: 503, code: 'device_permission' });
    expect(light.message).toContain('Immer ansehen');
    expect(sim.lightOn).toBe(0);

    // The device said clearly that nothing happened: no double-tap guard in the way once the permission is there.
    sim.permissions.watchAlways = true;
    await rig.integration.openDoor('haustuer', '1', ANNA);
    expect(sim.opened).toHaveLength(1);
    await rig.integration.light('haustuer');
    expect(sim.lightOn).toBe(1);
    expect(requestsTo(sim, 'light-on.cgi').at(-1)).toMatchObject({ path: '/bha-api/light-on.cgi', status: 200 });
  });

  it('serves snapshots from a short cache and shares a request between simultaneous callers', async () => {
    const sim = await startSim();
    const rig = startHub([sim]);
    await online(rig);

    const pictures = await Promise.all(Array.from({ length: 6 }, () => rig.integration.snapshot('haustuer')));
    expect(pictures[0]!.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(pictures.every((picture) => picture.equals(pictures[0]!))).toBe(true);
    await rig.integration.snapshot('haustuer');
    expect(requestsTo(sim, 'image.cgi').filter((request) => request.status === 200)).toHaveLength(1);
    await pause(450);
    await rig.integration.snapshot('haustuer');
    expect(requestsTo(sim, 'image.cgi').filter((request) => request.status === 200)).toHaveLength(2);

    expect(await failure(rig.integration.snapshot('unbekannt'))).toMatchObject({ statusCode: 404 });
    expect(await failure(rig.integration.light('unbekannt'))).toMatchObject({ statusCode: 404 });
  });

  it('explains a snapshot refused with HTTP 204 and retries a busy device once', async () => {
    const sim = await startSim({ permissions: { watchAlways: false } });
    const rig = startHub([sim]);
    await online(rig);
    // Nothing else is talking to the device while its answers are counted below.
    await synced(rig);

    const refused = await failure(rig.integration.snapshot('haustuer'));
    expect(refused).toMatchObject({ statusCode: 503, code: 'device_permission' });
    expect(refused.message).toContain('Immer ansehen');
    // Several apps asking at once do not multiply the requests to a device that just refused.
    await failure(rig.integration.snapshot('haustuer'));
    expect(requestsTo(sim, 'image.cgi')).toHaveLength(1);
    // A missing permission is not an outage.
    expect(rig.door('haustuer')?.available).toBe(true);

    sim.permissions.watchAlways = true;
    await pause(120);
    sim.failNext(503);
    const picture = await rig.integration.snapshot('haustuer');
    expect(picture.length).toBeGreaterThan(100);
    expect(requestsTo(sim, 'image.cgi').map((request) => request.status)).toEqual([204, 503, 200]);

    // Busy twice in a row: give up with a clear message instead of retrying on and on.
    await pause(450);
    sim.failNext(503, 2);
    const busy = await failure(rig.integration.snapshot('haustuer'));
    expect(busy).toMatchObject({ statusCode: 503, code: 'device_busy' });
    expect(busy.message).toContain('beschäftigt');
  });
});

describe('when something is wrong', () => {
  it('reports a refused login clearly and leaves the device alone afterwards', async () => {
    const sim = await startSim();
    const rig = startHub([sim], { devices: [{ password: 'falsches-passwort' }] });
    await waitFor(() => serviceOf(rig).status === 'offline', 5000, 'offline');
    const message = serviceOf(rig).message ?? '';
    expect(message).toContain('Haustür');
    expect(message).toContain('Anmeldung abgelehnt');
    expect(message).toContain('API-Operator');
    expect(rig.door('haustuer')).toMatchObject({ available: false, name: 'Haustür' });
    expect(diagnosticsOf(rig).login).toBe('rejected');

    // A wrong password must not lock the owner's account: after the refusal nothing more is sent.
    // (The refusal itself: the answers to the Digest challenge, then one check with Basic.)
    const sent = sim.requests.length;
    expect(sim.stats.failedLogins).toBeLessThanOrEqual(3);
    expect(diagnosticsOf(rig).authentication).toBe('auto');
    await pause(400);
    rig.integration.setActive(true);
    const snapshot = await failure(rig.integration.snapshot('haustuer'));
    expect(snapshot).toMatchObject({ statusCode: 503, code: 'device_auth' });
    expect(snapshot.message).toContain('API-Operator');
    const open = await failure(rig.integration.openDoor('haustuer', '1', ANNA));
    expect(open).toMatchObject({ statusCode: 503, code: 'device_auth' });
    await pause(100);
    expect(sim.requests).toHaveLength(sent);
    expect(sim.stats.monitorOpened).toBe(0);
    expect(sim.opened).toEqual([]);
    expect(audit(rig)).toMatchObject([{ action: 'door.open_failed', detail: { door: 'Haustür', reason: 'login_refused' } }]);
    expect(JSON.stringify([message, snapshot.message, open.message, rig.integration.diagnostics()])).not.toContain('falsches-passwort');
    expect(rig.logs.join('\n')).not.toContain('falsches-passwort');
  });

  it('does not repeat a request the device refused with 401 while the login itself works', async () => {
    const sim = await startSim();
    const rig = startHub([sim]);
    await online(rig);
    await synced(rig);
    const infos = requestsTo(sim, 'info.cgi').length;

    sim.failNext(401);
    const refused = await failure(rig.integration.snapshot('haustuer'));
    expect(refused).toMatchObject({ statusCode: 503, code: 'device_permission' });
    expect(refused.message).toContain('Berechtigungen');
    // Whether the password still works is settled with exactly one info.cgi …
    await waitFor(() => requestsTo(sim, 'info.cgi').length === infos + 1 && diagnosticsOf(rig).login === 'verified', 5000, 'login check');
    // … and the refused function is left alone for a while, whoever asks.
    await pause(150);
    const images = requestsTo(sim, 'image.cgi').length;
    expect((await failure(rig.integration.snapshot('haustuer'))).statusCode).toBe(503);
    expect(requestsTo(sim, 'image.cgi')).toHaveLength(images);
    expect(requestsTo(sim, 'info.cgi')).toHaveLength(infos + 1);
    // Everything else keeps working.
    await rig.integration.openDoor('haustuer', '1', ANNA);
    expect(sim.opened).toHaveLength(1);
    expect(rig.door('haustuer')?.available).toBe(true);
    expect(serviceOf(rig).status).toBe('ok');
  });

  it('treats a user without the "API-Operator" permission like a refused login', async () => {
    const sim = await startSim({ permissions: { apiOperator: false } });
    const rig = startHub([sim]);
    await waitFor(() => serviceOf(rig).status === 'offline', 5000, 'offline');
    expect(serviceOf(rig).message).toContain('API-Operator');
    const sent = sim.requests.length;
    await pause(300);
    expect(sim.requests).toHaveLength(sent);
  });

  it('recognises a locked account (HTTP 423) and waits', async () => {
    const sim = await startSim({ lockAfterFailures: 1 });
    const rig = startHub([sim], { devices: [{ password: 'falsches-passwort' }] });
    await waitFor(() => diagnosticsOf(rig).login === 'locked', 5000, 'locked');
    expect(serviceOf(rig)).toMatchObject({ status: 'offline' });
    expect(serviceOf(rig).message).toContain('gesperrt');
    const sent = sim.requests.length;
    await pause(300);
    expect(sim.requests).toHaveLength(sent);
    expect(sim.stats.failedLogins).toBe(1);
  });

  it('shows an unreachable door station as unavailable and recovers when it returns', async () => {
    const sim = await startSim();
    await sim.setOffline(true);
    const rig = startHub([sim]);
    await waitFor(() => serviceOf(rig).status === 'offline', 5000, 'offline');
    expect(serviceOf(rig).message).toBe('Haustür ist nicht erreichbar.');
    // The door stays in the app, greyed out.
    expect(rig.door('haustuer')).toMatchObject({ available: false, name: 'Haustür' });
    const unreachable = await failure(rig.integration.openDoor('haustuer', '1', ANNA));
    expect(unreachable.statusCode).toBe(503);
    expect(unreachable.message).toContain('nicht erreichbar');
    expect(diagnosticsOf(rig).reachable).toBe(false);

    await sim.setOffline(false);
    await online(rig);
    await waitFor(() => serviceOf(rig).status === 'ok', 5000, 'ok again');
    expect(serviceOf(rig).message).toBeNull();
    await listening(rig);
    sim.ring();
    await waitFor(() => count(rig, 'doorbell') === 1, 5000, 'ring after recovery');
  });

  it('keeps one door station working while the other is down, and notices an outage while running', async () => {
    const front = await startSim({ name: 'Haustür' });
    const side = await startSim({ name: 'Seiteneingang', relays: ['1'] });
    const rig = startHub([front, side]);
    await listening(rig, 0);
    await listening(rig, 1);
    await waitFor(() => serviceOf(rig).status === 'ok', 5000, 'ok');

    await side.setOffline(true);
    await waitFor(() => serviceOf(rig).status === 'degraded', 5000, 'degraded');
    expect(serviceOf(rig).message).toBe('Seiteneingang ist nicht erreichbar.');
    expect(rig.door('seite')).toMatchObject({ available: false, model: 'DoorBird D2101V', relays: [{ id: '1', name: 'Türöffner' }] });
    expect(rig.door('haustuer')?.available).toBe(true);
    const down = await failure(rig.integration.snapshot('seite'));
    expect(down.statusCode).toBe(503);
    expect(down.message).toContain('Seiteneingang');

    // The front door is not affected at all.
    front.ring();
    await waitFor(() => rig.events.some((event) => event.type === 'doorbell' && event.doorId === 'haustuer'), 5000, 'front door ring');
    await rig.integration.openDoor('haustuer', '1', ANNA);
    expect(front.opened).toHaveLength(1);

    await front.setOffline(true);
    await waitFor(() => serviceOf(rig).status === 'offline', 5000, 'offline');
    expect(serviceOf(rig).message).toContain('Haustür ist nicht erreichbar.');
    expect(serviceOf(rig).message).toContain('Seiteneingang ist nicht erreichbar.');

    await Promise.all([front.setOffline(false), side.setOffline(false)]);
    await waitFor(() => serviceOf(rig).status === 'ok', 5000, 'ok again');
    await listening(rig, 1);
    side.ring();
    await waitFor(() => rig.events.some((event) => event.type === 'doorbell' && event.doorId === 'seite'), 5000, 'side door ring');
  });

  it('stops completely: no stream, no timer, no further request', async () => {
    const sim = await startSim();
    const rig = startHub([sim]);
    await listening(rig);
    sim.ring();
    await waitFor(() => count(rig, 'doorbell') === 1, 5000, 'ring');

    await rig.integration.stop();
    await waitFor(() => sim.monitorStreams === 0, 5000, 'stream closed');
    const sent = sim.requests.length;
    const published = rig.events.length;
    sim.ring();
    await pause(300);
    expect(sim.requests).toHaveLength(sent);
    expect(rig.events).toHaveLength(published);
    expect((await failure(rig.integration.snapshot('haustuer'))).statusCode).toBe(503);
    expect((await failure(rig.integration.openDoor('haustuer', '1', ANNA))).statusCode).toBe(503);
    expect(sim.opened).toEqual([]);
    await rig.integration.stop();
  });

  it('stops promptly while a device does not answer at all', async () => {
    const sockets = new Set<net.Socket>();
    const blackHole = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => blackHole.listen(0, '127.0.0.1', resolve));
    const port = (blackHole.address() as net.AddressInfo).port;
    try {
      const rig = startHub([], {
        extraDevices: [{ id: 'haustuer', name: 'Haustür', host: `127.0.0.1:${port}`, username: 'ghtest0001', password: 'egal', room: '', relayNames: {}, hiddenRelays: [] }],
        timings: { requestTimeoutMs: 10_000 },
      });
      await waitFor(() => sockets.size > 0, 5000, 'connection');
      const startedAt = Date.now();
      await rig.integration.stop();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => blackHole.close(() => resolve()));
    }
  });
});

describe('connection test', () => {
  it('reports model, firmware, relays and the permissions that matter', async () => {
    const sim = await startSim({ model: 'DoorBird D2101V', relays: ['1', '2'] });
    const result = await DoorBirdIntegration.test(sim.settings({ id: 'neu', name: 'Neu' }), FAST);
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Verbunden mit DoorBird D2101V.');
    expect(result.details).toEqual(['Modell: DoorBird D2101V', 'Firmware: 000125 (Build 15870439)', 'Relais: 1, 2', '✓ Live-Bild und Türöffner: erlaubt', '✓ Verlauf: erlaubt']);
    // The test neither opens a door nor leaves a stream behind.
    expect(sim.opened).toEqual([]);
    expect(sim.monitorStreams).toBe(0);
  });

  it('names the permissions to switch on in the DoorBird app', async () => {
    const sim = await startSim({ permissions: { watchAlways: false, history: false } });
    const result = await DoorBirdIntegration.test(sim.settings({ id: 'neu', name: 'Neu' }), FAST);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('noch nicht alles');
    expect(result.details.filter((line) => line.startsWith('✗'))).toHaveLength(2);
    expect(result.details.find((line) => line.includes('Live-Bild'))).toContain('„Immer ansehen“');
    expect(result.details.find((line) => line.includes('Verlauf'))).toContain('„Verlauf“');
  });

  it('explains wrong credentials, an unreachable device and a bad address without ever throwing', async () => {
    const sim = await startSim();
    const wrong = await DoorBirdIntegration.test(sim.settings({ id: 'neu', name: 'Neu', password: 'falsches-passwort' }));
    expect(wrong.ok).toBe(false);
    expect(wrong.message).toContain('Benutzername und Passwort');
    expect(wrong.message).toContain('API-Operator');
    expect(sim.stats.failedLogins).toBeLessThanOrEqual(3);
    expect(requestsTo(sim, 'image.cgi')).toEqual([]);

    await sim.setOffline(true);
    const unreachable = await DoorBirdIntegration.test(sim.settings({ id: 'neu', name: 'Neu' }));
    expect(unreachable.ok).toBe(false);
    expect(unreachable.message).toContain('nicht erreichbar');

    const settings = sim.settings({ id: 'neu', name: 'Neu' });
    expect(await DoorBirdIntegration.test({ ...settings, host: 'tuer.lan:99999' })).toMatchObject({ ok: false, message: 'Die Adresse der Türstation ist ungültig.' });
    expect(await DoorBirdIntegration.test({ ...settings, host: '  ' })).toMatchObject({ ok: false });
    expect(await DoorBirdIntegration.test({ ...settings, password: '' })).toMatchObject({ ok: false });
    for (const result of [wrong, unreachable]) {
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
      expect(JSON.stringify(result)).not.toContain('falsches-passwort');
    }
  });
});

describe('video streams', () => {
  it('declares a main and a talk stream per door with credentials go2rtc can digest', async () => {
    const sim = await startSim();
    const rig = startHub([sim]);
    const specs = rig.integration.streams();
    expect(specs.map((spec) => spec.name)).toEqual(['door_haustuer_main', 'door_haustuer_talk']);
    const user = sim.username;
    const escaped = 'S3cr3t%26Pass%2342%20%25x';
    expect(specs[0]!.sources).toEqual([
      `rtsp://${user}:${escaped}@127.0.0.1:554/mpeg/media.amp#backchannel=0`,
      `rtsp://${user}:${escaped}@127.0.0.1:8557/mpeg/media.amp#backchannel=0`,
      `doorbird://${user}:${escaped}@${sim.address}?media=audio`,
    ]);
    expect(specs[1]!.sources).toEqual([`doorbird://${user}:S3cr3t%2526Pass%252342%2520%2525x@${sim.address}`]);

    // go2rtc decodes the user info once and pastes it unescaped into
    // "audio-transmit.cgi?http-user=…&http-password=…" (pkg/doorbird/backchannel.go).
    // What arrives at the device must be the real password.
    const talk = /^doorbird:\/\/([^:]+):([^@]+)@(.+)$/.exec(specs[1]!.sources[0]!)!;
    const query = `http-user=${decodeURIComponent(talk[1]!)}&http-password=${decodeURIComponent(talk[2]!)}`;
    const response = await fetch(`http://${talk[3]}/bha-api/info.cgi?${query}`);
    expect(response.status).toBe(200);
    // The same password pasted without the second escaping would not even be a valid query string.
    const naive = await fetch(`http://${sim.address}/bha-api/info.cgi?http-user=${user}&http-password=${PASSWORD}`);
    expect(naive.status).toBe(401);
    expect(sim.requests.filter((request) => request.auth === 'query').map((request) => request.status)).toEqual([200, 401]);
  });

  it('keeps the HTTP port out of the RTSP sources', () => {
    const sources = streamSources({ host: ' tuer.lan:8080 ', username: 'ghabcd0001', password: 'geheim' });
    expect(sources.main).toEqual([
      'rtsp://ghabcd0001:geheim@tuer.lan:554/mpeg/media.amp#backchannel=0',
      'rtsp://ghabcd0001:geheim@tuer.lan:8557/mpeg/media.amp#backchannel=0',
      'doorbird://ghabcd0001:geheim@tuer.lan:8080?media=audio',
    ]);
    expect(sources.talk).toEqual(['doorbird://ghabcd0001:geheim@tuer.lan:8080']);
  });
});

describe('protocol details', () => {
  it('parses info.cgi of current and old firmware', () => {
    // Structure of doorbirdpy's fixture (D2101V with two paired door controllers).
    const current = {
      BHA: {
        RETURNCODE: '1',
        VERSION: [
          {
            FIRMWARE: '000125',
            BUILD_NUMBER: '15870439',
            WIFI_MAC_ADDR: '1CCAE3000001',
            RELAYS: ['1', '2', 'gggaaa@1', 'gggaaa@2', 'gggaaa@3', 'hhhbbb@1'],
            'DEVICE-TYPE': 'DoorBird D2101V',
          },
        ],
      },
    };
    expect(parseInfo(JSON.stringify(current))).toEqual({
      model: 'DoorBird D2101V',
      firmware: '000125',
      build: '15870439',
      relays: ['1', '2', 'gggaaa@1', 'gggaaa@2', 'gggaaa@3', 'hhhbbb@1'],
    });
    // Before firmware 000108: no RELAYS, no DEVICE-TYPE. With a byte order mark, unknown fields and a wired MAC.
    const old = '﻿{"BHA":{"RETURNCODE":"1","VERSION":[{"FIRMWARE":"000099","BUILD_NUMBER":"96","PRIMARY_MAC_ADDR":"1CCAE3000002","SOMETHING_NEW":{"A":1}}]}}';
    expect(parseInfo(Buffer.from(old))).toEqual({ model: null, firmware: '000099', build: '96', relays: ['1'] });
    // Numbers instead of strings, empty and duplicate entries.
    const odd = { BHA: { RETURNCODE: 1, VERSION: [{ FIRMWARE: 125, BUILD_NUMBER: '', RELAYS: [1, '2', '', '2', null, 'no spaces allowed'], 'DEVICE-TYPE': '  ' }] } };
    expect(parseInfo(JSON.stringify(odd))).toEqual({ model: null, firmware: '125', build: null, relays: ['1', '2'] });

    expect(() => parseInfo('<html>Login</html>')).toThrow();
    expect(() => parseInfo('{"BHA":{"RETURNCODE":"0"}}')).toThrow();
    expect(() => parseInfo('{"something":"else"}')).toThrow();
  });

  it('names relays and hides the ones that must not be offered', () => {
    const relays = visibleRelays(['1', '2', 'gggaaa@1', 'constructor'], { relayNames: { '2': ' Gartentor ', 'gggaaa@1': '' }, hiddenRelays: ['constructor'] });
    expect(relays).toEqual([
      { id: '1', name: 'Türöffner' },
      { id: '2', name: 'Gartentor' },
      { id: 'gggaaa@1', name: 'Relais gggaaa@1' },
    ]);
    expect(visibleRelays(['2', 'constructor'], { relayNames: {}, hiddenRelays: [] })).toEqual([
      { id: '2', name: 'Relais 2' },
      { id: 'constructor', name: 'Relais constructor' },
    ]);
  });

  it('reads the event stream as the device writes it, however it is cut into packets', () => {
    // Byte for byte what nymea's plugin documents.
    const wire = '--ioboundary\r\nContent-Type: text/plain\r\n\r\ndoorbell:H\r\n\r\n--ioboundary\r\nContent-Type: text/plain\r\n\r\nmotionsensor:L\r\n\r\n';
    const expected = [
      { signal: 'doorbell', high: true },
      { signal: 'motionsensor', high: false },
    ];
    expect(new MonitorParser().push(Buffer.from(wire))).toEqual(expected);

    for (const size of [1, 2, 3, 7, 16, 41]) {
      const parser = new MonitorParser();
      const reports: MonitorReport[] = [];
      for (let offset = 0; offset < wire.length; offset += size) reports.push(...parser.push(Buffer.from(wire.slice(offset, offset + size))));
      // A level may be reported twice (once before its line end arrived), never a wrong or a missing one.
      const distinct = reports.filter((report, index) => index === 0 || JSON.stringify(report) !== JSON.stringify(reports[index - 1]));
      expect(distinct).toEqual(expected);
    }

    // Variants: a strictly MIME-conformant delimiter, bare line feeds, other headers, upper case, junk in between.
    const strict = '----ioboundary\nContent-Type: text/plain; charset=utf-8\nContent-Length: 12\n\nDoorBell:h\n\n----ioboundary\n\nrubbish line\nmotionsensor : H\n';
    expect(new MonitorParser().push(strict)).toEqual([
      { signal: 'doorbell', high: true },
      { signal: 'motionsensor', high: true },
    ]);
    expect(new MonitorParser().push('doorbell:HIGH\r\nkeypad:H\r\ndoorbell=1\r\n')).toEqual([]);

    // Endless garbage without a line end does not pile up.
    const parser = new MonitorParser();
    for (let i = 0; i < 200; i++) expect(parser.push('x'.repeat(1000))).toEqual([]);
    expect(parser.push('\r\ndoorbell:L\r\n')).toEqual([{ signal: 'doorbell', high: false }]);
  });

  it('turns levels into events only on a change from L to H', () => {
    const edges = new EdgeDetector(5_000);
    const ring = { signal: 'doorbell', high: true } as const;
    const idle = { signal: 'doorbell', high: false } as const;
    const motion = { signal: 'motionsensor', high: true } as const;

    edges.connected(1_000_000);
    // The state right after connecting says nothing about what happened before.
    expect(edges.report(ring, 1_000_100)).toBe(false);
    // Heartbeats repeat the level.
    expect(edges.report(ring, 1_020_000)).toBe(false);
    expect(edges.report(idle, 1_021_000)).toBe(false);
    expect(edges.report(ring, 1_022_000)).toBe(true);
    expect(edges.report(ring, 1_042_000)).toBe(false);
    // The signals are independent; a first "H" long after connecting is news.
    expect(edges.report(motion, 1_042_000)).toBe(true);

    edges.connected(2_000_000);
    expect(edges.report(ring, 2_004_999)).toBe(false);
    edges.connected(3_000_000);
    expect(edges.report(idle, 3_000_010)).toBe(false);
    expect(edges.report(ring, 3_000_020)).toBe(true);
  });

  it('accepts X-Timestamp only when it is a believable time', () => {
    const now = Date.UTC(2026, 10, 11, 12, 0, 0);
    expect(parseTimestampHeader('1762862400', now)).toBe(1_762_862_400_000);
    expect(parseTimestampHeader([' 1762862400 '], now)).toBe(1_762_862_400_000);
    expect(parseTimestampHeader('1762862400123', now)).toBe(1_762_862_400_123);
    // No clock set (1970 / 2000), far in the future, or not a number at all.
    expect(parseTimestampHeader('0', now)).toBeNull();
    expect(parseTimestampHeader('946684800', now)).toBeNull();
    expect(parseTimestampHeader('4102444800', now)).toBeNull();
    expect(parseTimestampHeader('yesterday', now)).toBeNull();
    expect(parseTimestampHeader(undefined, now)).toBeNull();
  });
});

describe('simulator', () => {
  it('offers the demo household', async () => {
    expect(DOORBIRD_DEMO_STATIONS.map((station) => [station.device.name, station.sim.model, station.sim.relays])).toEqual([
      ['Haustür', 'DoorBird D2101V', ['1', '2']],
      ['Seiteneingang', 'DoorBird D1101V', ['1']],
    ]);
    const sim = await startDoorBirdSim(DOORBIRD_DEMO_STATIONS[1]!.sim);
    strays.push(sim);
    // Unauthenticated requests are challenged; history comes pre-filled and newest first.
    const challenge = await fetch(`http://${sim.address}/bha-api/info.cgi`);
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toMatch(/^Digest realm="DoorBird", nonce="[0-9a-f]+", qop="auth", Basic realm="DoorBird"$/);
    expect(sim.history.doorbell.length).toBeGreaterThan(0);
    expect(sim.history.motionsensor.length).toBeGreaterThan(0);
    expect(sim.history.doorbell.map((entry) => entry.at)).toEqual([...sim.history.doorbell.map((entry) => entry.at)].sort((a, b) => b - a));

    const login = `http-user=${sim.username}&http-password=${sim.password}`;
    const info = (await (await fetch(`http://${sim.address}/bha-api/info.cgi?${login}`)).json()) as { BHA: { RETURNCODE: string; VERSION: Record<string, unknown>[] } };
    expect(info.BHA.RETURNCODE).toBe('1');
    expect(info.BHA.VERSION[0]).toMatchObject({ FIRMWARE: '000125', RELAYS: ['1'], 'DEVICE-TYPE': 'DoorBird D1101V' });
    const picture = await fetch(`http://${sim.address}/bha-api/history.cgi?index=1&event=doorbell&${login}`);
    expect(picture.status).toBe(200);
    expect(picture.headers.get('x-timestamp')).toBe(String(Math.floor(sim.history.doorbell[0]!.at / 1000)));
    expect((await fetch(`http://${sim.address}/bha-api/history.cgi?index=50&event=doorbell&${login}`)).status).toBe(404);
    expect(await (await fetch(`http://${sim.address}/bha-api/monitor.cgi?check=doorbell&${login}`)).text()).toBe('doorbell=0\r\n');
  });

  it('takes intercom audio the way go2rtc sends it and serves the listening stream', async () => {
    const sim = await startSim();
    const login = `http-user=${sim.username}&http-password=${encodeURIComponent(sim.password)}`;
    // Request head as go2rtc 1.9.15 writes it (pkg/doorbird/backchannel.go): HTTP/1.0, a huge length, then raw µ-law.
    const socket = net.connect(sim.port, sim.host);
    socket.on('error', () => {});
    socket.write(
      `POST /bha-api/audio-transmit.cgi?${login} HTTP/1.0\r\nContent-Type: audio/basic\r\nContent-Length: 9999999\r\nConnection: Keep-Alive\r\nCache-Control: no-cache\r\n\r\n`,
    );
    socket.write(Buffer.alloc(800, 0xff));
    await waitFor(() => sim.stats.audioBytes === 800 && sim.talking, 5000, 'audio received');
    // A second talker is turned away while the first one is on.
    expect((await fetch(`http://${sim.address}/bha-api/audio-transmit.cgi?${login}`, { method: 'POST', body: 'x' })).status).toBe(503);
    socket.destroy();
    await waitFor(() => !sim.talking, 5000, 'talker gone');

    const listen = await fetch(`http://${sim.address}/bha-api/audio-receive.cgi?${login}`);
    expect(listen.status).toBe(200);
    expect(listen.headers.get('content-type')).toBe('audio/basic');
    const reader = listen.body!.getReader();
    const { value } = await reader.read();
    expect(value && value.length > 0 && value.every((byte: number) => byte === 0xff)).toBe(true);
    await reader.cancel();
  });
});
