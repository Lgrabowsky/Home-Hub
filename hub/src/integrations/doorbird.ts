import type { DoorBirdDeviceSettings, DoorBirdSettings, DoorEventType, DoorHistoryPage, TestResult } from '@home-hub/shared';
import type { StreamSpec } from './media.ts';
import type { Actor, Integration, IntegrationDeps } from './types.ts';

/**
 * DoorBird door stations (LAN API).
 *
 * CONTRACT STUB — the public surface below is what the rest of the hub relies on.
 * `doorId` is always the configured device id (the entity id is `door:<doorId>`).
 */
export class DoorBirdIntegration implements Integration {
  constructor(
    protected readonly deps: IntegrationDeps,
    protected readonly settings: DoorBirdSettings,
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
   * go2rtc streams of all door stations (names via `streamName('door', id, …)`):
   *   `door_<id>_main`  live video + audio from the door (never opens a talk channel)
   *   `door_<id>_talk`  talk channel (browser microphone → door speaker)
   */
  streams(): StreamSpec[] {
    throw new Error('not implemented');
  }

  /** Current JPEG from the door camera. Throws `HttpError` when the door is unknown or unreachable. */
  async snapshot(_doorId: string): Promise<Buffer> {
    throw new Error('not implemented');
  }

  /** Triggers a door opener relay, records it in the door history and the audit log, and publishes `door_opened`. */
  async openDoor(_doorId: string, _relayId: string, _actor: Actor): Promise<void> {
    throw new Error('not implemented');
  }

  /** Switches the door station's light on. */
  async light(_doorId: string): Promise<void> {
    throw new Error('not implemented');
  }

  /** Door history (rings, motion, openings), newest first, from the hub's own store. */
  history(_doorId: string, _options: { before?: number | null; limit?: number; type?: DoorEventType | null }): DoorHistoryPage {
    throw new Error('not implemented');
  }

  /** Decrypted JPEG of a history event, or null when it has no image (any more). */
  historyImage(_eventId: string): Buffer | null {
    throw new Error('not implemented');
  }

  /** Connection test for one (possibly unsaved) device. Never throws. */
  static async test(_device: DoorBirdDeviceSettings): Promise<TestResult> {
    throw new Error('not implemented');
  }
}
