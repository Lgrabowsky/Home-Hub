import { ChevronRight, Home, Lightbulb, Thermometer, Wind } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { EntityTile } from '../components/entities/EntityTile.tsx';
import { EntitySheet } from '../components/entities/sheets.tsx';
import { cx, EmptyState, PageHeader, Section, TileGrid } from '../components/ui.tsx';
import { useAllEntities, useRooms, type RoomSummary } from '../hooks/entities.ts';
import { formatTemperature } from '../lib/format.ts';

function RoomCard({ room }: { room: RoomSummary }) {
  const lit = room.lightsOn > 0;
  return (
    <Link
      to={`/raeume/${room.id}`}
      className={cx('group flex min-h-[7.25rem] flex-col rounded-tile p-4 shadow-tile transition active:scale-[0.99]', lit ? 'bg-raised' : 'bg-surface hover:bg-raised')}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-2 text-[17px] font-semibold leading-snug">{room.name}</h3>
        <ChevronRight className="mt-0.5 size-4.5 shrink-0 text-faint transition group-hover:translate-x-0.5" aria-hidden />
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-3 text-[13px] text-muted">
        {room.temperature !== null && (
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Thermometer className="size-3.5" aria-hidden />
            {formatTemperature(room.temperature)}
          </span>
        )}
        {room.lightCount > 0 && (
          <span className={cx('inline-flex items-center gap-1', lit && 'font-medium text-warm')}>
            <Lightbulb className="size-3.5" aria-hidden />
            {lit ? `${room.lightsOn} an` : 'aus'}
          </span>
        )}
        {room.openContacts > 0 && (
          <span className="inline-flex items-center gap-1 font-medium text-warn">
            <Wind className="size-3.5" aria-hidden />
            {room.openContacts} offen
          </span>
        )}
      </div>
    </Link>
  );
}

export function RoomsPage() {
  const rooms = useRooms();
  const all = useAllEntities();
  const [details, setDetails] = useState<string | null>(null);
  // Whole-house controls: groups and devices that belong to no room.
  const house = useMemo(
    () => all.filter((entity) => (entity.kind === 'light' || entity.kind === 'blind' || entity.kind === 'switch') && (entity.room === null || ('isGroup' in entity && entity.isGroup))),
    [all],
  );

  if (rooms.length === 0 && house.length === 0) {
    return (
      <>
        <PageHeader title="Räume" />
        <EmptyState icon={Home} title="Noch keine Räume" text="Sobald Geräte eingerichtet sind, erscheinen sie hier nach Räumen sortiert." />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Räume" />
      {house.length > 0 && (
        <Section title="Ganzes Haus">
          <TileGrid>
            {house.map((entity) => (
              <EntityTile key={entity.id} entity={entity} onDetails={setDetails} />
            ))}
          </TileGrid>
        </Section>
      )}
      <Section title={house.length > 0 ? 'Räume' : undefined}>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]">
          {rooms.map((room) => (
            <RoomCard key={room.id} room={room} />
          ))}
        </div>
      </Section>
      <EntitySheet entityId={details} onClose={() => setDetails(null)} />
    </>
  );
}
