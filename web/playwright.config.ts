import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests: the real, built hub in demo mode (all devices simulated,
 * the integrations talking to them over real sockets) serving the built app,
 * driven through a browser.
 *
 *   npm run build            (once, from the repository root)
 *   npm run e2e -w web
 *
 * Live video needs `go2rtc` and `ffmpeg` (set GO2RTC_BIN / FFMPEG_BIN if they
 * are not on the PATH); without them the video tests are skipped.
 */

const PORT = Number(process.env.HH_E2E_PORT ?? 18480);
// One data directory per run; workers inherit it through the environment.
process.env.HH_E2E_DATA ??= mkdtempSync(join(tmpdir(), 'home-hub-e2e-'));

export const ADMIN = { name: 'Erika Muster', username: 'erika', password: 'Ein-langes-Test-Passwort-1' };
export const STORAGE = 'e2e/.auth/admin.json';

export default defineConfig({
  testDir: './e2e',
  // One simulated household is shared by all tests; they change its state.
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    colorScheme: 'dark',
    trace: 'retain-on-failure',
    permissions: ['microphone'],
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/, use: { ...devices['Pixel 7'] } },
    { name: 'phone', dependencies: ['setup'], use: { ...devices['Pixel 7'], storageState: STORAGE } },
  ],
  webServer: {
    command: 'node ../hub/dist/index.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    env: {
      HUB_DEMO: '1',
      HUB_HOST: '127.0.0.1',
      HUB_PORT: String(PORT),
      HUB_WEBRTC_PORT: String(PORT + 1),
      HUB_RTSP_PORT: String(PORT + 2),
      HUB_DATA_DIR: process.env.HH_E2E_DATA,
      HUB_SETUP_TOKEN: 'DEMO-DEMO-DEMO',
      HUB_LOG_LEVEL: 'warn',
      HUB_WEB_DIR: join(import.meta.dirname, 'dist'),
    },
  },
});
