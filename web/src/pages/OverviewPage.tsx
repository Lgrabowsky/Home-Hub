import {
  AlertTriangle,
  Bell,
  ChevronRight,
  Lightbulb,
  Music2,
  PlayCircle,
  Power,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Star,
  Thermometer,
  Wind,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { SERVICE_LABELS, type ActionEntity, type Entity, type LightEntity } from '@home-hub/shared';
import { EntityTile } from '../components/entities/EntityTile.tsx';
import { EntitySheet } from '../components/entities/sheets.tsx';
import { HubImage } from '../components/HubImage.tsx';
import { Button, Card, cx, EmptyState, Notice, Row, RowGroup, Section, Sheet, TileGrid, Toggle, toneSoft, type Tone } from '../components/ui.tsx';
import { useFavorites, useRooms } from '../hooks/entities.ts';
import { light, runAction, sendCommand } from '../lib/actions.ts';
import { formatAgo, formatTemperature, greeting } from '../lib/format.ts';
import { useHub } from '../store/hub.ts';
import { useCan, useIsAdmin, useSession } from '../store/session.ts';

const DATE = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'de', { numeric: true });

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
    <button
      type="button"
      onClick={onClick}
      className={cx('flex h-10 shrink-0 items-center gap-2 rounded-full pl-3 pr-4 text-sm font-medium transition active:scale-[0.97]', toneSoft[tone])}
    >
      <Icon className="size-4.5" aria-hidden />
      <span className="whitespace-nowrap text-fg">{children}</span>
    </button>
  );
}

/** The lights that are on, each switchable, plus "all off". */
function LightsOnSheet({ open, onClose, lights }: { open: boolean; onClose(): void; lights: LightEntity[] }) {
  const canControl = useCan('home.control');
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Eingeschaltete Lichter"
      footer={
        canControl && lights.length > 0 ? (
          <Button
            block
            icon={Power}
            onClick={() => {
              for (const entity of lights) void sendCommand(entity, { action: 'turn_off' }, { on: false });
              onClose();
            }}
          >
            Alle ausschalten
          </Button>
        ) : undefined
      }
    >
      {lights.length === 0 ? (
        <p className="py-6 text-center text-muted">Alle Lichter sind aus.</p>
      ) : (
        <RowGroup className="bg-sunken shadow-none">
          {lights.map((entity) => (
            <Row
              key={entity.id}
              icon={Lightbulb}
              tone="warm"
              title={entity.name}
              subtitle={entity.room ?? undefined}
              trailing={<Toggle checked={entity.on} label={`${entity.name} schalten`} tone="warm" disabled={!canControl} onChange={() => void light.toggle(entity)} />}
            />
          ))}
        </RowGroup>
      )}
    </Sheet>
  );
}

function SnapshotCard({ entity }: { entity: Extract<Entity, { kind: 'camera' | 'door' }> }) {
  const deviceId = entity.id.slice(entity.id.indexOf(':') + 1);
  const isDoor = entity.kind === 'door';
  const state = !entity.available
    ? 'Nicht erreichbar'
    : isDoor
      ? entity.lastRingAt
        ? `Geklingelt ${formatAgo(entity.lastRingAt)}`
        : 'Türstation'
      : (entity.room ?? 'Kamera');
  return (
    <Link
      to={isDoor ? `/sicherheit/tuer/${deviceId}` : `/sicherheit/kamera/${deviceId}`}
      className={cx(
        'relative block aspect-video w-64 shrink-0 snap-start overflow-hidden rounded-tile bg-surface shadow-tile transition active:scale-[0.99] sm:w-auto',
        !entity.available && 'opacity-60',
      )}
    >
      <HubImage
        src={entity.available ? `/api/${isDoor ? 'doors' : 'cameras'}/${deviceId}/snapshot` : null}
        alt={entity.name}
        refreshMs={10_000}
        className="absolute inset-0 size-full"
      />
      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-3.5 pb-2.5 pt-8 text-white">
        <span className="flex items-center gap-1.5 truncate text-[15px] font-semibold">
          {isDoor && <Bell className="size-4 shrink-0" aria-hidden />}
          {entity.name}
        </span>
        <span className="block truncate text-[13px] text-white/75">{state}</span>
      </span>
    </Link>
  );
}

export function OverviewPage() {
  const navigate = useNavigate();
  const now = useMinuteTick();
  const user = useSession((state) => state.user);
  const entities = useHub((state) => state.entities);
  const services = useHub((state) => state.services);
  const music = useHub((state) => state.music);
  const favorites = useFavorites();
  const rooms = useRooms();
  const isAdmin = useIsAdmin();
  const canSecurity = useCan('security.view');
  const canControl = useCan('home.control');
  const [details, setDetails] = useState<string | null>(null);
  const [lightsOpen, setLightsOpen] = useState(false);

  const data = useMemo(() => {
    const all = Object.values(entities);
    const lightsOn = all.filter((e): e is LightEntity => e.kind === 'light' && e.on && e.available && !e.isGroup).sort(byName);
    const contacts = all.filter((e) => e.kind === 'contact');
    const openContacts = contacts.filter((e) => e.kind === 'contact' && e.open);
    const alarms = all.filter((e) => e.kind === 'alarm');
    const alarmTriggered = alarms.some((e) => e.kind === 'alarm' && e.triggered);
    const alarmBreached = alarms.find((e) => e.kind === 'alarm' && e.breached);
    const scenes = all.filter((e): e is ActionEntity => e.kind === 'action' && e.available).sort(byName);
    const media = all.filter((e): e is Extract<Entity, { kind: 'camera' | 'door' }> => e.kind === 'camera' || e.kind === 'door').sort((a, b) => (a.kind === b.kind ? byName(a, b) : a.kind === 'door' ? -1 : 1));
    const lastRing = all
      .filter((e) => e.kind === 'door' && e.lastRingAt !== null)
      .map((e) => ({ door: e, at: e.kind === 'door' ? (e.lastRingAt ?? 0) : 0 }))
      .sort((a, b) => b.at - a.at)[0];
    const outside = entities['gekko:meteo/temperature'];
    return { all, lightsOn, contacts, openContacts, alarms, alarmTriggered, alarmBreached, scenes, media, lastRing, outside };
  }, [entities]);

  const playing = music.groups.filter((group) => group.state === 'playing');
  const problems = Object.values(services).filter((service) => service && (service.status === 'offline' || service.status === 'degraded'));
  const nothingConfigured = data.all.length === 0 && music.players.length === 0 && Object.values(services).every((service) => !service || service.status === 'unconfigured');

  const favoriteIds = new Set(favorites.map((entity) => entity.id));
  const favoriteScenes = data.scenes.filter((scene) => favoriteIds.has(scene.id));
  const scenes = (favoriteScenes.length > 0 ? favoriteScenes : data.scenes).slice(0, 8);
  const pinned = favorites.filter((entity) => entity.kind !== 'action');
  const recentRing = data.lastRing && now - data.lastRing.at < 30 * 60_000 ? data.lastRing : null;
  const outsideTemperature = data.outside?.kind === 'sensor' && typeof data.outside.value === 'number' ? data.outside.value : null;

  const header = (
    <header className="mb-5 pt-1">
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
    </header>
  );

  if (nothingConfigured) {
    return (
      <>
        {header}
        <EmptyState
          icon={Sparkles}
          title="Willkommen in deinem Home Hub"
          text={
            isAdmin
              ? 'Noch ist nichts verbunden. Richte als Erstes deine Geräte ein – Gebäudesteuerung, Türstationen, Kameras und Lautsprecher.'
              : 'Noch sind keine Geräte eingerichtet. Bitte einen Administrator, das zu erledigen.'
          }
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

  return (
    <>
      {header}

      {/* What needs attention, at a glance */}
      <div className="no-scrollbar -mx-4 mb-6 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
        {canSecurity && data.alarmTriggered && (
          <Chip icon={ShieldAlert} tone="danger" onClick={() => navigate('/sicherheit')}>
            Alarm!
          </Chip>
        )}
        {canSecurity && data.contacts.length > 0 && (
          <Chip icon={data.openContacts.length > 0 ? Wind : ShieldCheck} tone={data.openContacts.length > 0 ? 'warn' : 'ok'} onClick={() => navigate('/sicherheit')}>
            {data.openContacts.length > 0 ? `${data.openContacts.length} offen` : 'Alles geschlossen'}
          </Chip>
        )}
        {canSecurity && data.contacts.length === 0 && data.alarms.length > 0 && (
          <Chip icon={data.alarmBreached ? Wind : ShieldCheck} tone={data.alarmBreached ? 'warn' : 'ok'} onClick={() => navigate('/sicherheit')}>
            {data.alarmBreached ? `${data.alarmBreached.name}: Kontakt offen` : 'Alles geschlossen'}
          </Chip>
        )}
        {data.lightsOn.length > 0 && (
          <Chip icon={Lightbulb} tone="warm" onClick={() => setLightsOpen(true)}>
            {data.lightsOn.length === 1 ? '1 Licht an' : `${data.lightsOn.length} Lichter an`}
          </Chip>
        )}
        {playing.length > 0 && (
          <Chip icon={Music2} tone="music" onClick={() => navigate('/musik')}>
            Musik in {playing[0]!.name}
            {playing.length > 1 ? ` +${playing.length - 1}` : ''}
          </Chip>
        )}
        {recentRing && (
          <Chip icon={Bell} tone="accent" onClick={() => navigate(`/sicherheit/tuer/${recentRing.door.id.slice(5)}`)}>
            Geklingelt {formatAgo(recentRing.at, now)} · {recentRing.door.name}
          </Chip>
        )}
      </div>

      {problems.length > 0 && (
        <div className="mb-6 space-y-2">
          {problems.map(
            (service) =>
              service && (
                <Notice key={service.id} tone={service.status === 'offline' ? 'danger' : 'warn'} icon={AlertTriangle}>
                  <span className="font-medium">{SERVICE_LABELS[service.id]}:</span> {service.message ?? 'gerade nicht erreichbar.'}
                  {isAdmin && (
                    <Link to="/einstellungen/diagnose" className="ml-1.5 underline underline-offset-2">
                      Diagnose
                    </Link>
                  )}
                </Notice>
              ),
          )}
        </div>
      )}

      {scenes.length > 0 && (
        <Section
          title="Szenen"
          action={
            <Link to="/mehr/automationen" className="flex items-center text-sm text-muted hover:text-fg">
              Alle <ChevronRight className="size-4" aria-hidden />
            </Link>
          }
        >
          <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
            {scenes.map((scene) => (
              <button
                key={scene.id}
                type="button"
                disabled={!canControl}
                onClick={() => void runAction(scene)}
                className={cx(
                  'flex h-12 shrink-0 items-center gap-2.5 rounded-control bg-surface pl-3.5 pr-4.5 font-medium shadow-tile transition hover:bg-raised active:scale-[0.97] disabled:opacity-60',
                  scene.active && 'ring-1 ring-accent/50',
                )}
              >
                <PlayCircle className="size-5 text-accent" aria-hidden />
                <span className="whitespace-nowrap">{scene.name}</span>
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section title="Favoriten">
        {pinned.length > 0 ? (
          <TileGrid>
            {pinned.map((entity) => (
              <EntityTile key={entity.id} entity={entity} onDetails={setDetails} showRoom />
            ))}
          </TileGrid>
        ) : (
          <Card className="flex items-center gap-3.5 p-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-warm/15 text-warm">
              <Star className="size-5" aria-hidden />
            </span>
            <p className="min-w-0 flex-1 text-sm text-muted">
              Hier erscheinen deine wichtigsten Geräte. Tippe bei einem Gerät auf das Regler-Symbol und wähle „Auf der Übersicht zeigen“.
            </p>
            <Button size="sm" onClick={() => navigate('/raeume')}>
              Zu den Räumen
            </Button>
          </Card>
        )}
      </Section>

      {data.media.length > 0 && (
        <Section title="Kameras & Türen">
          <div className="no-scrollbar -mx-4 flex snap-x gap-2.5 overflow-x-auto px-4 sm:mx-0 sm:grid sm:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] sm:px-0">
            {data.media.map((entity) => (
              <SnapshotCard key={entity.id} entity={entity} />
            ))}
          </div>
        </Section>
      )}

      {rooms.length > 0 && (
        <Section
          title="Räume"
          action={
            <Link to="/raeume" className="flex items-center text-sm text-muted hover:text-fg">
              Alle <ChevronRight className="size-4" aria-hidden />
            </Link>
          }
        >
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]">
            {rooms.slice(0, 6).map((room) => (
              <Link key={room.id} to={`/raeume/${room.id}`} className="rounded-tile bg-surface p-3.5 shadow-tile transition hover:bg-raised active:scale-[0.99]">
                <p className="truncate font-semibold">{room.name}</p>
                <p className="mt-1 flex flex-wrap gap-x-2.5 text-[13px] text-muted">
                  {room.temperature !== null && <span className="tabular-nums">{formatTemperature(room.temperature)}</span>}
                  {room.lightsOn > 0 && <span className="font-medium text-warm">{room.lightsOn} an</span>}
                  {room.openContacts > 0 && <span className="font-medium text-warn">{room.openContacts} offen</span>}
                  {room.temperature === null && room.lightsOn === 0 && room.openContacts === 0 && <span>Alles ruhig</span>}
                </p>
              </Link>
            ))}
          </div>
        </Section>
      )}

      <LightsOnSheet open={lightsOpen} onClose={() => setLightsOpen(false)} lights={data.lightsOn} />
      <EntitySheet entityId={details} onClose={() => setDetails(null)} />
    </>
  );
}
