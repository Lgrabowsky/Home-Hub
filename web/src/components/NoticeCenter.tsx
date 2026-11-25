import { AlertTriangle, Bell, BellRing, Eye, ShieldAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatAgo } from '../lib/format.ts';
import { isDismissed, useDismissed, useNotices, type AppNotice } from '../lib/notices.ts';
import { useHub } from '../store/hub.ts';
import { Button, cx, IconButton, Notice, Sheet, toneSoft } from './ui.tsx';

/** "seit 5 Min." — or "gerade eben". */
function sinceText(since: number): string {
  const ago = formatAgo(since);
  return ago.startsWith('vor ') ? `seit ${ago.slice(4)}` : ago;
}

function NoticeIcon({ notice }: { notice: AppNotice }) {
  const Icon = notice.id.startsWith('alarm:') ? ShieldAlert : AlertTriangle;
  return (
    <span className={cx('flex size-9 shrink-0 items-center justify-center rounded-full', toneSoft[notice.tone])}>
      <Icon className="size-4.5" aria-hidden />
    </span>
  );
}

function NoticeItem({ notice, dismissed, onClose }: { notice: AppNotice; dismissed: boolean; onClose(): void }) {
  const dismiss = useDismissed((state) => state.dismiss);
  const restore = useDismissed((state) => state.restore);
  return (
    <li className={cx('flex items-start gap-3 py-3', dismissed && 'opacity-60')}>
      <NoticeIcon notice={notice} />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{notice.title}</p>
        <p className="text-sm text-muted">{notice.text}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-faint">
          {notice.since && <span>{sinceText(notice.since)}</span>}
          {notice.link && (
            <Link to={notice.link.to} onClick={onClose} className="font-medium text-accent">
              {notice.link.label}
            </Link>
          )}
        </p>
      </div>
      {dismissed ? (
        <IconButton icon={Eye} size="sm" label={`${notice.title} wieder anzeigen`} onClick={() => restore(notice.id)} />
      ) : (
        <IconButton icon={X} size="sm" label={`${notice.title} ausblenden`} onClick={() => dismiss([notice])} />
      )}
    </li>
  );
}

/**
 * The notification centre behind a small bell in the page header: everything out of the ordinary,
 * with the dismissed notices below the current ones.
 */
export function NoticeBell() {
  const notices = useNotices();
  const dismissed = useDismissed((state) => state.dismissed);
  const dismiss = useDismissed((state) => state.dismiss);
  const prune = useDismissed((state) => state.prune);
  const loaded = useHub((state) => state.loaded);
  const link = useHub((state) => state.link);
  const [open, setOpen] = useState(false);

  // Problems that are gone are forgotten, so they show again should they return.
  useEffect(() => {
    if (loaded && link === 'online') prune(notices);
  }, [notices, loaded, link, prune]);

  const active = notices.filter((notice) => !isDismissed(notice, dismissed));
  const hidden = notices.filter((notice) => isDismissed(notice, dismissed));
  const urgent = active.some((notice) => notice.tone === 'danger');
  const label = notices.length === 0 ? 'Meldungen: keine' : `Meldungen: ${notices.length}${hidden.length > 0 ? `, ${hidden.length} ausgeblendet` : ''}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        title="Meldungen"
        className="relative inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-sunken hover:text-fg active:scale-95"
      >
        {active.length > 0 ? <BellRing className="size-5" aria-hidden /> : <Bell className="size-5" aria-hidden />}
        {active.length > 0 && (
          <span className={cx('absolute right-1 top-1 flex min-w-4.5 items-center justify-center rounded-full px-1 text-[10px] font-bold leading-[1.125rem]', urgent ? 'bg-danger text-white' : 'bg-warn text-black')} aria-hidden>
            {active.length}
          </span>
        )}
      </button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Meldungen"
        subtitle={notices.length === 0 ? 'Alles in Ordnung' : active.length === 0 ? 'Alle Meldungen ausgeblendet' : `${active.length} ${active.length === 1 ? 'aktuelle Meldung' : 'aktuelle Meldungen'}`}
        footer={
          active.length > 1 ? (
            <Button block icon={X} onClick={() => dismiss(active)}>
              Alle ausblenden
            </Button>
          ) : undefined
        }
      >
        {notices.length === 0 ? (
          <p className="flex items-center gap-2 rounded-control bg-sunken px-4 py-3 text-sm text-muted">
            <Bell className="size-4.5" aria-hidden />
            Gerade gibt es nichts Auffälliges.
          </p>
        ) : (
          <>
            {active.length > 0 && (
              <ul className="divide-y divide-line/70">
                {active.map((notice) => (
                  <NoticeItem key={notice.id} notice={notice} dismissed={false} onClose={() => setOpen(false)} />
                ))}
              </ul>
            )}
            {hidden.length > 0 && (
              <>
                <p className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-faint">Ausgeblendet</p>
                <ul className="divide-y divide-line/70">
                  {hidden.map((notice) => (
                    <NoticeItem key={notice.id} notice={notice} dismissed onClose={() => setOpen(false)} />
                  ))}
                </ul>
              </>
            )}
            <p className="mt-4 text-[13px] text-faint">Ausgeblendete Meldungen erscheinen wieder, wenn sich das Problem ändert oder neu auftritt.</p>
          </>
        )}
      </Sheet>
    </>
  );
}

/** The notices as banners (start page), each with a button to dismiss it. */
export function NoticeBanners({ className }: { className?: string }) {
  const notices = useNotices();
  const dismissed = useDismissed((state) => state.dismissed);
  const dismiss = useDismissed((state) => state.dismiss);
  const shown = notices.filter((notice) => notice.banner && !isDismissed(notice, dismissed));
  if (shown.length === 0) return null;
  return (
    <div className={cx('space-y-2', className)}>
      {shown.map((notice) => (
        <Notice key={notice.id} tone={notice.tone} icon={AlertTriangle} className="pr-2">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 pt-0.5">
              <span className="font-medium">{notice.title}:</span> {notice.text}
              {notice.link && (
                <Link to={notice.link.to} className="ml-1.5 underline underline-offset-2">
                  {notice.link.label}
                </Link>
              )}
            </p>
            <button
              type="button"
              onClick={() => dismiss([notice])}
              aria-label={`Meldung ${notice.title} ausblenden`}
              title="Ausblenden"
              className="-my-1 flex size-8 shrink-0 items-center justify-center rounded-full text-fg/70 transition hover:bg-fg/10 hover:text-fg"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        </Notice>
      ))}
    </div>
  );
}
