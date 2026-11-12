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
import { ArrowUpDown, Check, GripVertical, Home, Lightbulb, Music2, RotateCcw, Wind } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { LightEntity } from '@home-hub/shared';
import { HomeNav } from '../components/home/categories.tsx';
import { FloorSection } from '../components/home/FloorSection.tsx';
import { BlindGlyph } from '../components/home/glyphs.tsx';
import { toast } from '../components/toast.tsx';
import { Button, cx, EmptyState, PageHeader } from '../components/ui.tsx';
import { useFloors, type RoomSummary } from '../hooks/entities.ts';
import { sendCommand } from '../lib/actions.ts';
import { formatNumber, formatPercent } from '../lib/format.ts';
import { useHub } from '../store/hub.ts';
import { useCan, useSession } from '../store/session.ts';

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

/** A room card that can be picked up and moved while the page is in "Anordnen" mode. */
function SortableRoom({ room }: { room: RoomSummary }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: room.id, data: { name: room.name } });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      aria-label={`${room.name} verschieben`}
      aria-roledescription="verschiebbarer Raum"
      className={cx('touch-manipulation rounded-tile outline-none focus-visible:ring-2 focus-visible:ring-accent', isDragging ? 'relative z-10 cursor-grabbing' : 'cursor-grab')}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <div className={cx('transition-[transform,box-shadow] duration-200', isDragging ? 'scale-[1.04] shadow-float' : 'outline-1 outline-dashed outline-line')} style={{ borderRadius: 'inherit' }}>
        <RoomCard room={room} arranging />
      </div>
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

export function RoomsPage() {
  const floors = useFloors();
  const [arranging, setArranging] = useState(false);
  const hasOrder = useSession((state) => state.prefs.roomOrder.length > 0);
  const sensors = useSensors(
    // Mouse: a small movement picks a card up. Touch: a short hold, so the page still scrolls.
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const save = (roomOrder: string[]) => void useSession.getState().savePrefs({ roomOrder }).catch(() => toast.error('Die Reihenfolge konnte nicht gespeichert werden.'));

  const onDragEnd = (floorIndex: number) => (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = floors[floorIndex]!.rooms.map((room) => room.id);
    const moved = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    // The order is kept for the whole house: this storey's rooms in their new order, the others as shown.
    save(floors.flatMap((floor, index) => (index === floorIndex ? moved : floor.rooms.map((room) => room.id))));
  };

  return (
    <>
      <PageHeader
        title="Räume"
        actions={
          floors.length > 0 &&
          (arranging ? (
            <Button size="sm" variant="primary" icon={Check} onClick={() => setArranging(false)}>
              Fertig
            </Button>
          ) : (
            <Button size="sm" variant="ghost" icon={ArrowUpDown} onClick={() => setArranging(true)}>
              Anordnen
            </Button>
          ))
        }
      />
      {arranging ? (
        <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 px-1">
          <p className="flex-1 text-sm text-muted">Räume halten und an die gewünschte Stelle ziehen. Die Reihenfolge gilt für dich auf allen Geräten.</p>
          {hasOrder && (
            <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => save([])}>
              Alphabetisch
            </Button>
          )}
        </div>
      ) : (
        <HomeNav />
      )}
      {floors.length === 0 && <EmptyState icon={Home} title="Noch keine Räume" text="Sobald Geräte eingerichtet sind, erscheinen sie hier nach Stockwerk und Raum sortiert." />}
      {floors.map((floor, floorIndex) => (
        <FloorSection key={floor.name || 'haus'} name={floor.name} meta={arranging ? undefined : floorMeta(floor.rooms)}>
          {arranging ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={onDragEnd(floorIndex)}
              accessibility={{ announcements: ANNOUNCEMENTS, screenReaderInstructions: { draggable: 'Leertaste zum Aufnehmen, Pfeiltasten zum Verschieben, Leertaste zum Ablegen, Escape zum Abbrechen.' } }}
            >
              <SortableContext items={floor.rooms.map((room) => room.id)} strategy={rectSortingStrategy}>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(12.5rem,1fr))]">
                  {floor.rooms.map((room) => (
                    <SortableRoom key={room.id} room={room} />
                  ))}
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
    </>
  );
}
