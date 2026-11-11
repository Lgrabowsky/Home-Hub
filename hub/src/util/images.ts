import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Vault } from '../security/crypto.ts';

/**
 * Artwork proxy.
 *
 * Cover art lives on Sonos speakers (LAN only) and on public CDNs. The apps
 * never load it from there directly: the hub hands out signed, hub-relative
 * URLs (`/api/img?u=…&s=…`) and fetches the picture itself. That keeps the
 * app's Content-Security-Policy strict, works from outside the home network
 * and does not reveal who is listening to which CDN.
 *
 * Only URLs signed by this hub are fetched, and targets inside private
 * networks are refused unless they were registered explicitly (the Sonos
 * players), so the endpoint cannot be abused to probe the home network.
 */

export interface ProxiedImage {
  body: Buffer;
  contentType: string;
}

const MAX_BYTES = 6 * 1024 * 1024;
const CACHE_BUDGET = 48 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
  }
  return true;
}

export class ImageProxy {
  private readonly lanHosts = new Set<string>();
  private readonly cache = new Map<string, ProxiedImage>();
  private cacheBytes = 0;
  private readonly inflight = new Map<string, Promise<ProxiedImage | null>>();

  constructor(private readonly vault: Vault) {}

  /** Allows fetching from a host inside the home network (e.g. a Sonos player's IP). */
  allowLanHost(host: string): void {
    this.lanHosts.add(host.toLowerCase());
  }

  /** Turns a remote image URL into a hub-relative, signed URL. Returns null for anything unusable. */
  url(remote: string | null | undefined): string | null {
    if (!remote) return null;
    let parsed: URL;
    try {
      parsed = new URL(remote);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const encoded = Buffer.from(parsed.toString(), 'utf8').toString('base64url');
    if (encoded.length > 3000) return null;
    return `/api/img?u=${encoded}&s=${this.vault.sign('img', encoded)}`;
  }

  /** Fetches the image behind a URL created by `url()`. */
  async fetch(encoded: string, signature: string): Promise<ProxiedImage | null> {
    if (!encoded || encoded.length > 3000 || !this.vault.verify('img', encoded, signature)) return null;
    const cached = this.cache.get(encoded);
    if (cached) {
      // Refresh the entry's position (cheap LRU).
      this.cache.delete(encoded);
      this.cache.set(encoded, cached);
      return cached;
    }
    let pending = this.inflight.get(encoded);
    if (!pending) {
      pending = this.load(Buffer.from(encoded, 'base64url').toString('utf8'))
        .catch(() => null)
        .then((image) => {
          this.inflight.delete(encoded);
          if (image) this.remember(encoded, image);
          return image;
        });
      this.inflight.set(encoded, pending);
    }
    return pending;
  }

  private remember(key: string, image: ProxiedImage): void {
    if (image.body.length > CACHE_BUDGET / 8) return;
    this.cache.set(key, image);
    this.cacheBytes += image.body.length;
    for (const [oldKey, old] of this.cache) {
      if (this.cacheBytes <= CACHE_BUDGET) break;
      this.cache.delete(oldKey);
      this.cacheBytes -= old.body.length;
    }
  }

  private async load(remote: string, redirects = 0): Promise<ProxiedImage | null> {
    const url = new URL(remote);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');

    // Resolve first and connect to the checked address, so a DNS answer cannot
    // change between the check and the request.
    const address = isIP(hostname) ? hostname : (await lookup(hostname, { family: 0 })).address;
    const lanAllowed = this.lanHosts.has(hostname.toLowerCase()) || this.lanHosts.has(address);
    if (isPrivateAddress(address) && !lanAllowed) return null;

    const secure = url.protocol === 'https:';
    const response = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const request = (secure ? https : http).request(
        {
          host: address,
          servername: isIP(hostname) ? undefined : hostname,
          port: url.port || (secure ? 443 : 80),
          path: url.pathname + url.search,
          method: 'GET',
          headers: { Host: url.host, Accept: 'image/*', 'User-Agent': 'HomeHub' },
          // Speakers on the LAN do not use TLS; public hosts get full certificate validation.
          timeout: TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BYTES) {
              request.destroy(new Error('image too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        },
      );
      request.on('timeout', () => request.destroy(new Error('timeout')));
      request.on('error', reject);
      request.end();
    });

    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      if (redirects >= MAX_REDIRECTS) return null;
      return this.load(new URL(response.headers.location, url).toString(), redirects + 1);
    }
    const contentType = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (response.status !== 200 || !/^image\/(jpeg|png|webp|gif|avif|bmp|x-icon|vnd\.microsoft\.icon)$/.test(contentType)) return null;
    if (response.body.length === 0) return null;
    return { body: response.body, contentType };
  }
}

/** `image/png` or `image/jpeg`, judged by the file signature (devices are not always honest about it). */
export function sniffImageType(data: Buffer): 'image/png' | 'image/jpeg' {
  return data.length > 3 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 ? 'image/png' : 'image/jpeg';
}
