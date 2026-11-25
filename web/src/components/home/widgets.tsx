import { Bell, Box, CalendarClock, ChevronDown, ChevronRight, ChevronUp, CloudRain, DoorOpen, Lightbulb, Music2, PlayCircle, Power, ShieldCheck, Star, Thermometer, Wind, type LucideIcon } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { HOME_FUNCTIONS, roomKey, shownRoom, type ActionEntity, type Entity, type HomeFunction, type HomeWidget, type HomeWidgetSize, type HomeWidgetType, type LightEntity } from '@home-hub/shared';
import { useTimers, describeAt } from '../../pages/home/TimersSection.tsx';
import { EntityTile } from '../entities/EntityTile.tsx';
import { HubImage } from '../HubImage.tsx';
import { allBlinds, allLightsOff, useHouseSummary } from './categories.tsx';
import { BlindGlyph, BulbGlyph, ClimateGlyph, SwitchGlyph } from './glyphs.tsx';
import { Button, Card, cx, TileGrid, toneSoft, toneVar, type Tone } from '../ui.tsx';
import { useFavorites, useFloors, type RoomSummary } from '../../hooks/entities.ts';
import { runAction } from '../../lib/actions.ts';
import { formatAgo, formatNumber, formatTemperature } from '../../lib/format.ts';
import { useHub } from '../../store/hub.ts';
import { useLabs } from '../../store/labs.ts';
import { useCan } from '../../store/session.ts';
import { LightsOnSheet, purposeOf } from '../security/LightWatch.tsx';
import { tileSnapshot, TILE_REFRESH_MS } from '../../lib/snapshots.ts';

/**
 * The tiles of the start page. Each person arranges them as they like
 * (stored with their preferences on the hub); without an arrangement the
 * standard one below is shown.
 */

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'de', { numeric: true });

// --- building blocks ---------------------------------------------------------------------------

/** One function of the house: its state in large, a link to its menu and the most common action right on it. */
export function ControlCard({ to, title, visual, figure, caption, glow, children }: { to: string; title: string; visual: ReactNode; figure: ReactNode; caption: ReactNode; glow?: Tone; children?: ReactNode }) {
  return (
    <div
      className="panel relative flex h-full min-h-[9.75rem] flex-col rounded-tile p-3.5 transition-[background] duration-500"
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

export function QuickButton({ icon: Icon, label, onClick, tone }: { icon: LucideIcon; label: string; onClick(): void; tone?: Tone }) {
  return (
    <button
      type="button"
      data-quick
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cx('relative z-10 flex size-10 items-center justify-center rounded-full transition active:scale-90', tone ? toneSoft[tone] : 'bg-sunken text-muted hover:text-fg')}
    >
      <Icon className="size-5" aria-hidden />
    </button>
  );
}

function IconBubble({ icon: Icon, tone, pulse }: { icon: LucideIcon; tone: Tone | null; pulse?: boolean }) {
  return (
    <span className={cx('flex size-10 items-center justify-center rounded-full', tone ? toneSoft[tone] : 'bg-sunken text-muted')}>
      <Icon className={cx('size-5', pulse && 'animate-pulse')} aria-hidden />
    </span>
  );
}

export function SnapshotCard({ entity, large }: { entity: Extract<Entity, { kind: 'camera' | 'door' }>; large?: boolean }) {
  const deviceId = entity.id.slice(entity.id.indexOf(':') + 1);
  const isDoor = entity.kind === 'door';
  const state = !entity.available ? 'Nicht erreichbar' : isDoor ? (entity.lastRingAt ? `Geklingelt ${formatAgo(entity.lastRingAt)}` : 'Türstation') : (entity.room ?? 'Kamera');
  return (
    <Link
      to={isDoor ? `/sicherheit/tuer/${deviceId}` : `/sicherheit/kamera/${deviceId}`}
      className={cx('relative block h-full w-full overflow-hidden rounded-tile bg-surface shadow-tile transition active:scale-[0.99]', large ? 'min-h-56' : 'aspect-video', !entity.available && 'opacity-60')}
    >
      <HubImage src={entity.available ? tileSnapshot(entity) : null} alt={entity.name} refreshMs={TILE_REFRESH_MS} className="absolute inset-0 size-full" />
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

// --- the tiles ---------------------------------------------------------------------------------

function FunctionCard({ fn }: { fn: HomeFunction }) {
  const summary = useHouseSummary();
  const entities = useHub((state) => state.entities);
  const music = useHub((state) => state.music);
  const canControl = useCan('home.control');
  const all = Object.values(entities);
  switch (fn) {
    case 'licht':
      return (
        <ControlCard
          to="/licht"
          title="Licht"
          glow={summary.lightsOn.length > 0 ? 'warm' : undefined}
          visual={<BulbGlyph entity={{ on: summary.lightsOn.length > 0, brightness: null, color: null }} />}
          figure={summary.lightsOn.length > 0 ? `${summary.lightsOn.length} an` : 'Alle aus'}
          caption={summary.lightsOn.length > 0 ? [...new Set(summary.lightsOn.map((entity) => entity.room ?? entity.name))].join(', ') : `${summary.lights.length} Lichter`}
        >
          {canControl && summary.lightsOn.length > 0 && <QuickButton icon={Power} tone="warm" label="Alle Lichter ausschalten" onClick={() => allLightsOff(summary)} />}
        </ControlCard>
      );
    case 'jalousien':
      return (
        <ControlCard
          to="/jalousien"
          title="Jalousien"
          glow={summary.blindsMoving > 0 ? 'cool' : undefined}
          visual={<BlindGlyph entity={{ position: summary.blinds.length > 0 ? summary.blinds.reduce((sum, entity) => sum + (entity.position ?? 0), 0) / summary.blinds.length : 0, motion: summary.blindsMoving > 0 ? 'down' : 'stopped', tilt: null }} />}
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
      );
    case 'klima':
      return (
        <ControlCard
          to="/klima"
          title="Klima"
          glow={summary.heating > 0 ? 'warm' : undefined}
          visual={<ClimateGlyph heating={summary.heating > 0} cooling={false} />}
          figure={summary.averageTemperature === null ? '–' : `${formatNumber(summary.averageTemperature)}°`}
          caption={summary.heating > 0 ? `${summary.heating} ${summary.heating === 1 ? 'Raum heizt' : 'Räume heizen'}` : 'im Schnitt'}
        />
      );
    case 'sicherheit': {
      const contacts = all.filter((e) => e.kind === 'contact');
      const open = contacts.filter((e) => e.kind === 'contact' && e.open);
      // Only zones of windows and doors (not the lighting or smoke detector zones).
      const breached = all.some((e) => e.kind === 'alarm' && e.breached && purposeOf(e) === 'contacts');
      const warn = open.length > 0 || breached;
      return (
        <ControlCard
          to="/sicherheit"
          title="Fenster & Türen"
          glow={warn ? 'warn' : undefined}
          visual={<IconBubble icon={warn ? Wind : ShieldCheck} tone={warn ? 'warn' : 'ok'} />}
          figure={open.length > 0 ? `${open.length} offen` : breached ? 'Offen' : 'Alle zu'}
          caption={open.length > 0 ? open.map((entity) => entity.name).join(', ') : `${contacts.length} Kontakte`}
        />
      );
    }
    case 'zutritt':
      return (
        <ControlCard
          to="/zutritt"
          title="Zutritt"
          glow={summary.accessOpen > 0 ? 'warn' : undefined}
          visual={<IconBubble icon={DoorOpen} tone={summary.accessOpen > 0 ? 'warn' : 'ok'} />}
          figure={summary.accessOpen > 0 ? `${summary.accessOpen} offen` : 'Alles zu'}
          caption={`${summary.access} Türen und Tore`}
        />
      );
    case 'geraete':
      return (
        <ControlCard
          to="/geraete"
          title="Geräte"
          glow={summary.switchesOn > 0 ? 'accent' : undefined}
          visual={<SwitchGlyph entity={{ on: summary.switchesOn > 0, variant: 'socket' }} />}
          figure={summary.switchesOn > 0 ? `${summary.switchesOn} an` : 'Alle aus'}
          caption="Geräte & Steckdosen"
        />
      );
    case 'musik': {
      const playing = music.groups.filter((group) => group.state === 'playing');
      return (
        <ControlCard
          to="/musik"
          title="Musik"
          glow={playing.length > 0 ? 'music' : undefined}
          visual={<IconBubble icon={Music2} tone={playing.length > 0 ? 'music' : null} pulse={playing.length > 0} />}
          figure={playing.length > 0 ? 'Spielt' : 'Ruhe'}
          caption={playing.length > 0 ? `${playing[0]!.name}${playing.length > 1 ? ` +${playing.length - 1}` : ''} · ${playing[0]!.track?.title ?? ''}` : `${music.players.length} Lautsprecher`}
        />
      );
    }
  }
}

function RoomTile({ room }: { room: RoomSummary }) {
  return (
    <Link to={`/raeume/${room.id}`} className="panel flex h-full min-h-14 items-center gap-2 rounded-2xl px-3.5 py-3 transition hover:bg-raised active:scale-[0.99]">
      <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{room.name}</span>
      {room.openContacts > 0 && <span className="size-2 shrink-0 rounded-full bg-warn" title={`${room.openContacts} offen`} />}
      {room.lightsOn > 0 && <Lightbulb className="size-4 shrink-0 text-warm" aria-label={`${room.lightsOn} an`} />}
      {room.temperature !== null && <span className="shrink-0 text-[13px] tabular-nums text-muted">{formatNumber(room.temperature)}°</span>}
    </Link>
  );
}

function ScenesRow() {
  const entities = useHub((state) => state.entities);
  const canControl = useCan('home.control');
  const scenes = Object.values(entities)
    .filter((e): e is ActionEntity => e.kind === 'action' && e.available)
    .sort(byName)
    .slice(0, 12);
  if (scenes.length === 0) return <EmptyTile text="Keine Szenen eingerichtet." />;
  return (
    <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
      {scenes.map((scene) => (
        <button
          key={scene.id}
          type="button"
          disabled={!canControl}
          onClick={() => void runAction(scene)}
          className={cx('flex h-12 shrink-0 items-center gap-2.5 rounded-control bg-surface pl-3.5 pr-4.5 font-medium shadow-tile transition hover:bg-raised active:scale-[0.97] disabled:opacity-60', scene.active && 'ring-1 ring-accent/50')}
        >
          <PlayCircle className="size-5 text-accent" aria-hidden />
          <span className="whitespace-nowrap">{scene.name}</span>
        </button>
      ))}
    </div>
  );
}

function FavoritesGroup({ onDetails }: { onDetails(id: string): void }) {
  const favorites = useFavorites().filter((entity) => entity.kind !== 'action');
  const navigate = useNavigate();
  if (favorites.length === 0) {
    return (
      <Card className="flex flex-wrap items-center gap-x-3.5 gap-y-3 p-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-warm/15 text-warm">
          <Star className="size-5" aria-hidden />
        </span>
        <p className="min-w-0 flex-1 basis-52 text-sm text-muted">Hier erscheinen deine Favoriten. Tippe bei einem Gerät auf das Regler-Symbol und wähle „Auf der Übersicht zeigen“.</p>
        <Button size="sm" className="ml-auto" onClick={() => navigate('/raeume')}>
          Zu den Räumen
        </Button>
      </Card>
    );
  }
  return (
    <TileGrid>
      {favorites.map((entity) => (
        <EntityTile key={entity.id} entity={entity} onDetails={onDetails} showRoom />
      ))}
    </TileGrid>
  );
}

function RoomsList() {
  const floors = useFloors();
  if (floors.length === 0) return <EmptyTile text="Noch keine Räume." />;
  return (
    <div>
      {floors.map((floor) => (
        <div key={floor.name || 'haus'} className="mb-3">
          {floor.name && floors.length > 1 && <p className="mb-1.5 px-1 text-[13px] text-muted">{floor.name}</p>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]">
            {floor.rooms.map((room) => (
              <RoomTile key={room.id} room={room} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function WeatherCard({ wide }: { wide: boolean }) {
  const entities = useHub((state) => state.entities);
  const sensor = (key: string) => {
    const entity = entities[`gekko:meteo/${key}`];
    return entity?.kind === 'sensor' && typeof entity.value === 'number' ? entity : null;
  };
  const temperature = sensor('temperature');
  const wind = sensor('wind');
  const rain = entities['gekko:meteo/rain'];
  const raining = rain?.kind === 'sensor' && typeof rain.value === 'number' && rain.value > 0;
  return (
    <ControlCard
      to="/mehr/haus"
      title="Wetter"
      visual={<IconBubble icon={raining ? CloudRain : Thermometer} tone={raining ? 'cool' : 'accent'} />}
      figure={temperature ? formatTemperature(temperature.value as number) : '–'}
      caption={[raining ? 'Regen' : null, wide && wind ? `Wind ${formatNumber(wind.value as number)} ${wind.unit ?? ''}`.trim() : null, 'draußen'].filter(Boolean).join(' · ')}
    />
  );
}

function TimersCard() {
  const timers = useTimers();
  const upcoming = (timers.data?.timers ?? [])
    .filter((timer) => timer.enabled && timer.nextRunAt !== null)
    .sort((a, b) => a.nextRunAt! - b.nextRunAt!)
    .slice(0, 3);
  return (
    <Link to="/uhren" className="panel flex h-full min-h-[9.75rem] flex-col rounded-tile p-3.5 transition hover:bg-raised">
      <div className="flex items-start justify-between gap-2">
        <IconBubble icon={CalendarClock} tone="accent" />
        <span className="pt-1 text-[13px] font-medium text-muted">Zeitschaltuhren</span>
      </div>
      <div className="mt-auto pt-3">
        {upcoming.length === 0 ? (
          <p className="text-[13px] text-muted">Keine Zeitschaltuhr steht an.</p>
        ) : (
          upcoming.map((timer) => (
            <p key={timer.id} className="flex items-baseline gap-2 truncate text-[13px]">
              <span className="shrink-0 font-semibold tabular-nums">{new Date(timer.nextRunAt!).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span>
              <span className="truncate text-muted">
                {timer.name} · {describeAt(timer.at)}
              </span>
            </p>
          ))
        )}
      </div>
    </Link>
  );
}

function House3DCard() {
  return (
    <ControlCard to="/haus3d" title="3D-Haus" visual={<IconBubble icon={Box} tone="accent" />} figure="3D" caption="Labs · das Haus als Modell">
      <ChevronRight className="size-5 text-faint" aria-hidden />
    </ControlCard>
  );
}

/**
 * Which lights are on, by room. Tapping shows them, to switch one by one — there is deliberately no
 * button that switches every light of the house (the "Licht" tile has one).
 */
function LightsStatusCard({ wide }: { wide: boolean }) {
  const entities = useHub((state) => state.entities);
  const [open, setOpen] = useState(false);
  const { lights, on, rooms } = useMemo(() => {
    const lights = Object.values(entities).filter((entity): entity is LightEntity => entity.kind === 'light' && !entity.isGroup);
    const on = lights
      .filter((light) => light.on && light.available)
      .sort((a, b) => (a.room ?? '').localeCompare(b.room ?? '', 'de') || byName(a, b));
    const counts = new Map<string, number>();
    for (const light of on) counts.set(light.room ?? 'Ohne Raum', (counts.get(light.room ?? 'Ohne Raum') ?? 0) + 1);
    return { lights, on, rooms: [...counts.entries()] };
  }, [entities]);
  const figure = on.length === 0 ? 'Alle aus' : `${on.length} an`;
  return (
    <>
      <div
        className="panel relative flex h-full min-h-[9.75rem] flex-col rounded-tile p-3.5 transition-[background] duration-500"
        style={on.length > 0 ? { background: `radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, ${toneVar.warm} 15%, transparent), transparent 65%), var(--hh-panel), var(--hh-raised)` } : undefined}
      >
        <button type="button" onClick={() => setOpen(true)} aria-label={`Lichter-Status: ${figure} – anzeigen`} className="absolute inset-0 rounded-tile transition hover:bg-fg/[0.03] active:bg-fg/[0.06]" />
        <div className="pointer-events-none relative flex items-start justify-between gap-2">
          <BulbGlyph entity={{ on: on.length > 0, brightness: null, color: null }} />
          <span className="pt-1 text-[13px] font-medium text-muted">Lichter-Status</span>
        </div>
        <div className="pointer-events-none relative mt-auto min-w-0 pt-3">
          <p className="text-[26px] font-semibold leading-none tracking-tight tabular-nums">{figure}</p>
          {on.length === 0 ? (
            <p className="mt-1 truncate text-[13px] text-muted">{lights.length === 1 ? '1 Licht' : `${lights.length} Lichter`} im Haus</p>
          ) : wide ? (
            <p className="mt-1.5 flex flex-wrap gap-1.5">
              {rooms.slice(0, 6).map(([room, count]) => (
                <span key={room} className="rounded-full bg-warm/15 px-2 py-0.5 text-xs font-medium text-fg">
                  {room}
                  {count > 1 ? ` · ${count}` : ''}
                </span>
              ))}
              {rooms.length > 6 && <span className="px-1 text-xs text-muted">+{rooms.length - 6}</span>}
            </p>
          ) : (
            <p className="mt-1 truncate text-[13px] text-muted">{rooms.map(([room]) => room).join(', ')}</p>
          )}
        </div>
      </div>
      <LightsOnSheet title="Lichter-Status" open={open} onClose={() => setOpen(false)} lights={on} allOff={false} />
    </>
  );
}

function EmptyTile({ text }: { text: string }) {
  return <div className="flex h-full min-h-20 items-center justify-center rounded-tile border border-dashed border-line px-4 text-center text-sm text-muted">{text}</div>;
}

/** One tile of the start page. */
export function WidgetView({ widget, onDetails }: { widget: HomeWidget; onDetails(id: string): void }) {
  const entities = useHub((state) => state.entities);
  const layout = useHub((state) => state.layout);
  const floors = useFloors();
  const house3d = useLabs((state) => state.house3d);
  switch (widget.type) {
    case 'function':
      return <FunctionCard fn={widget.function} />;
    case 'entity': {
      const entity = entities[widget.entityId];
      return entity ? <EntityTile entity={entity} onDetails={onDetails} showRoom /> : <EmptyTile text="Dieses Gerät gibt es nicht mehr." />;
    }
    case 'camera': {
      const entity = entities[widget.entityId];
      return entity && (entity.kind === 'camera' || entity.kind === 'door') ? <SnapshotCard entity={entity} large={widget.size === 'large'} /> : <EmptyTile text="Diese Kamera gibt es nicht mehr." />;
    }
    case 'room': {
      // A room renamed or merged since the tile was placed is found under its new name.
      const wanted = roomKey(shownRoom(widget.room, layout));
      const room = floors.flatMap((floor) => floor.rooms).find((entry) => roomKey(entry.name) === wanted || entry.id === widget.room);
      return room ? <RoomTile room={room} /> : <EmptyTile text={`Raum „${widget.room}“ nicht gefunden.`} />;
    }
    case 'scenes':
      return <ScenesRow />;
    case 'favorites':
      return <FavoritesGroup onDetails={onDetails} />;
    case 'rooms':
      return <RoomsList />;
    case 'weather':
      return <WeatherCard wide={widget.size !== 'small'} />;
    case 'timers':
      return <TimersCard />;
    case 'house3d':
      return house3d ? <House3DCard /> : <EmptyTile text="3D-Haus ist unter Labs ausgeschaltet." />;
    case 'lights':
      return <LightsStatusCard wide={widget.size !== 'small'} />;
  }
}

// --- layout rules -----------------------------------------------------------------------------

/** Tiles that always take the full width (lists and rows of things). */
export const FULL_WIDTH: ReadonlySet<HomeWidgetType> = new Set(['scenes', 'favorites', 'rooms']);

export function sizesFor(type: HomeWidgetType): HomeWidgetSize[] {
  switch (type) {
    case 'camera':
      return ['small', 'wide', 'large'];
    case 'scenes':
    case 'favorites':
    case 'rooms':
      return [];
    case 'timers':
      return ['wide'];
    default:
      return ['small', 'wide'];
  }
}

export const SIZE_LABELS: Record<HomeWidgetSize, string> = { small: 'Klein', wide: 'Breit', large: 'Groß' };

/** Grid classes for a tile: 2 columns on phones, 4 on wide screens. */
export function spanClass(widget: HomeWidget): string {
  if (FULL_WIDTH.has(widget.type)) return 'col-span-2 sm:col-span-4';
  if (widget.size === 'large') return 'col-span-2 sm:row-span-2';
  if (widget.size === 'wide') return 'col-span-2';
  return 'col-span-1';
}

/** Titles shown above full-width tiles. */
export const SECTION_TITLES: Partial<Record<HomeWidgetType, string>> = { scenes: 'Szenen', favorites: 'Favoriten', rooms: 'Räume' };

export const FUNCTION_LABELS: Record<HomeFunction, string> = {
  licht: 'Licht',
  jalousien: 'Jalousien',
  klima: 'Klima',
  sicherheit: 'Fenster & Türen',
  zutritt: 'Zutritt',
  geraete: 'Geräte & Steckdosen',
  musik: 'Musik',
};

const OVERVIEW_NAMES: Partial<Record<HomeWidgetType, string>> = { ...SECTION_TITLES, weather: 'Wetter', timers: 'Zeitschaltuhren', house3d: '3D-Haus', lights: 'Lichter-Status' };

/** What a tile shows, in words (for the edit controls and screen readers). */
export function widgetName(widget: HomeWidget, entities: Record<string, Entity>): string {
  switch (widget.type) {
    case 'function':
      return FUNCTION_LABELS[widget.function];
    case 'room':
      return widget.room;
    case 'camera':
    case 'entity':
      return entities[widget.entityId]?.name ?? 'Gerät';
    default:
      return OVERVIEW_NAMES[widget.type] ?? 'Kachel';
  }
}

let counter = 0;
export function widgetKey(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/** The standard start page: what the house offers, in the order the app always showed it. */
export function useDefaultHome(): HomeWidget[] {
  const entities = useHub((state) => state.entities);
  const music = useHub((state) => state.music);
  const canSecurity = useCan('security.view');
  const all = Object.values(entities);
  const has = (kind: Entity['kind']) => all.some((entity) => entity.kind === kind);
  const functions: HomeFunction[] = HOME_FUNCTIONS.filter((fn) => {
    switch (fn) {
      case 'licht':
        return has('light');
      case 'jalousien':
        return has('blind');
      case 'klima':
        return has('climate');
      case 'sicherheit':
        return canSecurity && (has('contact') || has('alarm'));
      case 'zutritt':
        return has('access');
      case 'geraete':
        return has('switch');
      case 'musik':
        return music.players.length > 0;
    }
  });
  const media = all
    .filter((e): e is Extract<Entity, { kind: 'camera' | 'door' }> => e.kind === 'camera' || e.kind === 'door')
    .sort((a, b) => (a.kind === b.kind ? byName(a, b) : a.kind === 'door' ? -1 : 1));
  return [
    ...functions.map((fn): HomeWidget => ({ key: `fn-${fn}`, size: 'small', type: 'function', function: fn })),
    ...(has('action') ? [{ key: 'scenes', size: 'wide', type: 'scenes' } as HomeWidget] : []),
    { key: 'favorites', size: 'wide', type: 'favorites' },
    ...media.map((entity): HomeWidget => ({ key: `cam-${entity.id}`, size: 'small', type: 'camera', entityId: entity.id })),
    { key: 'rooms', size: 'wide', type: 'rooms' },
  ];
}
