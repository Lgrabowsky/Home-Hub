import { Bell, Camera, ChevronRight, Shield, ShieldAlert, ShieldCheck, Wind } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AlarmEntity, CameraEntity, ContactEntity, DoorEntity } from '@home-hub/shared';
import { contactIcon } from '../../components/entities/icons.ts';
import { HubImage } from '../../components/HubImage.tsx';
import { Badge, Card, cx, EmptyState, Notice, PageHeader, Row, RowGroup, Section, Segmented } from '../../components/ui.tsx';
import { useEntities } from '../../hooks/entities.ts';
import { formatAgo } from '../../lib/format.ts';
import { useCan, useIsAdmin } from '../../store/session.ts';

type Filter = 'all' | 'open' | 'window' | 'door';

function ContactRow({ contact }: { contact: ContactEntity }) {
  const Icon = contactIcon(contact);
  return (
    <Row
      icon={Icon}
      tone={!contact.available ? 'neutral' : contact.open ? 'warn' : 'ok'}
      className={cx(!contact.available && 'opacity-60')}
      title={contact.name}
      subtitle={contact.room ?? contact.zone ?? undefined}
      trailing={
        !contact.available ? (
          'Nicht erreichbar'
        ) : contact.open ? (
          <span className="font-medium text-warn">Offen{contact.changedAt ? ` · seit ${formatAgo(contact.changedAt).replace(/^vor /, '')}` : ''}</span>
        ) : (
          'Geschlossen'
        )
      }
    />
  );
}

/** "Hülle": are windows and doors closed — and if not, which ones? */
function Perimeter({ contacts, alarms }: { contacts: ContactEntity[]; alarms: AlarmEntity[] }) {
  const isAdmin = useIsAdmin();
  const [filter, setFilter] = useState<Filter>('all');
  const open = contacts.filter((contact) => contact.open && contact.available);
  const triggered = alarms.filter((alarm) => alarm.triggered);
  const breachedZones = alarms.filter((alarm) => alarm.breached);
  // The controller knows that something in the zone is open, but no individual contact says so.
  const unknownOpen = breachedZones.length > 0 && open.length === 0;

  const shown = useMemo(() => {
    const filtered = contacts.filter((contact) => {
      if (filter === 'open') return contact.open;
      if (filter === 'window') return contact.contactType === 'window';
      if (filter === 'door') return contact.contactType === 'door' || contact.contactType === 'garage';
      return true;
    });
    // Open ones first — that is what the user came for.
    return [...filtered].sort((a, b) => Number(b.open) - Number(a.open) || (a.room ?? '').localeCompare(b.room ?? '', 'de') || a.name.localeCompare(b.name, 'de', { numeric: true }));
  }, [contacts, filter]);

  if (contacts.length === 0 && alarms.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Shield}
          title="Noch keine Fenster- und Türkontakte"
          text={
            isAdmin
              ? 'Sobald die Gebäudesteuerung verbunden ist und Kontakte zugeordnet sind, siehst du hier, was offen ist.'
              : 'Sobald Kontakte eingerichtet sind, siehst du hier, was offen ist.'
          }
          action={
            isAdmin ? (
              <Link to="/einstellungen/dienste/mygekko" className="text-accent underline-offset-4 hover:underline">
                Kontakte einrichten
              </Link>
            ) : undefined
          }
        />
      </Card>
    );
  }

  const tone = triggered.length > 0 ? 'danger' : open.length > 0 || unknownOpen ? 'warn' : 'ok';
  const StatusIcon = triggered.length > 0 ? ShieldAlert : tone === 'warn' ? Wind : ShieldCheck;
  return (
    <div className="space-y-2.5">
      <Card
        className={cx('flex items-center gap-4 p-4', tone === 'ok' && 'bg-ok/10', tone === 'warn' && 'bg-warn/10', tone === 'danger' && 'bg-danger/15')}
        role="status"
      >
        <span className={cx('flex size-14 shrink-0 items-center justify-center rounded-full', tone === 'ok' && 'bg-ok/20 text-ok', tone === 'warn' && 'bg-warn/20 text-warn', tone === 'danger' && 'bg-danger/25 text-danger')}>
          <StatusIcon className="size-7" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-lg font-semibold leading-snug">
            {triggered.length > 0
              ? `Alarm: ${triggered.map((alarm) => alarm.name).join(', ')}`
              : open.length > 0
                ? `${open.length} von ${contacts.length} offen`
                : unknownOpen
                  ? 'Mindestens ein Kontakt ist offen'
                  : 'Alles geschlossen'}
          </p>
          <p className="text-sm text-muted">
            {open.length > 0
              ? open.map((contact) => contact.name).join(', ')
              : unknownOpen
                ? 'Welcher, meldet die Anlage nicht einzeln.'
                : contacts.length > 0
                  ? `${contacts.length} Fenster und Türen überwacht`
                  : 'Die Alarmzone meldet keinen offenen Kontakt.'}
          </p>
        </div>
      </Card>

      {unknownOpen && isAdmin && (
        <Notice tone="neutral">
          Damit einzelne Fenster und Türen angezeigt werden, müssen ihre Kontakte zugeordnet sein.{' '}
          <Link to="/einstellungen/dienste/mygekko" className="text-accent underline-offset-2 hover:underline">
            Kontakte zuordnen
          </Link>
        </Notice>
      )}

      {alarms.length > 0 && (
        <RowGroup>
          {alarms.map((alarm) => (
            <Row
              key={alarm.id}
              icon={alarm.triggered ? ShieldAlert : ShieldCheck}
              tone={alarm.triggered ? 'danger' : alarm.breached ? 'warn' : 'ok'}
              title={alarm.name}
              subtitle={<span className="whitespace-normal">{alarm.stateText}</span>}
              trailing={<Badge tone={alarm.mode === 'armed' ? 'accent' : 'neutral'}>{alarm.mode === 'armed' ? 'Scharf' : alarm.mode === 'disarmed' ? 'Unscharf' : 'Unbekannt'}</Badge>}
            />
          ))}
        </RowGroup>
      )}

      {contacts.length > 0 && (
        <>
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'Alle' },
              { value: 'open', label: `Offen${open.length > 0 ? ` (${open.length})` : ''}` },
              { value: 'window', label: 'Fenster' },
              { value: 'door', label: 'Türen' },
            ]}
          />
          {shown.length > 0 ? (
            <RowGroup>
              {shown.map((contact) => (
                <ContactRow key={contact.id} contact={contact} />
              ))}
            </RowGroup>
          ) : (
            <p className="px-1 py-4 text-center text-muted">{filter === 'open' ? 'Nichts ist offen.' : 'Keine Einträge.'}</p>
          )}
        </>
      )}
    </div>
  );
}

function MediaCard({ entity }: { entity: DoorEntity | CameraEntity }) {
  const deviceId = entity.id.slice(entity.id.indexOf(':') + 1);
  const isDoor = entity.kind === 'door';
  const state = !entity.available
    ? 'Nicht erreichbar'
    : isDoor
      ? entity.lastRingAt
        ? `Geklingelt ${formatAgo(entity.lastRingAt)}`
        : entity.lastMotionAt
          ? `Bewegung ${formatAgo(entity.lastMotionAt)}`
          : (entity.room ?? 'Türstation')
      : (entity.room ?? entity.model ?? 'Kamera');
  return (
    <Link
      to={isDoor ? `/sicherheit/tuer/${deviceId}` : `/sicherheit/kamera/${deviceId}`}
      className={cx('group relative block aspect-video overflow-hidden rounded-tile bg-surface shadow-tile transition active:scale-[0.99]', !entity.available && 'opacity-60')}
    >
      <HubImage src={entity.available ? `/api/${isDoor ? 'doors' : 'cameras'}/${deviceId}/snapshot` : null} alt={entity.name} refreshMs={10_000} className="absolute inset-0 size-full" />
      <span className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/75 to-transparent px-3.5 pb-2.5 pt-10 text-white">
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold">{entity.name}</span>
          <span className="block truncate text-[13px] text-white/75">{state}</span>
        </span>
        <ChevronRight className="mb-1 size-5 shrink-0 opacity-70 transition group-hover:translate-x-0.5" aria-hidden />
      </span>
    </Link>
  );
}

export function SecurityPage() {
  const contacts = useEntities('contact');
  const alarms = useEntities('alarm');
  const doors = useEntities('door');
  const cameras = useEntities('camera');
  const canSecurity = useCan('security.view');
  const canDoors = useCan('doors.view');
  const canCameras = useCan('cameras.view');

  if (!canSecurity && !canDoors && !canCameras) {
    return (
      <>
        <PageHeader title="Sicherheit" />
        <EmptyState icon={Shield} title="Kein Zugriff" text="Für diesen Bereich fehlt dir die Berechtigung." />
      </>
    );
  }

  const hasMedia = (canDoors && doors.length > 0) || (canCameras && cameras.length > 0);
  return (
    <>
      <PageHeader title="Sicherheit" />
      <div className={cx('lg:grid lg:items-start lg:gap-8', canSecurity && hasMedia && 'lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]')}>
        {canSecurity && (
          <Section title="Fenster & Türen">
            <Perimeter contacts={contacts} alarms={alarms} />
          </Section>
        )}
        <div>
          {canDoors && doors.length > 0 && (
            <Section title="Türen">
              <div className="grid gap-2.5 sm:grid-cols-2">
                {doors.map((door) => (
                  <MediaCard key={door.id} entity={door} />
                ))}
              </div>
            </Section>
          )}
          {canCameras && cameras.length > 0 && (
            <Section title="Kameras">
              <div className="grid gap-2.5 sm:grid-cols-2">
                {cameras.map((camera) => (
                  <MediaCard key={camera.id} entity={camera} />
                ))}
              </div>
            </Section>
          )}
          {!hasMedia && !canSecurity && <EmptyState icon={Camera} title="Noch keine Kameras oder Türstationen" />}
          {!hasMedia && canSecurity && (canDoors || canCameras) && (
            <Section title="Kameras & Türen">
              <Card>
                <EmptyState icon={Bell} title="Noch keine Kameras oder Türstationen" text="Sobald sie eingerichtet sind, erscheinen ihre Bilder hier." />
              </Card>
            </Section>
          )}
        </div>
      </div>
    </>
  );
}
