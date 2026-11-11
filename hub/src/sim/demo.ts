import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DemoState, DemoTrigger } from '@home-hub/shared';
import type { HubContext } from '../context.ts';
import { HttpError } from '../http/errors.ts';
import { streamName } from '../integrations/media.ts';
import { describeError } from '../util/http.ts';
import { DOORBIRD_DEMO_STATIONS, startDoorBirdSim, type DoorBirdSim } from './doorbird-sim.ts';
import { startMyGekkoSim, type MyGekkoSim } from './mygekko-sim.ts';
import { REOLINK_DEMO_CAMERAS, startReolinkSim } from './reolink-sim.ts';
import { startSonosSim } from './sonos-sim.ts';
import { startSpotifySim, type SpotifySim } from './spotify-sim.ts';

/**
 * Demo mode (HUB_DEMO=1): starts simulated devices and points the integrations
 * at them, so the whole app can be tried without any hardware.
 *
 * The integrations run unchanged — they talk to the simulators over real
 * sockets and cannot tell the difference. Only live video needs help: the
 * simulators draw still pictures, so the demo turns each device's current
 * snapshot into a video stream (ffmpeg, started by go2rtc on demand).
 */

export interface DemoHandle {
  /** Runs once the integrations are up. */
  ready(): Promise<void>;
  stop(): Promise<void>;
}

/** What the demo panel in the app can ask for (`/api/demo/*`). */
export interface DemoControl {
  state(): DemoState;
  trigger(request: DemoTrigger): Promise<void>;
}

interface FrameSource {
  /** go2rtc device kind and id. */
  kind: 'cam' | 'door';
  id: string;
  snapshot(): Promise<Buffer>;
  file: string;
  busy: boolean;
  lastAt: number;
  /** True while the picture changes quickly (a camera is turning). */
  fast?: () => boolean;
}

const FRAME_INTERVAL_MS = 1000;
const FAST_FRAME_INTERVAL_MS = 250;
const SPOTIFY_REDIRECT = 'http://127.0.0.1/api/spotify/callback';

/**
 * go2rtc source that turns a (regularly rewritten) picture into a live stream
 * with a quiet ambient sound, so that "listening in" has something to play.
 * `{output}` is go2rtc's own RTSP address; ffmpeg publishes there.
 */
function videoSource(ffmpeg: string, file: string, width: number, height: number): string {
  return [
    `exec:${ffmpeg} -hide_banner -loglevel error`,
    `-re -f image2 -loop 1 -framerate 5 -i ${file}`,
    '-f lavfi -i anoisesrc=color=brown:amplitude=0.02:sample_rate=48000',
    `-vf scale=${width}:${height}`,
    '-c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -profile:v baseline -g 10 -bf 0',
    '-c:a libopus -b:a 24k -ac 1',
    '-f rtsp {output}',
  ].join(' ');
}

/** go2rtc source that accepts the app's microphone audio and throws it away (a camera's speaker). */
export function talkSink(ffmpeg: string): string {
  // Without `#audio=` go2rtc would offer 16 kHz PCM, which browsers cannot send; G.711 A-law they can.
  return `exec:${ffmpeg} -hide_banner -loglevel error -f alaw -ar 8000 -i - -f null -#backchannel=1#audio=alaw/8000`;
}

export async function startDemo(ctx: HubContext): Promise<DemoHandle> {
  const { settings, integrations, log, config } = ctx;
  const closers: (() => Promise<void>)[] = [];
  const frames: FrameSource[] = [];
  const frameDir = join(config.dataDir, 'demo-frames');
  rmSync(frameDir, { recursive: true, force: true });
  mkdirSync(frameDir, { recursive: true });
  const ffmpeg = config.media.ffmpegBin;

  // Cover art and snapshots come from the simulators on this machine.
  ctx.images.allowLanHost('127.0.0.1');

  function addVideo(kind: 'cam' | 'door', id: string, snapshot: () => Promise<Buffer>, qualities: ('main' | 'sub')[], fast?: () => boolean): void {
    const file = join(frameDir, `${kind}-${id}.png`);
    frames.push({ kind, id, snapshot, file, busy: false, lastAt: 0, fast });
    for (const quality of qualities) {
      const [width, height] = quality === 'main' ? [1280, 720] : [640, 360];
      integrations.streamOverrides.set(streamName(kind, id, quality), [videoSource(ffmpeg, file, width, height)]);
    }
  }

  // --- myGEKKO -----------------------------------------------------------------------------------

  const gekko: MyGekkoSim = await startMyGekkoSim({ blindTravelMs: 12_000 });
  closers.push(() => gekko.close());
  settings.override('mygekko', {
    enabled: true,
    mode: 'local',
    host: gekko.host,
    username: gekko.username,
    password: gekko.password,
    // Window contacts on room controllers only show up by themselves after they were seen open once;
    // mapped explicitly they are there from the first second (and the settings page has something to show).
    contacts: [
      { id: 'fenster-schlafzimmer', source: 'roomtemps/item3', field: 12, openWhen: 'nonzero', name: 'Fenster Schlafzimmer', contactType: 'window', room: 'Schlafzimmer', zone: 'Hülle' },
      { id: 'fenster-kinderzimmer', source: 'roomtemps/item4', field: 12, openWhen: 'nonzero', name: 'Fenster Kinderzimmer', contactType: 'window', room: 'Kinderzimmer', zone: 'Hülle' },
    ],
  });

  // --- DoorBird ----------------------------------------------------------------------------------

  const doors: { id: string; name: string; sim: DoorBirdSim }[] = [];
  for (const station of DOORBIRD_DEMO_STATIONS) {
    const sim = await startDoorBirdSim(station.sim);
    closers.push(() => sim.close());
    doors.push({ id: station.device.id, name: station.device.name, sim });
    // The talk stream is used as declared: the simulator accepts go2rtc's audio upload like a real station.
    addVideo('door', station.device.id, () => integrations.need('doorbird').snapshot(station.device.id), ['main']);
  }
  settings.override('doorbird', {
    enabled: true,
    retentionDays: 90,
    devices: doors.map((door, index) => door.sim.settings(DOORBIRD_DEMO_STATIONS[index]!.device)),
  });

  // --- Reolink -----------------------------------------------------------------------------------

  const cameraDevices = [];
  for (const entry of REOLINK_DEMO_CAMERAS) {
    const sim = await startReolinkSim(entry.sim);
    closers.push(() => sim.close());
    cameraDevices.push(sim.settings(entry.device));
    const id = entry.device.id;
    // Straight from the simulator (not through the hub's one-second snapshot cache), so turning the camera looks smooth.
    addVideo('cam', id, async () => sim.frame(), ['main', 'sub'], () => sim.moving);
    // The simulated cameras have no RTSP server: something else has to "be the speaker".
    integrations.streamOverrides.set(streamName('cam', id, 'talk'), [talkSink(ffmpeg)]);
  }
  settings.override('reolink', { enabled: true, devices: cameraDevices });

  // --- Sonos -------------------------------------------------------------------------------------

  const sonosSim = await startSonosSim();
  closers.push(() => sonosSim.close());
  settings.override('sonos', { enabled: true, hosts: [sonosSim.seedHosts[0]!], spotifyRegion: 'EU' });

  // --- Spotify -----------------------------------------------------------------------------------

  const spotifySim: SpotifySim = await startSpotifySim();
  closers.push(() => spotifySim.close());
  integrations.spotifyEndpoints = { apiBase: spotifySim.apiBase, accountsBase: spotifySim.accountsBase };
  settings.override('spotify', { enabled: true, clientId: spotifySim.clientId, clientSecret: '', market: 'DE' });
  // Tokens of an earlier demo run belong to a simulator that no longer exists.
  settings.setInternal('spotify.tokens', null);

  // --- Live pictures → video ---------------------------------------------------------------------

  let active = false;
  const onActivity = (now: boolean) => {
    active = now;
  };
  ctx.realtime.on('activity', onActivity);

  async function refresh(frame: FrameSource): Promise<void> {
    frame.busy = true;
    frame.lastAt = Date.now();
    try {
      const picture = await frame.snapshot();
      // Written next to the target and renamed, so ffmpeg never reads half a file.
      const temp = `${frame.file}.tmp`;
      writeFileSync(temp, picture);
      renameSync(temp, frame.file);
    } catch (err) {
      log.debug({ err: describeError(err), device: `${frame.kind}:${frame.id}` }, 'demo: no picture');
    } finally {
      frame.busy = false;
    }
  }

  const frameTimer = setInterval(() => {
    const now = Date.now();
    for (const frame of frames) {
      if (frame.busy) continue;
      // Nobody is looking: one picture a minute keeps the file fresh enough for the first viewer.
      const interval = active && frame.fast?.() ? FAST_FRAME_INTERVAL_MS : active ? FRAME_INTERVAL_MS : 60_000;
      if (now - frame.lastAt >= interval) void refresh(frame);
    }
  }, FAST_FRAME_INTERVAL_MS);
  frameTimer.unref();

  // --- Controls for the demo panel ------------------------------------------------------------------

  const control: DemoControl = {
    state() {
      return {
        doors: doors.map((door) => ({ id: door.id, name: door.name })),
        contacts: gekko.contactNames().map((name) => ({ name, open: gekko.isContactOpen(name) })),
      };
    },
    async trigger(request) {
      switch (request.action) {
        case 'ring':
        case 'motion': {
          const door = doors.find((entry) => entry.id === request.door);
          if (!door) throw new HttpError(404, 'not_found', 'Diese Türstation gibt es in der Demo nicht.');
          if (request.action === 'ring') door.sim.ring();
          else door.sim.motion();
          return;
        }
        case 'contact': {
          if (!gekko.contactNames().includes(request.name)) throw new HttpError(404, 'not_found', 'Diesen Kontakt gibt es in der Demo nicht.');
          gekko.setContact(request.name, request.open);
          return;
        }
      }
    },
  };
  ctx.demo = control;

  return {
    async ready() {
      const spotify = integrations.spotify;
      if (spotify) {
        try {
          await spotify.finishAuth(await spotifySim.authorize(spotify.beginAuth(SPOTIFY_REDIRECT, 'demo')), SPOTIFY_REDIRECT);
        } catch (err) {
          log.warn({ err: describeError(err) }, 'demo: could not link the simulated Spotify account');
        }
      }
      // First pictures, so a stream that starts right away has something to show.
      await Promise.all(frames.map((frame) => refresh(frame)));
      log.info('demo mode: simulated devices are running');
    },
    async stop() {
      clearInterval(frameTimer);
      ctx.realtime.off('activity', onActivity);
      ctx.demo = null;
      await Promise.all(closers.map((close) => close().catch(() => {})));
      rmSync(frameDir, { recursive: true, force: true });
    },
  };
}
