import { SlidersHorizontal, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx, toneSoft, toneVar, type Tone } from './ui.tsx';

interface TileProps {
  icon: LucideIcon;
  title: string;
  /** State in words: "An · 60 %", "Geschlossen", "21,5 °C". */
  subtitle?: ReactNode;
  /** Highlights the tile (light is on, music is playing, window is open …). */
  active?: boolean;
  tone?: Tone;
  /** The device is unreachable: shown dimmed, not clickable. */
  unavailable?: boolean;
  /** Main action when the tile is tapped. */
  onPress?(): void;
  /** Opens details (dimmer, colour …). Shown as a small button in the corner. */
  onMore?(): void;
  moreLabel?: string;
  /** Extra controls at the bottom of the tile (e.g. up/stop/down). */
  children?: ReactNode;
  /** Accessible description of what tapping does, e.g. "Licht ausschalten". */
  pressLabel?: string;
  /** Replaces the icon: a picture of the device's state (see components/home/glyphs). */
  visual?: ReactNode;
  /** A large value next to the picture, e.g. the room temperature. */
  value?: ReactNode;
  className?: string;
}

/**
 * The basic unit of the app: one device, its state at a glance, one tap for
 * the most common action. Every device type renders through this, which is
 * what makes lights, blinds, sockets and scenes feel like one system.
 */
export function Tile({ icon: Icon, title, subtitle, active, tone = 'accent', unavailable, onPress, onMore, moreLabel = 'Einstellungen', children, pressLabel, visual, value, className }: TileProps) {
  const interactive = Boolean(onPress) && !unavailable;
  return (
    <div
      className={cx(
        'panel group relative flex min-h-[7rem] flex-col rounded-tile p-3.5 transition-[background] duration-300',
        unavailable && 'opacity-55',
        className,
      )}
      // An active tile glows faintly in its state colour (warm for light, cool for shading …).
      style={
        active && !unavailable
          ? { background: `radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, ${toneVar[tone]} 16%, transparent), transparent 65%), var(--hh-panel), var(--hh-raised)` }
          : undefined
      }
    >
      {interactive && (
        <button
          type="button"
          aria-label={pressLabel ?? title}
          onClick={onPress}
          className="absolute inset-0 rounded-tile transition hover:bg-fg/[0.03] active:bg-fg/[0.06]"
        />
      )}
      <div className="pointer-events-none relative flex items-start justify-between gap-2">
        {visual ?? (
          <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-full transition-colors', active ? toneSoft[tone] : 'bg-sunken text-muted')}>
            <Icon className="size-5" aria-hidden />
          </span>
        )}
        {value !== undefined && <span className="ml-auto text-[22px] font-semibold leading-none tracking-tight tabular-nums">{value}</span>}
        {onMore && !unavailable && (
          <button
            type="button"
            aria-label={`${moreLabel}: ${title}`}
            title={moreLabel}
            onClick={onMore}
            className="pointer-events-auto -mr-1.5 -mt-1.5 flex size-9 items-center justify-center rounded-full text-faint transition hover:bg-sunken hover:text-fg"
          >
            <SlidersHorizontal className="size-4" aria-hidden />
          </button>
        )}
      </div>
      <div className="pointer-events-none relative pt-2.5">
        <p className="line-clamp-2 text-[15px] font-semibold leading-snug">{title}</p>
        <p className={cx('mt-0.5 truncate text-[13px]', unavailable ? 'text-faint' : active ? 'text-fg/75' : 'text-muted')}>
          {unavailable ? 'Nicht erreichbar' : subtitle}
        </p>
      </div>
      {children && !unavailable && <div className="relative mt-auto pt-2.5">{children}</div>}
    </div>
  );
}
