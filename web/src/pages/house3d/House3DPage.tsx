import { useQueryClient } from '@tanstack/react-query';
import { Box, Check, ChevronLeft, Crosshair, FlaskConical, MapPin, Minus, Moon, Plus, Search, Settings2, Sun, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Entity, House3DLevel, House3DMarker, House3DState } from '@home-hub/shared';
import { EntityTile, entityIsActive } from '../../components/entities/EntityTile.tsx';
import { entityIcon } from '../../components/entities/icons.ts';
import { EntitySheet } from '../../components/entities/sheets.tsx';
import { toast } from '../../components/toast.tsx';
import { Button, cx, EmptyState, IconButton, Notice, PageHeader, Section, Sheet, Spinner, TextInput, TileGrid } from '../../components/ui.tsx';
import { useAllEntities } from '../../hooks/entities.ts';
import { del, errorMessage, put } from '../../lib/api.ts';
import { runAction } from '../../lib/actions.ts';
import { formatTemperature } from '../../lib/format.ts';
import { useHub } from '../../store/hub.ts';
import { useIsAdmin } from '../../store/session.ts';
import { useHouse3D, useModel, type ParsedModel } from './data.ts';
import { HouseEngine, type EngineStatus, type PickResult } from './engine.ts';
import { sunTimes } from './sun.ts';

/** Name of a storey as the household calls it. */
function levelName(level: House3DLevel, names: Record<string, string>): string {
  return names[level.id]?.trim() || level.name;
}

function hoursToDate(hours: number): Date {
  const date = new Date();
  date.setHours(Math.floor(hours), Math.round((hours % 1) * 60), 0, 0);
  return date;
}

function clock(date: Date): string {
  return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/** Model position of a marker, and the storey it belongs to. */
function placeOf(marker: House3DMarker, model: ParsedModel): { position: [number, number, number]; level: number } {
  const [ox, oy, oz] = model.info.origin;
  const position: [number, number, number] = [marker.position[0] - ox, marker.position[1] - oy, marker.position[2] - oz];
  let level = model.info.levels.findIndex((l) => l.id === marker.level);
  if (level < 0) {
    // The storey is gone in a revised model: take the one at that height.
    const storeys = model.info.levels.map((l, i) => ({ l, i })).filter(({ l }) => l.kind === 'storey');
    level = storeys.reduce((best, { l, i }) => (position[2] >= l.floorZ - 0.3 ? i : best), storeys[0]?.i ?? 0);
  }
  return { position, level };
}

export function House3DPage() {
  const isAdmin = useIsAdmin();
  const state = useHouse3D();
  const model = useModel(state.data?.model?.version);
  const navigate = useNavigate();

  const header = (
    <PageHeader
      title="3D-Haus"
      subtitle={
        <span className="inline-flex items-center gap-1.5">
          <FlaskConical className="size-4" aria-hidden /> Labs · Testversion
        </span>
      }
      back
      actions={isAdmin && <IconButton icon={Settings2} label="3D-Haus einrichten" onClick={() => navigate('/einstellungen/haus3d')} />}
    />
  );

  if (state.isPending || (state.data?.model && model.isPending)) {
    return (
      <>
        {header}
        <div className="flex h-[min(64dvh,40rem)] flex-col items-center justify-center gap-3 rounded-tile bg-surface text-muted shadow-tile">
          <Spinner className="size-7" />
          <span className="text-sm">Das Modell wird geladen …</span>
        </div>
      </>
    );
  }
  if (state.isError || model.isError) {
    return (
      <>
        {header}
        <Notice tone="danger">{errorMessage(state.error ?? model.error)}</Notice>
      </>
    );
  }
  if (!state.data?.model || !model.data) {
    return (
      <>
        {header}
        <EmptyState
          icon={Box}
          title="Noch kein 3D-Modell"
          text={isAdmin ? 'Lade das IFC-Modell deines Hauses hoch (Export aus ArchiCAD, Revit, cadwork, …). Es bleibt auf deinem Hub.' : 'Ein Administrator kann das 3D-Modell des Hauses in den Einstellungen hochladen.'}
          action={isAdmin && <Button variant="primary" icon={Box} onClick={() => navigate('/einstellungen/haus3d')}>Modell hochladen</Button>}
        />
      </>
    );
  }
  return (
    <>
      {header}
      <HouseView state={state.data} model={model.data} />
    </>
  );
}

function HouseView({ state, model }: { state: House3DState; model: ParsedModel }) {
  const isAdmin = useIsAdmin();
  const queryClient = useQueryClient();
  const entities = useHub((s) => s.entities);
  const [search, setSearch] = useSearchParams();
  const container = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const engineRef = useRef<HouseEngine | null>(null);
  const [engine, setEngine] = useState<HouseEngine | null>(null);
  const [status, setStatus] = useState<EngineStatus>({ mode: 'overview', level: 0, zoom: 1, night: false });
  const [failed, setFailed] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [details, setDetails] = useState<string | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [placing, setPlacing] = useState<string | null>(null);
  const [chooser, setChooser] = useState(search.get('platzieren') === '1' && isAdmin);
  const placingRef = useRef<string | null>(null);
  placingRef.current = placing;
  const placeRef = useRef<(entityId: string, hit: PickResult) => Promise<void>>(async () => {});

  const { info } = model;
  const view = state.view;

  // --- the engine lives as long as the page
  useEffect(() => {
    if (!container.current || !canvasHost.current) return;
    let created: HouseEngine;
    try {
      created = new HouseEngine(container.current, canvasHost.current, {
        onStatus: setStatus,
        onTap: (hit: PickResult | null) => {
          const id = placingRef.current;
          if (id) {
            if (hit) void placeRef.current(id, hit);
            return;
          }
          engineRef.current?.handleTap(hit);
        },
      });
    } catch {
      setFailed('Dieses Gerät kann keine 3D-Grafik (WebGL) anzeigen.');
      return;
    }
    engineRef.current = created;
    setEngine(created);
    return () => {
      created.dispose();
      engineRef.current = null;
      setEngine(null);
    };
    // Created once; the tap handler reads what changes through refs.
  }, []);

  useEffect(() => {
    engine?.setModel(model, view);
    // Only a new model rebuilds the scene; view changes are applied below.
  }, [engine, model]);

  useEffect(() => {
    engine?.applyView(view);
  }, [engine, view]);

  // The light follows the clock; the slider previews another time of today.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    engine?.setTime(preview === null ? null : hoursToDate(preview));
  }, [engine, preview, now]);

  // --- devices in the model
  const placed = useMemo(
    () =>
      state.markers
        .map((marker) => {
          const entity = entities[marker.entityId];
          return entity ? { marker, entity, ...placeOf(marker, model) } : null;
        })
        .filter((m): m is { marker: House3DMarker; entity: Entity; position: [number, number, number]; level: number } => m !== null),
    [state.markers, entities, model],
  );

  useEffect(() => {
    engine?.setLamps(
      placed
        .filter((p) => p.entity.kind === 'light')
        .map((p) => {
          const light = p.entity as Extract<Entity, { kind: 'light' }>;
          return { id: p.entity.id, position: p.position, level: p.level, brightness: light.on ? (light.brightness ?? 100) / 100 : 0 };
        }),
    );
  }, [engine, placed]);

  const placeDevice = useCallback(
    async (entityId: string, hit: PickResult) => {
      const [ox, oy, oz] = info.origin;
      const level = info.levels[hit.level];
      try {
        const next = await put<House3DState>(`/api/house3d/markers/${encodeURIComponent(entityId)}`, {
          position: [hit.point[0] + ox, hit.point[1] + oy, hit.point[2] + oz],
          level: level?.id ?? 'eg',
        });
        queryClient.setQueryData(['house3d'], (old: House3DState | undefined) => (old ? { ...old, markers: next.markers } : next));
        toast.success(`„${entities[entityId]?.name ?? 'Gerät'}“ platziert`);
        setPlacing(null);
      } catch (err) {
        toast.fromError(err);
      }
    },
    [info, queryClient, entities],
  );
  placeRef.current = placeDevice;

  const removeMarker = async (entityId: string) => {
    try {
      const next = await del<House3DState>(`/api/house3d/markers/${encodeURIComponent(entityId)}`);
      queryClient.setQueryData(['house3d'], (old: House3DState | undefined) => (old ? { ...old, markers: next.markers } : next));
    } catch (err) {
      toast.fromError(err);
    }
  };

  const storeys = info.levels.map((level, index) => ({ level, index })).filter(({ level }) => level.kind === 'storey');
  const current = info.levels[status.level];
  const crumb = status.mode === 'overview' ? 'Haus' : status.mode === 'open' ? 'Haus geöffnet' : current ? levelName(current, view.levelNames) : 'Geschoss';
  const times = useMemo(() => sunTimes(now, view.latitude, view.longitude), [now, view.latitude, view.longitude]);
  const shownTime = preview === null ? now : hoursToDate(preview);
  const left = info.bounds.min[0] - 0.6;
  const midY = (info.bounds.min[1] + info.bounds.max[1]) / 2;

  // Devices listed under the model: those of the opened storey, else outdoors and on the roof.
  const listed = placed.filter((p) => {
    const level = info.levels[p.level];
    if (!level) return false;
    return status.mode === 'floor' ? p.level === status.level : level.kind !== 'storey';
  });
  const scenes = useMemo(() => Object.values(entities).filter((e): e is Extract<Entity, { kind: 'action' }> => e.kind === 'action').slice(0, 8), [entities]);

  return (
    <>
      <div
        ref={container}
        tabIndex={0}
        role="application"
        aria-label="3D-Ansicht des Hauses. Wischen dreht, zwei Finger zoomen. Pfeiltasten drehen und neigen, Plus und Minus zoomen."
        onPointerDown={() => setTouched(true)}
        className="relative -mx-4 h-[min(66dvh,44rem)] touch-none select-none overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-accent md:mx-0 md:rounded-tile md:shadow-tile"
      >
        <div ref={canvasHost} className="absolute inset-0" />

        {failed && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <Notice tone="warn">{failed}</Notice>
          </div>
        )}

        {/* Storey tags, shown while the house is opened. */}
        {engine &&
          storeys.map(({ level, index }) => (
            <button
              key={`tag-${level.id}`}
              type="button"
              data-no-gesture
              ref={(el) => engine.setOverlay(`tag-${level.id}`, el, [left, midY, level.cutZ], index, 'tag')}
              onClick={() => engine.showLevel(index)}
              className="absolute left-0 top-0 h-8 whitespace-nowrap rounded-full bg-surface/90 px-3 text-xs font-semibold text-fg shadow-float backdrop-blur-md"
              style={{ visibility: 'hidden' }}
            >
              {levelName(level, view.levelNames)}
              {(() => {
                const on = placed.filter((p) => p.level === index && p.entity.kind === 'light' && p.entity.on).length;
                return on > 0 ? <span className="ml-1.5 text-warm">· {on} an</span> : null;
              })()}
            </button>
          ))}

        {/* Devices. */}
        {engine &&
          placed.map((p) => (
            <MarkerButton
              key={p.entity.id}
              entity={p.entity}
              setRef={(el) => engine.setOverlay(p.entity.id, el, p.position, p.level, 'marker')}
              onOpen={() => setDetails(p.entity.id)}
            />
          ))}

        {/* Where am I, back. */}
        <div data-no-gesture className="absolute left-3 top-3 flex items-center gap-1.5">
          {status.mode !== 'overview' && (
            <button type="button" aria-label="Eine Ebene zurück" onClick={() => engine?.back()} className="flex size-10 items-center justify-center rounded-full bg-surface/85 text-fg shadow-float backdrop-blur-md">
              <ChevronLeft className="size-5" aria-hidden />
            </button>
          )}
          <span className="flex h-8 items-center rounded-full bg-surface/85 px-3 text-sm font-semibold shadow-float backdrop-blur-md">{crumb}</span>
        </div>

        {/* Storeys. */}
        <div data-no-gesture role="group" aria-label="Geschoss" className="absolute right-3 top-3 flex flex-col gap-0.5 rounded-2xl bg-surface/85 p-1 shadow-float backdrop-blur-md">
          {[...storeys].reverse().map(({ level, index }) => {
            const active = status.mode === 'floor' && status.level === index;
            return (
              <button
                key={level.id}
                type="button"
                aria-pressed={active}
                aria-label={levelName(level, view.levelNames)}
                onClick={() => engine?.showLevel(index)}
                className={cx('h-8 min-w-12 rounded-xl px-2 text-xs font-bold transition', active ? 'bg-accent text-accent-fg' : 'text-fg hover:bg-sunken')}
              >
                {level.short}
              </button>
            );
          })}
        </div>

        {!touched && !placing && (
          <p className="pointer-events-none absolute inset-x-0 bottom-[4.75rem] text-center text-xs font-medium text-fg/80 [text-shadow:0_1px_6px_rgb(0_0_0/0.35)]">
            Wischen dreht · zwei Finger zoomen und drehen
          </p>
        )}

        {placing && (
          <div data-no-gesture className="absolute inset-x-3 top-14 flex items-center gap-2 rounded-2xl bg-accent px-3 py-2 text-sm font-medium text-accent-fg shadow-float">
            <Crosshair className="size-4.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">Tippe auf die Stelle für „{entities[placing]?.name ?? 'Gerät'}“</span>
            <button type="button" aria-label="Abbrechen" onClick={() => setPlacing(null)} className="flex size-8 items-center justify-center rounded-full bg-black/15">
              <X className="size-4" aria-hidden />
            </button>
          </div>
        )}

        {/* Time of day. */}
        <div data-no-gesture className="absolute bottom-3 left-3 flex h-11 items-center gap-2.5 rounded-full bg-surface/85 pl-3 pr-3.5 shadow-float backdrop-blur-md">
          <span className="flex w-[3.9rem] items-center gap-1.5 text-sm font-semibold tabular-nums">
            {status.night ? <Moon className="size-4" aria-hidden /> : <Sun className="size-4" aria-hidden />}
            {clock(shownTime)}
          </span>
          <span className="relative block h-7 w-24">
            <span
              aria-hidden
              className="absolute inset-x-0 top-[11px] h-1.5 rounded-full"
              style={{ background: dayGradient(times.rise, times.set) }}
            />
            <span
              aria-hidden
              className="absolute top-1.5 size-4 -translate-x-1/2 rounded-full bg-white shadow ring-1 ring-black/10"
              style={{ left: `${((shownTime.getHours() + shownTime.getMinutes() / 60) / 24) * 100}%` }}
            />
            <input
              type="range"
              aria-label="Tageszeit ansehen"
              min={0}
              max={23.75}
              step={0.25}
              value={shownTime.getHours() + Math.round(shownTime.getMinutes() / 15) / 4}
              onChange={(event) => setPreview(Number(event.target.value))}
              className="absolute -inset-x-2 inset-y-0 cursor-pointer opacity-0"
            />
          </span>
          {preview !== null && (
            <button type="button" onClick={() => setPreview(null)} className="text-xs font-semibold text-accent">
              Jetzt
            </button>
          )}
        </div>

        {/* Zoom and compass. */}
        <div data-no-gesture className="absolute bottom-3 right-3 flex flex-col items-center gap-2">
          <div className="flex flex-col overflow-hidden rounded-full bg-surface/85 shadow-float backdrop-blur-md">
            <button type="button" aria-label="Hineinzoomen" onClick={() => engine?.zoomStep(1)} className="flex size-11 items-center justify-center text-fg hover:bg-sunken/60">
              <Plus className="size-5" aria-hidden />
            </button>
            <span className="mx-2.5 h-px bg-line" aria-hidden />
            <button type="button" aria-label="Herauszoomen" onClick={() => engine?.zoomStep(-1)} className="flex size-11 items-center justify-center text-fg hover:bg-sunken/60">
              <Minus className="size-5" aria-hidden />
            </button>
          </div>
          <button type="button" aria-label="Ansicht ausrichten" onClick={() => engine?.resetView()} className="flex size-11 items-center justify-center rounded-full bg-surface/85 text-muted shadow-float backdrop-blur-md">
            <span ref={(el) => engine?.setCompass(el)} className="block size-7" aria-hidden>
              <svg viewBox="0 0 30 30" className="size-7">
                <path d="M15 3 L19.5 15 L10.5 15 Z" fill="#d1493d" />
                <path d="M15 27 L19.5 15 L10.5 15 Z" fill="currentColor" />
                <circle cx="15" cy="15" r="1.7" fill="#fff" />
              </svg>
            </span>
          </button>
        </div>
      </div>

      {preview === null && (times.rise || times.set) && (
        <p className="mt-2 text-center text-xs text-faint">
          Licht wie draußen · {times.rise ? `Sonnenaufgang ${clock(times.rise)}` : ''}
          {times.rise && times.set ? ' · ' : ''}
          {times.set ? `Sonnenuntergang ${clock(times.set)}` : ''}
        </p>
      )}

      {status.mode !== 'floor' && scenes.length > 0 && (
        <Section title="Szenen" className="mt-5">
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 no-scrollbar md:mx-0 md:px-0">
            {scenes.map((scene) => (
              <Button key={scene.id} size="sm" onClick={() => void runAction(scene)} disabled={!scene.available} className="shrink-0">
                {scene.name}
              </Button>
            ))}
          </div>
        </Section>
      )}

      <Section
        title={status.mode === 'floor' && current ? levelName(current, view.levelNames) : 'Außen & Dach'}
        className="mt-5"
        action={
          isAdmin && (
            <Button size="sm" variant="ghost" icon={MapPin} onClick={() => setChooser(true)}>
              Geräte platzieren
            </Button>
          )
        }
      >
        {listed.length > 0 ? (
          <TileGrid>
            {listed.map((p) => (
              <EntityTile key={p.entity.id} entity={p.entity} onDetails={setDetails} showRoom />
            ))}
          </TileGrid>
        ) : (
          <p className="text-sm text-muted">
            {status.mode === 'floor'
              ? 'In diesem Geschoss sind noch keine Geräte platziert.'
              : 'Zoome hinein oder wähle rechts oben ein Geschoss, um seine Geräte zu sehen.'}
            {isAdmin && placed.length === 0 && ' Mit „Geräte platzieren“ legst du fest, wo welches Gerät im Haus sitzt.'}
          </p>
        )}
      </Section>

      <EntitySheet entityId={details} onClose={() => setDetails(null)} />
      {isAdmin && (
        <PlacementSheet
          open={chooser}
          onClose={() => {
            setChooser(false);
            if (search.get('platzieren')) {
              search.delete('platzieren');
              setSearch(search, { replace: true });
            }
          }}
          markers={state.markers}
          onPick={(id) => {
            setChooser(false);
            setPlacing(id);
          }}
          onRemove={(id) => void removeMarker(id)}
        />
      )}
    </>
  );
}

function dayGradient(rise: Date | null, set: Date | null): string {
  const pct = (d: Date | null, fallback: number) => (d ? ((d.getHours() + d.getMinutes() / 60) / 24) * 100 : fallback);
  const r = pct(rise, 27);
  const s = pct(set, 81);
  return `linear-gradient(90deg, #26314a 0%, #26314a ${r - 3}%, #e9b48c ${r}%, #a7c7dd ${r + 6}%, #a7c7dd ${s - 6}%, #e6a57a ${s}%, #26314a ${s + 3}%, #26314a 100%)`;
}

function MarkerButton({ entity, setRef, onOpen }: { entity: Entity; setRef(el: HTMLElement | null): void; onOpen(): void }) {
  const Icon = entityIcon(entity);
  const active = entityIsActive(entity);
  const warm = entity.kind === 'light' || (entity.kind === 'climate' && entity.heating);
  const text = entity.kind === 'climate' ? formatTemperature(entity.temperature) : null;
  return (
    <button
      type="button"
      data-no-gesture
      ref={setRef}
      onClick={onOpen}
      aria-label={`${entity.name}${entity.room ? `, ${entity.room}` : ''}`}
      style={{ visibility: 'hidden' }}
      className={cx(
        'absolute left-0 top-0 flex h-9 items-center justify-center gap-1 rounded-full text-xs font-bold shadow-float transition-[background-color,color] duration-200',
        text ? 'px-2.5' : 'w-9',
        !entity.available && 'opacity-60',
        active ? (warm ? 'bg-warm text-black' : 'bg-accent text-accent-fg') : 'bg-surface/95 text-fg ring-1 ring-line',
      )}
    >
      <Icon className="size-4" aria-hidden />
      {text && <span className="tabular-nums">{text}</span>}
    </button>
  );
}

function PlacementSheet({ open, onClose, markers, onPick, onRemove }: { open: boolean; onClose(): void; markers: House3DMarker[]; onPick(id: string): void; onRemove(id: string): void }) {
  const all = useAllEntities();
  const [query, setQuery] = useState('');
  const placedIds = new Set(markers.map((m) => m.entityId));
  const q = query.trim().toLowerCase();
  const candidates = all.filter((e) => e.kind !== 'action' && e.kind !== 'clock' && (q === '' || `${e.name} ${e.room ?? ''}`.toLowerCase().includes(q)));
  const byRoom = new Map<string, Entity[]>();
  for (const entity of candidates) {
    const room = entity.room ?? 'Ohne Raum';
    byRoom.set(room, [...(byRoom.get(room) ?? []), entity]);
  }
  return (
    <Sheet open={open} onClose={onClose} title="Geräte platzieren" subtitle="Gerät wählen, dann im Modell auf seine Stelle tippen. Öffne vorher das passende Geschoss.">
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4.5 -translate-y-1/2 text-faint" aria-hidden />
        <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Gerät oder Raum suchen" className="pl-10" aria-label="Gerät oder Raum suchen" />
      </div>
      <div className="flex flex-col gap-4">
        {[...byRoom.entries()]
          .sort(([a], [b]) => a.localeCompare(b, 'de'))
          .map(([room, list]) => (
            <div key={room}>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">{room}</p>
              <div className="flex flex-col divide-y divide-line rounded-control bg-sunken/60">
                {list.map((entity) => {
                  const Icon = entityIcon(entity);
                  const isPlaced = placedIds.has(entity.id);
                  return (
                    <div key={entity.id} className="flex items-center gap-3 px-3 py-2">
                      <Icon className="size-4.5 shrink-0 text-muted" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{entity.name}</span>
                      {isPlaced && <Check className="size-4 text-ok" aria-label="platziert" />}
                      {isPlaced && <IconButton icon={Trash2} size="sm" label={`${entity.name} aus dem Modell nehmen`} onClick={() => onRemove(entity.id)} />}
                      <Button size="sm" variant={isPlaced ? 'ghost' : 'secondary'} onClick={() => onPick(entity.id)}>
                        {isPlaced ? 'Versetzen' : 'Platzieren'}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        {candidates.length === 0 && <p className="text-sm text-muted">Keine Geräte gefunden.</p>}
      </div>
    </Sheet>
  );
}
