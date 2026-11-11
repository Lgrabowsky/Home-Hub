import type { HubContext } from '../context.ts';

export interface DemoHandle {
  stop(): Promise<void>;
}

/**
 * Demo mode (HUB_DEMO=1): starts simulated devices and points the integrations
 * at them, so the whole app can be tried without any hardware.
 *
 * Placeholder — wired up once the simulators exist.
 */
export async function startDemo(_ctx: HubContext): Promise<DemoHandle> {
  throw new Error('Der Demo-Modus ist in diesem Build noch nicht enthalten.');
}
