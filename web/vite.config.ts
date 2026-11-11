import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * Two targets from one code base:
 *   vite build                → dist/         web app + PWA, served by the hub
 *   vite build --mode native  → dist-native/  bundled into the Android app (Capacitor)
 */
export default defineConfig(({ mode }) => {
  const native = mode === 'native';
  return {
    base: native ? './' : '/',
    plugins: [
      react(),
      tailwindcss(),
      !native &&
        VitePWA({
          registerType: 'autoUpdate',
          // An external script instead of an inline one keeps the hub's strict Content-Security-Policy intact.
          injectRegister: 'script-defer',
          includeAssets: ['favicon.svg', 'icons/*.png'],
          manifest: {
            name: 'Home Hub',
            short_name: 'Home Hub',
            description: 'Licht, Jalousien, Kameras, Türen und Musik in einer App.',
            lang: 'de',
            start_url: '/',
            scope: '/',
            display: 'standalone',
            orientation: 'any',
            background_color: '#0b0e13',
            theme_color: '#0b0e13',
            icons: [
              { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
              { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
              { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            ],
          },
          workbox: {
            // Only the app shell is cached. Nothing under /api ever is: live data and camera
            // pictures must never be stored on the device or served stale.
            globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
            navigateFallback: '/index.html',
            navigateFallbackDenylist: [/^\/api\//],
            cleanupOutdatedCaches: true,
            clientsClaim: true,
            skipWaiting: true,
          },
        }),
    ],
    resolve: {
      alias: {
        '@home-hub/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        // The hub checks the Origin header, so the Host header must stay as the browser sent it.
        // HUB_URL lets several developers (or test runs) point their dev server at their own hub.
        '/api': { target: process.env.HUB_URL ?? 'http://127.0.0.1:8080', ws: true, changeOrigin: false },
      },
    },
    build: {
      outDir: native ? 'dist-native' : 'dist',
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 900,
    },
  };
});
