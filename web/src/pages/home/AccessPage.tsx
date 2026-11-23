import { Bell, Check, ChevronRight, DoorOpen, Pencil, RotateCcw, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { mergeOrder, setPageOrder, sortByPage, type AccessEntity, type ContactEntity, type DoorEntity, type Entity } from '@home-hub/shared';
import { AccessControls, accessIcon, accessIsOpen, accessStateText, isGate } from '../../components/entities/access.tsx';
import { contactIcon, entityIcon } from '../../components/entities/icons.ts';
import { EntitySheet } from '../../components/entities/sheets.tsx';
import { HomeNav } from '../../components/home/categories.tsx';
import { SortableList } from '../../components/layout/SortableList.tsx';
import { Button, cx, EmptyState, PageHeader, Row, RowGroup, Section, toneSoft } from '../../components/ui.tsx';
import { formatAgo } from '../../lib/format.ts';
import { saveLayout } from '../../lib/layout.ts';
import { useHub } from '../../store/hub.ts';
import { useCan, useIsAdmin } from '../../store/session.ts';
import { OpenDoorSlider } from '../security/DoorPage.tsx';

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'de', { numeric: true });

/** One door or gate of the building controller: its state, the slider to open it and the other commands. */
function AccessCard({ entity, onDetails }: { entity: AccessEntity; onDetails(id: string): void }) {
  const Icon = accessIcon(entity);
  const open = accessIsOpen(entity);
  const gate = isGate(entity);
  return (
    <div className={cx('panel flex flex-col gap-3 rounded-tile p-4', !entity.available && 'opacity-60')}>
      <button type="button" onClick={() => onDetails(entity.id)} className="flex items-center gap-3 text-left" aria-label={`${entity.name}: Details`}>
        <span className={cx('flex size-11 shrink-0 items-center justify-center rounded-full', open ? toneSoft.warn : toneSoft.ok)}>
          <Icon className="size-5.5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold">{entity.name}</span>
          <span className={cx('block truncate text-[13px]', open ? 'text-warn' : 'text-muted')}>
            {entity.available ? accessStateText(entity) : 'Nicht erreichbar'}
            {entity.room ? ` · ${entity.room}` : ''}
          </span>
        </span>
        <ChevronRight className="size-4.5 shrink-0 text-faint" aria-hidden />
      </button>
      {gate && entity.level !== null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-label={`${entity.name} geöffnet`} aria-valuenow={entity.level} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-warn transition-[width] duration-700" style={{ width: `${entity.level}%` }} />
        </div>
      )}
      <AccessControls entity={entity} compact />
    </div>
  );
}

/** A door station (DoorBird) with its door openers. */
function DoorStationCard({ door }: { door: DoorEntity }) {
  const canOpen = useCan('doors.open');
  const deviceId = door.id.slice(door.id.indexOf(':') + 1);
  return (
    <div className={cx('panel flex flex-col gap-3 rounded-tile p-4', !door.available && 'opacity-60')}>
      <Link to={`/sicherheit/tuer/${deviceId}`} className="flex items-center gap-3">
        <span className={cx('flex size-11 shrink-0 items-center justify-center rounded-full', toneSoft.accent)}>
          <Bell className="size-5.5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold">{door.name}</span>
          <span className="block truncate text-[13px] text-muted">
            Türstation{door.lastRingAt ? ` · geklingelt ${formatAgo(door.lastRingAt)}` : ''}
          </span>
        </span>
        <ChevronRight className="size-4.5 shrink-0 text-faint" aria-hidden />
      </Link>
      {canOpen && door.available && door.relays.map((relay) => <OpenDoorSlider key={relay.id} door={door} relayId={relay.id} relayName={relay.name} />)}
    </div>
  );
}

/**
 * "Zutritt": every door and gate in one place — the building controller's door openers and
 * gates, the door stations, and the door contacts that only report open or closed.
 */
/** A list of the page in edit mode: entries moved by their grip. */
function OrderList({ entities, onReorder }: { entities: Entity[]; onReorder(ids: string[]): void }) {
  return (
    <div className="overflow-hidden rounded-tile bg-surface shadow-tile">
      <SortableList
        items={entities.map((entity) => ({ id: entity.id, label: entity.name }))}
        onReorder={onReorder}
        render={(item) => {
          const entity = entities.find((entry) => entry.id === item.id)!;
          const Icon = entity.kind === 'contact' ? contactIcon(entity) : entity.kind === 'door' ? Bell : entityIcon(entity);
          return (
            <div className="flex items-center gap-2.5 py-2.5 pr-3">
              <Icon className="size-4.5 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{entity.name}</span>
              {entity.room && <span className="truncate text-sm text-faint">{entity.room}</span>}
            </div>
          );
        }}
      />
    </div>
  );
}

/**
 * "Zutritt": every door and gate in one place — the building controller's door openers and
 * gates, the door stations, and the door contacts that only report open or closed.
 */
export function AccessPage() {
  const entities = useHub((state) => state.entities);
  const order = useHub((state) => state.layout.pageOrder?.zutritt);
  const isAdmin = useIsAdmin();
  const [details, setDetails] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const { access, stations, contacts } = useMemo(() => {
    const all = Object.values(entities);
    const accessList = sortByPage(all.filter((e): e is AccessEntity => e.kind === 'access').sort(byName), order, (e) => e.id);
    const linked = new Set(accessList.map((e) => e.id));
    return {
      access: accessList,
      stations: sortByPage(all.filter((e): e is DoorEntity => e.kind === 'door').sort(byName), order, (e) => e.id),
      // Door contacts that do not belong to an access element already shown above.
      contacts: sortByPage(
        all
          .filter((e): e is ContactEntity => e.kind === 'contact' && (e.contactType === 'door' || e.contactType === 'garage') && !(e.linkedEntityId && linked.has(e.linkedEntityId)))
          .sort(byName),
        order,
        (e) => e.id,
      ),
    };
  }, [entities, order]);

  const openCount = access.filter(accessIsOpen).length + contacts.filter((c) => c.open).length;
  const total = access.length + contacts.length;
  const everything = [...access, ...stations, ...contacts].map((entity) => entity.id);
  const reorder = (ids: string[]) => void saveLayout(setPageOrder(useHub.getState().layout, 'zutritt', mergeOrder(everything, ids)), 'Reihenfolge auf „Zutritt“ geändert');

  return (
    <>
      <PageHeader
        title="Zutritt"
        actions={
          isAdmin &&
          total + stations.length > 0 &&
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
      {total + stations.length === 0 ? (
        <>
          <HomeNav />
          <EmptyState icon={DoorOpen} title="Keine Türen und Tore" text="Türöffner, Tore und Türkontakte aus der Gebäudesteuerung und Türstationen erscheinen hier." />
        </>
      ) : editing ? (
        <>
          <div className="mb-6 flex flex-wrap items-start gap-x-3 gap-y-2 px-1">
            <p className="min-w-0 flex-1 basis-64 text-sm text-muted">Einträge am Griff ziehen, um die Reihenfolge zu ändern. Gilt für alle im Haushalt.</p>
            {order && (
              <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => void saveLayout(setPageOrder(useHub.getState().layout, 'zutritt', null), 'Reihenfolge auf „Zutritt“ zurückgesetzt')}>
                Reihenfolge zurücksetzen
              </Button>
            )}
          </div>
          {access.length > 0 && (
            <Section title="Türen & Tore">
              <OrderList entities={access} onReorder={reorder} />
            </Section>
          )}
          {stations.length > 0 && (
            <Section title="Türstationen">
              <OrderList entities={stations} onReorder={reorder} />
            </Section>
          )}
          {contacts.length > 0 && (
            <Section title="Türkontakte">
              <OrderList entities={contacts} onReorder={reorder} />
            </Section>
          )}
        </>
      ) : (
        <>
          <HomeNav />
          <div className="panel mb-6 flex items-center gap-4 rounded-tile p-5">
            <span className={cx('flex size-14 shrink-0 items-center justify-center rounded-2xl', openCount > 0 ? toneSoft.warn : toneSoft.ok)}>
              {openCount > 0 ? <DoorOpen className="size-7" aria-hidden /> : <ShieldCheck className="size-7" aria-hidden />}
            </span>
            <div>
              <p className="text-[40px] font-semibold leading-none tracking-tight tabular-nums">{openCount > 0 ? openCount : 'Alles zu'}</p>
              <p className="mt-1.5 text-muted">{openCount > 0 ? `von ${total} Türen und Toren ${openCount === 1 ? 'ist' : 'sind'} offen` : `${total} Türen und Tore`}</p>
            </div>
          </div>

          {access.length > 0 && (
            <Section title="Türen & Tore">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {access.map((entity) => (
                  <AccessCard key={entity.id} entity={entity} onDetails={setDetails} />
                ))}
              </div>
            </Section>
          )}

          {stations.length > 0 && (
            <Section title="Türstationen">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {stations.map((door) => (
                  <DoorStationCard key={door.id} door={door} />
                ))}
              </div>
            </Section>
          )}

          {contacts.length > 0 && (
            <Section title="Türkontakte">
              <RowGroup>
                {contacts.map((contact) => (
                  <Row
                    key={contact.id}
                    icon={contactIcon(contact)}
                    tone={contact.open ? 'warn' : 'ok'}
                    title={contact.name}
                    subtitle={[contact.room, contact.changedAt ? `seit ${formatAgo(contact.changedAt)}` : null].filter(Boolean).join(' · ') || undefined}
                    trailing={<span className={contact.open ? 'font-medium text-warn' : undefined}>{contact.open ? 'Offen' : 'Zu'}</span>}
                    onClick={() => setDetails(contact.id)}
                  />
                ))}
              </RowGroup>
            </Section>
          )}
        </>
      )}
      <EntitySheet entityId={details} onClose={() => setDetails(null)} />
    </>
  );
}
