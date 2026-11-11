import { Home, LayoutGrid, Menu, Music2, Shield, WifiOff, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { NavLink, Outlet, useLocation, useNavigationType } from 'react-router-dom';
import { useHub } from '../store/hub.ts';
import { useCan } from '../store/session.ts';
import { DoorbellOverlay } from './DoorbellOverlay.tsx';
import { Logo } from './Logo.tsx';
import { MiniPlayer } from './MiniPlayer.tsx';
import { cx, Spinner } from './ui.tsx';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  /** Further path prefixes that belong to this section. */
  also?: string[];
}

const NAV: NavItem[] = [
  { to: '/', label: 'Übersicht', icon: Home, end: true },
  { to: '/raeume', label: 'Räume', icon: LayoutGrid },
  { to: '/sicherheit', label: 'Sicherheit', icon: Shield },
  { to: '/musik', label: 'Musik', icon: Music2 },
  { to: '/mehr', label: 'Mehr', icon: Menu, also: ['/einstellungen'] },
];

/** Number shown on the "Sicherheit" tab: things that want attention. */
function useSecurityBadge(): number {
  const entities = useHub((state) => state.entities);
  const allowed = useCan('security.view');
  return useMemo(() => {
    if (!allowed) return 0;
    let count = 0;
    for (const entity of Object.values(entities)) {
      if (entity.kind === 'contact' && entity.open) count++;
      else if (entity.kind === 'alarm' && entity.triggered) count++;
    }
    return count;
  }, [entities, allowed]);
}

function ScrollToTop() {
  const { pathname } = useLocation();
  const type = useNavigationType();
  useEffect(() => {
    if (type !== 'POP') window.scrollTo(0, 0);
  }, [pathname, type]);
  return null;
}

/** Tells the user when the screen may be out of date — quietly, and only when it lasts. */
function ConnectionBanner() {
  const link = useHub((state) => state.link);
  const loaded = useHub((state) => state.loaded);
  if (link === 'online' || !loaded) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-40 flex justify-center px-4 pt-[calc(env(safe-area-inset-top)+0.5rem)]" role="status">
      <div className={cx('flex animate-pop items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium shadow-float', link === 'offline' ? 'bg-danger text-white' : 'bg-raised text-muted')}>
        {link === 'offline' ? <WifiOff className="size-4" aria-hidden /> : <Spinner className="size-4" />}
        {link === 'offline' ? 'Keine Verbindung zum Hub' : 'Verbindung wird hergestellt …'}
      </div>
    </div>
  );
}

export function AppShell() {
  const { pathname } = useLocation();
  const hubName = useHub((state) => state.hubName);
  const loaded = useHub((state) => state.loaded);
  const badge = useSecurityBadge();

  const isActive = (item: NavItem) =>
    item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`) || (item.also ?? []).some((prefix) => pathname.startsWith(prefix));

  return (
    <div className="min-h-dvh md:pl-20 lg:pl-60">
      <ScrollToTop />
      <ConnectionBanner />

      {/* Sidebar (tablet / desktop) */}
      <nav aria-label="Hauptnavigation" className="fixed inset-y-0 left-0 z-30 hidden w-20 flex-col border-r border-line bg-surface/60 px-3 py-5 backdrop-blur-xl md:flex lg:w-60">
        <div className="mb-7 flex items-center gap-3 px-1 lg:px-2">
          <Logo className="size-10 shrink-0" />
          <span className="hidden truncate text-lg font-bold tracking-tight lg:block">{hubName}</span>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          {NAV.map((item) => {
            const active = isActive(item);
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'relative flex h-12 items-center justify-center gap-3 rounded-control px-3 font-medium transition lg:justify-start',
                  active ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-sunken hover:text-fg',
                )}
              >
                <item.icon className="size-5.5 shrink-0" aria-hidden />
                <span className="hidden lg:block">{item.label}</span>
                <span className="sr-only lg:hidden">{item.label}</span>
                {item.to === '/sicherheit' && badge > 0 && (
                  <span className="absolute right-2 top-1.5 flex min-w-5 items-center justify-center rounded-full bg-warn px-1.5 text-xs font-bold text-black lg:static lg:ml-auto" aria-label={`${badge} offen`}>
                    {badge}
                  </span>
                )}
              </NavLink>
            );
          })}
        </div>
      </nav>

      <main className="mx-auto w-full max-w-6xl px-4 pb-nav pt-[calc(env(safe-area-inset-top)+0.75rem)] md:px-8 md:pb-28 md:pt-8">
        {loaded ? (
          <Outlet />
        ) : (
          <div className="flex min-h-[60dvh] items-center justify-center">
            <Spinner className="size-7" />
          </div>
        )}
      </main>

      <MiniPlayer />

      {/* Tab bar (phones) */}
      <nav aria-label="Hauptnavigation" className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/85 backdrop-blur-xl md:hidden">
        <div className="mx-auto flex max-w-lg">
          {NAV.map((item) => {
            const active = isActive(item);
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                aria-current={active ? 'page' : undefined}
                className={cx('relative flex h-[3.75rem] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition active:scale-95', active ? 'text-accent' : 'text-muted')}
              >
                <span className="relative">
                  <item.icon className="size-6" aria-hidden />
                  {item.to === '/sicherheit' && badge > 0 && (
                    <span className="absolute -right-2.5 -top-1.5 flex min-w-4.5 items-center justify-center rounded-full bg-warn px-1 text-[10px] font-bold leading-[1.125rem] text-black" aria-label={`${badge} offen`}>
                      {badge}
                    </span>
                  )}
                </span>
                {item.label}
              </NavLink>
            );
          })}
        </div>
      </nav>

      <DoorbellOverlay />
    </div>
  );
}
