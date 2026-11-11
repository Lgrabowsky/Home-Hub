import type { ContactCandidate, EntityCommand, MyGekkoSettings, TestResult } from '@home-hub/shared';
import type { Integration, IntegrationDeps } from './types.ts';

/**
 * myGEKKO building controller (Query API, local or via live.my-gekko.com).
 *
 * CONTRACT STUB — the public surface below is what the rest of the hub relies on.
 */
export class MyGekkoIntegration implements Integration {
  constructor(
    protected readonly deps: IntegrationDeps,
    protected readonly settings: MyGekkoSettings,
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
   * Executes a command on one of this integration's entities (`gekko:…`).
   * Throws `HttpError` (German message) when the entity is unknown, the command
   * does not fit the entity or the controller rejects it.
   */
  async command(_entityId: string, _command: EntityCommand): Promise<void> {
    throw new Error('not implemented');
  }

  /** Every element that could be a window/door contact, with its raw values (admin mapping / learn UI). */
  contactCandidates(): ContactCandidate[] {
    throw new Error('not implemented');
  }

  /** Connection test for (possibly unsaved) settings. Never throws. */
  static async test(_settings: MyGekkoSettings): Promise<TestResult> {
    throw new Error('not implemented');
  }
}
