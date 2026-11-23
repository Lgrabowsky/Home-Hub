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
import type { TlsMaterial } from './security/tls.ts';
import type { HostControl } from './system/host-control.ts';
import type { House3DStore } from './house3d/store.ts';
import type { TimerService } from './automation/timers.ts';
import type { LayoutService } from './layout.ts';

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
  /** Certificate the hub serves HTTPS with (null without HUB_TLS). Replaced when it is renewed. */
  tls: TlsMaterial | null;
  /** Requests to the machine the hub runs on (restart), answered by a helper installed there. */
  hostControl: HostControl;
  /** The 3D model of the house (Labs). */
  house3d: House3DStore;
  /** The hub's own time switches. */
  timers: TimerService;
  layout: LayoutService;
  /** Demo mode: where the search for KNX interfaces goes instead of the multicast group. */
  knxSearchTarget?: { host: string; port: number } | null;
}
