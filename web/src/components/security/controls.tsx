import {
  ArrowDown,
  ArrowDownLeft,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  Mic,
  MicOff,
  Minus,
  Move,
  Plus,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import type { PtzOp } from '@home-hub/shared';
import { useTalk } from '../../hooks/useTalk.ts';
import { post } from '../../lib/api.ts';
import { sendPtz } from '../../lib/realtime.ts';
import { cx, Spinner } from '../ui.tsx';

/**
 * Continuous camera movement with a dead-man switch: while a direction is held
 * the command is repeated every 400 ms; the hub stops the camera by itself when
 * the repeats stop arriving, so a lost "stop" can never leave it turning.
 */
export function usePtz(cameraId: string): { start(op: PtzOp): void; stop(): void } {
  const timer = useRef<number | null>(null);

  const send = useCallback(
    (op: PtzOp) => {
      // The realtime socket is the fast path; fall back to a request when it is down.
      if (!sendPtz(cameraId, op)) void post(`/api/cameras/${encodeURIComponent(cameraId)}/ptz`, { op }).catch(() => {});
    },
    [cameraId],
  );

  const stop = useCallback(() => {
    if (timer.current === null) return;
    window.clearInterval(timer.current);
    timer.current = null;
    send('stop');
  }, [send]);

  const start = useCallback(
    (op: PtzOp) => {
      if (timer.current !== null) window.clearInterval(timer.current);
      send(op);
      timer.current = window.setInterval(() => send(op), 400);
    },
    [send],
  );

  useEffect(() => stop, [stop]);
  return { start, stop };
}

function HoldButton({ icon: Icon, label, onStart, onStop, className }: { icon: LucideIcon; label: string; onStart(): void; onStop(): void; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx('flex touch-none select-none items-center justify-center rounded-full text-fg transition active:scale-90 active:bg-accent/25 active:text-accent', className)}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        onStart();
      }}
      onPointerUp={onStop}
      onPointerCancel={onStop}
      onLostPointerCapture={onStop}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) onStart();
      }}
      onKeyUp={(event) => {
        if (event.key === ' ' || event.key === 'Enter') onStop();
      }}
      onBlur={onStop}
    >
      <Icon className="size-5" aria-hidden />
    </button>
  );
}

const DIRECTIONS: { op: PtzOp; icon: LucideIcon; label: string; cell: string }[] = [
  { op: 'left_up', icon: ArrowUpLeft, label: 'Nach links oben', cell: 'col-start-1 row-start-1' },
  { op: 'up', icon: ArrowUp, label: 'Nach oben', cell: 'col-start-2 row-start-1' },
  { op: 'right_up', icon: ArrowUpRight, label: 'Nach rechts oben', cell: 'col-start-3 row-start-1' },
  { op: 'left', icon: ArrowLeft, label: 'Nach links', cell: 'col-start-1 row-start-2' },
  { op: 'right', icon: ArrowRight, label: 'Nach rechts', cell: 'col-start-3 row-start-2' },
  { op: 'left_down', icon: ArrowDownLeft, label: 'Nach links unten', cell: 'col-start-1 row-start-3' },
  { op: 'down', icon: ArrowDown, label: 'Nach unten', cell: 'col-start-2 row-start-3' },
  { op: 'right_down', icon: ArrowDownRight, label: 'Nach rechts unten', cell: 'col-start-3 row-start-3' },
];

const ARROW_KEYS: Record<string, PtzOp> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

/** Round pad to pan/tilt (hold a direction) and, optionally, zoom. */
export function PtzPad({ cameraId, pan, zoom, overlay }: { cameraId: string; pan: boolean; zoom: boolean; overlay?: boolean }) {
  const { start, stop } = usePtz(cameraId);
  return (
    <div className="flex items-center gap-4">
      {pan && (
        <div
          role="group"
          aria-label="Kamera schwenken (gedrückt halten)"
          tabIndex={0}
          className={cx('grid size-44 shrink-0 grid-cols-3 grid-rows-3 rounded-full p-1.5 outline-offset-4', overlay ? 'bg-black/45 text-white backdrop-blur' : 'bg-sunken')}
          onKeyDown={(event) => {
            const op = ARROW_KEYS[event.key];
            if (op && !event.repeat) {
              event.preventDefault();
              start(op);
            }
          }}
          onKeyUp={(event) => {
            if (ARROW_KEYS[event.key]) stop();
          }}
          onBlur={stop}
        >
          {DIRECTIONS.map((direction) => (
            <HoldButton key={direction.op} icon={direction.icon} label={direction.label} className={direction.cell} onStart={() => start(direction.op)} onStop={stop} />
          ))}
          <span className="col-start-2 row-start-2 flex items-center justify-center text-faint" aria-hidden>
            <Move className="size-5" />
          </span>
        </div>
      )}
      {zoom && (
        <div role="group" aria-label="Zoom" className={cx('flex flex-col gap-2 rounded-full p-1.5', overlay ? 'bg-black/45 text-white backdrop-blur' : 'bg-sunken')}>
          <HoldButton icon={Plus} label="Hineinzoomen" className="size-12" onStart={() => start('zoom_in')} onStop={stop} />
          <HoldButton icon={Minus} label="Herauszoomen" className="size-12" onStart={() => start('zoom_out')} onStop={stop} />
        </div>
      )}
    </div>
  );
}

/**
 * Talk to a camera or door station. Hold to talk; a short tap latches it
 * (tap again to stop). `onTalking` lets the page mute the device's sound
 * meanwhile, which avoids echo.
 */
export function TalkButton({ entityId, onTalking, large }: { entityId: string; onTalking?(talking: boolean): void; large?: boolean }) {
  const talk = useTalk(entityId);
  const downAt = useRef(0);
  const startedByThisPress = useRef(false);
  const notify = useRef(onTalking);
  notify.current = onTalking;

  useEffect(() => {
    notify.current?.(talk.state !== 'idle');
  }, [talk.state]);

  const live = talk.state === 'live';
  const busy = talk.state === 'connecting';
  const label = live ? 'Du sprichst – tippen zum Beenden' : busy ? 'Verbindung wird aufgebaut …' : 'Sprechen (halten oder tippen)';

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={talk.state !== 'idle'}
      title={label}
      className={cx(
        'flex shrink-0 touch-none select-none flex-col items-center justify-center gap-1 rounded-full font-medium transition active:scale-95',
        large ? 'size-24 text-sm' : 'size-16 text-xs',
        live ? 'animate-ring bg-accent text-accent-fg' : busy ? 'bg-accent/25 text-accent' : 'bg-raised text-fg shadow-tile hover:bg-sunken',
      )}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        downAt.current = Date.now();
        startedByThisPress.current = talk.state === 'idle';
        if (talk.state === 'idle') talk.start();
        else talk.stop();
      }}
      onPointerUp={() => {
        // Held longer than a tap: push-to-talk, so releasing ends it.
        if (startedByThisPress.current && Date.now() - downAt.current > 450) talk.stop();
        startedByThisPress.current = false;
      }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
          event.preventDefault();
          talk.toggle();
        }
      }}
    >
      {busy ? <Spinner className="size-6 text-accent" /> : live ? <Mic className={large ? 'size-8' : 'size-6'} aria-hidden /> : <MicOff className={large ? 'size-8' : 'size-6'} aria-hidden />}
      {large && <span>{live ? 'Du sprichst' : busy ? 'Verbinde …' : 'Sprechen'}</span>}
    </button>
  );
}
