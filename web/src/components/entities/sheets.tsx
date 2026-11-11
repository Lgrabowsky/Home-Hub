import { ChevronDown, ChevronUp, Lock, Minus, Plus, Power, Square, Star, Wind } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BlindEntity, ClimateEntity, Entity, LightEntity } from '@home-hub/shared';
import { useEntity, useIsFavorite } from '../../hooks/entities.ts';
import { blind, climate, light } from '../../lib/actions.ts';
import { formatNumber, formatPercent, formatTemperature } from '../../lib/format.ts';
import { BlindGlyph, ClimateGlyph } from '../home/glyphs.tsx';
import { useCan } from '../../store/session.ts';
import { Button, cx, IconButton, Notice, Row, RowGroup, Sheet, Slider, Toggle } from '../ui.tsx';

/** "Show on the overview" switch that every detail sheet ends with. */
export function FavoriteRow({ entity }: { entity: Entity }) {
  const [isFavorite, toggle] = useIsFavorite(entity.id);
  return (
    <RowGroup className="mt-5 bg-sunken shadow-none">
      <Row icon={Star} tone={isFavorite ? 'warm' : 'neutral'} title="Auf der Übersicht zeigen" trailing={<Toggle checked={isFavorite} onChange={toggle} label="Auf der Übersicht zeigen" tone="warm" />} />
    </RowGroup>
  );
}

function Label({ children, value }: { children: ReactNode; value?: ReactNode }) {
  return (
    <div className="mb-2 mt-5 flex items-baseline justify-between px-0.5 text-sm">
      <span className="font-medium text-muted">{children}</span>
      {value !== undefined && <span className="tabular-nums text-fg">{value}</span>}
    </div>
  );
}

interface EntitySheetProps {
  entityId: string | null;
  onClose(): void;
}

/** Detail sheet for any entity; picks the right controls by kind. */
export function EntitySheet({ entityId, onClose }: EntitySheetProps) {
  const entity = useEntity(entityId ?? undefined);
  // Keep rendering the last known entity while the sheet animates out / the device vanishes.
  const last = useRef<Entity | undefined>(undefined);
  if (entity) last.current = entity;
  const shown = entity ?? last.current;
  if (!shown) return null;
  return (
    <Sheet open={entityId !== null} onClose={onClose} title={shown.name} subtitle={shown.room && shown.room !== shown.name ? shown.room : undefined}>
      {!shown.available && <Notice tone="warn">Dieses Gerät ist gerade nicht erreichbar.</Notice>}
      {shown.kind === 'light' && <LightControls entity={shown} />}
      {shown.kind === 'blind' && <BlindControls entity={shown} />}
      {shown.kind === 'climate' && <ClimateControls entity={shown} />}
      <FavoriteRow entity={shown} />
    </Sheet>
  );
}

// --- Light ----------------------------------------------------------------------------------

const SWATCHES = ['#ffb86b', '#fff1d6', '#ffffff', '#ff5a5a', '#ff9f43', '#ffd93d', '#6bd968', '#4fd1c5', '#5b9dff', '#9b6bff', '#ff6bd6'];

function LightControls({ entity }: { entity: LightEntity }) {
  const can = useCan('home.control');
  return (
    <div>
      <button
        type="button"
        disabled={!can || !entity.available}
        onClick={() => void light.toggle(entity)}
        className={cx(
          'mt-1 flex h-16 w-full items-center justify-between rounded-tile px-5 text-left transition active:scale-[0.99] disabled:opacity-60',
          entity.on ? 'bg-warm/15 text-warm' : 'bg-sunken text-muted',
        )}
      >
        <span className="text-base font-semibold">{entity.on ? 'Eingeschaltet' : 'Ausgeschaltet'}</span>
        <Power className="size-6" aria-hidden />
      </button>

      {entity.features.dim && (
        <>
          <Label value={entity.on ? formatPercent(entity.brightness) : 'Aus'}>Helligkeit</Label>
          <Slider label="Helligkeit" tone="warm" value={entity.on ? (entity.brightness ?? 100) : 0} disabled={!can || !entity.available} onCommit={(value) => void light.setBrightness(entity, value)} />
        </>
      )}

      {entity.features.colorTemp && (
        <>
          <Label>Farbtemperatur</Label>
          <div className="rounded-full bg-gradient-to-r from-[#ffb86b] via-[#fff3e0] to-[#cfe6ff] px-1">
            <Slider thin bare label="Farbtemperatur" value={entity.colorTemp ?? 50} disabled={!can || !entity.available} onCommit={(value) => void light.setColorTemp(entity, value)} />
          </div>
          <div className="mt-1 flex justify-between px-0.5 text-xs text-faint">
            <span>Warm</span>
            <span>Kalt</span>
          </div>
        </>
      )}

      {entity.features.color && (
        <>
          <Label>Farbe</Label>
          <div className="flex flex-wrap gap-2.5">
            {SWATCHES.map((swatch) => (
              <button
                key={swatch}
                type="button"
                aria-label={`Farbe ${swatch}`}
                disabled={!can || !entity.available}
                onClick={() => void light.setColor(entity, swatch)}
                className={cx(
                  'size-10 rounded-full shadow-tile transition active:scale-90 disabled:opacity-50',
                  entity.color?.toLowerCase() === swatch && 'ring-2 ring-fg ring-offset-2 ring-offset-surface',
                )}
                style={{ background: swatch }}
              />
            ))}
            <label className="relative flex size-10 cursor-pointer items-center justify-center rounded-full bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)] shadow-tile" title="Eigene Farbe">
              <span className="sr-only">Eigene Farbe wählen</span>
              <input
                type="color"
                className="absolute inset-0 size-full cursor-pointer opacity-0"
                value={entity.color ?? '#ffffff'}
                disabled={!can || !entity.available}
                onChange={(event) => void light.setColor(entity, event.target.value)}
              />
            </label>
          </div>
        </>
      )}
    </div>
  );
}

// --- Blind ----------------------------------------------------------------------------------

export function blindStateText(entity: BlindEntity): string {
  if (entity.motion === 'up') return 'Fährt hoch …';
  if (entity.motion === 'down') return 'Fährt runter …';
  if (entity.position === null) return entity.isGroup ? 'Gruppe' : 'Angehalten';
  if (entity.position <= 1) return 'Offen';
  if (entity.position >= 99) return 'Geschlossen';
  return `${Math.round(entity.position)} % geschlossen`;
}

const BLIND_PRESETS = [
  { label: 'Offen', value: 0 },
  { label: 'Halb', value: 50 },
  { label: 'Zu', value: 100 },
];

function BlindControls({ entity }: { entity: BlindEntity }) {
  const can = useCan('home.control');
  const disabled = !can || !entity.available;
  // While the finger is on the slider, the picture follows it.
  const [preview, setPreview] = useState<number | null>(null);
  return (
    <div>
      {entity.locked && (
        <Notice tone="warn" icon={Lock} className="mb-3">
          Die Jalousie ist am Gebäude gesperrt (z. B. Wind- oder Alarmschutz).
        </Notice>
      )}
      <div className="flex items-center justify-center gap-7 py-2">
        <BlindGlyph entity={{ ...entity, position: preview ?? entity.position }} size="lg" />
        <div className="flex flex-col items-center gap-3">
          <IconButton icon={ChevronUp} label="Hochfahren" size="lg" variant="filled" active={entity.motion === 'up'} tone="cool" disabled={disabled} onClick={() => void blind.up(entity)} />
          {!entity.isGroup && <IconButton icon={Square} label="Anhalten" size="lg" variant="filled" disabled={disabled} onClick={() => void blind.stop(entity)} />}
          <IconButton icon={ChevronDown} label="Herunterfahren" size="lg" variant="filled" active={entity.motion === 'down'} tone="cool" disabled={disabled} onClick={() => void blind.down(entity)} />
        </div>
      </div>
      <p className="mt-2 text-center text-muted" role="status">
        {blindStateText(entity)}
      </p>

      {entity.features.position && (
        <>
          <Label value={entity.position === null ? '–' : formatPercent(preview ?? entity.position)}>Position (geschlossen)</Label>
          <Slider
            label="Position"
            tone="cool"
            value={entity.position ?? 0}
            disabled={disabled}
            onChange={setPreview}
            onCommit={(value) => {
              setPreview(null);
              void blind.setPosition(entity, value);
            }}
          />
          <div className="mt-3 grid grid-cols-3 gap-2">
            {BLIND_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                disabled={disabled}
                onClick={() => void blind.setPosition(entity, preset.value)}
                className={cx(
                  'h-11 rounded-2xl text-sm font-medium transition active:scale-[0.97] disabled:opacity-50',
                  entity.position !== null && Math.abs(entity.position - preset.value) < 3 ? 'bg-cool/20 text-cool' : 'bg-sunken text-muted hover:text-fg',
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </>
      )}
      {entity.features.tilt && (
        <>
          <Label value={entity.tilt === null ? '–' : formatPercent(entity.tilt)}>Lamellen</Label>
          <Slider label="Lamellen" tone="cool" value={entity.tilt ?? 0} disabled={disabled} onCommit={(value) => void blind.setTilt(entity, value)} />
        </>
      )}
    </div>
  );
}

// --- Climate --------------------------------------------------------------------------------

const MODE_LABELS: Record<ClimateEntity['mode'], string> = {
  comfort: 'Komfort',
  reduced: 'Absenken',
  off: 'Aus',
  manual: 'Manuell',
  standby: 'Standby',
  unknown: 'Unbekannt',
};

/** A round button with a glow when on — the power switch of the inspiration's AC panel. */
function PowerButton({ on, label, disabled, onClick, tone = 'warm' }: { on: boolean; label: string; disabled?: boolean; onClick(): void; tone?: 'warm' | 'cool' | 'accent' }) {
  const colour = `var(--hh-${tone})`;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cx('flex size-12 shrink-0 items-center justify-center rounded-full transition duration-300 active:scale-95 disabled:opacity-50', on ? 'text-white' : 'bg-sunken text-muted')}
      style={on ? { background: colour, boxShadow: `0 0 0 4px color-mix(in srgb, ${colour} 22%, transparent), 0 0 26px -2px ${colour}` } : undefined}
    >
      <Power className="size-5.5" aria-hidden />
    </button>
  );
}

function InfoTile({ label, value, tone }: { label: string; value: ReactNode; tone?: 'warm' | 'cool' | 'warn' }) {
  return (
    <div className="rounded-2xl bg-sunken px-3.5 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={cx('mt-0.5 font-semibold tabular-nums', tone === 'warm' && 'text-warm', tone === 'cool' && 'text-cool', tone === 'warn' && 'text-warn')}>{value}</p>
    </div>
  );
}

const SELECTABLE_MODES = ['comfort', 'reduced', 'standby', 'manual'] as const;

function ClimateControls({ entity }: { entity: ClimateEntity }) {
  const can = useCan('home.control');
  const disabled = !can || !entity.available;
  // The target follows the buttons instantly; the command is sent once the user pauses.
  const [target, setTarget] = useState(entity.target);
  const [sync, setSync] = useState<'idle' | 'sending' | 'done'>('idle');
  const timer = useRef<number | null>(null);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setTarget(entity.target);
  }, [entity.target]);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  const { min, max, step: size } = entity.targetRange;
  const clamp = (value: number) => Math.min(max, Math.max(min, Math.round(value / size) * size));

  const send = (next: number, delay: number) => {
    setTarget(next);
    editing.current = true;
    setSync('sending');
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void climate.setTarget(entity, next).then((ok) => {
        editing.current = false;
        setSync(ok ? 'done' : 'idle');
        if (ok) timer.current = window.setTimeout(() => setSync('idle'), 2000);
      });
    }, delay);
  };
  const step = (delta: number) => send(clamp((target ?? entity.temperature ?? 21) + delta * size), 700);

  const off = entity.mode === 'off';
  const status = sync === 'sending' ? 'Wird übertragen …' : sync === 'done' ? 'Übernommen' : entity.cooling ? 'Kühlt gerade' : entity.heating ? 'Heizt gerade' : off ? 'Ausgeschaltet' : 'Temperatur erreicht';

  return (
    <div>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted">Raumtemperatur</p>
          <p className="text-xl font-semibold tabular-nums">{formatTemperature(entity.temperature)}</p>
        </div>
        {entity.features.mode && (
          <PowerButton
            on={!off}
            disabled={disabled}
            label={off ? 'Heizung einschalten' : 'Heizung ausschalten'}
            tone={entity.cooling ? 'cool' : 'warm'}
            onClick={() => void climate.setMode(entity, off ? 'comfort' : 'off')}
          />
        )}
      </div>

      <div className={cx('mt-2 flex flex-col items-center transition-opacity duration-300', off && 'opacity-45')}>
        <ClimateGlyph heating={entity.heating} cooling={entity.cooling} size="lg" />
        {entity.features.target && (
          <p className="mt-3 text-[64px] font-light leading-none tracking-tight tabular-nums" aria-live="polite">
            {target === null ? '–' : formatNumber(target)}
            <span className="ml-1 align-top text-2xl font-normal text-muted">°C</span>
          </p>
        )}
        <p className="mt-2 text-sm text-muted">Wunschtemperatur</p>
      </div>

      {entity.features.target && (
        <div className="mt-5">
          <div className="flex items-center gap-3">
            <IconButton icon={Minus} label="Kälter" variant="filled" disabled={disabled} onClick={() => step(-1)} />
            <div className="flex-1 rounded-full px-1" style={{ background: 'linear-gradient(90deg, var(--hh-cool), color-mix(in srgb, var(--hh-warm) 60%, var(--hh-cool)), var(--hh-warm), #ff7a59)' }}>
              <Slider
                thin
                bare
                label="Wunschtemperatur"
                min={min}
                max={max}
                step={size}
                value={target ?? min}
                disabled={disabled}
                onChange={(value) => {
                  editing.current = true;
                  setTarget(value);
                }}
                onCommit={(value) => send(clamp(value), 0)}
              />
            </div>
            <IconButton icon={Plus} label="Wärmer" variant="filled" disabled={disabled} onClick={() => step(1)} />
          </div>
          <div className="mt-1.5 flex justify-between px-14 text-xs text-faint tabular-nums">
            <span>{formatNumber(min)}°</span>
            <span>{formatNumber(max)}°</span>
          </div>
        </div>
      )}

      {entity.windowOpen && (
        <Notice tone="warn" icon={Wind} className="mt-4">
          In diesem Raum ist ein Fenster offen.
        </Notice>
      )}

      {entity.features.mode && (
        <>
          <Label>Betriebsart</Label>
          <div className="grid grid-cols-2 gap-2 min-[420px]:grid-cols-4">
            {SELECTABLE_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={entity.mode === mode}
                disabled={disabled}
                onClick={() => void climate.setMode(entity, mode)}
                className={cx(
                  'h-12 rounded-2xl text-sm font-medium transition active:scale-[0.97] disabled:opacity-50',
                  entity.mode === mode ? 'bg-fg text-bg' : 'bg-sunken text-muted hover:text-fg',
                )}
              >
                {MODE_LABELS[mode]}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        {entity.output !== null && <InfoTile label="Ventil" value={formatPercent(entity.output)} tone={entity.heating ? 'warm' : undefined} />}
        {entity.humidity !== null && <InfoTile label="Luftfeuchte" value={formatPercent(entity.humidity)} />}
        {entity.windowOpen !== null && <InfoTile label="Fenster" value={entity.windowOpen ? 'Offen' : 'Zu'} tone={entity.windowOpen ? 'warn' : undefined} />}
      </div>

      <p className="mt-4 flex items-center justify-center gap-2 text-sm text-muted" role="status">
        <span className={cx('size-1.5 rounded-full', sync === 'sending' ? 'animate-pulse bg-accent' : entity.heating ? 'bg-warm' : entity.cooling ? 'bg-cool' : 'bg-faint')} />
        {status}
      </p>
    </div>
  );
}

export function climateModeLabel(mode: ClimateEntity['mode']): string {
  return MODE_LABELS[mode];
}

/** Small "confirm before running" dialog is deliberately absent: scenes run on one tap, as in the wall panel. */
export function SheetFooterClose({ onClose }: { onClose(): void }) {
  return (
    <Button block onClick={onClose}>
      Fertig
    </Button>
  );
}
