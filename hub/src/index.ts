import { createHub } from './app.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './log.ts';
import { join } from 'node:path';
import { Vault } from './security/crypto.ts';
import { loadTlsMaterial } from './security/tls.ts';

async function main(): Promise<void> {
  const config = loadConfig();

  // `--prepare-tls`: create/renew the certificate and say where the CA file is (for install scripts).
  if (process.argv.includes('--prepare-tls')) {
    if (config.tls.mode !== 'auto') throw new Error('--prepare-tls needs HUB_TLS=auto');
    const vault = config.tls.dir ? Vault.open(config.tls.dir, null).vault : Vault.open(config.dataDir, config.masterKey).vault;
    const tls = loadTlsMaterial(config, vault)!;
    process.stdout.write(`${JSON.stringify({ caFile: join(config.tls.dir ?? join(config.dataDir, 'tls'), 'ca.crt'), fingerprint: tls.caFingerprint, names: tls.names })}\n`);
    return;
  }
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
  if (hub.ctx.tls) {
    // Plain text like the setup code: the owner compares this with what the phone shows.
    const line = '-'.repeat(64);
    process.stdout.write(
      `\n${line}\n  HTTPS aktiv (Port ${config.tls.httpsPort}). Fingerabdruck des Hub-Zertifikats:\n  ${hub.ctx.tls.caFingerprint}\n` +
        `  Gilt für: ${hub.ctx.tls.names.join(', ')}\n${line}\n\n`,
    );
  }
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
