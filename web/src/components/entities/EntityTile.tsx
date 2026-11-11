import { ChevronDown, ChevronUp, Square } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { Entity } from '@home-hub/shared';
import { blind, light, runAction, toggleClock, toggleSwitch } from '../../lib/actions.ts';
import { formatAgo, formatNumber, formatPercent, formatTemperature } from '../../lib/format.ts';
import { BlindGlyph, BulbGlyph, ClimateGlyph, SwitchGlyph } from '../home/glyphs.tsx';
import { HubImage } from '../HubImage.tsx';
import { Tile } from '../Tile.tsx';
import { cx, type Tone } from '../ui.tsx';
import { entityIcon } from './icons.ts';
import { blindStateText, climateModeLabel } from './sheets.tsx';

/** One-line state of any entity, in words. Also used in lists and for screen readers. */
export function entityStateText(entity: Entity): string {
  switch (entity.kind) {
    case 'light':
      return entity.on ? (entity.features.dim && entity.brightness !== null ? `An · ${formatPercent(entity.brightness)}` : 'An') : 'Aus';
    case 'blind':
      return blindStateText(entity);
    case 'switch':
      return entity.on ? 'An' : 'Aus';
    case 'climate':
      return `${formatTemperature(entity.temperature)}${entity.target !== null ? ` · Soll ${formatNumber(entity.target)}` : ''}`;
    case 'action':
      return entity.active ? 'Aktiv' : 'Szene';
    case 'clock':
      return entity.enabled === false ? 'Pausiert' : 'Zeitschaltuhr aktiv';
    case 'contact':
      return entity.open ? 'Offen' : 'Geschlossen';
    case 'alarm':
      return entity.stateText;
    case 'sensor':
      return entity.value === null ? '–' : `${typeof entity.value === 'number' ? formatNumber(entity.value) : entity.value}${entity.unit ? ` ${entity.unit}` : ''}`;
    case 'camera':
      return entity.model ?? 'Kamera';
    case 'door':
      return entity.lastRingAt ? `Geklingelt ${formatAgo(entity.lastRingAt)}` : 'Türstation';
  }
}

export function entityTone(entity: Entity): Tone {
  switch (entity.kind) {
    case 'light':
      return 'warm';
    case 'blind':
      return 'cool';
    case 'climate':
      return entity.cooling ? 'cool' : 'warm';
    case 'contact':
      return 'warn';
    case 'alarm':
      return entity.triggered ? 'danger' : entity.breached ? 'warn' : 'ok';
    case 'action':
    case 'clock':
      return 'accent';
    default:
      return 'accent';
  }
}

/** Is the entity in a state worth highlighting? */
export function entityIsActive(entity: Entity): boolean {
  switch (entity.kind) {
    case 'light':
    case 'switch':
      return entity.on;
    case 'blind':
      return entity.motion !== 'stopped';
    case 'climate':
      return entity.heating || entity.cooling;
    case 'action':
      return entity.active === true;
    case 'clock':
      return entity.enabled !== false;
    case 'contact':
      return entity.open;
    case 'alarm':
      return entity.triggered || entity.breached || entity.mode === 'armed';
    default:
      return false;
  }
}

interface EntityTileProps {
  entity: Entity;
  /** Opens the detail sheet (the page owns a single <EntitySheet>). */
  onDetails(entityId: string): void;
  /** Show the room in front of the name — useful outside of a room page. */
  showRoom?: boolean;
}

/** Renders any entity as a tile with the fitting one-tap action. */
export function EntityTile({ entity, onDetails, showRoom }: EntityTileProps) {
  const navigate = useNavigate();
  const title = showRoom && entity.room && !entity.name.toLowerCase().includes(entity.room.toLowerCase()) ? `${entity.room} · ${entity.name}` : entity.name;
  const common = {
    icon: entityIcon(entity),
    title,
    subtitle: entityStateText(entity),
    active: entityIsActive(entity),
    tone: entityTone(entity),
    unavailable: !entity.available,
    onMore: () => onDetails(entity.id),
  };

  switch (entity.kind) {
    case 'light':
      return <Tile {...common} visual={<BulbGlyph entity={entity} />} pressLabel={`${entity.name} ${entity.on ? 'ausschalten' : 'einschalten'}`} onPress={() => void light.toggle(entity)} />;

    case 'switch':
      return <Tile {...common} visual={<SwitchGlyph entity={entity} />} pressLabel={`${entity.name} ${entity.on ? 'ausschalten' : 'einschalten'}`} onPress={() => void toggleSwitch(entity)} />;

    case 'blind':
      return (
        <Tile {...common} visual={<BlindGlyph entity={entity} />} pressLabel={`${entity.name}: Einstellungen`} onPress={() => onDetails(entity.id)}>
          <div className="flex gap-1.5">
            {(
              [
                { key: 'up', icon: ChevronUp, label: 'Hochfahren', run: () => blind.up(entity), on: entity.motion === 'up' },
                ...(entity.isGroup ? [] : [{ key: 'stop', icon: Square, label: 'Anhalten', run: () => blind.stop(entity), on: false }]),
                { key: 'down', icon: ChevronDown, label: 'Herunterfahren', run: () => blind.down(entity), on: entity.motion === 'down' },
              ] as const
            ).map((button) => (
              <button
                key={button.key}
                type="button"
                aria-label={`${entity.name}: ${button.label}`}
                onClick={() => void button.run()}
                className={cx(
                  'flex h-9 flex-1 items-center justify-center rounded-xl transition active:scale-95',
                  button.on ? 'bg-cool/20 text-cool' : 'bg-sunken text-muted hover:text-fg',
                )}
              >
                <button.icon className={cx(button.key === 'stop' ? 'size-3.5' : 'size-5')} aria-hidden />
              </button>
            ))}
          </div>
        </Tile>
      );

    case 'climate':
      return (
        <Tile
          {...common}
          subtitle={
            <>
              {entity.target !== null ? `Soll ${formatTemperature(entity.target)}` : climateModeLabel(entity.mode)}
              {entity.windowOpen ? ' · Fenster offen' : ''}
            </>
          }
          visual={<ClimateGlyph heating={entity.heating} cooling={entity.cooling} />}
          value={entity.temperature === null ? '–' : `${formatNumber(entity.temperature)}°`}
          pressLabel={`${entity.name}: Temperatur einstellen`}
          onPress={() => onDetails(entity.id)}
        />
      );

    case 'action':
      return <Tile {...common} subtitle={entity.active ? 'Aktiv' : 'Tippen zum Starten'} pressLabel={`Szene ${entity.name} starten`} onPress={() => void runAction(entity)} />;

    case 'clock':
      return <Tile {...common} pressLabel={`${entity.name} ${entity.enabled === false ? 'aktivieren' : 'pausieren'}`} onPress={entity.features.toggle ? () => void toggleClock(entity) : undefined} />;

    case 'camera':
    case 'door': {
      const deviceId = entity.id.slice(entity.id.indexOf(':') + 1);
      const path = entity.kind === 'camera' ? `/sicherheit/kamera/${deviceId}` : `/sicherheit/tuer/${deviceId}`;
      const snapshot = entity.kind === 'camera' ? `/api/cameras/${deviceId}/snapshot` : `/api/doors/${deviceId}/snapshot`;
      return (
        <button
          type="button"
          onClick={() => navigate(path)}
          className={cx('group relative col-span-2 aspect-video overflow-hidden rounded-tile bg-surface text-left shadow-tile transition active:scale-[0.99]', !entity.available && 'opacity-60')}
        >
          <HubImage src={entity.available ? snapshot : null} alt={entity.name} refreshMs={10_000} className="absolute inset-0 size-full" />
          <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-3.5 pb-2.5 pt-8 text-white">
            <span className="block truncate text-[15px] font-semibold">{title}</span>
            <span className="block truncate text-[13px] text-white/75">{entity.available ? entityStateText(entity) : 'Nicht erreichbar'}</span>
          </span>
        </button>
      );
    }

    default:
      // Contacts, alarm zones and sensors only show their state.
      return <Tile {...common} onMore={() => onDetails(entity.id)} />;
  }
}
