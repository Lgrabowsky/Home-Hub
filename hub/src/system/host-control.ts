import { accessSync, constants, existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Asks the machine the hub runs on to restart – without giving the hub any power over it.
 *
 * The hub runs unprivileged (in Docker: read-only, without capabilities, as an ordinary user).
 * The set-up script for Linux (deploy/linux/install.sh) installs a small helper on the machine
 * that shares one directory with the hub (HUB_HOST_CONTROL_DIR) and watches it with a systemd
 * path unit. All the hub can do is put a request file there; the helper checks that the request
 * is fresh, removes it and restarts the machine. The helper marks the directory with the file
 * `helper`, so the app only offers the button where somebody will answer it.
 */

export const HELPER_MARKER = 'helper';
export const REBOOT_REQUEST = 'reboot-request';

export class HostControl {
  constructor(private readonly dir: string | null) {}

  /** A helper on the machine is installed and the hub may leave it a request. */
  get canReboot(): boolean {
    if (!this.dir) return false;
    try {
      if (!existsSync(join(this.dir, HELPER_MARKER))) return false;
      accessSync(this.dir, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Leaves the request; the helper restarts the machine within a few seconds. */
  requestReboot(by: string): void {
    if (!this.dir || !this.canReboot) throw new Error('No helper on the host machine');
    const file = join(this.dir, REBOOT_REQUEST);
    // Written aside and renamed, so the helper never sees half a file.
    const temp = `${file}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ requestedAt: new Date().toISOString(), by })}\n`, { mode: 0o640 });
    renameSync(temp, file);
  }
}
