import { DoorOpen, KeyRound, LogIn, LogOut, ScrollText, Settings2, ShieldAlert, ShieldCheck, UserRound, type LucideIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { AuditEntry } from '@home-hub/shared';
import { Button, cx, EmptyState, Notice, PageHeader, Segmented, Spinner, toneSoft, type Tone } from '../../../components/ui.tsx';
import { errorMessage, get } from '../../../lib/api.ts';
import { formatDay, formatTime } from '../../../lib/format.ts';

type Category = 'login' | 'door' | 'change';
interface Described {
  icon: LucideIcon;
  tone: Tone;
  category: Category;
  text: string;
}

const AREAS: Record<string, string> = { general: 'Allgemein', mygekko: 'Gebäude', doorbird: 'Türstationen', reolink: 'Kameras', sonos: 'Lautsprecher', spotify: 'Spotify' };

/** Turns a raw audit record into a sentence a home owner understands. */
function describe(entry: AuditEntry): Described {
  const who = entry.username ?? 'Jemand';
  const detail = entry.detail ?? {};
  const text = (value: unknown, fallback = '') => (typeof value === 'string' && value ? value : fallback);
  switch (entry.action) {
    case 'login.success':
      return { icon: LogIn, tone: 'ok', category: 'login', text: `${who} hat sich angemeldet${detail.client === 'native' ? ' (App)' : ''}` };
    case 'login.failed':
      return { icon: ShieldAlert, tone: 'danger', category: 'login', text: `Fehlgeschlagene Anmeldung für „${who}“ (${detail.reason === 'second_factor' ? 'falscher Code' : 'falsche Zugangsdaten'})` };
    case 'logout':
      return { icon: LogOut, tone: 'neutral', category: 'login', text: `${who} hat sich abgemeldet` };
    case 'setup.completed':
      return { icon: ShieldCheck, tone: 'ok', category: 'change', text: `Der Hub wurde eingerichtet (${who})` };
    case 'setup.failed':
      return { icon: ShieldAlert, tone: 'danger', category: 'login', text: 'Falscher Einrichtungscode eingegeben' };
    case 'password.changed':
      return { icon: KeyRound, tone: 'accent', category: 'change', text: `${who} hat das eigene Passwort geändert` };
    case 'totp.enabled':
      return { icon: ShieldCheck, tone: 'ok', category: 'change', text: `${who} hat die Zwei-Faktor-Anmeldung eingerichtet` };
    case 'totp.disabled':
      return { icon: ShieldAlert, tone: 'warn', category: 'change', text: `${who} hat die Zwei-Faktor-Anmeldung deaktiviert` };
    case 'totp.recovery_codes_renewed':
      return { icon: KeyRound, tone: 'accent', category: 'change', text: `${who} hat neue Wiederherstellungscodes erzeugt` };
    case 'session.revoked':
    case 'session.revoked_others':
      return { icon: LogOut, tone: 'neutral', category: 'login', text: `${who} hat ein Gerät abgemeldet` };
    case 'user.created':
      return { icon: UserRound, tone: 'accent', category: 'change', text: `${who} hat „${text(detail.username)}“ angelegt` };
    case 'user.updated':
      return { icon: UserRound, tone: 'accent', category: 'change', text: `${who} hat „${text(detail.username)}“ geändert${detail.disabled ? ' (deaktiviert)' : ''}` };
    case 'user.password_reset':
      return { icon: KeyRound, tone: 'warn', category: 'change', text: `${who} hat das Passwort von „${text(detail.username)}“ zurückgesetzt` };
    case 'user.totp_reset':
      return { icon: ShieldAlert, tone: 'warn', category: 'change', text: `${who} hat die Zwei-Faktor-Anmeldung von „${text(detail.username)}“ zurückgesetzt` };
    case 'user.sessions_revoked':
      return { icon: LogOut, tone: 'neutral', category: 'change', text: `${who} hat „${text(detail.username)}“ überall abgemeldet` };
    case 'user.deleted':
      return { icon: UserRound, tone: 'danger', category: 'change', text: `${who} hat „${text(detail.username)}“ gelöscht` };
    case 'settings.changed':
      return { icon: Settings2, tone: 'accent', category: 'change', text: `${who} hat Einstellungen geändert (${AREAS[text(detail.area)] ?? text(detail.area, 'unbekannt')})` };
    case 'door.opened':
      return { icon: DoorOpen, tone: 'warn', category: 'door', text: `${who} hat ${text(detail.door, 'eine Tür')} geöffnet${detail.relay ? ` (${text(detail.relay)})` : ''}` };
    case 'door.open_failed':
      return { icon: DoorOpen, tone: 'danger', category: 'door', text: `${who} konnte ${text(detail.door, 'eine Tür')} nicht öffnen` };
    case 'spotify.linked':
      return { icon: Settings2, tone: 'ok', category: 'change', text: `Spotify wurde verbunden${detail.account ? ` (${text(detail.account)})` : ''}` };
    case 'spotify.unlinked':
      return { icon: Settings2, tone: 'neutral', category: 'change', text: `${who} hat Spotify getrennt` };
    default:
      return { icon: ScrollText, tone: 'neutral', category: 'change', text: `${who}: ${entry.action}` };
  }
}

export function AuditPage() {
  const [filter, setFilter] = useState<'all' | Category>('all');
  const query = useInfiniteQuery({
    queryKey: ['audit'],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => get<{ entries: AuditEntry[] }>(`/api/admin/audit?limit=100${pageParam ? `&before=${pageParam}` : ''}`),
    getNextPageParam: (last) => (last.entries.length === 100 ? last.entries[last.entries.length - 1]!.id : null),
    staleTime: 10_000,
  });
  const days = useMemo(() => {
    const groups: { day: string; rows: { entry: AuditEntry; info: Described }[] }[] = [];
    for (const entry of query.data?.pages.flatMap((page) => page.entries) ?? []) {
      const info = describe(entry);
      if (filter !== 'all' && info.category !== filter) continue;
      const day = formatDay(entry.ts);
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.rows.push({ entry, info });
      else groups.push({ day, rows: [{ entry, info }] });
    }
    return groups;
  }, [query.data, filter]);

  return (
    <>
      <PageHeader title="Protokoll" subtitle="Wer hat sich angemeldet, was wurde geöffnet oder geändert" back="/einstellungen" />
      <Segmented
        className="mb-4"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'Alles' },
          { value: 'login', label: 'Anmeldungen' },
          { value: 'door', label: 'Türen' },
          { value: 'change', label: 'Änderungen' },
        ]}
      />
      {query.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-7" />
        </div>
      ) : query.isError ? (
        <Notice tone="danger">{errorMessage(query.error)}</Notice>
      ) : days.length === 0 ? (
        <EmptyState icon={ScrollText} title="Keine Einträge" />
      ) : (
        <div className="space-y-5">
          {days.map((group) => (
            <div key={group.day}>
              <p className="mb-1.5 px-1 text-sm font-medium text-muted">{group.day}</p>
              <ul className="divide-y divide-line overflow-hidden rounded-tile bg-surface shadow-tile">
                {group.rows.map(({ entry, info }) => (
                  <li key={entry.id} className="flex items-start gap-3 px-4 py-3">
                    <span className={cx('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full', toneSoft[info.tone])}>
                      <info.icon className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block">{info.text}</span>
                      <span className="block text-sm tabular-nums text-muted">
                        {formatTime(entry.ts)} Uhr{entry.ip ? ` · ${entry.ip}` : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {query.hasNextPage && (
            <Button block loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              Ältere Einträge laden
            </Button>
          )}
        </div>
      )}
    </>
  );
}
