import { Bell, ChevronLeft, ChevronRight, DoorOpen, Footprints, KeyRound, Lightbulb, Maximize, Minimize, Volume2, VolumeX, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import type { DoorEntity, DoorEvent, DoorEventType, DoorHistoryPage } from '@home-hub/shared';
import { FavoriteRow } from '../../components/entities/sheets.tsx';
import { HubImage } from '../../components/HubImage.tsx';
import { LiveView } from '../../components/LiveView.tsx';
import { TalkButton } from '../../components/security/controls.tsx';
import { toast } from '../../components/toast.tsx';
import { Button, cx, EmptyState, IconButton, Notice, PageHeader, Section, Segmented, Sheet, SlideToConfirm, Spinner, toneSoft, type Tone } from '../../components/ui.tsx';
import { useEntity } from '../../hooks/entities.ts';
import { useFullscreen } from '../../hooks/useFullscreen.ts';
import { get, post } from '../../lib/api.ts';
import { formatDateTime, formatDay, formatTime } from '../../lib/format.ts';
import type { LiveStatus } from '../../lib/live.ts';
import { haptic } from '../../lib/platform.ts';
import { onHubEvent, useHub } from '../../store/hub.ts';
import { useCan } from '../../store/session.ts';

const EVENT_META: Record<DoorEventType, { icon: LucideIcon; tone: Tone; label(event: DoorEvent): string }> = {
  doorbell: { icon: Bell, tone: 'accent', label: () => 'Geklingelt' },
  motion: { icon: Footprints, tone: 'neutral', label: () => 'Bewegung' },
  open: { icon: KeyRound, tone: 'ok', label: (event) => `Geöffnet${event.actor ? ` von ${event.actor}` : ''}${event.detail ? ` · ${event.detail}` : ''}` },
};

/** Opens a door relay. The slider itself is the confirmation. */
export function OpenDoorSlider({ door, relayId, relayName, onOpened }: { door: DoorEntity; relayId: string; relayName: string; onOpened?(): void }) {
  const [busy, setBusy] = useState(false);
  const deviceId = door.id.slice(5);
  return (
    <SlideToConfirm
      icon={DoorOpen}
      label={door.relays.length > 1 ? `Schieben · ${relayName}` : 'Zum Öffnen schieben'}
      disabled={!door.available}
      busy={busy}
      onConfirm={() => {
        setBusy(true);
        post(`/api/doors/${encodeURIComponent(deviceId)}/open`, { relay: relayId })
          .then(() => {
            haptic('success');
            toast.success(`${relayName} geöffnet`);
            onOpened?.();
          })
          .catch((err: unknown) => toast.fromError(err))
          .finally(() => setBusy(false));
      }}
    />
  );
}

function History({ doorId }: { doorId: string }) {
  const [filter, setFilter] = useState<'all' | DoorEventType>('all');
  const [viewer, setViewer] = useState<number | null>(null);
  const client = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: ['door-history', doorId, filter],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '30' });
      if (pageParam) params.set('before', String(pageParam));
      if (filter !== 'all') params.set('type', filter);
      return get<DoorHistoryPage>(`/api/doors/${encodeURIComponent(doorId)}/history?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextBefore,
    staleTime: 15_000,
  });

  // New rings, movements and openings show up without reloading.
  useEffect(
    () =>
      onHubEvent((event) => {
        if (event.type === 'history_updated' && event.doorId === doorId) void client.invalidateQueries({ queryKey: ['door-history', doorId] });
      }),
    [client, doorId],
  );

  const events = useMemo(() => query.data?.pages.flatMap((page) => page.events) ?? [], [query.data]);
  const withImages = useMemo(() => events.filter((event) => event.hasImage), [events]);
  const days = useMemo(() => {
    const groups: { day: string; events: DoorEvent[] }[] = [];
    for (const event of events) {
      const day = formatDay(event.ts);
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.events.push(event);
      else groups.push({ day, events: [event] });
    }
    return groups;
  }, [events]);
  const shown = viewer !== null ? withImages[viewer] : undefined;

  return (
    <Section title="Verlauf">
      <Segmented
        className="mb-3"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'Alle' },
          { value: 'doorbell', label: 'Klingeln' },
          { value: 'motion', label: 'Bewegung' },
          { value: 'open', label: 'Geöffnet' },
        ]}
      />
      {query.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : query.isError ? (
        <Notice tone="danger">Der Verlauf konnte nicht geladen werden.</Notice>
      ) : events.length === 0 ? (
        <EmptyState icon={Bell} title="Noch keine Einträge" text="Sobald jemand klingelt, sich etwas bewegt oder die Tür geöffnet wird, steht es hier." />
      ) : (
        <div className="space-y-4">
          {days.map((group) => (
            <div key={group.day}>
              <p className="mb-1.5 px-1 text-sm font-medium text-muted">{group.day}</p>
              <ul className="divide-y divide-line overflow-hidden rounded-tile bg-surface shadow-tile">
                {group.events.map((event) => {
                  const meta = EVENT_META[event.type];
                  const body = (
                    <>
                      <span className={cx('flex size-9 shrink-0 items-center justify-center rounded-full', toneSoft[meta.tone])}>
                        <meta.icon className="size-4.5" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block truncate font-medium">{meta.label(event)}</span>
                        <span className="block text-sm tabular-nums text-muted">{formatTime(event.ts)} Uhr</span>
                      </span>
                      {event.hasImage && (
                        <HubImage src={`/api/doors/events/${encodeURIComponent(event.id)}/image`} alt="" className="h-14 w-24 shrink-0 rounded-lg" />
                      )}
                    </>
                  );
                  return (
                    <li key={event.id}>
                      {event.hasImage ? (
                        <button
                          type="button"
                          aria-label={`${meta.label(event)}, ${formatDateTime(event.ts)} – Bild ansehen`}
                          className="flex w-full items-center gap-3 px-4 py-2.5 transition hover:bg-sunken/60"
                          onClick={() => setViewer(withImages.findIndex((entry) => entry.id === event.id))}
                        >
                          {body}
                        </button>
                      ) : (
                        <div className="flex items-center gap-3 px-4 py-2.5">{body}</div>
                      )}
                    </li>
                  );
                })}
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

      <Sheet open={shown !== undefined} onClose={() => setViewer(null)} title={shown ? EVENT_META[shown.type].label(shown) : ''} subtitle={shown ? formatDateTime(shown.ts) : ''} wide flush>
        {shown && viewer !== null && (
          <div className="relative bg-black">
            <HubImage src={`/api/doors/events/${encodeURIComponent(shown.id)}/image`} alt={`${EVENT_META[shown.type].label(shown)}, ${formatDateTime(shown.ts)}`} className="max-h-[70dvh] w-full !object-contain" />
            <IconButton
              icon={ChevronLeft}
              label="Neueres Bild"
              disabled={viewer === 0}
              className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/50 text-white hover:bg-black/70 hover:text-white"
              onClick={() => setViewer(viewer - 1)}
            />
            <IconButton
              icon={ChevronRight}
              label="Älteres Bild"
              disabled={viewer >= withImages.length - 1}
              className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/50 text-white hover:bg-black/70 hover:text-white"
              onClick={() => setViewer(viewer + 1)}
            />
          </div>
        )}
      </Sheet>
    </Section>
  );
}

export function DoorPage() {
  const { id = '' } = useParams();
  const door = useEntity<'door'>(`door:${id}`) as DoorEntity | undefined;
  const canView = useCan('doors.view');
  const canOpen = useCan('doors.open');
  const frame = useRef<HTMLDivElement>(null);
  const fullscreen = useFullscreen(frame);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [sound, setSound] = useState(false);
  const [talking, setTalking] = useState(false);

  // Being on the door's page answers the bell: no need for the overlay on top.
  const ring = useHub((state) => state.ring);
  useEffect(() => {
    if (ring?.doorId === id) useHub.getState().setRing(null);
  }, [ring, id]);

  if (!canView) {
    return (
      <>
        <PageHeader title="Tür" back="/sicherheit" />
        <EmptyState icon={Bell} title="Kein Zugriff" text="Für Türstationen fehlt dir die Berechtigung." />
      </>
    );
  }
  if (!door) {
    return (
      <>
        <PageHeader title="Tür" back="/sicherheit" />
        <EmptyState icon={Bell} title="Diese Türstation gibt es nicht (mehr)" />
      </>
    );
  }

  return (
    <>
      <PageHeader title={door.name} subtitle={door.room ?? door.model ?? undefined} back="/sicherheit" />
      {!door.available && (
        <Notice tone="warn" className="mb-4">
          Die Türstation ist gerade nicht erreichbar.
        </Notice>
      )}

      <div className="lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(20rem,2fr)] lg:items-start lg:gap-6">
        <div>
          <div ref={frame} className="relative overflow-hidden rounded-tile bg-black shadow-tile">
            <LiveView
              entityId={door.id}
              alt={`Live-Bild ${door.name}`}
              poster={door.available ? `/api/doors/${encodeURIComponent(id)}/snapshot` : null}
              muted={!sound || talking}
              onStatus={setStatus}
              className={cx('w-full', fullscreen.active ? 'h-dvh' : 'aspect-video')}
            >
              <div className="absolute right-2.5 top-2.5 flex gap-1.5">
                {status?.hasAudio && (
                  <IconButton
                    icon={sound ? Volume2 : VolumeX}
                    label={sound ? 'Ton aus' : 'Ton an'}
                    size="sm"
                    className="bg-black/50 text-white backdrop-blur hover:bg-black/70 hover:text-white"
                    onClick={() => setSound(!sound)}
                  />
                )}
                {fullscreen.supported && (
                  <IconButton
                    icon={fullscreen.active ? Minimize : Maximize}
                    label={fullscreen.active ? 'Vollbild beenden' : 'Vollbild'}
                    size="sm"
                    className="bg-black/50 text-white backdrop-blur hover:bg-black/70 hover:text-white"
                    onClick={fullscreen.toggle}
                  />
                )}
              </div>
            </LiveView>
          </div>

          <div className="mt-4 flex items-center gap-4 rounded-tile bg-surface p-4 shadow-tile">
            {door.features.talk && door.available && <TalkButton entityId={door.id} onTalking={setTalking} />}
            <div className="min-w-0 flex-1 space-y-2.5">
              {canOpen ? (
                door.relays.map((relay) => <OpenDoorSlider key={relay.id} door={door} relayId={relay.id} relayName={relay.name} />)
              ) : (
                <p className="text-sm text-muted">Zum Öffnen der Tür fehlt dir die Berechtigung.</p>
              )}
            </div>
            {door.features.light && (
              <IconButton
                icon={Lightbulb}
                label="Licht an der Tür einschalten"
                variant="filled"
                disabled={!door.available}
                onClick={() => {
                  haptic();
                  post(`/api/doors/${encodeURIComponent(id)}/light`).then(
                    () => toast.success('Licht eingeschaltet'),
                    (err: unknown) => toast.fromError(err),
                  );
                }}
              />
            )}
          </div>
          <FavoriteRow entity={door} />
        </div>

        <div className="mt-7 lg:mt-0">
          <History doorId={id} />
        </div>
      </div>
    </>
  );
}
