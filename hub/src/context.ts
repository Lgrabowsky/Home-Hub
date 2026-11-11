import type { AuditLog } from './security/audit.ts';
import type { SessionStore } from './auth/sessions.ts';
import type { UserStore } from './auth/users.ts';
import type { HubConfig } from './config.ts';
import type { Db } from './db.ts';
import type { Logger } from './log.ts';
import type { RealtimeHub } from './realtime.ts';
import type { Vault } from './security/crypto.ts';
import type { RateLimiter, Throttle } from './security/throttle.ts';
import type { SettingsStore } from './settings.ts';
import type { StateStore } from './state.ts';
import type { SetupGuard } from './auth/setup.ts';
import type { TicketStore } from './auth/tickets.ts';
import type { IntegrationManager } from './integrations/manager.ts';
import type { ImageProxy } from './util/images.ts';
import type { DemoControl } from './sim/demo.ts';

/** Everything the HTTP layer and the integrations share. */
export interface HubContext {
  config: HubConfig;
  log: Logger;
  db: Db;
  vault: Vault;
  settings: SettingsStore;
  users: UserStore;
  sessions: SessionStore;
  audit: AuditLog;
  state: StateStore;
  realtime: RealtimeHub;
  throttle: Throttle;
  apiLimiter: RateLimiter;
  authLimiter: RateLimiter;
  setup: SetupGuard;
  tickets: TicketStore;
  integrations: IntegrationManager;
  images: ImageProxy;
  startedAt: number;
  /** Set while the demo mode (HUB_DEMO=1) is running. */
  demo: DemoControl | null;
}
