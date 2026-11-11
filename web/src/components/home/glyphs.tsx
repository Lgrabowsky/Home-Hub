import { Fan, Lightbulb, Plug, Power, Snowflake, type LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { BlindEntity, LightEntity, SwitchEntity } from '@home-hub/shared';
import { cx } from '../ui.tsx';

/**
 * Small pictures of the devices that show their state — a window whose blind
 * really is half down, a bulb that glows as bright as the lamp, a radiator that
 * gives off heat. They move only when the device does.
 */

/** A window with its blind at `position` (0 = open, 100 = closed). */
export function BlindGlyph({ entity, size = 'md' }: { entity: Pick<BlindEntity, 'position' | 'motion' | 'tilt'>; size?: 'md' | 'lg' }) {
  const closed = Math.min(100, Math.max(0, entity.position ?? 0));
  const moving = entity.motion !== 'stopped';
  // While moving without a reported position, show the direction it is heading.
  const shown = moving && entity.position === null ? (entity.motion === 'down' ? 70 : 20) : closed;
  const big = size === 'lg';
  // Tilted slats let more light through: thinner stripes.
  const tilt = entity.tilt ?? 0;
  const slat = big ? 6 : 3;
  const gap = big ? Math.max(1, 3 - tilt / 40) : 1;
  return (
    <span
      aria-hidden
      className={cx('relative block shrink-0 overflow-hidden border-cool/50', big ? 'h-36 w-32 rounded-xl border-[3px]' : 'size-10 rounded-[0.6rem] border-2')}
      style={{ background: 'linear-gradient(180deg, color-mix(in srgb, var(--hh-cool) 22%, transparent), color-mix(in srgb, var(--hh-cool) 6%, transparent))' }}
    >
      {/* Window cross */}
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-cool/30" />
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-cool/30" />
      <span
        className={cx('absolute inset-x-0 top-0 bg-[size:100%_6px] transition-[height] duration-[1200ms] ease-in-out', moving && 'animate-slats')}
        style={{
          height: `${shown}%`,
          backgroundImage: `repeating-linear-gradient(to bottom, var(--hh-cool) 0 ${slat - gap}px, color-mix(in srgb, var(--hh-cool) 45%, transparent) ${slat - gap}px ${slat}px)`,
          backgroundSize: `100% ${slat}px`,
        }}
      />
      {/* Bottom rail of the blind */}
      <span className="absolute inset-x-0 h-[3px] rounded-full bg-cool transition-[top] duration-[1200ms] ease-in-out" style={{ top: `calc(${shown}% - 2px)`, opacity: shown > 2 ? 1 : 0 }} />
    </span>
  );
}

/** A bulb that glows as bright as the lamp. */
export function BulbGlyph({ entity }: { entity: Pick<LightEntity, 'on' | 'brightness' | 'color'> }) {
  const level = entity.on ? (entity.brightness === null ? 1 : Math.max(0.25, entity.brightness / 100)) : 0;
  const colour = entity.on && entity.color ? entity.color : 'var(--hh-warm)';
  return (
    <span aria-hidden className={cx('relative flex size-10 shrink-0 items-center justify-center rounded-full transition-colors duration-300', entity.on ? 'text-warm' : 'bg-sunken text-muted')}>
      {entity.on && (
        <span
          key="glow"
          className="absolute inset-0 animate-glow rounded-full transition-opacity duration-500"
          style={{ background: `radial-gradient(circle, color-mix(in srgb, ${colour} 55%, transparent) 0%, transparent 70%)`, opacity: 0.45 + level * 0.55 }}
        />
      )}
      <Lightbulb className="relative size-5" style={entity.on ? { color: colour, filter: `drop-shadow(0 0 ${3 + level * 5}px ${colour})` } : undefined} />
    </span>
  );
}

/** A radiator: heat rises from it while it heats; frost lines when cooling. */
export function ClimateGlyph({ heating, cooling, size = 'md' }: { heating: boolean; cooling: boolean; size?: 'md' | 'lg' }) {
  const big = size === 'lg';
  const tone = cooling ? 'var(--hh-cool)' : heating ? 'var(--hh-warm)' : 'var(--hh-muted)';
  return (
    <span aria-hidden className={cx('relative flex shrink-0 flex-col items-center justify-end', big ? 'h-32 w-40' : 'size-10')}>
      {(heating || cooling) && (
        <span className={cx('absolute inset-x-0 flex justify-center', big ? 'top-0 gap-5' : '-top-0.5 gap-[3px]')}>
          {[0, 1, 2].map((index) =>
            cooling ? (
              <Snowflake key={index} className={cx('animate-rise', big ? 'size-5' : 'size-2.5')} style={{ color: tone, animationDelay: `${index * 0.6}s` }} />
            ) : (
              <span
                key={index}
                className={cx('animate-rise rounded-full', big ? 'h-9 w-1' : 'h-3 w-[2px]')}
                style={{ background: `linear-gradient(to top, transparent, ${tone})`, animationDelay: `${index * 0.6}s` } as CSSProperties}
              />
            ),
          )}
        </span>
      )}
      {/* Radiator body: a row of fins */}
      <span className={cx('relative flex items-end', big ? 'gap-1.5' : 'gap-[2px]')}>
        {Array.from({ length: big ? 7 : 4 }, (_, index) => (
          <span
            key={index}
            className={cx('rounded-t-full transition-colors duration-500', big ? 'h-16 w-3.5' : 'h-[18px] w-[5px]')}
            style={{ background: heating ? `color-mix(in srgb, ${tone} ${70 - index * 3}%, var(--hh-raised))` : 'color-mix(in srgb, var(--hh-muted) 40%, var(--hh-raised))' }}
          />
        ))}
      </span>
    </span>
  );
}

/** Sockets and devices: a fan turns, everything else shows a lit power symbol. */
export function SwitchGlyph({ entity }: { entity: Pick<SwitchEntity, 'on' | 'variant'> }) {
  const Icon: LucideIcon = entity.variant === 'fan' ? Fan : entity.variant === 'socket' ? Plug : Power;
  return (
    <span aria-hidden className={cx('flex size-10 shrink-0 items-center justify-center rounded-full transition-colors duration-300', entity.on ? 'bg-accent/15 text-accent' : 'bg-sunken text-muted')}>
      <Icon className={cx('size-5', entity.on && entity.variant === 'fan' && 'animate-spin-slow')} />
    </span>
  );
}
