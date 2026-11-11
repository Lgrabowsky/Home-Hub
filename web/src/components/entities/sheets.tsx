import { ChevronDown, ChevronUp, Lock, Minus, Plus, Power, Square, Star, Wind } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BlindEntity, ClimateEntity, Entity, LightEntity } from '@home-hub/shared';
import { useEntity, useIsFavorite } from '../../hooks/entities.ts';
import { blind, climate, light } from '../../lib/actions.ts';
import { formatPercent, formatTemperature } from '../../lib/format.ts';
import { useCan } from '../../store/session.ts';
import { Button, cx, IconButton, Notice, Row, RowGroup, Segmented, Sheet, Slider, Toggle } from '../ui.tsx';

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
    <Sheet open={entityId !== null} onClose={onClose} title={shown.name} subtitle={shown.room ?? undefined}>
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

function BlindControls({ entity }: { entity: BlindEntity }) {
  const can = useCan('home.control');
  const disabled = !can || !entity.available;
  return (
    <div>
      {entity.locked && (
        <Notice tone="warn" icon={Lock} className="mb-3">
          Die Jalousie ist am Gebäude gesperrt (z. B. Wind- oder Alarmschutz).
        </Notice>
      )}
      <p className="mb-3 text-center text-muted">{blindStateText(entity)}</p>
      <div className="flex justify-center gap-4">
        <IconButton icon={ChevronUp} label="Hochfahren" size="lg" variant="filled" active={entity.motion === 'up'} tone="cool" disabled={disabled} onClick={() => void blind.up(entity)} />
        {!entity.isGroup && <IconButton icon={Square} label="Anhalten" size="lg" variant="filled" disabled={disabled} onClick={() => void blind.stop(entity)} />}
        <IconButton icon={ChevronDown} label="Herunterfahren" size="lg" variant="filled" active={entity.motion === 'down'} tone="cool" disabled={disabled} onClick={() => void blind.down(entity)} />
      </div>

      {entity.features.position && (
        <>
          <Label value={entity.position === null ? '–' : formatPercent(entity.position)}>Position (geschlossen)</Label>
          <Slider label="Position" tone="cool" value={entity.position ?? 0} disabled={disabled} onCommit={(value) => void blind.setPosition(entity, value)} />
          <div className="mt-1 flex justify-between px-0.5 text-xs text-faint">
            <span>Offen</span>
            <span>Geschlossen</span>
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

function ClimateControls({ entity }: { entity: ClimateEntity }) {
  const can = useCan('home.control');
  const disabled = !can || !entity.available;
  // The target follows the buttons instantly; the command is sent once the user pauses.
  const [target, setTarget] = useState(entity.target);
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

  const step = (delta: number) => {
    const { min, max, step: size } = entity.targetRange;
    const base = target ?? entity.temperature ?? 21;
    const next = Math.min(max, Math.max(min, Math.round((base + delta * size) / size) * size));
    setTarget(next);
    editing.current = true;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void climate.setTarget(entity, next).finally(() => {
        editing.current = false;
      });
    }, 700);
  };

  return (
    <div>
      <div className="mt-1 flex items-center justify-between rounded-tile bg-sunken px-5 py-4">
        <div>
          <p className="text-sm text-muted">Aktuell</p>
          <p className="text-4xl font-bold tabular-nums tracking-tight">{formatTemperature(entity.temperature)}</p>
        </div>
        <div className="text-right text-sm text-muted">
          {entity.humidity !== null && <p>Luftfeuchte {formatPercent(entity.humidity)}</p>}
          {entity.output !== null && <p>Ventil {formatPercent(entity.output)}</p>}
          <p className={cx(entity.heating && 'text-warm', entity.cooling && 'text-cool')}>{entity.cooling ? 'Kühlt' : entity.heating ? 'Heizt' : 'Ruht'}</p>
        </div>
      </div>

      {entity.windowOpen && (
        <Notice tone="warn" icon={Wind} className="mt-3">
          In diesem Raum ist ein Fenster offen.
        </Notice>
      )}

      {entity.features.target && (
        <>
          <Label>Wunschtemperatur</Label>
          <div className="flex items-center justify-between gap-3">
            <IconButton icon={Minus} label="Kälter" size="lg" variant="filled" disabled={disabled} onClick={() => step(-1)} />
            <span className="text-3xl font-semibold tabular-nums">{formatTemperature(target)}</span>
            <IconButton icon={Plus} label="Wärmer" size="lg" variant="filled" disabled={disabled} onClick={() => step(1)} />
          </div>
        </>
      )}

      {entity.features.mode && (
        <>
          <Label>Betriebsart</Label>
          <Segmented
            className="w-full"
            value={entity.mode}
            onChange={(mode) => !disabled && void climate.setMode(entity, mode)}
            options={(['comfort', 'reduced', 'off', 'manual', 'standby'] as const).map((mode) => ({ value: mode, label: MODE_LABELS[mode] }))}
          />
        </>
      )}
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
