import { useQuery } from '@tanstack/react-query';
import { Info, X } from 'lucide-react';
import { useState } from 'react';
import type { BootstrapInfo } from '@home-hub/shared';
import { get } from '../lib/api.ts';
import { isNative } from '../lib/platform.ts';
import { useIsAdmin } from '../store/session.ts';
import { IconButton } from './ui.tsx';

/**
 * 1 when a brings newer functions than b, -1 when older, 0 otherwise. Only
 * major and minor count (a fix release of one side changes nothing for the
 * other); development builds are not compared.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())?.slice(1).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y || x.join('.') === '0.0.0' || y.join('.') === '0.0.0') return 0;
  for (let i = 0; i < 2; i++) if (x[i] !== y[i]) return x[i]! > y[i]! ? 1 : -1;
  return 0;
}

const DISMISSED_KEY = 'hh.version-notice';

/**
 * Says so when app and hub do not match — instead of new functions failing
 * with "Nicht gefunden." because the hub does not know them yet.
 */
export function VersionNotice() {
  const isAdmin = useIsAdmin();
  const info = useQuery({ queryKey: ['bootstrap'], queryFn: () => get<BootstrapInfo>('/api/bootstrap'), staleTime: 10 * 60_000 });
  const hub = info.data?.version ?? '';
  const pair = `${hub}|${__APP_VERSION__}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISSED_KEY) === pair;
    } catch {
      return false;
    }
  });
  const order = compareVersions(hub, __APP_VERSION__);
  // The web app comes from the hub itself; only the installed app can be older.
  if (!hub || dismissed || order === 0 || (order > 0 && !isNative)) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISSED_KEY, pair);
    } catch {
      /* private mode: shown again next time */
    }
  };
  return (
    <div role="status" className="mb-5 flex items-start gap-3 rounded-tile bg-accent/15 px-4 py-3 text-sm">
      <Info className="mt-0.5 size-4.5 shrink-0 text-accent" aria-hidden />
      <p className="min-w-0 flex-1">
        {order < 0 ? (
          <>
            <span className="font-medium">Der Hub ist älter als die App</span> (Hub {hub}, App {__APP_VERSION__}). Neue Funktionen gehen erst, wenn der Hub aktualisiert ist
            {isAdmin ? ' – in der VM mit dem Befehl aus der Anleitung („Aktualisieren“).' : ' – sag einem Administrator Bescheid.'}
          </>
        ) : (
          <>
            <span className="font-medium">Für deinen Hub gibt es eine neuere App</span> (Hub {hub}, App {__APP_VERSION__}). Du findest sie auf GitHub unter „Releases“.
          </>
        )}
      </p>
      <IconButton icon={X} size="sm" label="Hinweis schließen" onClick={dismiss} className="-my-1 -mr-1.5" />
    </div>
  );
}
