import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface HubConfig {
  version: string;
  host: string;
  port: number;
  dataDir: string;
  /** Canonical external URL of the hub (https://…), if known. */
  publicUrl: URL | null;
  /** Additional browser origins allowed to call the API with a bearer token. */
  extraOrigins: string[];
  trustProxy: boolean | number | string;
  masterKey: string | null;
  demo: boolean;
  logLevel: string;
  /** Directory with the built web app (index.html). */
  webDir: string | null;
  setupToken: string | null;
  media: {
    enabled: boolean;
    go2rtcBin: string;
    ffmpegBin: string;
    webrtcPort: number;
    /** go2rtc `webrtc.candidates` entries, e.g. `home.example.com:8555` or `stun:8555`. */
    candidates: string[];
    /** ICE servers for go2rtc and the browsers. Empty by default: no third party is contacted. */
    iceServers: IceServer[];
    rtspPort: number;
  };
}

/** Origins used by the Capacitor Android shell. */
export const NATIVE_APP_ORIGINS = ['https://localhost', 'capacitor://localhost', 'http://localhost'];

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be a port number, got "${value}"`);
  return n;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (value === undefined || value === '') return false;
  const v = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return 1; // exactly one proxy hop (e.g. Caddy)
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  if (/^\d+$/.test(v)) return Number(v);
  return value.trim(); // comma separated CIDR list
}

function parseIceServers(value: string | undefined): IceServer[] {
  if (!value?.trim()) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) throw new Error('HUB_WEBRTC_ICE_SERVERS must be a JSON array');
    return parsed.map((entry) => {
      const e = entry as { urls?: string | string[]; username?: string; credential?: string };
      const urls = Array.isArray(e.urls) ? e.urls : e.urls ? [e.urls] : [];
      if (urls.length === 0) throw new Error('HUB_WEBRTC_ICE_SERVERS: every entry needs "urls"');
      return { urls, username: e.username, credential: e.credential };
    });
  }
  // Short form: comma separated list of stun:/turn: URLs without credentials.
  return [{ urls: list(trimmed) }];
}

function findWebDir(explicit: string | undefined): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicit,
    resolve(here, '../../web/dist'), // running from hub/dist or hub/src
    resolve(here, '../web'), // docker image layout: /app/dist/index.js + /app/web
    resolve(process.cwd(), 'web/dist'),
    resolve(process.cwd(), '../web/dist'),
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'index.html'))) return resolve(candidate);
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  let publicUrl: URL | null = null;
  if (env.HUB_PUBLIC_URL?.trim()) {
    publicUrl = new URL(env.HUB_PUBLIC_URL.trim());
    if (!['http:', 'https:'].includes(publicUrl.protocol)) {
      throw new Error('HUB_PUBLIC_URL must start with https:// (or http:// for local tests)');
    }
  }

  return {
    version: process.env.HUB_VERSION ?? '0.0.0-dev',
    host: env.HUB_HOST?.trim() || '0.0.0.0',
    port: int(env.HUB_PORT, 8080, 'HUB_PORT'),
    dataDir: resolve(env.HUB_DATA_DIR?.trim() || './data'),
    publicUrl,
    extraOrigins: list(env.HUB_ALLOWED_ORIGINS).map((o) => new URL(o).origin),
    trustProxy: parseTrustProxy(env.HUB_TRUST_PROXY),
    masterKey: env.HUB_MASTER_KEY?.trim() || null,
    demo: bool(env.HUB_DEMO),
    logLevel: env.HUB_LOG_LEVEL?.trim() || 'info',
    webDir: findWebDir(env.HUB_WEB_DIR?.trim()),
    setupToken: env.HUB_SETUP_TOKEN?.trim() || null,
    media: {
      enabled: bool(env.HUB_MEDIA, true),
      go2rtcBin: env.GO2RTC_BIN?.trim() || 'go2rtc',
      ffmpegBin: env.FFMPEG_BIN?.trim() || 'ffmpeg',
      webrtcPort: int(env.HUB_WEBRTC_PORT, 8555, 'HUB_WEBRTC_PORT'),
      candidates: list(env.HUB_WEBRTC_CANDIDATES),
      iceServers: parseIceServers(env.HUB_WEBRTC_ICE_SERVERS),
      rtspPort: int(env.HUB_RTSP_PORT, 8554, 'HUB_RTSP_PORT'),
    },
  };
}
