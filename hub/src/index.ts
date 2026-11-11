import { createHub } from './app.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './log.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);

  // An integration bug must never take the whole hub down.
  process.on('unhandledRejection', (reason) => log.error({ err: reason }, 'unhandled promise rejection'));
  process.on('uncaughtException', (err) => log.error({ err }, 'uncaught exception'));

  const hub = await createHub(config, { log });
  const address = await hub.start();
  log.info(
    {
      address,
      version: config.version,
      dataDir: config.dataDir,
      demo: config.demo,
      web: config.webDir ?? 'not found (API only)',
      publicUrl: config.publicUrl?.origin ?? null,
    },
    'Home Hub is running',
  );
  if (config.demo) log.info('Demo-Modus: alle Geräte sind simuliert.');
  if (!config.publicUrl) {
    log.info('HUB_PUBLIC_URL ist nicht gesetzt – für den Zugriff von außen und für Spotify bitte die https://-Adresse des Hubs eintragen.');
  }

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    hub.stop().then(
      () => process.exit(0),
      (err) => {
        log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  // Configuration problems end up here: say it plainly and stop.
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Home Hub konnte nicht starten: ${message}\n`);
  process.exit(1);
});
