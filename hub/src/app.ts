import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { SessionStore } from './auth/sessions.ts';
import { SetupGuard } from './auth/setup.ts';
import { TicketStore } from './auth/tickets.ts';
import { UserStore } from './auth/users.ts';
import type { HubConfig } from './config.ts';
import type { HubContext } from './context.ts';
import { Db } from './db.ts';
import { buildServer } from './http/server.ts';
import { IntegrationManager } from './integrations/manager.ts';
import { createLogger, type Logger } from './log.ts';
import { RealtimeHub } from './realtime.ts';
import { AuditLog } from './security/audit.ts';
import { Vault } from './security/crypto.ts';
import { RateLimiter, Throttle } from './security/throttle.ts';
import { SettingsStore } from './settings.ts';
import { startDemo, type DemoHandle } from './sim/demo.ts';
import { StateStore } from './state.ts';
import { ImageProxy } from './util/images.ts';

export interface Hub {
  ctx: HubContext;
  app: FastifyInstance;
  /** Starts integrations and the HTTP server; resolves with the address it listens on. */
  start(): Promise<string>;
  stop(): Promise<void>;
}

/** Wires the hub together. Nothing touches the network before `start()`. */
export async function createHub(config: HubConfig, options: { log?: Logger } = {}): Promise<Hub> {
  const log = options.log ?? createLogger(config.logLevel);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

  const { vault, source } = Vault.open(config.dataDir, config.masterKey);
  if (source === 'generated') {
    log.info({ file: join(config.dataDir, 'master.key') }, 'created a new master key — include it in your backups, without it stored passwords cannot be read');
  }

  const db = new Db(join(config.dataDir, 'hub.sqlite'));
  const settings = new SettingsStore(db, vault);
  const users = new UserStore(db, vault);
  const sessions = new SessionStore(db, users, () => settings.get('general').sessionDays);
  const audit = new AuditLog(db);
  const state = new StateStore();
  const realtime = new RealtimeHub(state, sessions, users, log.child({ mod: 'realtime' }));
  const images = new ImageProxy(vault);
  const integrations = new IntegrationManager({ config, log, state, settings, db, vault, audit, images });

  if (config.demo) {
    // The demo must be usable without an authenticator app at hand.
    settings.override('general', {
      hubName: 'Demo-Zuhause',
      requireTotp: false,
      floors: [
        { name: 'Erdgeschoss', rooms: ['Eingang', 'Flur', 'Wohnzimmer', 'Esszimmer', 'Küche', 'Büro', 'Hauswirtschaftsraum'] },
        { name: 'Obergeschoss', rooms: ['Schlafzimmer', 'Kinderzimmer', 'Bad'] },
        { name: 'Außen', rooms: ['Außen', 'Terrasse'] },
      ],
    });
  }

  const ctx: HubContext = {
    config,
    log,
    db,
    vault,
    settings,
    users,
    sessions,
    audit,
    state,
    realtime,
    throttle: new Throttle(),
    apiLimiter: new RateLimiter(1200, 60_000),
    authLimiter: new RateLimiter(40, 60_000),
    setup: new SetupGuard(users, config.dataDir, log, config.setupToken),
    tickets: new TicketStore(),
    integrations,
    images,
    startedAt: Date.now(),
    demo: null,
  };

  const app = await buildServer(ctx);
  realtime.on('activity', (active) => integrations.setActive(active));
  // Live video must not outlive the session that started it.
  sessions.on('ended', (sessionId) => integrations.media.endSession(sessionId));

  let demo: DemoHandle | null = null;
  let maintenance: NodeJS.Timeout | null = null;
  let stopped = false;

  return {
    ctx,
    app,
    async start() {
      if (config.demo) demo = await startDemo(ctx);
      await integrations.start();
      await demo?.ready();
      const address = await app.listen({ host: config.host, port: config.port });
      maintenance = setInterval(
        () => {
          try {
            sessions.cleanup();
            audit.cleanup();
          } catch (err) {
            log.warn({ err }, 'maintenance failed');
          }
        },
        60 * 60_000,
      );
      maintenance.unref();
      return address;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (maintenance) clearInterval(maintenance);
      realtime.close();
      await app.close();
      await integrations.stop();
      await demo?.stop();
      db.close();
    },
  };
}
