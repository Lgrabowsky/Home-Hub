import { CalendarClock, ChevronDown, ChevronUp, PlayCircle, Power, type LucideIcon } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { BlindEntity, Entity, LightEntity } from '@home-hub/shared';
import { EntityTile } from '../../components/entities/EntityTile.tsx';
import { EntitySheet } from '../../components/entities/sheets.tsx';
import { allBlinds, allLightsOff, CATEGORIES, HomeNav, useHouseSummary, type Category, type HouseSummary } from '../../components/home/categories.tsx';
import { FloorSection, RoomHeading } from '../../components/home/FloorSection.tsx';
import { EntityRow } from '../../components/home/rows.tsx';
import { Button, cx, EmptyState, IconButton, PageHeader, Row, RowGroup, Section, TileGrid, Toggle, toneSoft, type Tone } from '../../components/ui.tsx';
import { useAllEntities, useFloors } from '../../hooks/entities.ts';
import { blind, sendCommand, toggleClock } from '../../lib/actions.ts';
import { formatNumber } from '../../lib/format.ts';
import { useCan } from '../../store/session.ts';

/** The big figure at the top of a menu — what the inspiration calls "22 °C". */
function Hero({ icon: Icon, tone, figure, unit, caption, children }: { icon: LucideIcon; tone: Tone; figure: ReactNode; unit?: string; caption: ReactNode; children?: ReactNode }) {
  return (
    <div className="panel mb-8 flex flex-wrap items-center gap-x-5 gap-y-4 rounded-tile p-5">
      <span className={cx('flex size-14 shrink-0 items-center justify-center rounded-2xl', toneSoft[tone])}>
        <Icon className="size-7" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[40px] font-semibold leading-none tracking-tight tabular-nums">
          {figure}
          {unit && <span className="ml-1 align-top text-xl font-medium text-muted">{unit}</span>}
        </p>
        <p className="mt-1.5 text-muted">{caption}</p>
      </div>
      {children && <div className="flex w-full gap-2 sm:w-auto">{children}</div>}
    </div>
  );
}

function CategoryHero({ category, summary, canControl }: { category: Category; summary: HouseSummary; canControl: boolean }) {
  switch (category.id) {
    case 'licht':
      return (
        <Hero icon={category.icon} tone="warm" figure={summary.lightsOn.length} caption={`von ${summary.lights.length} Lichtern ${summary.lightsOn.length === 1 ? 'ist' : 'sind'} an`}>
          {canControl && summary.lightsOn.length > 0 && (
            <Button icon={Power} className="flex-1 sm:flex-none" onClick={() => allLightsOff(summary)}>
              Alle aus
            </Button>
          )}
        </Hero>
      );
    case 'jalousien':
      return (
        <Hero
          icon={category.icon}
          tone="cool"
          figure={summary.blindsMoving > 0 ? summary.blindsMoving : summary.blindsClosed}
          caption={summary.blindsMoving > 0 ? `von ${summary.blinds.length} fahren gerade` : `von ${summary.blinds.length} sind geschlossen`}
        >
          {canControl && summary.blinds.length > 0 && (
            <>
              <Button icon={ChevronUp} className="flex-1 sm:flex-none" onClick={() => allBlinds(summary, 'up')}>
                Alle hoch
              </Button>
              <Button icon={ChevronDown} className="flex-1 sm:flex-none" onClick={() => allBlinds(summary, 'down')}>
                Alle runter
              </Button>
            </>
          )}
        </Hero>
      );
    case 'klima':
      return (
        <Hero
          icon={category.icon}
          tone="warm"
          figure={summary.averageTemperature === null ? '–' : formatNumber(summary.averageTemperature)}
          unit="°C"
          caption={`im Schnitt · ${summary.heating === 0 ? 'keine Heizung aktiv' : summary.heating === 1 ? '1 Raum heizt' : `${summary.heating} Räume heizen`}`}
        />
      );
    case 'geraete':
      return <Hero icon={category.icon} tone="accent" figure={summary.switchesOn} caption={`von ${summary.switches} Geräten ${summary.switchesOn === 1 ? 'ist' : 'sind'} eingeschaltet`} />;
    case 'aktionen':
      return null;
  }
}

/** Quick controls next to a room's name in a menu: everything in this room at once. */
function RoomActions({ category, entities, canControl }: { category: Category; entities: Entity[]; canControl: boolean }) {
  if (!canControl) return null;
  if (category.id === 'licht') {
    const on = entities.filter((entity): entity is LightEntity => entity.kind === 'light' && entity.on && entity.available);
    if (on.length < 2) return null;
    return (
      <Button size="sm" variant="ghost" icon={Power} onClick={() => on.forEach((entity) => void sendCommand(entity, { action: 'turn_off' }, { on: false }))}>
        Aus
      </Button>
    );
  }
  if (category.id === 'jalousien') {
    const blinds = entities.filter((entity): entity is BlindEntity => entity.kind === 'blind' && entity.available);
    if (blinds.length < 2) return null;
    return (
      <>
        <IconButton size="sm" icon={ChevronUp} label="Alle im Raum hochfahren" onClick={() => blinds.forEach((entity) => void blind.up(entity))} />
        <IconButton size="sm" icon={ChevronDown} label="Alle im Raum herunterfahren" onClick={() => blinds.forEach((entity) => void blind.down(entity))} />
      </>
    );
  }
  return null;
}

function roomMeta(category: Category, entities: Entity[]): string | undefined {
  if (category.id === 'licht') {
    const on = entities.filter((entity) => entity.kind === 'light' && entity.on).length;
    return on > 0 ? `${on} an` : undefined;
  }
  return undefined;
}

/** A room (or "Ganzes Haus") as a card of device rows. */
function RoomCard({ title, id, meta, actions, entities, room, onDetails }: { title: string; id?: string; meta?: string; actions?: ReactNode; entities: Entity[]; room?: string; onDetails(id: string): void }) {
  // A room with a single device is just that device, under the room's name.
  if (room && entities.length === 1) {
    return (
      <div className="panel mb-3 break-inside-avoid overflow-hidden rounded-tile">
        <EntityRow entity={entities[0]!} room={room} title={room} onDetails={onDetails} />
      </div>
    );
  }
  return (
    <div className="panel mb-3 break-inside-avoid overflow-hidden rounded-tile">
      <div className="px-3 pt-2.5">
        <RoomHeading id={id} name={title} meta={meta} actions={actions} />
      </div>
      <div className="divide-y divide-line/70">
        {entities.map((entity) => (
          <EntityRow key={entity.id} entity={entity} room={room} onDetails={onDetails} />
        ))}
      </div>
    </div>
  );
}

const MASONRY = 'columns-1 gap-3 md:columns-2 xl:columns-3';

function Clocks({ canControl }: { canControl: boolean }) {
  const all = useAllEntities();
  const clocks = all.filter((entity) => entity.kind === 'clock');
  if (clocks.length === 0) return null;
  return (
    <Section title="Zeitschaltuhren">
      <RowGroup>
        {clocks.map((clock) => (
          <Row
            key={clock.id}
            icon={CalendarClock}
            tone={clock.enabled === false ? 'neutral' : 'accent'}
            className={clock.available ? undefined : 'opacity-60'}
            title={clock.name}
            subtitle={!clock.available ? 'Nicht erreichbar' : [clock.room, clock.enabled === false ? 'Pausiert' : 'Aktiv'].filter(Boolean).join(' · ')}
            trailing={
              <Toggle
                checked={clock.enabled !== false}
                label={`${clock.name} ${clock.enabled === false ? 'aktivieren' : 'pausieren'}`}
                disabled={!canControl || !clock.available || !clock.features.toggle}
                onChange={() => void toggleClock(clock)}
              />
            }
          />
        ))}
      </RowGroup>
    </Section>
  );
}

/** One function across the whole house — all lights, all blinds … — by storey and room. */
export function CategoryPage({ id }: { id: Category['id'] }) {
  const category = CATEGORIES.find((entry) => entry.id === id)!;
  const summary = useHouseSummary();
  const floors = useFloors();
  const all = useAllEntities();
  const canControl = useCan('home.control');
  const [details, setDetails] = useState<string | null>(null);

  const { house, unassigned, layout } = useMemo(() => {
    // Timers are listed separately below; they do not belong to a room.
    const matches = (entity: Entity) => category.kinds.includes(entity.kind) && entity.kind !== 'clock';
    const ofKind = all.filter(matches);
    const groups = ofKind.filter((entity) => 'isGroup' in entity && entity.isGroup);
    return {
      house: groups,
      unassigned: ofKind.filter((entity) => entity.room === null && !groups.includes(entity)),
      layout: floors
        .map((floor) => ({
          name: floor.name,
          rooms: floor.rooms.map((room) => ({ id: room.id, name: room.name, entities: room.entities.filter(matches) })).filter((room) => room.entities.length > 0),
        }))
        .filter((floor) => floor.rooms.length > 0),
    };
  }, [all, floors, category]);

  const empty = house.length === 0 && unassigned.length === 0 && layout.length === 0;
  const named = layout.some((floor) => floor.name);

  return (
    <>
      <PageHeader title={category.title} />
      <HomeNav />
      <CategoryHero category={category} summary={summary} canControl={canControl} />

      {empty && category.id !== 'aktionen' && <EmptyState icon={category.icon} title={`Keine ${category.label === 'Licht' ? 'Lichter' : category.label}`} text="Sobald solche Geräte in der Gebäudesteuerung eingerichtet sind, erscheinen sie hier." />}
      {empty && category.id === 'aktionen' && summary.actions === 0 && (
        <EmptyState icon={PlayCircle} title="Noch keine Aktionen" text="Szenen und Zeitschaltuhren aus deiner Gebäudesteuerung erscheinen hier automatisch." />
      )}

      {house.length > 0 && category.id !== 'aktionen' && (
        <div className={cx(MASONRY, 'mb-6')}>
          <RoomCard title="Ganzes Haus" entities={house} onDetails={setDetails} />
        </div>
      )}

      {category.id === 'aktionen' && unassigned.length > 0 && (
        <Section title="Szenen">
          <TileGrid>
            {unassigned.map((entity) => (
              <EntityTile key={entity.id} entity={entity} onDetails={setDetails} />
            ))}
          </TileGrid>
        </Section>
      )}

      {layout.map((floor) => (
        <FloorSection key={floor.name || 'haus'} name={named ? floor.name : ''}>
          <div className={MASONRY}>
            {floor.rooms.map((room) => (
              <RoomCard
                key={room.id}
                id={room.id}
                title={room.name}
                room={room.name}
                meta={roomMeta(category, room.entities)}
                actions={<RoomActions category={category} entities={room.entities} canControl={canControl} />}
                entities={room.entities}
                onDetails={setDetails}
              />
            ))}
          </div>
        </FloorSection>
      ))}

      {category.id !== 'aktionen' && unassigned.length > 0 && (
        <div className={MASONRY}>
          <RoomCard title="Ohne Raum" entities={unassigned} onDetails={setDetails} />
        </div>
      )}

      {category.id === 'aktionen' && <Clocks canControl={canControl} />}

      <EntitySheet entityId={details} onClose={() => setDetails(null)} />
    </>
  );
}
