import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TlsMaterial } from '../security/tls.ts';

/**
 * Everything a device needs before it trusts the hub's own certificate:
 * a page that explains the one-time step, and the CA certificate to install.
 *
 * With HTTPS switched on, the plain-HTTP port serves only this (plus a
 * redirect to https for everything else) — no app, no API, no session ever
 * travels unencrypted.
 */

export const CA_PATH = '/hub-ca.crt';
export const CERT_PAGE_PATH = '/zertifikat';

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** A Host header we are willing to put into a link or a redirect. */
export function safeHost(header: string | undefined): string | null {
  const value = (header ?? '').trim();
  if (!value || value.length > 255) return null;
  // Name or IPv4 with optional port, or a bracketed IPv6 address with optional port.
  return /^([a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d{1,5})?$/i.test(value) ? value : null;
}

export function hostWithoutPort(host: string): string {
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
}

export function certificatePage(tls: TlsMaterial, httpsOrigin: string | null): string {
  const fingerprint = tls.caFingerprint;
  const own = tls.source === 'own';
  const steps = own
    ? '<p>Dieser Hub verwendet ein eigenes Zertifikat. Ist es nicht öffentlich anerkannt, installiere die Datei unten als vertrauenswürdige Zertifizierungsstelle.</p>'
    : `<p>Damit Browser und App dem Hub ohne Warnung vertrauen, installierst du <b>einmal pro Gerät</b> sein Zertifikat.
       Es gilt nur für Adressen im Heimnetz (z.&nbsp;B. 192.168.…) – für Webseiten im Internet kann es nichts bescheinigen.</p>`;
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Home Hub – sichere Verbindung einrichten</title>
<style>
:root{color-scheme:dark light}body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0b0e15;color:#e8ecf3;margin:0;line-height:1.5}
main{max-width:40rem;margin:0 auto;padding:2rem 1.25rem 3rem}h1{font-size:1.6rem;margin:.2rem 0 1rem}h2{font-size:1.05rem;margin:1.8rem 0 .4rem}
a.button{display:inline-block;background:#7aa2ff;color:#0b0e15;font-weight:600;text-decoration:none;padding:.75rem 1.1rem;border-radius:.8rem;margin:.3rem .4rem .3rem 0}
a.secondary{background:#1c2330;color:#e8ecf3}ol{padding-left:1.25rem}li{margin:.25rem 0}code{font-size:.85rem;word-break:break-all;background:#151a24;padding:.15rem .35rem;border-radius:.35rem}
.box{background:#151a24;border-radius:1rem;padding:1rem 1.1rem;margin:1rem 0}small{color:#9aa4b5}
</style></head><body><main>
<h1>Sichere Verbindung einrichten</h1>
${steps}
<p><a class="button" href="${CA_PATH}" download="HomeHub-Zertifikat.crt">Zertifikat herunterladen</a>
${httpsOrigin ? `<a class="button secondary" href="${escape(httpsOrigin)}/">Weiter zum Hub (https)</a>` : ''}</p>
<div class="box"><small>Fingerabdruck (SHA-256) – vergleiche ihn mit dem, der im Fenster des Hubs auf dem PC steht:</small><br><code>${escape(fingerprint)}</code></div>
<h2>Android</h2>
<ol><li>Zertifikat herunterladen.</li>
<li><b>Einstellungen › Sicherheit</b> (je nach Hersteller „Sicherheit und Datenschutz“ oder „Biometrie und Sicherheit“) › <b>Weitere Sicherheitseinstellungen › Verschlüsselung &amp; Anmeldedaten › Zertifikat installieren › CA-Zertifikat</b>. Tipp: In den Einstellungen nach „CA-Zertifikat“ suchen.</li>
<li>Die Warnung bestätigen und die Datei <i>HomeHub-Zertifikat.crt</i> aus „Downloads“ wählen.</li>
<li>In der Home-Hub-App als Adresse <code>${escape(httpsOrigin ?? 'https://<IP des Hubs>:8443')}</code> eintragen.</li></ol>
<h2>iPhone / iPad</h2>
<ol><li>In Safari das Zertifikat herunterladen und „Zulassen“ wählen.</li>
<li><b>Einstellungen › Profil geladen › Installieren</b>.</li>
<li><b>Einstellungen › Allgemein › Info › Zertifikatsvertrauenseinstellungen</b>: „Home Hub …“ einschalten.</li></ol>
<h2>Windows</h2>
<p>Auf dem PC, auf dem der Hub läuft, erledigt das Startfenster das (Windows fragt einmal nach). Auf anderen PCs: Datei öffnen › <b>Zertifikat installieren › Aktueller Benutzer › Alle Zertifikate in folgendem Speicher speichern › Vertrauenswürdige Stammzertifizierungsstellen</b>.</p>
<h2>Mac</h2>
<p>Datei öffnen (Schlüsselbundverwaltung), Zertifikat doppelklicken, unter „Vertrauen“ <b>Immer vertrauen</b> wählen.</p>
<p><small>Danach Browser bzw. App einmal neu öffnen. Firefox verwendet eigene Einstellungen: Einstellungen › Datenschutz &amp; Sicherheit › Zertifikate › Importieren.</small></p>
</main></body></html>`;
}

export interface CertificateHelper {
  close(): Promise<void>;
  address: string;
}

/** The plain-HTTP port while HTTPS is on: the certificate, its page, and a redirect for everything else. */
export async function startCertificateHelper(options: { host: string; port: number; httpsPort: number; tls: () => TlsMaterial }): Promise<CertificateHelper> {
  const server = http.createServer((req, res) => {
    const headers = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Cache-Control': 'no-store',
    };
    const host = safeHost(req.headers.host);
    const httpsOrigin = host ? `https://${hostWithoutPort(host)}:${options.httpsPort}` : null;
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, Allow: 'GET, HEAD' });
      return void res.end();
    }
    if (path === CA_PATH) {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="HomeHub-Zertifikat.crt"' });
      return void res.end(req.method === 'HEAD' ? undefined : options.tls().caCert);
    }
    if (path === '/' || path === CERT_PAGE_PATH) {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      return void res.end(req.method === 'HEAD' ? undefined : certificatePage(options.tls(), httpsOrigin));
    }
    if (path === '/api/health') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ ok: true, https: options.httpsPort }));
    }
    if (!httpsOrigin) {
      res.writeHead(400, headers);
      return void res.end();
    }
    res.writeHead(308, { ...headers, Location: `${httpsOrigin}${(req.url ?? '/').startsWith('/') ? req.url : '/'}` });
    res.end();
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    address: `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
