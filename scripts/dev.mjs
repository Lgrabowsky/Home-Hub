#!/usr/bin/env node
// Development: runs the hub (with reload on change) and the web app's dev server together.
//   npm run dev            → hub on :8080, app on http://localhost:5173 (proxies /api to the hub)
//   HUB_DEMO=1 npm run dev → the same with simulated devices
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [
  spawn(npm, ['run', 'dev', '-w', 'hub'], { stdio: 'inherit', env: { HUB_SETUP_TOKEN: 'DEMO-DEMO-DEMO', ...process.env } }),
  spawn(npm, ['run', 'dev', '-w', 'web'], { stdio: 'inherit' }),
];

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) child.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
