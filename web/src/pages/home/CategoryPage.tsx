import { Check, ChevronDown, ChevronUp, Eye, EyeOff, Pencil, PlayCircle, Power, RotateCcw, type LucideIcon } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { mergeOrder, orderDevices, setDevice, setPageOrder, sortByPage, type BlindEntity, type Entity, type LightEntity } from '@home-hub/shared';
import { EntityTile } from '../../components/entities/EntityTile.tsx';
import { entityIcon } from '../../components/entities/icons.ts';
import { EntitySheet } from '../../components/entities/sheets.tsx';
import { allBlinds, allLightsOff, CATEGORIES, HomeNav, useHouseSummary, type Category, type HouseSummary } from '../../components/home/categories.tsx';
import { FloorSection, RoomHeading } from '../../components/home/FloorSection.tsx';
import { FloorFilter, useFloorFilter } from '../../components/home/FloorFilter.tsx';
import { EntityRow } from '../../components/home/rows.tsx';
import { DeviceEditor } from '../../components/layout/DeviceEditor.tsx';
import { SortableList } from '../../components/layout/SortableList.tsx';
import { TimersSection } from './TimersSection.tsx';
import { Button, cx, EmptyState, IconButton, PageHeader, Section, TileGrid, toneSoft, type Tone } from '../../components/ui.tsx';
import { buildRooms, groupByFloor, topDown, useAllEntities, useFloors } from '../../hooks/entities.ts';
import { blind, sendCommand } from '../../lib/actions.ts';
import { formatNumber } from '../../lib/format.ts';
import { saveLayout } from '../../lib/layout.ts';
import { useHub } from '../../store/hub.ts';
import { useCan, useIsAdmin } from '../../store/session.ts';

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
    case 'zutritt':
    case 'aktionen':
    case 'uhren':
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

/** A device in the editor: visible or not, name and room. */
function EditRow({ entity, onEdit }: { entity: Entity; onEdit(id: string): void }) {
  const Icon = entityIcon(entity);
  const toggle = () => void saveLayout(setDevice(useHub.getState().layout, entity, { hidden: !entity.hidden }), `„${entity.name}“ ${entity.hidden ? 'eingeblendet' : 'ausgeblendet'}`);
  return (
    <div className="flex items-center gap-2.5 py-1.5 pr-1.5">
      <Icon className={cx('size-4.5 shrink-0', entity.hidden ? 'text-faint' : 'text-muted')} aria-hidden />
      <span className={cx('min-w-0 flex-1 truncate', entity.hidden && 'text-faint line-through decoration-faint/50')}>{entity.name}</span>
      <IconButton icon={entity.hidden ? EyeOff : Eye} size="sm" active={!entity.hidden} label={entity.hidden ? `${entity.name} einblenden` : `${entity.name} ausblenden`} onClick={toggle} />
      <IconButton icon={Pencil} size="sm" label={`${entity.name} bearbeiten`} onClick={() => onEdit(entity.id)} />
    </div>
  );
}

/**
 * The menu in edit mode (administrators): every device of this function, the
 * hidden ones too — sorted within their rooms, shown or hidden, renamed or
 * moved to another room.
 */
function CategoryEditor({ category }: { category: Category }) {
  const entities = useHub((state) => state.entities);
  const hidden = useHub((state) => state.hidden);
  const layout = useHub((state) => state.layout);
  const floors = useHub((state) => state.floors);
  const [editing, setEditing] = useState<string | null>(null);
  const matches = (entity: Entity) => category.kinds.includes(entity.kind) && entity.kind !== 'clock';

  const { grouped, house, unassigned } = useMemo(() => {
    const all = [...Object.values(entities), ...Object.values(hidden)];
    const isGroup = (entity: Entity) => 'isGroup' in entity && entity.isGroup;
    return {
      // Rooms with all their devices: the order is kept for the whole room.
      grouped: groupByFloor(buildRooms(all, [], layout), floors),
      house: all.filter((entity) => matches(entity) && isGroup(entity)),
      unassigned: all.filter((entity) => matches(entity) && entity.room === null && !isGroup(entity)),
    };
  }, [entities, hidden, layout, floors, category]);

  // Rooms with something of this function, in the page's order within each storey.
  const shown = topDown(grouped)
    .map((floor) => ({
      name: floor.name,
      rooms: sortByPage(
        floor.rooms.map((room) => ({ room, own: room.entities.filter(matches) })).filter((entry) => entry.own.length > 0),
        layout.pageOrder?.[category.id],
        (entry) => entry.room.id,
      ),
    }))
    .filter((floor) => floor.rooms.length > 0);
  const pageRooms = shown.flatMap((floor) => floor.rooms.map(({ room }) => room.id));

  const plain = (title: string, list: Entity[]) =>
    list.length > 0 && (
      <div className="panel mb-3 break-inside-avoid overflow-hidden rounded-tile px-3 pt-2.5">
        <RoomHeading name={title} />
        <div className="divide-y divide-line/70">
          {list.map((entity) => (
            <EditRow key={entity.id} entity={entity} onEdit={setEditing} />
          ))}
        </div>
      </div>
    );

  return (
    <>
      {(house.length > 0 || unassigned.length > 0) && (
        <div className={cx(MASONRY, 'mb-6')}>
          {plain('Ganzes Haus', house)}
          {plain(category.id === 'aktionen' ? 'Szenen' : 'Ohne Raum', unassigned)}
        </div>
      )}
      {shown.map((floor) => (
        <FloorSection key={floor.name || 'haus'} name={floor.name}>
          {/* Rooms are moved by their grip on the left, devices inside by theirs. */}
          <SortableList
            items={floor.rooms.map(({ room }) => ({ id: room.id, label: room.name }))}
            onReorder={(ids) =>
              void saveLayout(setPageOrder(useHub.getState().layout, category.id, mergeOrder(pageRooms, ids)), `Räume auf „${category.title}“ sortiert`)
            }
            render={(item) => {
              const { room, own } = floor.rooms.find((entry) => entry.room.id === item.id)!;
              return (
                <div className="panel my-1.5 overflow-hidden rounded-tile pt-2.5">
                  <div className="px-3">
                    <RoomHeading name={room.name} />
                  </div>
                  <SortableList
                    items={own.map((entity) => ({ id: entity.id, label: entity.name }))}
                    onReorder={(ids) => void saveLayout(orderDevices(useHub.getState().layout, room.name, room.entities.map((entity) => entity.id), ids), `Reihenfolge in „${room.name}“ geändert`)}
                    render={(entry) => <EditRow entity={own.find((entity) => entity.id === entry.id)!} onEdit={setEditing} />}
                  />
                </div>
              );
            }}
          />
        </FloorSection>
      ))}
      <DeviceEditor entityId={editing} onClose={() => setEditing(null)} />
    </>
  );
}

/** One function across the whole house — all lights, all blinds … — by storey and room. */
export function CategoryPage({ id }: { id: Category['id'] }) {
  const category = CATEGORIES.find((entry) => entry.id === id)!;
  const summary = useHouseSummary();
  const floors = useFloors();
  const all = useAllEntities();
  const canControl = useCan('home.control');
  const isAdmin = useIsAdmin();
  const [details, setDetails] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const floorFilter = useFloorFilter({ topDown: true });

  const pageOrder = useHub((state) => state.layout.pageOrder?.[id]);
  const { house, unassigned, layout } = useMemo(() => {
    // Time switches have a page of their own; they do not belong to a room.
    const matches = (entity: Entity) => category.kinds.includes(entity.kind) && entity.kind !== 'clock';
    const ofKind = all.filter(matches);
    const groups = ofKind.filter((entity) => 'isGroup' in entity && entity.isGroup);
    return {
      house: groups,
      unassigned: ofKind.filter((entity) => entity.room === null && !groups.includes(entity)),
      // From the top of the house to the bottom, whatever the order on the Räume page.
      layout: topDown(floors)
        .map((floor) => ({
          name: floor.name,
          rooms: sortByPage(
            floor.rooms.map((room) => ({ id: room.id, name: room.name, entities: room.entities.filter(matches) })).filter((room) => room.entities.length > 0),
            pageOrder,
            (room) => room.id,
          ),
        }))
        .filter((floor) => floor.rooms.length > 0),
    };
  }, [all, floors, category, pageOrder]);

  if (category.id === 'uhren') {
    return (
      <>
        <PageHeader title={category.title} />
        <HomeNav />
        <TimersSection canControl={canControl} />
      </>
    );
  }

  const empty = house.length === 0 && unassigned.length === 0 && layout.length === 0;
  const named = layout.some((floor) => floor.name);
  const shownLayout = floorFilter.selected ? layout.filter((floor) => floor.name === floorFilter.selected) : layout;

  return (
    <>
      <PageHeader
        title={category.title}
        actions={
          isAdmin &&
          (editing ? (
            <Button size="sm" variant="primary" icon={Check} onClick={() => setEditing(false)}>
              Fertig
            </Button>
          ) : (
            <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(true)}>
              Bearbeiten
            </Button>
          ))
        }
      />
      {editing ? (
        <>
          <div className="mb-6 flex flex-wrap items-start gap-x-3 gap-y-2 px-1">
            <p className="min-w-0 flex-1 basis-64 text-sm text-muted">
              Räume und Geräte am Griff ziehen zum Sortieren, mit dem Auge aus- und einblenden, mit dem Stift umbenennen oder in einen anderen Raum legen. Gilt für alle im Haushalt.
            </p>
            {pageOrder && (
              <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => void saveLayout(setPageOrder(useHub.getState().layout, id, null), `Reihenfolge auf „${category.title}“ zurückgesetzt`)}>
                Reihenfolge der Räume zurücksetzen
              </Button>
            )}
          </div>
          <CategoryEditor category={category} />
        </>
      ) : (
        <>
          <HomeNav />
          <CategoryHero category={category} summary={summary} canControl={canControl} />
          {category.id !== 'aktionen' && layout.length > 1 && <FloorFilter state={floorFilter} />}

          {empty && category.id !== 'aktionen' && <EmptyState icon={category.icon} title={`Keine ${category.label === 'Licht' ? 'Lichter' : category.label}`} text="Sobald solche Geräte in der Gebäudesteuerung eingerichtet sind, erscheinen sie hier." />}
          {empty && category.id === 'aktionen' && <EmptyState icon={PlayCircle} title="Noch keine Szenen" text="Aktionen aus deiner Gebäudesteuerung erscheinen hier automatisch als Szenen." />}

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

          {shownLayout.map((floor) => (
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
        </>
      )}

      <EntitySheet entityId={details} onClose={() => setDetails(null)} />
    </>
  );
}
