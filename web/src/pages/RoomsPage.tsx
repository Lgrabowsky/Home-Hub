import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Box, Check, ChevronDown, ChevronUp, GripVertical, Home, Lightbulb, Music2, Pencil, Plus, RotateCcw, Trash2, Wind } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { addArea, addRoom, moveArea, orderRooms, removeArea, renameArea, resetLayout, roomKey, type LightEntity } from '@home-hub/shared';
import { HomeNav } from '../components/home/categories.tsx';
import { FloorSection } from '../components/home/FloorSection.tsx';
import { FloorFilter, useFloorFilter } from '../components/home/FloorFilter.tsx';
import { BlindGlyph } from '../components/home/glyphs.tsx';
import { NameDialog } from '../components/layout/NameDialog.tsx';
import { RoomEditor } from '../components/layout/RoomEditor.tsx';
import { Button, ConfirmDialog, cx, EmptyState, IconButton, PageHeader } from '../components/ui.tsx';
import { useFloors, type RoomSummary } from '../hooks/entities.ts';
import { sendCommand } from '../lib/actions.ts';
import { formatNumber, formatPercent } from '../lib/format.ts';
import { editableLayout, saveLayout } from '../lib/layout.ts';
import { useHub } from '../store/hub.ts';
import { useLabs } from '../store/labs.ts';
import { useCan, useIsAdmin } from '../store/session.ts';

/** Switches every lamp of a room at once — off when any is on, otherwise on. */
function RoomLightButton({ room }: { room: RoomSummary }) {
  const canControl = useCan('home.control');
  const lights = room.entities.filter((entity): entity is LightEntity => entity.kind === 'light' && entity.available);
  if (lights.length === 0) return null;
  const lit = room.lightsOn > 0;
  return (
    <button
      type="button"
      disabled={!canControl}
      aria-label={`Licht in ${room.name} ${lit ? 'ausschalten' : 'einschalten'}`}
      onClick={() => {
        for (const entity of lights) {
          if (entity.on === !lit) continue;
          void sendCommand(entity, { action: lit ? 'turn_off' : 'turn_on' }, { on: !lit });
        }
      }}
      className={cx(
        'relative z-10 flex size-11 shrink-0 items-center justify-center rounded-full transition duration-300 active:scale-95 disabled:opacity-50',
        lit ? 'bg-warm/20 text-warm shadow-[0_0_22px_-4px_var(--hh-warm)]' : 'bg-sunken text-muted hover:text-fg',
      )}
    >
      <Lightbulb className="size-5" aria-hidden />
    </button>
  );
}

/** What else is in a room, in a few words: "Türstation · 2 Geräte". */
function inventory(room: RoomSummary): string[] {
  const count = (kind: string) => room.entities.filter((entity) => entity.kind === kind).length;
  const parts: string[] = [];
  const doors = count('door');
  const cameras = count('camera');
  const switches = count('switch');
  const contacts = count('contact');
  if (doors) parts.push(doors === 1 ? 'Türstation' : `${doors} Türstationen`);
  if (cameras) parts.push(cameras === 1 ? 'Kamera' : `${cameras} Kameras`);
  if (switches) parts.push(switches === 1 ? '1 Gerät' : `${switches} Geräte`);
  if (contacts && room.openContacts === 0) parts.push(contacts === 1 ? '1 Kontakt zu' : `${contacts} Kontakte zu`);
  if (room.players.length && parts.length < 2) parts.push(room.players.length === 1 ? 'Lautsprecher' : `${room.players.length} Lautsprecher`);
  return parts;
}

function RoomCard({ room, arranging = false }: { room: RoomSummary; arranging?: boolean }) {
  const groups = useHub((state) => state.music.groups);
  const playing = room.players.some((player) => groups.find((group) => group.id === player.groupId)?.state === 'playing');
  const lit = room.lightsOn > 0;
  const hasBlinds = room.blindCount > 0 && room.blindClosed !== null;
  const status = [
    room.heating ? <span key="heat" className="text-warm">heizt{room.target !== null ? ` auf ${formatNumber(room.target)}°` : ''}</span> : null,
    room.openContacts > 0 ? (
      <span key="open" className="inline-flex items-center gap-1 font-medium text-warn">
        <Wind className="size-3.5" aria-hidden />
        {room.openContacts} offen
      </span>
    ) : null,
    playing ? (
      <span key="music" className="inline-flex items-center gap-1 text-music">
        <Music2 className="size-3.5" aria-hidden />
        Musik
      </span>
    ) : null,
  ].filter(Boolean);
  const extra = inventory(room);
  return (
    <div
      className="panel relative flex min-h-[9.5rem] flex-col rounded-tile p-3.5 transition-[background] duration-500"
      style={lit ? { background: 'radial-gradient(120% 90% at 100% 100%, color-mix(in srgb, var(--hh-warm) 15%, transparent), transparent 70%), var(--hh-panel), var(--hh-raised)' } : undefined}
    >
      {!arranging && <Link to={`/raeume/${room.id}`} className="absolute inset-0 rounded-tile transition hover:bg-fg/[0.03] active:bg-fg/[0.06]" aria-label={`${room.name} öffnen`} />}
      <div className="pointer-events-none relative">
        <h3 className="line-clamp-2 break-words text-[16px] font-semibold leading-snug" lang="de" style={{ hyphens: 'auto' }}>{room.name}</h3>
        {room.temperature !== null && (
          <p className="mt-1 text-[26px] font-semibold leading-none tracking-tight tabular-nums">
            {formatNumber(room.temperature)}
            <span className="text-base font-medium text-muted">°C</span>
          </p>
        )}
        <div className="mt-1 flex flex-wrap gap-x-2 text-[12.5px] text-muted">
          {status}
          {room.temperature === null && status.length === 0 && extra.length > 0 && <span>{extra.join(' · ')}</span>}
        </div>
      </div>
      <div className="relative mt-auto flex items-end gap-2 pt-3">
        <div className="pointer-events-none flex min-w-0 flex-1 items-center gap-2">
          {hasBlinds && (
            <span title={room.blindClosed! < 3 ? 'Jalousien offen' : `Jalousien ${formatPercent(Math.round(room.blindClosed!))} zu`}>
              <BlindGlyph entity={{ position: room.blindClosed, motion: room.blindsMoving ? 'down' : 'stopped', tilt: null }} />
            </span>
          )}
          {lit && <span className="truncate text-[12.5px] font-medium text-warm">{room.lightsOn} an</span>}
        </div>
        {arranging ? (
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-sunken text-muted" aria-hidden>
            <GripVertical className="size-5" />
          </span>
        ) : (
          <RoomLightButton room={room} />
        )}
      </div>
    </div>
  );
}

/** A room card that can be picked up and moved, or tapped to edit it, while the page is being edited. */
function SortableRoom({ room, onEdit }: { room: RoomSummary; onEdit(): void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: room.id, data: { name: room.name } });
  // Letting go after a drag must not count as a tap.
  const droppedAt = useRef(0);
  const wasDragging = useRef(false);
  useEffect(() => {
    if (wasDragging.current && !isDragging) droppedAt.current = Date.now();
    wasDragging.current = isDragging;
  }, [isDragging]);
  return (
    <div ref={setNodeRef} className={cx('relative', isDragging && 'z-10')} style={{ transform: CSS.Translate.toString(transform), transition }}>
      <div
        {...attributes}
        {...listeners}
        onClick={() => Date.now() - droppedAt.current > 400 && onEdit()}
        aria-label={`${room.name} verschieben`}
        aria-roledescription="verschiebbarer Raum"
        className={cx('touch-manipulation rounded-tile outline-none focus-visible:ring-2 focus-visible:ring-accent', isDragging ? 'cursor-grabbing' : 'cursor-grab')}
      >
        <div className={cx('transition-[transform,box-shadow] duration-200', isDragging ? 'scale-[1.04] shadow-float' : 'outline-1 outline-dashed outline-accent/40')} style={{ borderRadius: 'inherit' }}>
          <RoomCard room={room} arranging />
        </div>
      </div>
      <IconButton icon={Pencil} size="sm" variant="filled" label={`${room.name} bearbeiten`} onClick={onEdit} className="absolute right-2 top-2 z-10" />
    </div>
  );
}

const ANNOUNCEMENTS: Announcements = {
  onDragStart: ({ active }) => `${String(active.data.current?.name ?? 'Raum')} aufgenommen.`,
  onDragOver: ({ active, over }) => (over ? `${String(active.data.current?.name ?? 'Raum')} ist jetzt an der Stelle von ${String(over.data.current?.name ?? 'einem anderen Raum')}.` : undefined),
  onDragEnd: ({ active }) => `${String(active.data.current?.name ?? 'Raum')} abgelegt.`,
  onDragCancel: ({ active }) => `Verschieben von ${String(active.data.current?.name ?? 'Raum')} abgebrochen.`,
};

function floorMeta(rooms: RoomSummary[]): string | undefined {
  const lit = rooms.reduce((sum, room) => sum + room.lightsOn, 0);
  const open = rooms.reduce((sum, room) => sum + room.openContacts, 0);
  const parts = [lit > 0 ? `${lit} ${lit === 1 ? 'Licht' : 'Lichter'} an` : null, open > 0 ? `${open} offen` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

type NameAsk = { kind: 'area' } | { kind: 'rename-area'; area: string } | { kind: 'room'; area: string } | null;

/** Edit controls of an area: move up and down, rename, remove. */
function AreaActions({ area, first, last, onAsk }: { area: string; first: boolean; last: boolean; onAsk(ask: NameAsk): void }) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  return (
    <span className="flex items-center gap-0.5">
      <IconButton icon={ChevronUp} size="sm" label={`${area} nach oben`} disabled={first} onClick={() => void saveLayout(moveArea(editableLayout(), area, -1), `Bereich „${area}“ verschoben`)} />
      <IconButton icon={ChevronDown} size="sm" label={`${area} nach unten`} disabled={last} onClick={() => void saveLayout(moveArea(editableLayout(), area, 1), `Bereich „${area}“ verschoben`)} />
      <IconButton icon={Pencil} size="sm" label={`${area} umbenennen`} onClick={() => onAsk({ kind: 'rename-area', area })} />
      <IconButton icon={Trash2} size="sm" label={`${area} entfernen`} onClick={() => setConfirmRemove(true)} />
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`Bereich „${area}“ entfernen?`}
        text="Seine Räume bleiben erhalten und werden wieder automatisch einem Bereich zugeordnet."
        confirmLabel="Entfernen"
        danger
        onConfirm={async () => {
          await saveLayout(removeArea(editableLayout(), area), `Bereich „${area}“ entfernt`);
        }}
      />
    </span>
  );
}

export function RoomsPage() {
  const house3d = useLabs((state) => state.house3d);
  const navigate = useNavigate();
  const isAdmin = useIsAdmin();
  const [editing, setEditing] = useState(false);
  const floors = useFloors({ withEmpty: editing });
  const floorFilter = useFloorFilter();
  const shownFloors = floorFilter.selected && !editing ? floors.filter((floor) => floor.name === floorFilter.selected) : floors;
  const [editRoom, setEditRoom] = useState<string | null>(null);
  const [ask, setAsk] = useState<NameAsk>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const layout = useHub((state) => state.layout);
  const customised = layout.floors !== null || Object.keys(layout.rooms).length > 0 || Object.keys(layout.devices).length > 0 || Object.keys(layout.order).length > 0;
  const sensors = useSensors(
    // Mouse: a small movement picks a card up. Touch: a short hold, so the page still scrolls.
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (floorIndex: number) => (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const floor = floors[floorIndex]!;
    const ids = floor.rooms.map((room) => room.id);
    const moved = arrayMove(floor.rooms, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    void saveLayout(orderRooms(editableLayout(), floor.name || 'Räume', moved.map((room) => room.name)), `Räume in „${floor.name || 'Räume'}“ sortiert`);
  };

  const areaNames = floors.map((floor) => floor.name);
  const nameTaken = (name: string) => (areaNames.includes(name) ? 'Diesen Bereich gibt es schon.' : null);
  const roomTaken = (name: string) => (floors.some((floor) => floor.rooms.some((room) => roomKey(room.name) === roomKey(name))) ? 'Diesen Raum gibt es schon.' : null);

  return (
    <>
      <PageHeader
        title="Räume"
        actions={
          <>
            {house3d && !editing && (
              <Button size="sm" variant="ghost" icon={Box} onClick={() => navigate('/haus3d')}>
                3D
              </Button>
            )}
            {isAdmin && !editing && (
              <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(true)}>
                Bearbeiten
              </Button>
            )}
          </>
        }
      />
      {editing ? (
        <div className="sticky top-[calc(env(safe-area-inset-top)+0.5rem)] z-30 mb-6 rounded-tile bg-raised/95 p-2.5 shadow-float backdrop-blur-md">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" icon={RotateCcw} disabled={!customised} onClick={() => setConfirmReset(true)}>
              Zurücksetzen
            </Button>
            <span className="flex-1" />
            <Button size="sm" icon={Plus} onClick={() => setAsk({ kind: 'area' })}>
              Bereich
            </Button>
            <Button size="sm" variant="primary" icon={Check} onClick={() => setEditing(false)}>
              Fertig
            </Button>
          </div>
          <p className="px-1.5 pb-0.5 pt-2 text-[13px] text-muted">Räume antippen zum Bearbeiten, gedrückt halten und ziehen zum Sortieren. Gilt für alle im Haushalt.</p>
        </div>
      ) : (
        <>
          <HomeNav />
          <FloorFilter state={floorFilter} />
        </>
      )}
      {floors.length === 0 && <EmptyState icon={Home} title="Noch keine Räume" text="Sobald Geräte eingerichtet sind, erscheinen sie hier nach Stockwerk und Raum sortiert." />}
      {shownFloors.map((floor, index) => (
        <FloorSection
          key={floor.name || 'haus'}
          name={floor.name}
          meta={editing ? floor.name && <AreaActions area={floor.name} first={index === 0} last={index === shownFloors.length - 1} onAsk={setAsk} /> : floorMeta(floor.rooms)}
        >
          {editing ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={onDragEnd(floors.indexOf(floor))}
              accessibility={{ announcements: ANNOUNCEMENTS, screenReaderInstructions: { draggable: 'Leertaste zum Aufnehmen, Pfeiltasten zum Verschieben, Leertaste zum Ablegen, Escape zum Abbrechen.' } }}
            >
              <SortableContext items={floor.rooms.map((room) => room.id)} strategy={rectSortingStrategy}>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(12.5rem,1fr))]">
                  {floor.rooms.map((room) => (
                    <SortableRoom key={room.id} room={room} onEdit={() => setEditRoom(room.name)} />
                  ))}
                  <button
                    type="button"
                    onClick={() => setAsk({ kind: 'room', area: floor.name || 'Räume' })}
                    className="flex min-h-[9.5rem] flex-col items-center justify-center gap-1.5 rounded-tile border border-dashed border-line text-sm font-medium text-muted transition hover:border-accent hover:text-accent"
                  >
                    <Plus className="size-5" aria-hidden />
                    Raum{floor.name ? ` in ${floor.name}` : ''}
                  </button>
                </div>
              </SortableContext>
            </DndContext>
          ) : (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(12.5rem,1fr))]">
              {floor.rooms.map((room) => (
                <RoomCard key={room.id} room={room} />
              ))}
            </div>
          )}
        </FloorSection>
      ))}

      <RoomEditor room={editRoom} onClose={() => setEditRoom(null)} />
      <NameDialog
        open={ask?.kind === 'area'}
        title="Neuer Bereich"
        label="Name"
        placeholder="z. B. Dachgeschoss, Treppenhaus"
        confirmLabel="Anlegen"
        validate={nameTaken}
        onClose={() => setAsk(null)}
        onConfirm={(name) => saveLayout(addArea(editableLayout(), name), `Bereich „${name}“ angelegt`)}
      />
      <NameDialog
        open={ask?.kind === 'rename-area'}
        title="Bereich umbenennen"
        label="Name"
        initial={ask?.kind === 'rename-area' ? ask.area : ''}
        validate={(name) => (ask?.kind === 'rename-area' && name === ask.area ? null : nameTaken(name))}
        onClose={() => setAsk(null)}
        onConfirm={(name) => (ask?.kind === 'rename-area' ? saveLayout(renameArea(editableLayout(), ask.area, name), `Bereich „${ask.area}“ heißt jetzt „${name}“`) : undefined)}
      />
      <NameDialog
        open={ask?.kind === 'room'}
        title={ask?.kind === 'room' ? `Neuer Raum in ${ask.area}` : 'Neuer Raum'}
        label="Name"
        placeholder="z. B. Treppenhaus"
        confirmLabel="Anlegen"
        validate={roomTaken}
        onClose={() => setAsk(null)}
        onConfirm={async (name) => {
          if (ask?.kind !== 'room') return;
          if (await saveLayout(addRoom(editableLayout(), ask.area, name), `Raum „${name}“ angelegt`)) setEditRoom(name);
        }}
      />
      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Alles zurücksetzen?"
        text="Bereiche, Räume, Namen, Reihenfolge und ausgeblendete Geräte werden wieder so, wie der Hub sie erkannt hat. Die Lichter der Kameras bleiben."
        confirmLabel="Zurücksetzen"
        danger
        onConfirm={async () => {
          await saveLayout(resetLayout(useHub.getState().layout), 'Alles zurückgesetzt');
        }}
      />
    </>
  );
}
