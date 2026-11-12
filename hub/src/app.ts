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
import { startCertificateHelper, type CertificateHelper } from './http/certificate.ts';
import { buildServer } from './http/server.ts';
import { IntegrationManager } from './integrations/manager.ts';
import { createLogger, type Logger } from './log.ts';
import { RealtimeHub } from './realtime.ts';
import { AuditLog } from './security/audit.ts';
import { Vault } from './security/crypto.ts';
import { RateLimiter, Throttle } from './security/throttle.ts';
import { loadTlsMaterial, type TlsMaterial } from './security/tls.ts';
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

  // HTTPS by the hub itself: its own certificate (renewed when it ages or the addresses change) or the owner's.
  const loadTls = (): TlsMaterial | null => loadTlsMaterial(config, vault);
  const tls = loadTls();
  if (tls) {
    log.info({ names: tls.names, fingerprint: tls.caFingerprint, validUntil: tls.serverNotAfter.toISOString() }, 'HTTPS certificate ready');
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
    tls,
  };

  const app = await buildServer(ctx);
  realtime.on('activity', (active) => integrations.setActive(active));
  // Live video must not outlive the session that started it.
  sessions.on('ended', (sessionId) => integrations.media.endSession(sessionId));

  let demo: DemoHandle | null = null;
  let maintenance: NodeJS.Timeout | null = null;
  let helper: CertificateHelper | null = null;

  /** New addresses or an ageing certificate: issue a new one and hand it to the running server. */
  const renewTls = () => {
    if (config.tls.mode !== 'auto' || !ctx.tls) return;
    const next = loadTls();
    if (!next || next.cert === ctx.tls.cert) return;
    ctx.tls = next;
    (app.server as unknown as { setSecureContext(options: { key: string; cert: string }): void }).setSecureContext({ key: next.key, cert: next.cert });
    log.info({ names: next.names, validUntil: next.serverNotAfter.toISOString() }, 'HTTPS certificate renewed');
  };
  let stopped = false;

  return {
    ctx,
    app,
    async start() {
      if (config.demo) demo = await startDemo(ctx);
      await integrations.start();
      await demo?.ready();
      const address = await app.listen({ host: config.host, port: ctx.tls ? config.tls.httpsPort : config.port });
      if (ctx.tls) {
        helper = await startCertificateHelper({ host: config.host, port: config.port, httpsPort: config.tls.httpsPort, tls: () => ctx.tls! });
      }
      maintenance = setInterval(
        () => {
          try {
            sessions.cleanup();
            audit.cleanup();
            renewTls();
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
      await helper?.close();
      await app.close();
      await integrations.stop();
      await demo?.stop();
      db.close();
    },
  };
}
