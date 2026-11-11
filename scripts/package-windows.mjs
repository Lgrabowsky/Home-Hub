#!/usr/bin/env node
// Builds the Windows package: a folder (and zip) that runs Home Hub on a Windows PC
// with a double click. Run after `npm run build`:
//
//   GO2RTC_WINDOWS_BIN=/path/to/go2rtc.exe node scripts/package-windows.mjs
//
// Result: dist-windows/HomeHub-Windows.zip
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-windows');
const pkg = join(out, 'HomeHub');
const app = join(pkg, 'app');

const need = (path, hint) => {
  if (!existsSync(path)) {
    console.error(`missing ${path} – ${hint}`);
    process.exit(1);
  }
};
need(join(root, 'hub/dist/index.js'), 'run `npm run build` first');
need(join(root, 'web/dist/index.html'), 'run `npm run build` first');
const go2rtc = process.env.GO2RTC_WINDOWS_BIN;
if (!go2rtc) {
  console.error('GO2RTC_WINDOWS_BIN is not set (path to go2rtc.exe for windows/amd64)');
  process.exit(1);
}
need(go2rtc, 'build it with: GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go install github.com/AlexxIT/go2rtc@v1.9.15');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(app, 'hub/dist'), { recursive: true });
mkdirSync(join(pkg, 'bin'), { recursive: true });

// The hub bundle and the web app.
cpSync(join(root, 'hub/dist/index.js'), join(app, 'hub/dist/index.js'));
cpSync(join(root, 'web/dist'), join(app, 'web/dist'), { recursive: true });

// The hub's third-party packages (all plain JavaScript), at the versions of the lock file.
const hubPkg = JSON.parse(readFileSync(join(root, 'hub/package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const dependencies = Object.fromEntries(
  Object.keys(hubPkg.dependencies).map((name) => [name, lock.packages[`node_modules/${name}`]?.version ?? hubPkg.dependencies[name]]),
);
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'home-hub-windows', private: true, type: 'module', version: hubPkg.version, dependencies }, null, 2) + '\n');
writeFileSync(join(app, 'hub/package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], { cwd: app, stdio: 'inherit' });

cpSync(go2rtc, join(pkg, 'bin/go2rtc.exe'));

// Windows PowerShell 5.1 reads scripts without a byte order mark as ANSI – umlauts would break.
const BOM = '﻿';
const crlf = (text) => text.replace(/\r?\n/g, '\r\n');
const templates = join(root, 'deploy/windows');
writeFileSync(join(pkg, 'start.ps1'), BOM + crlf(readFileSync(join(templates, 'start.ps1'), 'utf8')));
writeFileSync(join(pkg, 'LIESMICH.txt'), BOM + crlf(readFileSync(join(templates, 'LIESMICH.txt'), 'utf8')));
for (const name of ['Demo starten.cmd', 'Home Hub starten.cmd']) {
  writeFileSync(join(pkg, name), crlf(readFileSync(join(templates, name), 'utf8')));
}

execFileSync('zip', ['-qr9', 'HomeHub-Windows.zip', 'HomeHub'], { cwd: out, stdio: 'inherit' });
console.log(`written ${join(out, 'HomeHub-Windows.zip')}`);
