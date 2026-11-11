import { useLocation, useNavigate } from 'react-router-dom';
import { useHub } from '../store/hub.ts';
import { Cover, groupSubtitle, TransportButtons, useTargetGroup } from './music/parts.tsx';

/**
 * "Now playing" bar that stays reachable from every screen — music is not a
 * place you have to go to, it is simply there.
 */
export function MiniPlayer() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const groups = useHub((state) => state.music.groups);
  const { group: target } = useTargetGroup();
  const hasTrack = target?.track && (target.state === 'playing' || target.state === 'paused' || target.state === 'transitioning');
  const group = hasTrack ? target : groups.find((entry) => entry.state === 'playing' && entry.track);
  // Hidden where it would sit on top of something more important: the music page itself and the settings' save bar.
  if (!group || pathname.startsWith('/musik') || pathname.startsWith('/einstellungen/dienste/')) return null;

  return (
    <>
      {/* Keeps the last bit of page content from hiding behind the bar. */}
      <div className="h-16 md:hidden" aria-hidden />
      <div className="fixed inset-x-2 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-30 md:inset-x-auto md:bottom-5 md:right-5 md:w-96">
        <div className="flex animate-pop items-center gap-2 rounded-2xl bg-raised/95 p-1.5 pr-2 shadow-float backdrop-blur-xl">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
            aria-label={`Musik öffnen: ${group.track?.title ?? group.name}`}
            onClick={() => navigate(`/musik?raum=${encodeURIComponent(group.coordinatorId)}&offen=1`)}
          >
            <Cover src={group.track?.artUrl} className="size-11" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{group.track?.title ?? 'Wiedergabe'}</span>
              <span className="block truncate text-xs text-muted">
                {group.name} · {groupSubtitle(group)}
              </span>
            </span>
          </button>
          <TransportButtons group={group} />
        </div>
      </div>
    </>
  );
}
