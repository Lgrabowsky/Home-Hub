import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HELPER_MARKER, HostControl, REBOOT_REQUEST } from '../src/system/host-control.ts';
import { createTestHub, setupAdmin, type TestHub } from './helpers.ts';

const dirs: string[] = [];
const hubs: TestHub[] = [];

function controlDir(withHelper: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'hub-control-'));
  dirs.push(dir);
  if (withHelper) writeFileSync(join(dir, HELPER_MARKER), '1\n');
  return dir;
}

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.destroy();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('asking the machine to restart', () => {
  it('is only offered where a helper on the machine answers', () => {
    expect(new HostControl(null).canReboot).toBe(false);
    expect(new HostControl(join(tmpdir(), 'does-not-exist-hub-control')).canReboot).toBe(false);
    expect(new HostControl(controlDir(false)).canReboot).toBe(false);
    expect(new HostControl(controlDir(true)).canReboot).toBe(true);
  });

  it('leaves a complete request and nothing else', () => {
    const dir = controlDir(true);
    new HostControl(dir).requestReboot('erika');
    const request = JSON.parse(readFileSync(join(dir, REBOOT_REQUEST), 'utf8')) as { requestedAt: string; by: string };
    expect(request.by).toBe('erika');
    expect(Date.now() - Date.parse(request.requestedAt)).toBeLessThan(5000);
    expect(existsSync(join(dir, `${REBOOT_REQUEST}.tmp`))).toBe(false);
    expect(() => new HostControl(controlDir(false)).requestReboot('erika')).toThrow();
  });
});

describe('restart button', () => {
  it('lets an administrator restart the machine, logs it and refuses where nobody answers', async () => {
    const dir = controlDir(true);
    const hub = await createTestHub({ HUB_HOST_CONTROL_DIR: dir });
    hubs.push(hub);
    const { client: admin } = await setupAdmin(hub);

    const diagnostics = await admin.get('/api/admin/diagnostics');
    expect(diagnostics.json()).toMatchObject({ host: { canReboot: true } });

    const response = await admin.post('/api/admin/system/reboot');
    expect(response.statusCode).toBe(202);
    expect(existsSync(join(dir, REBOOT_REQUEST))).toBe(true);
    const audit = (await admin.get('/api/admin/audit')).json() as { entries: { action: string; username: string | null }[] };
    expect(audit.entries[0]).toMatchObject({ action: 'system.reboot', username: 'admin' });

    // Without the helper (e.g. the Windows version) there is no button and the request is refused.
    rmSync(join(dir, HELPER_MARKER));
    rmSync(join(dir, REBOOT_REQUEST));
    expect((await admin.get('/api/admin/diagnostics')).json()).toMatchObject({ host: { canReboot: false } });
    expect((await admin.post('/api/admin/system/reboot')).statusCode).toBe(503);
    expect(existsSync(join(dir, REBOOT_REQUEST))).toBe(false);
  });

  it('is not there without a shared directory', async () => {
    const hub = await createTestHub();
    hubs.push(hub);
    const { client: admin } = await setupAdmin(hub);
    expect((await admin.get('/api/admin/diagnostics')).json()).toMatchObject({ host: { canReboot: false } });
    expect((await admin.post('/api/admin/system/reboot')).statusCode).toBe(503);
  });
});

