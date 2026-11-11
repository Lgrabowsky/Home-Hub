import { ChevronDown, ChevronUp, Minus, Play, Plus, Square } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ClimateEntity, Entity } from '@home-hub/shared';
import { blind, climate, light, runAction, toggleClock, toggleSwitch } from '../../lib/actions.ts';
import { formatNumber } from '../../lib/format.ts';
import { useCan } from '../../store/session.ts';
import { entityIcon } from '../entities/icons.ts';
import { entityIsActive, entityStateText, entityTone } from '../entities/EntityTile.tsx';
import { cx, Toggle, toneSoft } from '../ui.tsx';
import { BlindGlyph, BulbGlyph, ClimateGlyph, SwitchGlyph } from './glyphs.tsx';

/** "Wohnzimmer Decke" in the Wohnzimmer is just "Decke". */
export function shortName(entity: Entity, room?: string): string {
  const name = entity.name.trim();
  if (!room) return name;
  // "Jalousie Büro" in the Büro is just "Jalousie"; "Wohnzimmer Decke" in the Wohnzimmer just "Decke".
  const escaped = room.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rest = name.replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'i'), ' ').replace(/\s+/g, ' ').replace(/^[\s:·\-–]+|[\s:·\-–]+$/g, '');
  if (rest.length < 2) return name;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

function Glyph({ entity }: { entity: Entity }) {
  switch (entity.kind) {
    case 'light':
      return <BulbGlyph entity={entity} />;
    case 'blind':
      return <BlindGlyph entity={entity} />;
    case 'switch':
      return <SwitchGlyph entity={entity} />;
    case 'climate':
      return <ClimateGlyph heating={entity.heating} cooling={entity.cooling} />;
    default: {
      const Icon = entityIcon(entity);
      const active = entityIsActive(entity);
      return (
        <span aria-hidden className={cx('flex size-10 shrink-0 items-center justify-center rounded-full', active ? toneSoft[entityTone(entity)] : 'bg-sunken text-muted')}>
          <Icon className="size-5" />
        </span>
      );
    }
  }
}

function RoundButton({ label, onClick, children, on, small }: { label: string; onClick(): void; children: ReactNode; on?: boolean; small?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label.slice(label.indexOf(':') + 1).trim()}
      onClick={onClick}
      className={cx(
        'flex shrink-0 items-center justify-center rounded-full transition active:scale-90',
        small ? 'size-8' : 'size-9',
        on ? 'bg-cool/20 text-cool' : 'bg-sunken text-muted hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

/** Target temperature in steps; sent once the user stops tapping. */
function TargetStepper({ entity, disabled }: { entity: ClimateEntity; disabled: boolean }) {
  const [pending, setPending] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const shown = pending ?? entity.target;
  if (shown === null || !entity.features.target) return <span className="text-[15px] font-semibold tabular-nums">{entity.temperature === null ? '–' : `${formatNumber(entity.temperature)}°`}</span>;
  const { min, max, step } = entity.targetRange;
  const change = (delta: number) => {
    const next = Math.min(max, Math.max(min, Math.round((shown + delta) / step) * step));
    setPending(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void climate.setTarget(entity, next).finally(() => setPending(null));
    }, 700);
  };
  return (
    <span className="flex items-center gap-1">
      <RoundButton small label={`${entity.name}: kälter`} onClick={() => !disabled && change(-step)}>
        <Minus className="size-4" aria-hidden />
      </RoundButton>
      <span className={cx('w-12 text-center text-[17px] font-semibold tabular-nums transition-colors', pending !== null && 'text-accent')} aria-live="polite">
        {formatNumber(shown)}°
      </span>
      <RoundButton small label={`${entity.name}: wärmer`} onClick={() => !disabled && change(step)}>
        <Plus className="size-4" aria-hidden />
      </RoundButton>
    </span>
  );
}

function Control({ entity, canControl }: { entity: Entity; canControl: boolean }) {
  if (!entity.available) return <span className="text-[13px] text-faint">Nicht erreichbar</span>;
  switch (entity.kind) {
    case 'light':
      return <Toggle tone="warm" checked={entity.on} disabled={!canControl} label={`${entity.name} ${entity.on ? 'ausschalten' : 'einschalten'}`} onChange={() => void light.toggle(entity)} />;
    case 'switch':
      return entity.momentary ? (
        <RoundButton label={`${entity.name}: Auslösen`} onClick={() => void toggleSwitch(entity)}>
          <Play className="size-4" aria-hidden />
        </RoundButton>
      ) : (
        <Toggle checked={entity.on} disabled={!canControl} label={`${entity.name} ${entity.on ? 'ausschalten' : 'einschalten'}`} onChange={() => void toggleSwitch(entity)} />
      );
    case 'blind':
      if (!canControl) return null;
      return (
        <span className="flex gap-1">
          <RoundButton label={`${entity.name}: Hochfahren`} on={entity.motion === 'up'} onClick={() => void blind.up(entity)}>
            <ChevronUp className="size-5" aria-hidden />
          </RoundButton>
          {!entity.isGroup && (
            <RoundButton label={`${entity.name}: Anhalten`} onClick={() => void blind.stop(entity)}>
              <Square className="size-3" aria-hidden />
            </RoundButton>
          )}
          <RoundButton label={`${entity.name}: Herunterfahren`} on={entity.motion === 'down'} onClick={() => void blind.down(entity)}>
            <ChevronDown className="size-5" aria-hidden />
          </RoundButton>
        </span>
      );
    case 'climate':
      return <TargetStepper entity={entity} disabled={!canControl} />;
    case 'action':
      return canControl ? (
        <RoundButton label={`Szene ${entity.name} starten`} onClick={() => void runAction(entity)}>
          <Play className="size-4" aria-hidden />
        </RoundButton>
      ) : null;
    case 'clock':
      return <Toggle checked={entity.enabled !== false} disabled={!canControl || !entity.features.toggle} label={`${entity.name} ${entity.enabled === false ? 'aktivieren' : 'pausieren'}`} onChange={() => void toggleClock(entity)} />;
    default:
      return null;
  }
}

function rowState(entity: Entity): string {
  if (entity.kind === 'climate') {
    const parts = [entity.temperature === null ? null : `Ist ${formatNumber(entity.temperature)} °C`, entity.heating ? 'heizt' : entity.cooling ? 'kühlt' : null, entity.windowOpen ? 'Fenster offen' : null];
    return parts.filter(Boolean).join(' · ') || entityStateText(entity);
  }
  return entityStateText(entity);
}

/** One device as a line: its picture, name and state (tap for details), and the direct control. */
export function EntityRow({ entity, room, title, onDetails }: { entity: Entity; room?: string; title?: string; onDetails(id: string): void }) {
  const canControl = useCan('home.control');
  const active = entityIsActive(entity);
  return (
    <div className={cx('flex min-h-16 items-center gap-3 py-2 pl-3 pr-3.5', !entity.available && 'opacity-55')}>
      <button type="button" onClick={() => onDetails(entity.id)} aria-label={`${entity.name}: Einstellungen`} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left transition active:opacity-70">
        <Glyph entity={entity} />
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-medium">{title ?? shortName(entity, room)}</span>
          <span className={cx('block truncate text-[13px]', active ? 'text-fg/70' : 'text-muted')}>
            {title && shortName(entity, room) !== entity.name && entity.kind !== 'climate' ? `${shortName(entity, room)} · ` : ''}
            {entity.available ? rowState(entity) : 'Nicht erreichbar'}
          </span>
        </span>
      </button>
      <Control entity={entity} canControl={canControl} />
    </div>
  );
}
