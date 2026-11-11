import { clsx, type ClassValue } from 'clsx';
import { ChevronLeft, Loader2, X, type LucideIcon } from 'lucide-react';
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { haptic } from '../lib/platform.ts';

/**
 * The building blocks every screen is made of. Keeping them in one place is
 * what makes the app feel like one product instead of five vendor apps.
 */

export const cx = (...values: ClassValue[]): string => clsx(values);

export type Tone = 'accent' | 'warm' | 'cool' | 'ok' | 'warn' | 'danger' | 'music' | 'neutral';

/** Tinted background + matching text colour for an "active" state. */
export const toneSoft: Record<Tone, string> = {
  accent: 'bg-accent/15 text-accent',
  warm: 'bg-warm/15 text-warm',
  cool: 'bg-cool/15 text-cool',
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn',
  danger: 'bg-danger/15 text-danger',
  music: 'bg-music/15 text-music',
  neutral: 'bg-sunken text-muted',
};

export const toneText: Record<Tone, string> = {
  accent: 'text-accent',
  warm: 'text-warm',
  cool: 'text-cool',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  music: 'text-music',
  neutral: 'text-muted',
};

export const toneVar: Record<Tone, string> = {
  accent: 'var(--hh-accent)',
  warm: 'var(--hh-warm)',
  cool: 'var(--hh-cool)',
  ok: 'var(--hh-ok)',
  warn: 'var(--hh-warn)',
  danger: 'var(--hh-danger)',
  music: 'var(--hh-music)',
  neutral: 'var(--hh-muted)',
};

// --- Buttons ------------------------------------------------------------------------------

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: LucideIcon;
  block?: boolean;
}

export function Button({ variant = 'secondary', size = 'md', loading, icon: Icon, block, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex select-none items-center justify-center gap-2 rounded-control font-medium transition active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100',
        size === 'sm' && 'h-9 px-3 text-sm',
        size === 'md' && 'h-11 px-4',
        size === 'lg' && 'h-13 px-5 text-base',
        variant === 'primary' && 'bg-accent text-accent-fg hover:brightness-110',
        variant === 'secondary' && 'bg-raised text-fg shadow-tile hover:bg-sunken',
        variant === 'ghost' && 'text-muted hover:bg-sunken hover:text-fg',
        variant === 'danger' && 'bg-danger/15 text-danger hover:bg-danger/25',
        block && 'w-full',
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : Icon ? <Icon className="size-4.5 shrink-0" aria-hidden /> : null}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  /** Accessible name — icon buttons have no visible text. */
  label: string;
  size?: 'sm' | 'md' | 'lg';
  active?: boolean;
  tone?: Tone;
  variant?: 'plain' | 'filled';
}

export function IconButton({ icon: Icon, label, size = 'md', active, tone = 'accent', variant = 'plain', className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      {...rest}
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full transition active:scale-95 disabled:opacity-40',
        size === 'sm' && 'size-9',
        size === 'md' && 'size-11',
        size === 'lg' && 'size-14',
        active ? toneSoft[tone] : variant === 'filled' ? 'bg-raised text-fg shadow-tile hover:bg-sunken' : 'text-muted hover:bg-sunken hover:text-fg',
        className,
      )}
    >
      <Icon className={cx(size === 'lg' ? 'size-6' : size === 'sm' ? 'size-4.5' : 'size-5')} aria-hidden />
    </button>
  );
}

// --- Layout ----------------------------------------------------------------------------------

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx('rounded-tile bg-surface shadow-tile', className)}>
      {children}
    </div>
  );
}

export function Section({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('mb-7', className)}>
      {(title || action) && (
        <div className="mb-2.5 flex min-h-7 items-center justify-between gap-3 px-1">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted">{title}</h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** Responsive grid for tiles: 2 columns on phones, more on wider screens. */
export function TileGrid({ children, className, dense }: { children: ReactNode; className?: string; dense?: boolean }) {
  return (
    <div
      className={cx(
        'grid gap-2.5',
        dense ? 'grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]' : 'grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, back, actions }: { title: ReactNode; subtitle?: ReactNode; back?: boolean | string; actions?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <header className="mb-5 flex items-start gap-2 pt-1">
      {back && (
        <IconButton
          icon={ChevronLeft}
          label="Zurück"
          className="-ml-2 mt-0.5"
          onClick={() => (typeof back === 'string' ? navigate(back) : window.history.length > 1 ? navigate(-1) : navigate('/'))}
        />
      )}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[26px] font-bold leading-tight tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 truncate text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}

// --- Small pieces ------------------------------------------------------------------------------

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-5 animate-spin text-muted', className)} aria-label="Lädt" />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-tile bg-surface', className)} aria-hidden />;
}

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', toneSoft[tone], className)}>{children}</span>;
}

export function EmptyState({ icon: Icon, title, text, action }: { icon: LucideIcon; title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-surface text-muted shadow-tile">
        <Icon className="size-6" aria-hidden />
      </div>
      <p className="text-base font-semibold">{title}</p>
      {text && <p className="mt-1 max-w-sm text-muted">{text}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** A row in a settings-style list. */
export function Row({
  icon: Icon,
  title,
  subtitle,
  trailing,
  onClick,
  tone = 'neutral',
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  tone?: Tone;
  className?: string;
}) {
  const content = (
    <>
      {Icon && (
        <span className={cx('flex size-9 shrink-0 items-center justify-center rounded-full', toneSoft[tone])}>
          <Icon className="size-4.5" aria-hidden />
        </span>
      )}
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate font-medium">{title}</span>
        {subtitle && <span className="block truncate text-sm text-muted">{subtitle}</span>}
      </span>
      {trailing && <span className="flex shrink-0 items-center gap-2 text-sm text-muted">{trailing}</span>}
    </>
  );
  const classes = cx('flex min-h-14 w-full items-center gap-3 px-4 py-2.5', className);
  return onClick ? (
    <button type="button" onClick={onClick} className={cx(classes, 'transition hover:bg-sunken/60 active:bg-sunken')}>
      {content}
    </button>
  ) : (
    <div className={classes}>{content}</div>
  );
}

/** Groups rows into one card with hairlines between them. */
export function RowGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <Card className={cx('divide-y divide-line overflow-hidden', className)}>{children}</Card>;
}

// --- Form controls ------------------------------------------------------------------------------

export function Toggle({ checked, onChange, label, disabled, tone = 'accent' }: { checked: boolean; onChange(next: boolean): void; label: string; disabled?: boolean; tone?: Tone }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        haptic();
        onChange(!checked);
      }}
      className={cx('relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50', checked ? '' : 'bg-faint/40')}
      style={checked ? { background: toneVar[tone] } : undefined}
    >
      <span className={cx('absolute left-0.5 top-0.5 size-6 rounded-full bg-white shadow transition-transform', checked && 'translate-x-5')} />
    </button>
  );
}

interface SliderProps {
  value: number;
  /** Fires continuously while dragging (update local UI). */
  onChange?(value: number): void;
  /** Fires once when the user lets go (send the command). */
  onCommit(value: number): void;
  min?: number;
  max?: number;
  step?: number;
  tone?: Tone;
  thin?: boolean;
  /** No track fill: the caller paints its own track behind the slider (e.g. a colour gradient). */
  bare?: boolean;
  label: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Touch-friendly slider. While the user drags, the local value wins over
 * updates from the hub, so the thumb never jumps under the finger.
 */
export function Slider({ value, onChange, onCommit, min = 0, max = 100, step = 1, tone = 'accent', thin, bare, label, disabled, className }: SliderProps) {
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? value;
  const fill = max > min ? ((shown - min) / (max - min)) * 100 : 0;
  const commit = () => {
    if (dragging === null) return;
    onCommit(dragging);
    // Keep showing the chosen value until the hub confirms (or a moment passes).
    window.setTimeout(() => setDragging(null), 1200);
  };
  return (
    <input
      type="range"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={shown}
      disabled={disabled}
      className={cx('hh-range', thin && 'is-thin', bare && 'is-bare', className)}
      style={{ '--fill': `${fill}%`, '--tone': toneVar[tone] } as React.CSSProperties}
      onChange={(event) => {
        const next = Number(event.target.value);
        setDragging(next);
        onChange?.(next);
      }}
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
      onClick={(event) => event.stopPropagation()}
    />
  );
}

export function Segmented<T extends string>({ options, value, onChange, className }: { options: { value: T; label: ReactNode }[]; value: T; onChange(value: T): void; className?: string }) {
  return (
    <div role="tablist" className={cx('inline-flex max-w-full gap-1 overflow-x-auto rounded-control bg-sunken p-1 no-scrollbar', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
          className={cx(
            'h-9 shrink-0 whitespace-nowrap rounded-[0.625rem] px-3.5 text-sm font-medium transition',
            option.value === value ? 'bg-raised text-fg shadow-tile' : 'text-muted hover:text-fg',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  const id = useId();
  const noteId = `${id}-note`;
  const hasNote = Boolean(error || hint);
  // The control gets the label as its name and the hint/error as its description
  // (not as part of the name — screen readers would read the whole hint as the field's title).
  const control = isValidElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>(children)
    ? cloneElement(children, {
        id: children.props.id ?? id,
        'aria-describedby': hasNote ? noteId : undefined,
        'aria-invalid': error ? true : undefined,
      })
    : children;
  const controlId = isValidElement<{ id?: string }>(children) ? (children.props.id ?? id) : undefined;
  return (
    <div>
      <label htmlFor={controlId} className="mb-1.5 block text-sm font-medium text-muted">
        {label}
      </label>
      {control}
      {hasNote && (
        <p id={noteId} className={cx('mt-1.5 text-sm', error ? 'text-danger' : 'text-faint')}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

const inputClass =
  'h-12 w-full rounded-control border border-line bg-sunken px-3.5 text-base outline-none transition placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:opacity-60';

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(inputClass, className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(inputClass, 'appearance-none pr-9', className)}>
      {children}
    </select>
  );
}

export function Notice({ tone = 'neutral', icon: Icon, children, className }: { tone?: Tone; icon?: LucideIcon; children: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-start gap-2.5 rounded-control px-3.5 py-3 text-sm', toneSoft[tone], className)} role={tone === 'danger' ? 'alert' : undefined}>
      {Icon && <Icon className="mt-0.5 size-4.5 shrink-0" aria-hidden />}
      <div className="min-w-0 flex-1 text-fg/90">{children}</div>
    </div>
  );
}

// --- Sheet (bottom sheet on phones, dialog on larger screens) ---------------------------------

interface SheetProps {
  open: boolean;
  onClose(): void;
  title?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Wider dialog on desktop (camera views, forms). */
  wide?: boolean;
  /** No padding around the content (media). */
  flush?: boolean;
}

let openSheets = 0;

export function Sheet({ open, onClose, title, subtitle, children, footer, wide, flush }: SheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    openSheets++;
    document.documentElement.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      if (--openSheets === 0) document.documentElement.style.overflow = '';
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6" role="presentation">
      <div className="absolute inset-0 animate-fade-in bg-black/60 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={cx(
          'relative flex max-h-[92dvh] w-full animate-sheet-up flex-col overflow-hidden rounded-t-[1.75rem] bg-surface shadow-float outline-none sm:rounded-[1.75rem]',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-md',
        )}
      >
        <div className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-line sm:hidden" aria-hidden />
        {(title || subtitle) && (
          <div className="flex shrink-0 items-start gap-3 px-5 pb-2 pt-4">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="truncate text-lg font-semibold">
                {title}
              </h2>
              {subtitle && <p className="truncate text-sm text-muted">{subtitle}</p>}
            </div>
            <IconButton icon={X} label="Schließen" size="sm" className="-mr-1.5" onClick={onClose} />
          </div>
        )}
        <div className={cx('scroll-area min-h-0 flex-1 overflow-y-auto', !flush && 'px-5 pb-5 pt-2', !footer && 'safe-bottom')}>{children}</div>
        {footer && <div className="safe-bottom shrink-0 border-t border-line px-5 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  text,
  confirmLabel = 'Bestätigen',
  danger,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  text?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm(): void | Promise<void>;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <div className="flex gap-2.5">
          <Button block onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            block
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      {text && <p className="text-muted">{text}</p>}
    </Sheet>
  );
}

// --- Slide to confirm (door opener) ---------------------------------------------------------------

/**
 * A deliberate gesture for actions that must not happen by accident:
 * the thumb has to be dragged all the way to the right.
 */
export function SlideToConfirm({ label, onConfirm, icon: Icon, disabled, busy }: { label: string; onConfirm(): void; icon: LucideIcon; disabled?: boolean; busy?: boolean }) {
  const track = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, max: 0 });
  const THUMB = 52;

  const end = useCallback(
    (confirmed: boolean) => {
      setDragging(false);
      setOffset(0);
      if (confirmed) {
        haptic('success');
        onConfirm();
      }
    },
    [onConfirm],
  );

  return (
    <div
      ref={track}
      className={cx('relative h-14 select-none overflow-hidden rounded-full bg-sunken', (disabled || busy) && 'opacity-60')}
      aria-disabled={disabled || busy}
    >
      <div className="absolute inset-y-0 left-0 rounded-full bg-ok/25" style={{ width: offset + THUMB + 4 }} aria-hidden />
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center pl-10 text-sm font-medium text-muted">
        {busy ? 'Wird geöffnet …' : label}
      </span>
      <button
        type="button"
        aria-label={label}
        disabled={disabled || busy}
        className={cx(
          'absolute left-1 top-1 flex size-12 touch-none items-center justify-center rounded-full bg-ok text-black shadow-lg outline-offset-4',
          !dragging && 'transition-transform duration-200',
        )}
        style={{ transform: `translateX(${offset}px)` }}
        onPointerDown={(event) => {
          if (disabled || busy) return;
          const width = track.current?.clientWidth ?? 0;
          start.current = { x: event.clientX, max: Math.max(0, width - THUMB - 4) };
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
          haptic();
        }}
        onPointerMove={(event) => {
          if (!dragging) return;
          setOffset(Math.min(start.current.max, Math.max(0, event.clientX - start.current.x)));
        }}
        onPointerUp={() => dragging && end(offset >= start.current.max * 0.92)}
        onPointerCancel={() => dragging && end(false)}
        onKeyDown={(event) => {
          // Keyboard users confirm with Enter twice within two seconds instead of dragging.
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          const now = Date.now();
          const armed = Number(event.currentTarget.dataset.armed ?? 0);
          if (now - armed < 2000) end(true);
          else event.currentTarget.dataset.armed = String(now);
        }}
      >
        {busy ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Icon className="size-5" aria-hidden />}
      </button>
    </div>
  );
}
