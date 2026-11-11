import {
  AlertTriangle,
  Bell,
  ChevronDown,
  ChevronRight,
  ChevronUp,
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
import { SERVICE_LABELS, type ActionEntity, type Entity } from '@home-hub/shared';
import { EntityTile } from '../components/entities/EntityTile.tsx';
import { EntitySheet } from '../components/entities/sheets.tsx';
import { HubImage } from '../components/HubImage.tsx';
import { allBlinds, allLightsOff, useHouseSummary } from '../components/home/categories.tsx';
import { BlindGlyph, BulbGlyph, ClimateGlyph, SwitchGlyph } from '../components/home/glyphs.tsx';
import { Button, Card, cx, EmptyState, Notice, Section, TileGrid, toneSoft, toneVar, type Tone } from '../components/ui.tsx';
import { useFavorites, useFloors } from '../hooks/entities.ts';
import { runAction } from '../lib/actions.ts';
import { formatAgo, formatNumber, formatTemperature, greeting } from '../lib/format.ts';
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

/** One function of the house: its state in large, a link to its menu and the most common action right on it. */
function ControlCard({
  to,
  title,
  visual,
  figure,
  caption,
  glow,
  children,
}: {
  to: string;
  title: string;
  visual: ReactNode;
  figure: ReactNode;
  caption: ReactNode;
  glow?: Tone;
  children?: ReactNode;
}) {
  return (
    <div
      className="panel relative flex min-h-[9.75rem] flex-col rounded-tile p-3.5 transition-[background] duration-500"
      style={glow ? { background: `radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, ${toneVar[glow]} 15%, transparent), transparent 65%), var(--hh-panel), var(--hh-raised)` } : undefined}
    >
      <Link to={to} aria-label={`${title} öffnen`} className="absolute inset-0 rounded-tile transition hover:bg-fg/[0.03] active:bg-fg/[0.06]" />
      <div className="pointer-events-none relative flex items-start justify-between gap-2">
        {visual}
        <span className="pt-1 text-[13px] font-medium text-muted">{title}</span>
      </div>
      <div className="relative mt-auto flex items-end justify-between gap-2 pt-3">
        <div className="pointer-events-none min-w-0">
          <p className="text-[26px] font-semibold leading-none tracking-tight tabular-nums">{figure}</p>
          <p className="mt-1 truncate text-[13px] text-muted">{caption}</p>
        </div>
        {children && <div className="flex shrink-0 gap-1.5">{children}</div>}
      </div>
    </div>
  );
}

function QuickButton({ icon: Icon, label, onClick, tone }: { icon: LucideIcon; label: string; onClick(): void; tone?: Tone }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cx('relative z-10 flex size-10 items-center justify-center rounded-full transition active:scale-90', tone ? toneSoft[tone] : 'bg-sunken text-muted hover:text-fg')}
    >
      <Icon className="size-5" aria-hidden />
    </button>
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
  const floors = useFloors();
  const summary = useHouseSummary();
  const isAdmin = useIsAdmin();
  const canSecurity = useCan('security.view');
  const canControl = useCan('home.control');
  const [details, setDetails] = useState<string | null>(null);

  const data = useMemo(() => {
    const all = Object.values(entities);
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
    return { all, contacts, openContacts, alarms, alarmTriggered, alarmBreached, scenes, media, lastRing, outside };
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

      {/* Only what is urgent gets a chip; everything else is in the cards below. */}
      {((canSecurity && data.alarmTriggered) || recentRing) && (
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

      <Section title="Dein Zuhause">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {summary.lights.length > 0 && (
            <ControlCard
              to="/licht"
              title="Licht"
              glow={summary.lightsOn.length > 0 ? 'warm' : undefined}
              visual={<BulbGlyph entity={{ on: summary.lightsOn.length > 0, brightness: null, color: null }} />}
              figure={summary.lightsOn.length > 0 ? `${summary.lightsOn.length} an` : 'Alle aus'}
              caption={summary.lightsOn.length > 0 ? summary.lightsOn.map((entity) => entity.room ?? entity.name).filter((room, index, list) => list.indexOf(room) === index).join(', ') : `${summary.lights.length} Lichter`}
            >
              {canControl && summary.lightsOn.length > 0 && <QuickButton icon={Power} tone="warm" label="Alle Lichter ausschalten" onClick={() => allLightsOff(summary)} />}
            </ControlCard>
          )}
          {summary.blinds.length > 0 && (
            <ControlCard
              to="/jalousien"
              title="Jalousien"
              glow={summary.blindsMoving > 0 ? 'cool' : undefined}
              visual={
                <BlindGlyph
                  entity={{
                    position: summary.blinds.reduce((sum, entity) => sum + (entity.position ?? 0), 0) / summary.blinds.length,
                    motion: summary.blindsMoving > 0 ? 'down' : 'stopped',
                    tilt: null,
                  }}
                />
              }
              figure={summary.blindsMoving > 0 ? 'fahren' : summary.blindsClosed === 0 ? 'offen' : `${summary.blindsClosed} zu`}
              caption={`von ${summary.blinds.length}`}
            >
              {canControl && (
                <>
                  <QuickButton icon={ChevronUp} label="Alle Jalousien hochfahren" onClick={() => allBlinds(summary, 'up')} />
                  <QuickButton icon={ChevronDown} label="Alle Jalousien herunterfahren" onClick={() => allBlinds(summary, 'down')} />
                </>
              )}
            </ControlCard>
          )}
          {summary.climateCount > 0 && (
            <ControlCard
              to="/klima"
              title="Klima"
              glow={summary.heating > 0 ? 'warm' : undefined}
              visual={<ClimateGlyph heating={summary.heating > 0} cooling={false} />}
              figure={summary.averageTemperature === null ? '–' : `${formatNumber(summary.averageTemperature)}°`}
              caption={summary.heating > 0 ? `${summary.heating} ${summary.heating === 1 ? 'Raum heizt' : 'Räume heizen'}` : 'im Schnitt'}
            />
          )}
          {canSecurity && (data.contacts.length > 0 || data.alarms.length > 0) && (
            <ControlCard
              to="/sicherheit"
              title="Fenster & Türen"
              glow={data.openContacts.length > 0 || data.alarmBreached ? 'warn' : undefined}
              visual={
                <span className={cx('flex size-10 items-center justify-center rounded-full', data.openContacts.length > 0 || data.alarmBreached ? toneSoft.warn : toneSoft.ok)}>
                  {data.openContacts.length > 0 || data.alarmBreached ? <Wind className="size-5" aria-hidden /> : <ShieldCheck className="size-5" aria-hidden />}
                </span>
              }
              figure={data.contacts.length > 0 ? (data.openContacts.length > 0 ? `${data.openContacts.length} offen` : 'Alle zu') : data.alarmBreached ? 'Offen' : 'Alle zu'}
              caption={data.openContacts.length > 0 ? data.openContacts.map((entity) => entity.name).join(', ') : data.contacts.length > 0 ? `${data.contacts.length} Kontakte` : 'Hülle'}
            />
          )}
          {summary.switches > 0 && (
            <ControlCard
              to="/geraete"
              title="Geräte"
              glow={summary.switchesOn > 0 ? 'accent' : undefined}
              visual={<SwitchGlyph entity={{ on: summary.switchesOn > 0, variant: 'socket' }} />}
              figure={summary.switchesOn > 0 ? `${summary.switchesOn} an` : 'Alle aus'}
              caption="Geräte & Steckdosen"
            />
          )}
          {music.players.length > 0 && (
            <ControlCard
              to="/musik"
              title="Musik"
              glow={playing.length > 0 ? 'music' : undefined}
              visual={
                <span className={cx('flex size-10 items-center justify-center rounded-full', playing.length > 0 ? toneSoft.music : 'bg-sunken text-muted')}>
                  <Music2 className={cx('size-5', playing.length > 0 && 'animate-pulse')} aria-hidden />
                </span>
              }
              figure={playing.length > 0 ? 'Spielt' : 'Ruhe'}
              caption={playing.length > 0 ? `${playing[0]!.name}${playing.length > 1 ? ` +${playing.length - 1}` : ''} · ${playing[0]!.track?.title ?? ''}` : `${music.players.length} Lautsprecher`}
            />
          )}
        </div>
      </Section>

      {scenes.length > 0 && (
        <Section
          title="Szenen"
          action={
            <Link to="/aktionen" className="flex items-center text-sm text-muted hover:text-fg">
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
          <Card className="flex flex-wrap items-center gap-x-3.5 gap-y-3 p-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-warm/15 text-warm">
              <Star className="size-5" aria-hidden />
            </span>
            <p className="min-w-0 flex-1 basis-52 text-sm text-muted">
              Hier erscheinen deine wichtigsten Geräte. Tippe bei einem Gerät auf das Regler-Symbol und wähle „Auf der Übersicht zeigen“.
            </p>
            <Button size="sm" className="ml-auto" onClick={() => navigate('/raeume')}>
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

      {floors.length > 0 && (
        <Section
          title="Räume"
          action={
            <Link to="/raeume" className="flex items-center text-sm text-muted hover:text-fg">
              Alle <ChevronRight className="size-4" aria-hidden />
            </Link>
          }
        >
          {floors.map((floor) => (
            <div key={floor.name || 'haus'} className="mb-3">
              {floor.name && floors.length > 1 && <p className="mb-1.5 px-1 text-[13px] text-muted">{floor.name}</p>}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]">
                {floor.rooms.map((room) => (
                  <Link key={room.id} to={`/raeume/${room.id}`} className="panel flex items-center gap-2 rounded-2xl px-3.5 py-3 transition hover:bg-raised active:scale-[0.99]">
                    <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{room.name}</span>
                    {room.openContacts > 0 && <span className="size-2 shrink-0 rounded-full bg-warn" title={`${room.openContacts} offen`} />}
                    {room.lightsOn > 0 && <Lightbulb className="size-4 shrink-0 text-warm" aria-label={`${room.lightsOn} an`} />}
                    {room.temperature !== null && <span className="shrink-0 text-[13px] tabular-nums text-muted">{formatNumber(room.temperature)}°</span>}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </Section>
      )}

      <EntitySheet entityId={details} onClose={() => setDetails(null)} />
    </>
  );
}
