import { Bell, ChevronRight, DoorOpen, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AccessEntity, ContactEntity, DoorEntity } from '@home-hub/shared';
import { AccessControls, accessIcon, accessIsOpen, accessStateText, isGate } from '../../components/entities/access.tsx';
import { contactIcon } from '../../components/entities/icons.ts';
import { EntitySheet } from '../../components/entities/sheets.tsx';
import { HomeNav } from '../../components/home/categories.tsx';
import { FloorFilter, useFloorFilter } from '../../components/home/FloorFilter.tsx';
import { cx, EmptyState, PageHeader, Row, RowGroup, Section, toneSoft } from '../../components/ui.tsx';
import { groupByFloor } from '../../hooks/entities.ts';
import { formatAgo } from '../../lib/format.ts';
import { useHub } from '../../store/hub.ts';
import { useCan } from '../../store/session.ts';
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
export function AccessPage() {
  const entities = useHub((state) => state.entities);
  const floors = useHub((state) => state.floors);
  const [details, setDetails] = useState<string | null>(null);
  const floor = useFloorFilter();

  const { access, stations, contacts } = useMemo(() => {
    const all = Object.values(entities);
    const accessList = all.filter((e): e is AccessEntity => e.kind === 'access').sort(byName);
    const linked = new Set(accessList.map((e) => e.id));
    return {
      access: accessList,
      stations: all.filter((e): e is DoorEntity => e.kind === 'door').sort(byName),
      // Door contacts that do not belong to an access element already shown above.
      contacts: all
        .filter((e): e is ContactEntity => e.kind === 'contact' && (e.contactType === 'door' || e.contactType === 'garage') && !(e.linkedEntityId && linked.has(e.linkedEntityId)))
        .sort(byName),
    };
  }, [entities]);

  // The storey filter of the room pages applies here too.
  const inFloor = <T extends { room: string | null }>(list: T[]): T[] => {
    if (!floor.selected) return list;
    const rooms = groupByFloor(
      [...new Set(list.map((e) => e.room ?? ''))].map((name) => ({ name })),
      floors,
    ).find((group) => group.name === floor.selected);
    const names = new Set(rooms?.rooms.map((room) => room.name));
    return list.filter((e) => names.has(e.room ?? ''));
  };
  const shownAccess = inFloor(access);
  const shownContacts = inFloor(contacts);
  const openCount = access.filter(accessIsOpen).length + contacts.filter((c) => c.open).length;
  const total = access.length + contacts.length;

  return (
    <>
      <PageHeader title="Zutritt" />
      <HomeNav />
      {total + stations.length === 0 ? (
        <EmptyState icon={DoorOpen} title="Keine Türen und Tore" text="Türöffner, Tore und Türkontakte aus der Gebäudesteuerung und Türstationen erscheinen hier." />
      ) : (
        <>
          <div className="panel mb-6 flex items-center gap-4 rounded-tile p-5">
            <span className={cx('flex size-14 shrink-0 items-center justify-center rounded-2xl', openCount > 0 ? toneSoft.warn : toneSoft.ok)}>
              {openCount > 0 ? <DoorOpen className="size-7" aria-hidden /> : <ShieldCheck className="size-7" aria-hidden />}
            </span>
            <div>
              <p className="text-[40px] font-semibold leading-none tracking-tight tabular-nums">{openCount > 0 ? openCount : 'Alles zu'}</p>
              <p className="mt-1.5 text-muted">{openCount > 0 ? `von ${total} Türen und Toren ${openCount === 1 ? 'ist' : 'sind'} offen` : `${total} Türen und Tore`}</p>
            </div>
          </div>
          <FloorFilter state={floor} />

          {shownAccess.length > 0 && (
            <Section title="Türen & Tore">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {shownAccess.map((entity) => (
                  <AccessCard key={entity.id} entity={entity} onDetails={setDetails} />
                ))}
              </div>
            </Section>
          )}

          {stations.length > 0 && !floor.selected && (
            <Section title="Türstationen">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {stations.map((door) => (
                  <DoorStationCard key={door.id} door={door} />
                ))}
              </div>
            </Section>
          )}

          {shownContacts.length > 0 && (
            <Section title="Türkontakte">
              <RowGroup>
                {shownContacts.map((contact) => (
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
