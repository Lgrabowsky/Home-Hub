// Renders the app icons (PWA, Apple touch icon, Android launcher) from one SVG source.
// Run with: node scripts/make-icons.mjs   (needs Playwright's Chromium)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The mark: a house with a warm light inside. `pad` shrinks it for maskable / adaptive icons. */
const mark = (pad) => `
  <g transform="translate(32 32) scale(${1 - pad}) translate(-32 -32)">
    <path d="M32 13 12 30.5a2 2 0 0 0 1.3 3.5H17v13.5a3.5 3.5 0 0 0 3.5 3.5h23a3.5 3.5 0 0 0 3.5-3.5V34h3.7a2 2 0 0 0 1.3-3.5Z" fill="url(#g)"/>
    <circle cx="32" cy="37" r="6.2" fill="#0b0e13"/>
    <circle cx="32" cy="37" r="2.6" fill="#ffd27a"/>
  </g>`;

const svg = ({ pad = 0, radius = 15, background = '#0b0e13' }) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6aa2ff"/><stop offset="1" stop-color="#7a5cff"/></linearGradient></defs>
  ${background ? `<rect width="64" height="64" rx="${radius}" fill="${background}"/>` : ''}
  ${mark(pad)}
</svg>`;

const targets = [
  // Web / PWA
  { file: 'public/icons/icon-192.png', size: 192, svg: svg({}) },
  { file: 'public/icons/icon-512.png', size: 512, svg: svg({}) },
  { file: 'public/icons/icon-maskable-512.png', size: 512, svg: svg({ pad: 0.22, radius: 0 }) },
  { file: 'public/icons/apple-touch-icon.png', size: 180, svg: svg({ radius: 0 }) },
  // Android launcher (legacy square + round for old launchers; adaptive layers for Android 8+)
  ...[
    ['mdpi', 48],
    ['hdpi', 72],
    ['xhdpi', 96],
    ['xxhdpi', 144],
    ['xxxhdpi', 192],
  ].flatMap(([density, size]) => [
    { file: `android/app/src/main/res/mipmap-${density}/ic_launcher.png`, size, svg: svg({ radius: 14 }) },
    { file: `android/app/src/main/res/mipmap-${density}/ic_launcher_round.png`, size, svg: svg({ radius: 32 }) },
    { file: `android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`, size: Math.round(size * 2.25), svg: svg({ pad: 0.42, background: null }) },
  ]),
  // Splash mark
  { file: 'android/app/src/main/res/drawable/splash_mark.png', size: 512, svg: svg({ pad: 0.1, background: null }) },
];

const only = process.argv[2]; // e.g. "public" to skip the Android files
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const target of targets) {
  if (only && !target.file.startsWith(only)) continue;
  await page.setViewportSize({ width: target.size, height: target.size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${target.svg}`);
  const out = resolve(root, target.file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, await page.screenshot({ omitBackground: true, type: 'png' }));
  console.log('wrote', target.file);
}
await browser.close();
