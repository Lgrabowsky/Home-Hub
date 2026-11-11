/**
 * Where the app may connect to.
 *
 * Encrypted (https) always. Unencrypted (http) only to an address inside the
 * home network: there the hub on a PC is reachable without a certificate, and
 * the traffic stays in the own WLAN. Anything that could be on the internet
 * must be https — a password or session sent in clear across the internet
 * would be readable on the way.
 */

export class HubUrlError extends Error {}

function isPrivateIPv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    // Tailscale and other carrier-grade NAT ranges: reachable only through the private network.
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** True for addresses that can only exist inside a home network. */
export function isHomeNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isPrivateIPv4(host)) return true;
  if (/^(fe[89ab][0-9a-f]|f[cd][0-9a-f]{2}):/i.test(host)) return true;
  // Names the home router hands out; a name without dots is never resolved on the internet.
  if (/\.(local|lan|home|internal|home\.arpa|fritz\.box)$/.test(host)) return true;
  return /^[a-z0-9-]+$/.test(host) && host !== 'localhost';
}

/** Turns what the user typed into the hub's origin, or explains why it cannot be used. */
export function normaliseHubUrl(input: string): { origin: string; encrypted: boolean } {
  let url = input.trim().replace(/\/+$/, '');
  if (!url) throw new HubUrlError('Bitte die Adresse des Hubs eingeben.');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^https?:\/\//i.test(url)) {
    throw new HubUrlError('Die Adresse muss mit https:// (oder im Heimnetz mit http://) beginnen.');
  }
  if (!/^https?:\/\//i.test(url)) {
    // Without a scheme: a home-network address is most likely the hub on a PC (http), anything else https.
    const host = url.split(/[/:]/)[0] ?? '';
    url = `${isHomeNetworkHost(host) ? 'http' : 'https'}://${url}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HubUrlError('Das ist keine gültige Adresse.');
  }
  if (parsed.protocol === 'https:') return { origin: parsed.origin, encrypted: true };
  if (parsed.protocol === 'http:' && isHomeNetworkHost(parsed.hostname)) return { origin: parsed.origin, encrypted: false };
  if (parsed.protocol === 'http:') {
    throw new HubUrlError('Unverschlüsselt (http://) verbindet sich die App nur mit Adressen im Heimnetz, z. B. http://192.168.178.20:8080. Von unterwegs bitte die https-Adresse verwenden.');
  }
  throw new HubUrlError('Die Adresse muss mit https:// (oder im Heimnetz mit http://) beginnen.');
}
