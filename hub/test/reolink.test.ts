import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CameraEntity, ReolinkDeviceSettings } from '@home-hub/shared';
import { HttpError } from '../src/http/errors.ts';
import { ReolinkIntegration, type ReolinkTiming } from '../src/integrations/reolink.ts';
import { startReolinkSim, type ReolinkSim, type ReolinkSimOptions } from '../src/sim/reolink-sim.ts';
import { createTestDeps, waitFor, type TestDeps } from './deps.ts';

const FAST: Partial<ReolinkTiming> = { activeMs: 60, idleMs: 60, lightMs: 60, requestTimeoutMs: 1500, blockMs: 60_000, ptzHoldMs: 150, snapshotCacheMs: 250, presetCacheMs: 250 };

let env: TestDeps;
let sims: ReolinkSim[] = [];
let reolink: ReolinkIntegration | null = null;

async function sim(options: ReolinkSimOptions = {}): Promise<ReolinkSim> {
  const started = await startReolinkSim(options);
  sims.push(started);
  return started;
}

function start(devices: ReolinkDeviceSettings[], timing: Partial<ReolinkTiming> = {}): ReolinkIntegration {
  reolink = new ReolinkIntegration(env.deps, { enabled: true, devices }, { timing: { ...FAST, ...timing } });
  reolink.start();
  reolink.setActive(true);
  return reolink;
}

const camera = (id: string): CameraEntity | undefined => env.state.get(`cam:${id}`) as CameraEntity | undefined;
const health = () => env.state.allServices().find((service) => service.id === 'reolink');
const online = (id: string) => waitFor(() => (camera(id)?.available ? camera(id) : null), 4000, `camera ${id} online`);
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
});

afterEach(async () => {
  await reolink?.stop();
  reolink = null;
  await Promise.all(sims.map((entry) => entry.close()));
  // No credential may ever reach the log or the diagnostics.
  for (const entry of sims) {
    for (const line of env.logs) expect(line).not.toContain(entry.password);
  }
  sims = [];
  env.cleanup();
});

describe('cameras as entities', () => {
  it('shows a camera at once (greyed out) and fills in what it can do', async () => {
    const garden = await sim({ name: 'Garten', profile: 'ptz' });
    start([garden.settings({ id: 'garten', name: 'Garten', room: 'Außen' })]);
    expect(camera('garten')).toMatchObject({ kind: 'camera', name: 'Garten', room: 'Außen', available: false, service: 'reolink' });
    const entity = await online('garten');
    expect(entity).toMatchObject({
      model: 'RLC-823A',
      features: { ptz: true, zoom: false, presets: true, talk: false, audio: true, light: true, siren: true },
      lightOn: false,
    });
    expect(health()?.status).toBe('ok');
  });

  it('reads the abilities of different models', async () => {
    const fixed = await sim({ name: 'Einfahrt', profile: 'fixed4k' });
    const talk = await sim({ name: 'Terrasse', profile: 'talk' });
    start([fixed.settings({ id: 'einfahrt', name: 'Einfahrt' }), talk.settings({ id: 'terrasse', name: 'Terrasse' })]);
    expect((await online('einfahrt')).features).toEqual({ ptz: false, zoom: false, presets: false, talk: false, audio: true, light: false, siren: false });
    expect((await online('einfahrt')).lightOn).toBeNull();
    expect((await online('einfahrt')).room).toBeNull();
    expect((await online('terrasse')).features).toEqual({ ptz: false, zoom: true, presets: false, talk: true, audio: true, light: true, siren: true });
  });

  it('uses one session per camera and gives it back when the hub stops', async () => {
    const garden = await sim({ profile: 'ptz' });
    const integration = start([garden.settings({ id: 'garten', name: 'Garten' })]);
    await online('garten');
    await integration.snapshot('garten');
    await integration.presets('garten');
    await integration.setLight('garten', true);
    await sleep(200);
    expect(garden.stats.logins).toBe(1);
    expect(garden.sessions).toBe(1);
    await integration.stop();
    reolink = null;
    expect(garden.sessions).toBe(0);
    expect(garden.stats.logouts).toBe(1);
  });

  it('renews its token before the lease ends without piling up sessions', async () => {
    const garden = await sim({ profile: 'fixed4k', leaseTime: 60 });
    // "Renew 59.7 s before the end" of a 60 s lease = renew after about 300 ms.
    start([garden.settings({ id: 'garten', name: 'Garten' })], { renewBeforeMs: 59_700 });
    await online('garten');
    await waitFor(() => garden.stats.logins >= 3, 4000, 'token renewals');
    await waitFor(() => garden.sessions === 1, 2000, 'old sessions logged out');
    expect(camera('garten')?.available).toBe(true);
  });

  it('logs in again when the camera forgot the token (reboot)', async () => {
    const garden = await sim({ profile: 'ptz' });
    const integration = start([garden.settings({ id: 'garten', name: 'Garten' })]);
    await online('garten');
    garden.expireTokens();
    await integration.setLight('garten', true);
    expect(garden.light.state).toBe(1);
    expect(camera('garten')?.available).toBe(true);
    expect(garden.stats.logins).toBe(2);
  });

  it('marks an unreachable camera after two failures and recovers', async () => {
    const garden = await sim({ profile: 'ptz' });
    const drive = await sim({ profile: 'fixed4k' });
    const integration = start([garden.settings({ id: 'garten', name: 'Garten' }), drive.settings({ id: 'einfahrt', name: 'Einfahrt' })]);
    await online('garten');
    await online('einfahrt');
    await garden.setOffline(true);
    await waitFor(() => camera('garten')?.available === false, 6000, 'garten unavailable');
    // The camera stays in the list, and the other one is not affected.
    expect(camera('garten')?.name).toBe('Garten');
    expect(camera('einfahrt')?.available).toBe(true);
    expect(health()).toMatchObject({ status: 'degraded', message: expect.stringContaining('Garten') });
    expect((await failure(integration.snapshot('garten'))).statusCode).toBe(503);
    await garden.setOffline(false);
    await waitFor(() => camera('garten')?.available === true, 15_000, 'garten back');
    expect(health()?.status).toBe('ok');
  }, 25_000);

  it('does not hammer a camera that refuses the login', async () => {
    const garden = await sim({ profile: 'ptz' });
    start([{ ...garden.settings({ id: 'garten', name: 'Garten' }), password: 'falsch' }]);
    await waitFor(() => health()?.status === 'offline', 4000, 'offline');
    expect(health()?.message).toMatch(/Garten: Benutzername oder Passwort stimmen nicht/);
    expect(camera('garten')?.available).toBe(false);
    await sleep(500);
    // One refused login, then silence for the pause (5 minutes in production).
    expect(garden.stats.failedLogins).toBe(1);
    expect(JSON.stringify(reolink!.diagnostics())).not.toContain('falsch');
  });

  it('tries again after the pause', async () => {
    const garden = await sim({ profile: 'ptz' });
    start([{ ...garden.settings({ id: 'garten', name: 'Garten' }), password: 'falsch' }], { blockMs: 300 });
    await waitFor(() => garden.stats.failedLogins >= 1, 3000, 'first refusal');
    garden.setCredentials(garden.username, 'falsch');
    await online('garten');
    expect(health()?.status).toBe('ok');
  });

  it('shows a recorder channel without a camera as unavailable', async () => {
    const nvr = await sim({ profile: 'fixed4k', nvr: { channels: [{ name: 'Hof', online: true }, { name: '', online: false }] } });
    start([nvr.settings({ id: 'hof', name: 'Hof', channel: 0 }), nvr.settings({ id: 'leer', name: 'Carport', channel: 1 })]);
    await online('hof');
    await waitFor(() => health()?.status === 'degraded', 4000, 'degraded');
    expect(camera('leer')?.available).toBe(false);
    expect(health()?.message).toMatch(/Carport: Die Kamera ist am Rekorder nicht angemeldet/);
    nvr.setChannelOnline(1, true);
    await online('leer');
    expect(health()?.status).toBe('ok');
  });

  it('reports "no camera entered" instead of pretending to be fine', () => {
    start([]);
    expect(health()).toMatchObject({ status: 'unconfigured' });
  });
});

describe('pictures', () => {
  it('delivers a snapshot and does not ask the camera twice within a second', async () => {
    const garden = await sim({ profile: 'ptz' });
    const integration = start([garden.settings({ id: 'garten', name: 'Garten' })]);
    await online('garten');
    const [first, second] = await Promise.all([integration.snapshot('garten'), integration.snapshot('garten')]);
    expect(first.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(second).toBe(first);
    await integration.snapshot('garten');
    expect(garden.stats.snaps).toBe(1);
    await sleep(300);
    await integration.snapshot('garten');
    expect(garden.stats.snaps).toBe(2);
  });

  it('gets a new token when the snapshot is refused for the old one', async () => {
    const garden = await sim({ profile: 'ptz' });
    const integration = start([garden.settings({ id: 'garten', name: 'Garten' })], { activeMs: 60_000, lightMs: 60_000 });
    await online('garten');
    garden.expireTokens();
    expect((await integration.snapshot('garten')).length).toBeGreaterThan(1000);
  });

  it('answers 404 for a camera it does not know', async () => {
    const integration = start([]);
    expect((await failure(integration.snapshot('nirgends'))).statusCode).toBe(404);
    expect((await failure(integration.ptz('nirgends', 'left'))).statusCode).toBe(404);
  });
});

describe('moving the camera', () => {
  it('starts a movement once, keeps it alive while the button is held and stops by itself', async () => {
    const garden = await sim({ profile: 'ptz' });
    const integration = start([garden.settings({ id: 'garten', name: 'Garten' })]);
    await online('garten');
    await integration.ptz('garten', 'right', 40);
    for (let i = 0; i < 4; i++) {
      await sleep(60);
      await integration.ptz('garten', 'right', 40);
    }
    // Held for ~240 ms with a 150 ms dead-man switch: still exactly one command, still moving.
    expect(garden.ptzLog.map((entry) => entry.op)).toEqual(['Right']);
    expect(garden.ptzLog[0]).toMatchObject({ channel: 0, speed: 40 });
    expect(garden.moving).toBe(true);
    // The app goes quiet: the hub stops the camera.
    await waitFor(() => garden.ptzLog.at(-1)?.op === 'Stop', 2000, 'automatic stop');
    expect(garden.moving).toBe(false);
    expect(garden.pan).toBeGreaterThan(0);
  });

  it('switches direction immediately and stops on request', async () => {
    const garden = await sim({ profile: 'ptz' });
    const integration = start([garden.settings({ id: 'garten', name: 'Garten' })]);
    await online('garten');
    await integration.ptz('garten', 'left');
    await integration.ptz('garten', 'up');
    await integration.ptz('garten', 'stop');
    expect(garden.ptzLog.map((entry) => entry.op)).toEqual(['Left', 'Up', 'Stop']);
    expect(garden.ptzLog[0]?.speed).toBe(24);
    await sleep(300);
    // No second Stop from the dead-man switch.
    expect(garden.ptzLog).toHaveLength(3);
  });

  it('never leaves a camera turning when the hub stops', async () => {
    const garden = await sim({ profile: 'ptz' });
    const integration = start([garden.settings({ id: 'garten', name: 'Garten' })], { ptzHoldMs: 60_000 });
    await online('garten');
    await integration.ptz('garten', 'left');
    await integration.stop();
    reolink = null;
    expect(garden.ptzLog.at(-1)?.op).toBe('Stop');
  });

  it('refuses what the camera cannot do, in plain German', async () => {
    const fixed = await sim({ profile: 'fixed4k' });
    const zoomOnly = await sim({ profile: 'talk' });
    const integration = start([fixed.settings({ id: 'einfahrt', name: 'Einfahrt' }), zoomOnly.settings({ id: 'terrasse', name: 'Terrasse' })]);
    await online('einfahrt');
    await online('terrasse');
    const pan = await failure(integration.ptz('einfahrt', 'left'));
    expect(pan.statusCode).toBe(400);
    expect(pan.message).toMatch(/Einfahrt.*nicht schwenken/);
    expect((await failure(integration.ptz('einfahrt', 'zoom_in'))).message).toMatch(/keinen Zoom/);
    expect((await failure(integration.ptz('terrasse', 'up'))).statusCode).toBe(400);
    expect(fixed.ptzLog).toHaveLength(0);
    // A zoom lens takes no speed.
    await integration.ptz('terrasse', 'zoom_in', 50);
    expect(zoomOnly.ptzLog).toEqual([expect.objectContaining({ op: 'ZoomInc', speed: null })]);
    await integration.ptz('terrasse', 'stop');
    expect((await failure(integration.siren('einfahrt'))).statusCode).toBe(400);
    expect((await failure(integration.setLight('einfahrt', true))).statusCode).toBe(400);
    expect((await failure(integration.gotoPreset('einfahrt', 1))).statusCode).toBe(400);
    expect(await integration.presets('einfahrt')).toEqual([]);
  });

  it('lists the stored positions and moves to one', async () => {
    const garden = await sim({ profile: 'ptz' });
    const integration = start([garden.settings({ id: 'garten', name: 'Garten' })]);
    await online('garten');
    expect(await integration.presets('garten')).toEqual([
      { id: 1, name: 'Terrasse' },
      { id: 2, name: 'Rasen' },
      { id: 3, name: 'Tor' },
    ]);
    await integration.gotoPreset('garten', 3);
    expect(garden.ptzLog.at(-1)).toMatchObject({ op: 'ToPos', id: 3 });
    expect(garden.pan).toBeCloseTo(0.75);
  });
});

describe('light and siren', () => {
  it('switches the spotlight and leaves the camera\'s own settings alone', async () => {
    const garden = await sim({ profile: 'ptz' });
    const integration = start([garden.settings({ id: 'garten', name: 'Garten' })]);
    await online('garten');
    garden.light.bright = 42;
    garden.light.mode = 3;
    await integration.setLight('garten', true);
    expect(garden.light).toEqual({ state: 1, bright: 42, mode: 3 });
    expect(camera('garten')?.lightOn).toBe(true);
    await integration.setLight('garten', false);
    expect(garden.light.state).toBe(0);
    expect(camera('garten')?.lightOn).toBe(false);
  });

  it('notices when the light is switched somewhere else', async () => {
    const garden = await sim({ profile: 'ptz' });
    start([garden.settings({ id: 'garten', name: 'Garten' })]);
    await online('garten');
    garden.light.state = 1;
    await waitFor(() => camera('garten')?.lightOn === true, 3000, 'light state');
  });

  it('sounds the siren once', async () => {
    const garden = await sim({ profile: 'ptz' });
    const integration = start([garden.settings({ id: 'garten', name: 'Garten' })]);
    await online('garten');
    await integration.siren('garten');
    expect(garden.sirenCount).toBe(1);
  });

  it('passes on a refusal of the camera as an error, not as success', async () => {
    const garden = await sim({ profile: 'ptz' });
    const integration = start([garden.settings({ id: 'garten', name: 'Garten' })], { activeMs: 60_000, lightMs: 60_000 });
    await online('garten');
    garden.failNext(-1);
    const err = await failure(integration.siren('garten'));
    expect(err.statusCode).toBe(502);
    expect(garden.sirenCount).toBe(0);
  });
});

describe('video streams', () => {
  const device = (overrides: Partial<ReolinkDeviceSettings> = {}): ReolinkDeviceSettings => ({
    id: 'garten',
    name: 'Garten',
    host: '192.168.1.60',
    port: 0,
    https: true,
    username: 'hub user',
    password: "p@ss:w/ord?#1!'()*",
    channel: 0,
    room: '',
    rtspPort: 554,
    streamProtocol: 'rtsp',
    ...overrides,
  });
  const declare = (overrides: Partial<ReolinkDeviceSettings> = {}) => new ReolinkIntegration(env.deps, { enabled: true, devices: [device(overrides)] }).streams();

  it('declares viewing streams without back channel and a separate talk stream', () => {
    const streams = declare();
    const credentials = "hub%20user:p%40ss%3Aw%2Ford%3F%231%21%27%28%29%2A";
    expect(streams).toEqual([
      { name: 'cam_garten_main', sources: [`rtsp://${credentials}@192.168.1.60:554/Preview_01_main#backchannel=0`, 'ffmpeg:cam_garten_main#audio=opus'] },
      { name: 'cam_garten_sub', sources: [`rtsp://${credentials}@192.168.1.60:554/Preview_01_sub#backchannel=0`, 'ffmpeg:cam_garten_sub#audio=opus'] },
      // Bare URL: any "#…" would switch the back channel off.
      { name: 'cam_garten_talk', sources: [`rtsp://${credentials}@192.168.1.60:554/Preview_01_sub`] },
    ]);
    // The encoded credentials decode back to the originals.
    const parsed = new URL(streams[2]!.sources[0]!);
    expect(decodeURIComponent(parsed.username)).toBe('hub user');
    expect(decodeURIComponent(parsed.password)).toBe("p@ss:w/ord?#1!'()*");
  });

  it('numbers recorder channels from 01 and honours the RTSP port', () => {
    const streams = declare({ channel: 11, rtspPort: 8554, host: 'nvr.local:443' });
    expect(streams[0]!.sources[0]).toContain('@nvr.local:8554/Preview_12_main#backchannel=0');
  });

  it('builds FLV sources with the credentials as the camera expects them', () => {
    const https = declare({ streamProtocol: 'flv', password: 'a+b=c;d' });
    expect(https[0]!.sources).toEqual(['httpx://192.168.1.60/flv?port=1935&app=bcs&stream=channel0_main.bcs&user=hub%20user&password=a+b=c;d', 'ffmpeg:cam_garten_main#audio=opus']);
    const plain = declare({ streamProtocol: 'flv', https: false, port: 8080, channel: 2, username: 'hub', password: 'x' });
    expect(plain[1]!.sources[0]).toBe('http://192.168.1.60:8080/flv?port=1935&app=bcs&stream=channel2_sub.bcs&user=hub&password=x');
    // Talking always goes through RTSP.
    expect(plain[2]!.sources[0]).toMatch(/^rtsp:\/\//);
  });
});

describe('connection test', () => {
  it('describes the camera it found', async () => {
    const garden = await sim({ profile: 'ptz' });
    const result = await ReolinkIntegration.test(garden.settings({ id: 'garten', name: 'Garten' }));
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/RLC-823A gefunden \(Firmware v3\.1\.0/);
    expect(result.details.join('\n')).toMatch(/Schwenken\/Neigen/);
    expect(result.details.join('\n')).toMatch(/HD: H264, SD: H264/);
    // The test leaves no session behind.
    expect(garden.sessions).toBe(0);
  });

  it('warns about H.265', async () => {
    const drive = await sim({ profile: 'fixed4k' });
    const result = await ReolinkIntegration.test(drive.settings({ id: 'einfahrt', name: 'Einfahrt' }));
    expect(result.details.join('\n')).toMatch(/H\.265 kann nicht jeder Browser/);
  });

  it('says so when the password is wrong, with a single attempt', async () => {
    const garden = await sim({ profile: 'ptz' });
    const result = await ReolinkIntegration.test({ ...garden.settings({ id: 'garten', name: 'Garten' }), password: 'falsch-geheim' });
    expect(result).toMatchObject({ ok: false, message: 'Benutzername oder Passwort stimmen nicht.' });
    expect(garden.stats.failedLogins).toBe(1);
    expect(JSON.stringify(result)).not.toContain('falsch-geheim');
  });

  it('never throws when nothing answers', async () => {
    const garden = await sim({ profile: 'ptz' });
    const settings = garden.settings({ id: 'garten', name: 'Garten' });
    await garden.close();
    const result = await ReolinkIntegration.test(settings, { timing: { requestTimeoutMs: 800 } });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/nicht erreichbar/);
  });
});
