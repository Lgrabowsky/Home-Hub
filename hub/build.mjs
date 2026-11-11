// Bundles the hub into a single ESM file. Third-party packages stay external
// (they are installed next to it), our own workspace code is inlined.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: Object.keys(pkg.dependencies),
  alias: { '@home-hub/shared': '../shared/src/index.ts' },
  define: { 'process.env.HUB_VERSION': JSON.stringify(pkg.version) },
  logLevel: 'info',
});
