import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { Db } from '../src/db.ts';
import type { IntegrationDeps } from '../src/integrations/types.ts';
import { createLogger } from '../src/log.ts';
import { AuditLog } from '../src/security/audit.ts';
import { Vault } from '../src/security/crypto.ts';
import { SettingsStore } from '../src/settings.ts';
import { StateStore } from '../src/state.ts';
import { ImageProxy } from '../src/util/images.ts';

export interface TestDeps {
  deps: IntegrationDeps;
  state: StateStore;
  /** Every log line written by the integration (JSON strings) — assert that no secret ever shows up here. */
  logs: string[];
  dataDir: string;
  cleanup(): void;
}

/**
 * Real hub services (state store, settings, database, vault …) in a temporary
 * directory, for testing an integration against its simulator.
 */
export function createTestDeps(): TestDeps {
  const dataDir = mkdtempSync(join(tmpdir(), 'hub-int-'));
  const config = loadConfig({ HUB_DATA_DIR: dataDir, HUB_MEDIA: '0', HUB_LOG_LEVEL: 'debug' });
  const { vault } = Vault.open(dataDir, null);
  const db = new Db(join(dataDir, 'hub.sqlite'));
  const logs: string[] = [];
  const state = new StateStore();
  const images = new ImageProxy(vault);
  // Simulators listen on the loopback interface.
  images.allowLanHost('127.0.0.1');
  const deps: IntegrationDeps = {
    config,
    log: createLogger('debug', {}, (line) => logs.push(line)),
    state,
    settings: new SettingsStore(db, vault),
    db,
    vault,
    audit: new AuditLog(db),
    images,
  };
  return {
    deps,
    state,
    logs,
    dataDir,
    cleanup() {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Polls `check` until it returns a truthy value or the timeout expires. */
export async function waitFor<T>(check: () => T | Promise<T>, timeoutMs = 5000, label = 'condition'): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
