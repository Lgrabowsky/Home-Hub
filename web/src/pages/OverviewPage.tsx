import { closestCenter, DndContext, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors, type Announcements, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Bell, Check, LayoutGrid, Maximize2, Pencil, Plus, RotateCcw, Settings2, ShieldAlert, Sparkles, Thermometer, X, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { roomKey, shownRoom, type Entity, type HomeWidget, type HouseLayout } from '@home-hub/shared';
import { EntitySheet } from '../components/entities/sheets.tsx';
import { FULL_WIDTH, SECTION_TITLES, SIZE_LABELS, sizesFor, spanClass, useDefaultHome, WidgetView, widgetName } from '../components/home/widgets.tsx';
import { WidgetCatalog } from '../components/home/WidgetCatalog.tsx';
import { NoticeBanners, NoticeBell } from '../components/NoticeCenter.tsx';
import { toast } from '../components/toast.tsx';
import { Button, ConfirmDialog, cx, EmptyState, IconButton, toneSoft, type Tone } from '../components/ui.tsx';
import { useRooms } from '../hooks/entities.ts';
import { formatAgo, formatTemperature, greeting } from '../lib/format.ts';
import { useHub } from '../store/hub.ts';
import { useLabs } from '../store/labs.ts';
import { useCan, useIsAdmin, useSession } from '../store/session.ts';

const DATE = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });

/** Re-renders once a minute so "vor 5 Min." stays truthful. */
function useMinuteTick(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function Chip({ icon: Icon, tone, children, onClick }: { icon: LucideIcon; tone: Tone; children: ReactNode; onClick(): void }) {
  return (
    <button type="button" onClick={onClick} className={cx('flex h-10 shrink-0 items-center gap-2 rounded-full pl-3 pr-4 text-sm font-medium transition active:scale-[0.97]', toneSoft[tone])}>
      <Icon className="size-4.5" aria-hidden />
      <span className="whitespace-nowrap text-fg">{children}</span>
    </button>
  );
}

/** Whether a tile still points at something that exists (in normal view broken tiles are left out). */
function present(widget: HomeWidget, entities: Record<string, Entity>, roomNames: Set<string>, labs: boolean, layout: HouseLayout): boolean {
  switch (widget.type) {
    case 'entity':
    case 'camera':
      return Boolean(entities[widget.entityId]);
    case 'room':
      return roomNames.has(roomKey(shownRoom(widget.room, layout))) || roomNames.has(widget.room);
    case 'house3d':
      return labs;
    default:
      return true;
  }
}

function TileTitle({ widget }: { widget: HomeWidget }) {
  const title = SECTION_TITLES[widget.type];
  if (!title) return null;
  return <h2 className="mb-2.5 mt-3 px-1 text-[13px] font-semibold uppercase tracking-wide text-muted">{title}</h2>;
}

const ANNOUNCEMENTS: Announcements = {
  onDragStart: () => 'Kachel aufgenommen.',
  onDragOver: ({ over }) => (over ? 'Kachel über einer anderen Stelle.' : undefined),
  onDragEnd: () => 'Kachel abgelegt.',
  onDragCancel: () => 'Verschieben abgebrochen.',
};

/** A tile in edit mode: drag it anywhere, change its size, take it off. */
function EditableTile({ widget, onSize, onRemove, onDetails }: { widget: HomeWidget; onSize(): void; onRemove(): void; onDetails(id: string): void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: widget.key });
  const sizes = sizesFor(widget.type);
  const name = useHub((state) => widgetName(widget, state.entities));
  return (
    <div ref={setNodeRef} className={cx(spanClass(widget), 'relative', isDragging && 'z-20')} style={{ transform: CSS.Translate.toString(transform), transition }}>
      <TileTitle widget={widget} />
      <div
        {...attributes}
        {...listeners}
        aria-roledescription="verschiebbare Kachel"
        aria-label={name}
        className={cx('relative h-full touch-manipulation rounded-tile outline-none focus-visible:ring-2 focus-visible:ring-accent', isDragging ? 'cursor-grabbing' : 'cursor-grab')}
      >
        <div className={cx('pointer-events-none h-full select-none transition-[transform,box-shadow] duration-200 [&_[data-quick]]:invisible', isDragging ? 'scale-[1.03] shadow-float' : '')} style={{ borderRadius: 'inherit' }} aria-hidden>
          <WidgetView widget={widget} onDetails={onDetails} />
        </div>
        <span className="pointer-events-none absolute inset-0 rounded-tile outline-2 outline-dashed outline-accent/40" aria-hidden />
      </div>
      {/* Remove at the corner, size at the bottom: neither hides the tile's title. */}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`${name} entfernen`}
        className="absolute -right-2 -top-2 z-10 flex size-7 items-center justify-center rounded-full bg-danger text-white shadow-float"
        style={SECTION_TITLES[widget.type] ? { top: '2rem' } : undefined}
      >
        <X className="size-4" aria-hidden />
      </button>
      {sizes.length > 1 && (
        <button
          type="button"
          onClick={onSize}
          aria-label={`${name}: Größe ändern, jetzt ${SIZE_LABELS[widget.size]}`}
          className="absolute bottom-2 right-2 z-10 flex h-8 items-center gap-1 rounded-full bg-raised/95 px-2.5 text-xs font-semibold text-fg shadow-float ring-1 ring-line backdrop-blur"
        >
          <Maximize2 className="size-3.5" aria-hidden />
          {SIZE_LABELS[widget.size]}
        </button>
      )}
    </div>
  );
}

export function OverviewPage() {
  const navigate = useNavigate();
  const now = useMinuteTick();
  const user = useSession((state) => state.user);
  const saved = useSession((state) => state.prefs.home ?? null);
  const entities = useHub((state) => state.entities);
  const services = useHub((state) => state.services);
  const music = useHub((state) => state.music);
  const labs = useLabs((state) => state.house3d);
  const rooms = useRooms();
  const defaults = useDefaultHome();
  const isAdmin = useIsAdmin();
  const canSecurity = useCan('security.view');
  const [details, setDetails] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<HomeWidget[]>([]);
  const [catalog, setCatalog] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const data = useMemo(() => {
    const all = Object.values(entities);
    const alarmTriggered = all.some((e) => e.kind === 'alarm' && e.triggered);
    const lastRing = all
      .filter((e) => e.kind === 'door' && e.lastRingAt !== null)
      .map((e) => ({ door: e, at: e.kind === 'door' ? (e.lastRingAt ?? 0) : 0 }))
      .sort((a, b) => b.at - a.at)[0];
    const outside = entities['gekko:meteo/temperature'];
    return { all, alarmTriggered, lastRing, outside };
  }, [entities]);

  const nothingConfigured = data.all.length === 0 && music.players.length === 0 && Object.values(services).every((service) => !service || service.status === 'unconfigured');
  const recentRing = data.lastRing && now - data.lastRing.at < 30 * 60_000 ? data.lastRing : null;
  const outsideTemperature = data.outside?.kind === 'sensor' && typeof data.outside.value === 'number' ? data.outside.value : null;
  const houseLayout = useHub((state) => state.layout);
  const roomNames = useMemo(() => new Set(rooms.flatMap((room) => [room.name, room.id])), [rooms]);

  const widgets = editing ? draft : (saved ?? defaults).filter((widget) => present(widget, entities, roomNames, labs, houseLayout));

  const startEditing = () => {
    setDraft(saved ?? defaults);
    setEditing(true);
  };
  const finish = async () => {
    setEditing(false);
    try {
      await useSession.getState().savePrefs({ home: draft });
    } catch {
      toast.error('Die Startseite konnte nicht gespeichert werden.');
    }
  };
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setDraft((current) => arrayMove(current, current.findIndex((w) => w.key === active.id), current.findIndex((w) => w.key === over.id)));
  };
  const cycleSize = (key: string) =>
    setDraft((current) =>
      current.map((widget) => {
        if (widget.key !== key) return widget;
        const sizes = sizesFor(widget.type);
        const next = sizes[(sizes.indexOf(widget.size) + 1) % sizes.length] ?? widget.size;
        return { ...widget, size: next };
      }),
    );

  const header = (
    <header className="mb-5 flex items-start gap-3 pt-1">
      <div className="min-w-0 flex-1">
        <h1 className="text-[26px] font-bold leading-tight tracking-tight">
          {greeting(new Date(now))}
          {user ? `, ${user.displayName.split(' ')[0]}` : ''}
        </h1>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-muted">
          <span>{DATE.format(now)}</span>
          {outsideTemperature !== null && (
            <span className="inline-flex items-center gap-1 tabular-nums">
              · <Thermometer className="size-4" aria-hidden /> {formatTemperature(outsideTemperature)} draußen
            </span>
          )}
        </p>
      </div>
      <div className="-mr-2 mt-0.5 flex shrink-0 items-center gap-1">
        {!nothingConfigured && !editing && <IconButton icon={Pencil} label="Startseite bearbeiten" onClick={startEditing} />}
        <NoticeBell />
      </div>
    </header>
  );

  if (nothingConfigured) {
    return (
      <>
        {header}
        <EmptyState
          icon={Sparkles}
          title="Willkommen in deinem Home Hub"
          text={isAdmin ? 'Noch ist nichts verbunden. Richte als Erstes deine Geräte ein – Gebäudesteuerung, Türstationen, Kameras und Lautsprecher.' : 'Noch sind keine Geräte eingerichtet. Bitte einen Administrator, das zu erledigen.'}
          action={
            isAdmin ? (
              <Button variant="primary" icon={Settings2} onClick={() => navigate('/einstellungen/dienste')}>
                Geräte einrichten
              </Button>
            ) : undefined
          }
        />
      </>
    );
  }

  const grid = (
    <div className="grid grid-flow-row-dense grid-cols-2 gap-2.5 sm:grid-cols-4">
      {widgets.map((widget) =>
        editing ? (
          <EditableTile key={widget.key} widget={widget} onSize={() => cycleSize(widget.key)} onRemove={() => setDraft((current) => current.filter((w) => w.key !== widget.key))} onDetails={setDetails} />
        ) : (
          <div key={widget.key} className={spanClass(widget)}>
            <TileTitle widget={widget} />
            <WidgetView widget={widget} onDetails={setDetails} />
          </div>
        ),
      )}
    </div>
  );

  return (
    <>
      {header}

      {editing && (
        <div className="sticky top-[calc(env(safe-area-inset-top)+0.5rem)] z-30 mb-5 rounded-tile bg-raised/95 p-2.5 shadow-float backdrop-blur-md">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => setConfirmReset(true)}>
              Standard
            </Button>
            <span className="flex-1" />
            <Button size="sm" icon={Plus} onClick={() => setCatalog(true)}>
              Kachel
            </Button>
            <Button size="sm" variant="primary" icon={Check} onClick={() => void finish()}>
              Fertig
            </Button>
          </div>
          <p className="px-1.5 pb-0.5 pt-2 text-[13px] text-muted">Kachel gedrückt halten und ziehen, um sie zu verschieben.</p>
        </div>
      )}

      {/* Only what is urgent gets a chip; everything else is in the tiles below. */}
      {!editing && ((canSecurity && data.alarmTriggered) || recentRing) && (
        <div className="no-scrollbar -mx-4 mb-5 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
          {canSecurity && data.alarmTriggered && (
            <Chip icon={ShieldAlert} tone="danger" onClick={() => navigate('/sicherheit')}>
              Alarm!
            </Chip>
          )}
          {recentRing && (
            <Chip icon={Bell} tone="accent" onClick={() => navigate(`/sicherheit/tuer/${recentRing.door.id.slice(5)}`)}>
              Geklingelt {formatAgo(recentRing.at, now)} · {recentRing.door.name}
            </Chip>
          )}
        </div>
      )}

      {!editing && <NoticeBanners className="mb-6" />}

      {widgets.length === 0 && !editing && (
        <EmptyState icon={LayoutGrid} title="Deine Startseite ist leer" text="Füge Kacheln hinzu: Bereiche, Räume, Geräte, Kameras, Szenen …" action={<Button icon={Pencil} onClick={startEditing}>Bearbeiten</Button>} />
      )}

      {editing ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
          accessibility={{ announcements: ANNOUNCEMENTS, screenReaderInstructions: { draggable: 'Leertaste zum Aufnehmen, Pfeiltasten zum Verschieben, Leertaste zum Ablegen.' } }}
        >
          <SortableContext items={widgets.map((widget) => widget.key)} strategy={rectSortingStrategy}>
            {grid}
          </SortableContext>
        </DndContext>
      ) : (
        grid
      )}
      {editing && widgets.length === 0 && <p className="mt-2 text-center text-sm text-muted">Noch keine Kacheln – füge mit „Kachel“ welche hinzu.</p>}

      <EntitySheet entityId={details} onClose={() => setDetails(null)} />
      <WidgetCatalog
        open={catalog}
        onClose={() => setCatalog(false)}
        current={draft}
        onAdd={(widget) => {
          setDraft((current) => [...current, widget]);
          setCatalog(false);
          toast.success('Kachel hinzugefügt');
        }}
      />
      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Standard-Startseite?"
        text="Deine Anordnung wird durch die Standard-Startseite ersetzt."
        confirmLabel="Zurücksetzen"
        onConfirm={async () => {
          setDraft(defaults);
          setEditing(false);
          await useSession.getState().savePrefs({ home: null });
        }}
      />
    </>
  );
}
