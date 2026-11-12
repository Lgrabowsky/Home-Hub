import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CameraEntity, ReolinkDeviceSettings } from '@home-hub/shared';
import { HttpError } from '../src/http/errors.ts';
import { ReolinkIntegration, type ReolinkTiming } from '../src/integrations/reolink.ts';
import { passwordDigest } from '../src/integrations/reolink/onvif.ts';
import { describeRtsp, parseSdp, rtspAuthorization } from '../src/integrations/reolink/rtsp.ts';
import { startReolinkSim, type ReolinkSim, type ReolinkSimOptions } from '../src/sim/reolink-sim.ts';
import { createTestDeps, waitFor, type TestDeps } from './deps.ts';

/** Cameras without the HTTP interface (E1 series): ONVIF for control, RTSP for video. */

const FAST: Partial<ReolinkTiming> = { activeMs: 60, idleMs: 60, requestTimeoutMs: 1500, blockMs: 60_000, ptzHoldMs: 150, snapshotCacheMs: 250, presetCacheMs: 250 };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

let env: TestDeps;
let sims: ReolinkSim[] = [];
let reolink: ReolinkIntegration | null = null;
let streamChanges = 0;

async function sim(options: ReolinkSimOptions = {}): Promise<ReolinkSim> {
  const started = await startReolinkSim({ profile: 'e1pro', rtsp: true, ...options });
  sims.push(started);
  return started;
}

function start(devices: ReolinkDeviceSettings[]): ReolinkIntegration {
  reolink = new ReolinkIntegration(env.deps, { enabled: true, devices }, { timing: FAST });
  reolink.start();
  reolink.setActive(true);
  return reolink;
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
  streamChanges = 0;
  env.deps.streamsChanged = () => {
    streamChanges++;
  };
  env.deps.streamSnapshot = async () => JPEG;
});

afterEach(async () => {
  await reolink?.stop();
  reolink = null;
  await Promise.all(sims.map((entry) => entry.close()));
  for (const entry of sims) {
    for (const line of env.logs) expect(line).not.toContain(entry.password);
  }
  sims = [];
  env.cleanup();
});

describe('building blocks', () => {
  it('computes the WS-Security digest as specified', () => {
    // Example from the ONVIF Application Programmer's Guide (section 6.1.1.3).
    const nonce = Buffer.from('LKqI6G/AikKCQrN0zqZFlg==', 'base64');
    expect(passwordDigest(nonce, '2010-09-16T07:50:45Z', 'userpassword')).toBe('tuOSpGlFlIXsozq4HFNeeGeFLEI=');
  });

  it('answers RTSP digest challenges and reads the SDP', () => {
    const header = rtspAuthorization('Digest realm="BC Streaming Media", nonce="abc"', 'DESCRIBE', 'rtsp://1.2.3.4:554/x', 'admin', 'pw');
    expect(header).toMatch(/^Digest username="admin", realm="BC Streaming Media", nonce="abc", uri="rtsp:\/\/1\.2\.3\.4:554\/x", response="[0-9a-f]{32}"$/);
    const sdp = ['v=0', 'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H265/90000', 'm=audio 0 RTP/AVP 97', 'a=rtpmap:97 MPEG4-GENERIC/16000', 'a=recvonly', 'm=audio 0 RTP/AVP 8', 'a=rtpmap:8 PCMA/8000', 'a=sendonly'].join('\r\n');
    expect(parseSdp(sdp, true)).toEqual({ video: 'H265', audio: true, backchannel: true });
    expect(parseSdp(sdp, false).backchannel).toBe(false);
  });

  it('describes a stream with authentication and refuses wrong credentials', async () => {
    const e1 = await sim();
    const target = { host: e1.host, port: e1.rtspPort, path: '/h264Preview_01_sub', username: e1.username, password: e1.password, timeoutMs: 1500 };
    expect(await describeRtsp(target)).toEqual({ video: 'H264', audio: true, backchannel: false });
    await expect(describeRtsp({ ...target, password: 'falsch' })).rejects.toMatchObject({ kind: 'auth' });
    await expect(describeRtsp({ ...target, path: '/gibtsnicht' })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('an E1 Pro over ONVIF and RTSP', () => {
  it('comes online with what it can do and the video addresses it reports', async () => {
    const e1 = await sim({ name: 'Wohnzimmer' });
    const integration = start([e1.settings({ id: 'wohnzimmer', name: 'Wohnzimmer', room: 'Wohnzimmer' })]);
    const entity = await online('wohnzimmer');
    expect(entity).toMatchObject({
      model: 'E1 Pro',
      room: 'Wohnzimmer',
      features: { ptz: true, zoom: false, presets: true, talk: false, audio: true, light: false, siren: false },
      lightOn: null,
    });
    // The paths come from GetStreamUri; host and port stay the configured ones (not the address the camera claims).
    const streams = integration.streams();
    const main = streams.find((spec) => spec.name.endsWith('_main'))!;
    expect(main.sources[0]).toBe(`rtsp://${e1.username}:${encodeURIComponent(e1.password)}@127.0.0.1:${e1.rtspPort}/h264Preview_01_main#backchannel=0`);
    expect(streams.find((spec) => spec.name.endsWith('_talk'))!.sources[0]).toBe(`rtsp://${e1.username}:${encodeURIComponent(e1.password)}@127.0.0.1:${e1.rtspPort}/h264Preview_01_sub`);
    expect(streamChanges).toBe(1);
    // The camera's HTTP interface was never asked.
    expect(e1.commands.every((command) => command.startsWith('onvif:'))).toBe(true);
    expect(e1.rtspLog.some((entry) => entry.authorised && entry.backchannel)).toBe(true);
  });

  it('works even when the camera clock is far off', async () => {
    const e1 = await sim({ clockSkewMs: 2 * 60 * 60_000 });
    start([e1.settings({ id: 'kamera', name: 'Kamera' })]);
    await online('kamera');
    expect(e1.stats.failedLogins).toBe(0);
  });

  it('stops after a refused login instead of locking the account', async () => {
    const e1 = await sim();
    start([e1.settings({ id: 'kamera', name: 'Kamera', password: 'falsch' })]);
    await waitFor(() => env.state.allServices().find((service) => service.id === 'reolink' && service.status === 'offline'), 4000, 'offline');
    expect(env.state.allServices().find((service) => service.id === 'reolink')?.message).toContain('Passwort');
    await sleep(400);
    expect(e1.stats.failedLogins).toBe(1);
  });

  it('turns while the app holds the button, stops by itself, and refuses a zoom it does not have', async () => {
    const e1 = await sim();
    const integration = start([e1.settings({ id: 'kamera', name: 'Kamera' })]);
    await online('kamera');
    await integration.ptz('kamera', 'right', 32);
    expect(e1.ptzLog.at(-1)).toMatchObject({ op: 'Right', speed: 32 });
    expect(e1.moving).toBe(true);
    // Held: repeated calls do not send the movement again.
    await integration.ptz('kamera', 'right', 32);
    expect(e1.ptzLog.filter((entry) => entry.op === 'Right')).toHaveLength(1);
    // Released without "stop" (app closed): the hub stops the camera.
    await waitFor(() => !e1.moving || null, 2000, 'dead-man stop');
    expect(e1.ptzLog.at(-1)?.op).toBe('Stop');

    await integration.ptz('kamera', 'left_up');
    expect(e1.ptzLog.at(-1)).toMatchObject({ op: 'LeftUp', speed: 32 });
    await integration.ptz('kamera', 'stop');
    expect(e1.moving).toBe(false);

    expect((await failure(integration.ptz('kamera', 'zoom_in'))).statusCode).toBe(400);
    expect((await failure(integration.setLight('kamera', true))).statusCode).toBe(400);
    expect((await failure(integration.siren('kamera'))).statusCode).toBe(400);
  });

  it('lists and drives to stored positions', async () => {
    const e1 = await sim();
    const integration = start([e1.settings({ id: 'kamera', name: 'Kamera' })]);
    await online('kamera');
    const presets = await integration.presets('kamera');
    expect(presets).toEqual([
      { id: 1, name: 'Terrasse' },
      { id: 2, name: 'Rasen' },
      { id: 3, name: 'Tor' },
    ]);
    await integration.gotoPreset('kamera', 3);
    expect(e1.pan).toBeCloseTo(0.75);
    expect((await failure(integration.gotoPreset('kamera', 42))).statusCode).toBe(404);
  });

  it('offers talking only when the camera has an RTSP back channel', async () => {
    const terrace = await sim({ profile: 'talk' });
    start([terrace.settings({ id: 'terrasse', name: 'Terrasse', connection: 'onvif' })]);
    expect((await online('terrasse')).features).toMatchObject({ talk: true, zoom: true, ptz: false });
  });

  it('takes still pictures from the live video', async () => {
    const e1 = await sim();
    const integration = start([e1.settings({ id: 'kamera', name: 'Kamera' })]);
    await online('kamera');
    expect(await integration.snapshot('kamera')).toEqual(JPEG);
  });

  it('reports a camera that disappears and comes back', async () => {
    const e1 = await sim();
    start([e1.settings({ id: 'kamera', name: 'Kamera' })]);
    await online('kamera');
    await e1.setOffline(true);
    await waitFor(() => (camera('kamera')?.available === false ? true : null), 4000, 'offline');
    await e1.setOffline(false);
    await online('kamera');
  });
});

describe('connection test', () => {
  it('explains what works', async () => {
    const e1 = await sim();
    const result = await ReolinkIntegration.test(e1.settings({ id: 'kamera', name: 'Kamera' }));
    expect(result.ok).toBe(true);
    expect(result.message).toContain('E1 Pro');
    const details = result.details!.join('\n');
    expect(details).toContain('Schwenken/Neigen');
    expect(details).toContain('gespeicherte Positionen');
    expect(details).toContain('keinen Rückkanal');
  });

  it('names the problem: credentials, ONVIF switched off, RTSP switched off', async () => {
    const e1 = await sim();
    const wrong = await ReolinkIntegration.test(e1.settings({ id: 'kamera', name: 'Kamera', password: 'falsch' }));
    expect(wrong).toMatchObject({ ok: false, message: 'Benutzername oder Passwort stimmen nicht.' });

    const closed = await startReolinkSim();
    const port = closed.port;
    await closed.close();
    const noOnvif = await ReolinkIntegration.test(e1.settings({ id: 'kamera', name: 'Kamera', onvifPort: port }), { timing: { requestTimeoutMs: 1000 } });
    expect(noOnvif.ok).toBe(false);
    expect(noOnvif.details!.join('\n')).toContain('„ONVIF“ eingeschaltet');

    const noRtsp = await ReolinkIntegration.test(e1.settings({ id: 'kamera', name: 'Kamera', rtspPort: port }), { timing: { requestTimeoutMs: 1000 } });
    expect(noRtsp).toMatchObject({ ok: false, message: 'Steuerung erreichbar, aber kein Live-Bild.' });
  });

  it('points to ONVIF when the HTTP interface is missing', async () => {
    const e1 = await sim();
    const result = await ReolinkIntegration.test(e1.settings({ id: 'kamera', name: 'Kamera', connection: 'api' }), { timing: { requestTimeoutMs: 1000 } });
    expect(result.ok).toBe(false);
    expect(result.details!.join('\n')).toContain('ONVIF + RTSP');
  });
});
