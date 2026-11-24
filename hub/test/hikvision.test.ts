import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CameraEntity, ReolinkDeviceSettings } from '@home-hub/shared';
import { HttpError } from '../src/http/errors.ts';
import { ReolinkIntegration, type ReolinkTiming } from '../src/integrations/reolink.ts';
import { hikRtspUrl, hikSpeed, hikStreamId, hikTalkUrl } from '../src/integrations/reolink/hikvision-camera.ts';
import { startHikvisionSim, type HikvisionSim, type HikvisionSimOptions } from '../src/sim/hikvision-sim.ts';
import { createTestDeps, waitFor, type TestDeps } from './deps.ts';

/** Hikvision cameras and recorders: ISAPI (Digest) for control, RTSP for video. */

const FAST: Partial<ReolinkTiming> = { activeMs: 60, idleMs: 60, requestTimeoutMs: 1500, blockMs: 300, ptzHoldMs: 150, snapshotCacheMs: 250, presetCacheMs: 250 };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

let env: TestDeps;
let sims: HikvisionSim[] = [];
let cameras: ReolinkIntegration | null = null;

async function sim(options: HikvisionSimOptions = {}): Promise<HikvisionSim> {
  const started = await startHikvisionSim({ rtsp: true, ...options });
  sims.push(started);
  return started;
}

function start(devices: ReolinkDeviceSettings[], timing: Partial<ReolinkTiming> = FAST): ReolinkIntegration {
  cameras = new ReolinkIntegration(env.deps, { enabled: true, devices }, { timing });
  cameras.start();
  cameras.setActive(true);
  return cameras;
}

const camera = (id: string): CameraEntity | undefined => env.state.get(`cam:${id}`) as CameraEntity | undefined;
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
  env.deps.streamSnapshot = async () => JPEG;
});

afterEach(async () => {
  await cameras?.stop();
  cameras = null;
  await Promise.all(sims.map((entry) => entry.close()));
  for (const entry of sims) {
    for (const line of env.logs) expect(line).not.toContain(entry.password);
  }
  sims = [];
  env.cleanup();
});

describe('building blocks', () => {
  const device = { channel: 0, host: '192.168.1.40', rtspPort: 554, username: 'hub', password: 'p@ss:w/rd', https: false, port: 0 } as ReolinkDeviceSettings;

  it('numbers streams like Hikvision: 101/102 for camera 1, 301/302 for D3 on a recorder', () => {
    expect(hikStreamId(device, 'main')).toBe('101');
    expect(hikStreamId(device, 'sub')).toBe('102');
    expect(hikStreamId({ channel: 2 }, 'main')).toBe('301');
  });

  it('builds RTSP and ISAPI back channel addresses with escaped credentials', () => {
    expect(hikRtspUrl(device, 'sub')).toBe('rtsp://hub:p%40ss%3Aw%2Frd@192.168.1.40:554/Streaming/Channels/102');
    expect(hikTalkUrl(device)).toBe('isapi://hub:p%40ss%3Aw%2Frd@192.168.1.40:80/');
    expect(hikTalkUrl({ ...device, port: 8080 })).toBe('isapi://hub:p%40ss%3Aw%2Frd@192.168.1.40:8080/');
    // go2rtc's back channel only speaks HTTP: with HTTPS, the camera's port 80 is used.
    expect(hikTalkUrl({ ...device, https: true, port: 443 })).toBe('isapi://hub:p%40ss%3Aw%2Frd@192.168.1.40:80/');
  });

  it('maps the app speed onto 10…100', () => {
    expect(hikSpeed(undefined)).toBe(50);
    expect(hikSpeed(64)).toBe(100);
    expect(hikSpeed(1)).toBe(10);
    expect(hikSpeed(32)).toBe(50);
  });
});

describe('camera', () => {
  it('connects through Digest and reports the abilities of a pan/tilt/zoom dome', async () => {
    const dome = await sim({ profile: 'ptz' });
    start([dome.settings({ id: 'carport', name: 'Carport', room: 'Außen' })]);
    const entity = await online('carport');
    expect(entity).toMatchObject({ model: 'DS-2DE2A404IW-DE3', room: 'Außen', features: { ptz: true, zoom: true, presets: true, talk: false, light: false, siren: false }, lightOn: null });
    expect(dome.stats.failedLogins).toBe(0);
    expect(dome.requests).toContain('GET /ISAPI/PTZCtrl/channels/1/capabilities');
  });

  it('finds the speaker of a turret and the zoom of a motorised lens', async () => {
    const turret = await sim({ profile: 'turret' });
    const bullet = await sim({ profile: 'varifocal' });
    start([turret.settings({ id: 'turm', name: 'Turm' }), bullet.settings({ id: 'zufahrt', name: 'Zufahrt' })]);
    expect((await online('turm')).features).toMatchObject({ ptz: false, zoom: false, presets: false, talk: true, audio: true });
    expect((await online('zufahrt')).features).toMatchObject({ ptz: false, zoom: true, presets: false, talk: false });
  });

  it('offers no talking when the speaker uses a codec go2rtc cannot carry', async () => {
    const turret = await sim({ profile: 'turret', talkCodec: 'AAC', streamAudio: false });
    start([turret.settings({ id: 'turm', name: 'Turm' })]);
    expect((await online('turm')).features).toMatchObject({ talk: false, audio: false });
  });

  it('turns continuously, keeps turning while held, and stops by itself when the app goes quiet', async () => {
    const dome = await sim({ profile: 'ptz' });
    const integration = start([dome.settings({ id: 'carport', name: 'Carport' })]);
    await online('carport');
    await integration.ptz('carport', 'right', 64);
    expect(dome.moving).toBe(true);
    expect(dome.ptzLog.at(-1)).toMatchObject({ pan: 100, tilt: 0, zoom: 0 });
    // Held: no new command, only the dead-man switch is renewed.
    await integration.ptz('carport', 'right', 64);
    expect(dome.ptzLog).toHaveLength(1);
    await waitFor(() => (!dome.moving ? true : null), 2000, 'stopped by itself');
    expect(dome.ptzLog.at(-1)).toMatchObject({ pan: 0, tilt: 0, zoom: 0 });
    expect(dome.pan).toBeGreaterThan(0);

    await integration.ptz('carport', 'zoom_in');
    expect(dome.ptzLog.at(-1)).toMatchObject({ pan: 0, tilt: 0, zoom: 50 });
    await integration.ptz('carport', 'stop');
    expect(dome.moving).toBe(false);
  });

  it('zooms a motorised lens without sending pan or tilt', async () => {
    const bullet = await sim({ profile: 'varifocal' });
    const integration = start([bullet.settings({ id: 'zufahrt', name: 'Zufahrt' })]);
    await online('zufahrt');
    await integration.ptz('zufahrt', 'zoom_out', 32);
    expect(bullet.ptzLog.at(-1)).toMatchObject({ zoom: -50 });
    await integration.ptz('zufahrt', 'stop');
    expect((await failure(integration.ptz('zufahrt', 'left'))).statusCode).toBe(400);
  });

  it('lists and moves to stored positions', async () => {
    const dome = await sim({ profile: 'ptz' });
    const integration = start([dome.settings({ id: 'carport', name: 'Carport' })]);
    await online('carport');
    expect(await integration.presets('carport')).toEqual([
      { id: 1, name: 'Hauseingang' },
      { id: 2, name: 'Zufahrt' },
      { id: 3, name: 'Briefkasten' },
    ]);
    await integration.gotoPreset('carport', 3);
    expect(dome.ptzLog.at(-1)).toMatchObject({ preset: 3 });
    expect(dome.pan).toBeCloseTo(0.7);
    expect((await failure(integration.gotoPreset('carport', 42))).statusCode).toBe(404);
  });

  it('takes still pictures from ISAPI', async () => {
    const dome = await sim({ profile: 'ptz' });
    const integration = start([dome.settings({ id: 'carport', name: 'Carport' })]);
    await online('carport');
    const picture = await integration.snapshot('carport');
    expect(picture.subarray(0, 4).equals(dome.frame().subarray(0, 4))).toBe(true);
    expect(dome.stats.pictures).toBe(1);
  });

  it('declares RTSP streams and the ISAPI back channel for go2rtc', async () => {
    const dome = await sim({ profile: 'turret' });
    const integration = start([dome.settings({ id: 'turm', name: 'Turm' })]);
    const specs = integration.streams();
    const url = (name: string) => specs.find((spec) => spec.name === name)?.sources;
    expect(url('cam_turm_main')).toEqual([`rtsp://${dome.username}:${dome.password}@127.0.0.1:${dome.rtspPort}/Streaming/Channels/101#backchannel=0`, 'ffmpeg:cam_turm_main#audio=opus']);
    expect(url('cam_turm_sub')?.[0]).toContain('/Streaming/Channels/102#backchannel=0');
    expect(url('cam_turm_talk')).toEqual([`isapi://${dome.username}:${dome.password}@127.0.0.1:${dome.port}/`]);
  });

  it('refuses light and siren with a clear message', async () => {
    const turret = await sim({ profile: 'turret' });
    const integration = start([turret.settings({ id: 'turm', name: 'Turm' })]);
    await online('turm');
    expect((await failure(integration.setLight('turm', true))).statusCode).toBe(400);
    expect((await failure(integration.siren('turm'))).statusCode).toBe(400);
  });
});

describe('what the household switches on', () => {
  it('hides pan/tilt/zoom and talking that are switched off, but says what the camera can', async () => {
    const dome = await sim({ profile: 'ptz' });
    const turret = await sim({ profile: 'turret' });
    const integration = start([
      { ...dome.settings({ id: 'carport', name: 'Carport' }), ptz: false },
      { ...turret.settings({ id: 'turm', name: 'Turm' }), talk: false },
    ]);
    expect(await online('carport')).toMatchObject({ features: { ptz: false, zoom: false, presets: false }, supports: { ptz: true, talk: false } });
    expect(await online('turm')).toMatchObject({ features: { talk: false }, supports: { ptz: false, talk: true } });

    // The hub refuses what is switched off, whatever an app sends.
    expect((await failure(integration.ptz('carport', 'left'))).statusCode).toBe(400);
    expect((await failure(integration.gotoPreset('carport', 1))).statusCode).toBe(400);
    expect(await integration.presets('carport')).toEqual([]);
    expect(dome.ptzLog).toHaveLength(0);
    expect(integration.streams().map((spec) => spec.name)).not.toContain('cam_turm_talk');
    expect(integration.streams().map((spec) => spec.name)).toContain('cam_carport_talk');
  });

  it('reports what the camera can in the connection test', async () => {
    const dome = await sim({ profile: 'ptz' });
    const turret = await sim({ profile: 'turret', talkCodec: 'AAC' });
    expect((await ReolinkIntegration.test(dome.settings({ id: 'carport', name: 'Carport' }), { timing: FAST })).supports).toEqual({ ptz: true, talk: false });
    // A speaker with a codec the hub cannot feed does not count.
    expect((await ReolinkIntegration.test(turret.settings({ id: 'turm', name: 'Turm' }), { timing: FAST })).supports).toEqual({ ptz: false, talk: false });
    // Switched off or not: the test says what the camera itself can.
    expect((await ReolinkIntegration.test({ ...dome.settings({ id: 'carport', name: 'Carport' }), ptz: false }, { timing: FAST })).supports).toEqual({ ptz: true, talk: false });
  });
});

describe('logins', () => {
  it('pauses after a wrong password instead of running into the camera lock, and doubles the pause', async () => {
    const dome = await sim({ profile: 'ptz', lockAfterFailures: 3 });
    start([{ ...dome.settings({ id: 'carport', name: 'Carport' }), password: 'falsch' }], { ...FAST, blockMs: 400 });
    await waitFor(() => (env.state.getService('reolink').message?.includes('Passwort') ? true : null), 3000, 'refusal reported');
    expect(camera('carport')?.available).toBe(false);
    const first = dome.stats.failedLogins;
    expect(first).toBe(1);
    // An app opening does not trigger another try while the pause lasts.
    cameras!.setActive(false);
    cameras!.setActive(true);
    await sleep(250);
    expect(dome.stats.failedLogins).toBe(first);
    // After the pause one more try, then a pause twice as long.
    await waitFor(() => (dome.stats.failedLogins === 2 ? true : null), 2000, 'second try');
    await sleep(500);
    expect(dome.stats.failedLogins).toBe(2);
    expect(dome.lockedUntil).toBe(0);
  });

  it('waits out a lock the camera reports', async () => {
    const dome = await sim({ profile: 'ptz', lockAfterFailures: 1, lockMs: 60_000 });
    start([{ ...dome.settings({ id: 'carport', name: 'Carport' }), password: 'falsch' }], { ...FAST, blockMs: 50 });
    await waitFor(() => (env.state.getService('reolink').message?.includes('gesperrt') ? true : null), 3000, 'lock reported');
    expect(env.state.getService('reolink').message).toContain('Minute');
    const paused = (cameras!.diagnostics() as { cameras: { pausedUntil: string | null }[] }).cameras[0]!.pausedUntil;
    expect(Date.parse(paused!) - Date.now()).toBeGreaterThan(50_000);
    const tries = dome.stats.requests;
    cameras!.setActive(false);
    cameras!.setActive(true);
    await sleep(300);
    // Not a single request while the camera is locked.
    expect(dome.stats.requests).toBe(tries);
  });

  it('comes back when the camera is reachable again', async () => {
    const dome = await sim({ profile: 'ptz' });
    start([dome.settings({ id: 'carport', name: 'Carport' })]);
    await online('carport');
    await dome.setOffline(true);
    await waitFor(() => (camera('carport')?.available === false ? true : null), 4000, 'offline');
    await dome.setOffline(false);
    await online('carport');
  });
});

describe('recorder', () => {
  it('reaches a camera on a recorder through the proxy paths and notices when it is disconnected', async () => {
    const nvr = await sim({
      profile: 'ptz',
      nvr: {
        channels: [
          { name: 'Garage', online: true },
          { name: 'Carport', online: true },
        ],
      },
    });
    const integration = start([nvr.settings({ id: 'carport', name: 'Carport', channel: 1 })]);
    const entity = await online('carport');
    expect(entity).toMatchObject({ model: 'DS-7608NXI-K2', features: { ptz: true, talk: false } });
    await integration.ptz('carport', 'left');
    expect(nvr.ptzLog.at(-1)).toMatchObject({ channel: 2, pan: -50 });
    expect(nvr.requests).toContain('PUT /ISAPI/ContentMgmt/PTZCtrlProxy/channels/2/continuous');
    await integration.ptz('carport', 'stop');
    expect(integration.streams().find((spec) => spec.name === 'cam_carport_main')?.sources[0]).toContain('/Streaming/Channels/201');

    nvr.setChannelOnline(1, false);
    await waitFor(() => (camera('carport')?.available === false ? true : null), 3000, 'channel offline');
    expect(env.state.getService('reolink').message).toContain('D2');
  });
});

describe('connection test', () => {
  it('describes what works', async () => {
    const turret = await sim({ profile: 'turret' });
    const result = await ReolinkIntegration.test(turret.settings({ id: 'turm', name: 'Turm' }), { timing: FAST });
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Hikvision DS-2CD2387G2-LSU/SL gefunden (Firmware V5.7.15 build 231120).');
    const details = result.details!.join('\n');
    expect(details).toContain('Gegensprechen');
    expect(details).toContain('HD: H.265 3840×2160');
    expect(details).toContain('H.265 kann nicht jeder Browser');
  });

  it('explains a wrong password and the camera lock', async () => {
    const dome = await sim({ profile: 'ptz' });
    const result = await ReolinkIntegration.test({ ...dome.settings({ id: 'carport', name: 'Carport' }), password: 'falsch' }, { timing: FAST });
    expect(result).toMatchObject({ ok: false, message: 'Benutzername oder Passwort stimmen nicht.' });
    expect(result.details!.join('\n')).toContain('30 Minuten');
    expect(dome.stats.failedLogins).toBe(1);
  });

  it('says when the speaker needs another codec', async () => {
    const turret = await sim({ profile: 'turret', talkCodec: 'G.726' });
    const result = await ReolinkIntegration.test(turret.settings({ id: 'turm', name: 'Turm' }), { timing: FAST });
    expect(result.ok).toBe(true);
    expect(result.details!.join('\n')).toContain('G.711ulaw');
  });

  it('notices a missing live picture', async () => {
    const dome = await sim({ profile: 'ptz', rtsp: false });
    const result = await ReolinkIntegration.test({ ...dome.settings({ id: 'carport', name: 'Carport' }), rtspPort: 1 }, { timing: FAST });
    expect(result).toMatchObject({ ok: false, message: 'Steuerung erreichbar, aber kein Live-Bild.' });
  });

  it('notices an address without a camera', async () => {
    const dome = await sim({ profile: 'ptz' });
    const device = dome.settings({ id: 'carport', name: 'Carport' });
    await dome.setOffline(true);
    const result = await ReolinkIntegration.test(device, { timing: FAST });
    expect(result).toMatchObject({ ok: false, message: 'Die Kamera ist unter dieser Adresse nicht erreichbar.' });
  });
});
