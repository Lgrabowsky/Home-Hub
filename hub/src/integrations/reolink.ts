import type { PtzOp, PtzPreset, ReolinkDeviceSettings, ReolinkSettings, TestResult } from '@home-hub/shared';
import type { StreamSpec } from './media.ts';
import type { Integration, IntegrationDeps } from './types.ts';

/**
 * Reolink cameras / NVR channels (local HTTP API + RTSP/FLV through go2rtc).
 *
 * CONTRACT STUB — the public surface below is what the rest of the hub relies on.
 * `cameraId` is always the configured device id (the entity id is `cam:<cameraId>`).
 */
export class ReolinkIntegration implements Integration {
  constructor(
    protected readonly deps: IntegrationDeps,
    protected readonly settings: ReolinkSettings,
  ) {}

  start(): void {
    throw new Error('not implemented');
  }

  async stop(): Promise<void> {
    throw new Error('not implemented');
  }

  setActive(_active: boolean): void {
    throw new Error('not implemented');
  }

  diagnostics(): unknown {
    throw new Error('not implemented');
  }

  /**
   * go2rtc streams of all cameras (names via `streamName('cam', id, …)`):
   *   `cam_<id>_main`  full resolution (may be H.265)
   *   `cam_<id>_sub`   low resolution H.264, used for tiles and as fallback
   *   `cam_<id>_talk`  talk channel (browser microphone → camera speaker), RTSP back channel
   */
  streams(): StreamSpec[] {
    throw new Error('not implemented');
  }

  /** Current JPEG. Throws `HttpError` when the camera is unknown or unreachable. */
  async snapshot(_cameraId: string): Promise<Buffer> {
    throw new Error('not implemented');
  }

  /**
   * Continuous pan/tilt/zoom. The movement keeps going only while this is
   * called again at least once per second; otherwise the hub stops the camera
   * by itself (so a lost "stop" can never leave it spinning). `stop` halts at once.
   */
  async ptz(_cameraId: string, _op: PtzOp, _speed?: number): Promise<void> {
    throw new Error('not implemented');
  }

  async presets(_cameraId: string): Promise<PtzPreset[]> {
    throw new Error('not implemented');
  }

  async gotoPreset(_cameraId: string, _presetId: number): Promise<void> {
    throw new Error('not implemented');
  }

  /** Spotlight on/off. */
  async setLight(_cameraId: string, _on: boolean): Promise<void> {
    throw new Error('not implemented');
  }

  /** Sounds the siren once. */
  async siren(_cameraId: string): Promise<void> {
    throw new Error('not implemented');
  }

  /** Connection test for one (possibly unsaved) device. Never throws. */
  static async test(_device: ReolinkDeviceSettings): Promise<TestResult> {
    throw new Error('not implemented');
  }
}
