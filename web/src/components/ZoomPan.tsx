import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from './ui.tsx';

/** How far the picture can be enlarged. */
export const MAX_ZOOM = 6;
const DOUBLE_TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 300;

export interface ZoomView {
  scale: number;
  /** Shift of the picture's centre, in pixels. */
  x: number;
  y: number;
}

export const NO_ZOOM: ZoomView = { scale: 1, x: 0, y: 0 };

/** Keeps the enlarged picture covering the frame: it cannot be dragged out of view. */
export function clampView(view: ZoomView, width: number, height: number): ZoomView {
  const scale = Math.min(MAX_ZOOM, Math.max(1, view.scale));
  const maxX = (width * (scale - 1)) / 2;
  const maxY = (height * (scale - 1)) / 2;
  return { scale, x: Math.min(maxX, Math.max(-maxX, view.x)), y: Math.min(maxY, Math.max(-maxY, view.y)) };
}

/**
 * Zooms `view` to `scale` around a point given relative to the frame's centre, so the spot under
 * the fingers (or the mouse) stays where it is.
 */
export function zoomAround(view: ZoomView, scale: number, point: { x: number; y: number }): ZoomView {
  const factor = scale / view.scale;
  return { scale, x: point.x - (point.x - view.x) * factor, y: point.y - (point.y - view.y) * factor };
}

/**
 * Digital zoom for a picture: two fingers to zoom, one finger (or the mouse) to move the enlarged
 * picture, a double tap or double click to zoom in and out again, and the mouse wheel on desktops.
 * At normal size the page scrolls as usual.
 */
export function ZoomPan({ view, onView, enabled = true, className, children }: { view: ZoomView; onView(view: ZoomView): void; enabled?: boolean; className?: string; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ start: ZoomView; distance: number; mid: { x: number; y: number } } | null>(null);
  const pan = useRef<{ start: ZoomView; from: { x: number; y: number } } | null>(null);
  const tap = useRef<{ at: number; x: number; y: number; moved: boolean; started: number } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const relative = useCallback((clientX: number, clientY: number) => {
    const rect = frame.current!.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  }, []);
  const set = useCallback(
    (next: ZoomView) => {
      const element = frame.current;
      if (!element) return;
      const clamped = clampView(next, element.clientWidth, element.clientHeight);
      onView(clamped.scale <= 1.01 ? NO_ZOOM : clamped);
    },
    [onView],
  );

  // Mouse wheel: a listener that may prevent the page from scrolling (React's is passive).
  useEffect(() => {
    const element = frame.current;
    if (!element || !enabled) return;
    const onWheel = (event: WheelEvent) => {
      const current = viewRef.current;
      // Scrolling down at normal size scrolls the page.
      if (current.scale <= 1 && event.deltaY > 0) return;
      event.preventDefault();
      const scale = Math.min(MAX_ZOOM, Math.max(1, current.scale * Math.exp(-event.deltaY * 0.0018)));
      set(zoomAround(current, scale, relative(event.clientX, event.clientY)));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [enabled, relative, set]);

  const distance = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const middle = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? relative((a.x + b.x) / 2, (a.y + b.y) / 2) : { x: 0, y: 0 };
  };

  return (
    <div
      ref={frame}
      className={cx('absolute inset-0 overflow-hidden', className)}
      // At normal size the page may scroll vertically; once enlarged every gesture belongs to the picture.
      style={{ touchAction: !enabled ? 'auto' : view.scale > 1 ? 'none' : 'pan-y' }}
      onPointerDown={(event) => {
        if (!enabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // not capturable (synthetic event)
        }
        if (pointers.current.size === 2) {
          pan.current = null;
          tap.current = null;
          gesture.current = { start: viewRef.current, distance: distance(), mid: middle() };
        } else if (pointers.current.size === 1) {
          pan.current = viewRef.current.scale > 1 ? { start: viewRef.current, from: { x: event.clientX, y: event.clientY } } : null;
          const previous = tap.current;
          tap.current = { at: previous?.at ?? 0, x: event.clientX, y: event.clientY, moved: false, started: Date.now() };
        }
      }}
      onPointerMove={(event) => {
        if (!pointers.current.has(event.pointerId)) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (tap.current && Math.hypot(event.clientX - tap.current.x, event.clientY - tap.current.y) > 10) tap.current.moved = true;
        const pinch = gesture.current;
        if (pinch && pointers.current.size >= 2 && pinch.distance > 0) {
          const scale = Math.min(MAX_ZOOM, Math.max(1, pinch.start.scale * (distance() / pinch.distance)));
          const mid = middle();
          const zoomed = zoomAround(pinch.start, scale, pinch.mid);
          set({ scale, x: zoomed.x + (mid.x - pinch.mid.x), y: zoomed.y + (mid.y - pinch.mid.y) });
        } else if (pan.current) {
          set({ ...pan.current.start, x: pan.current.start.x + (event.clientX - pan.current.from.x), y: pan.current.start.y + (event.clientY - pan.current.from.y) });
        }
      }}
      onPointerUp={(event) => {
        if (!pointers.current.delete(event.pointerId)) return;
        if (pointers.current.size < 2) gesture.current = null;
        if (pointers.current.size === 0) {
          pan.current = null;
          const current = tap.current;
          // A short tap without moving: two of them in a row toggle the zoom at that spot.
          if (current && !current.moved && Date.now() - current.started < 250) {
            if (Date.now() - current.at < DOUBLE_TAP_MS) {
              const view = viewRef.current;
              set(view.scale > 1 ? NO_ZOOM : zoomAround(view, DOUBLE_TAP_ZOOM, relative(event.clientX, event.clientY)));
              tap.current = null;
            } else {
              tap.current = { ...current, at: Date.now() };
            }
          } else {
            tap.current = null;
          }
        }
      }}
      onPointerCancel={(event) => {
        pointers.current.delete(event.pointerId);
        if (pointers.current.size < 2) gesture.current = null;
        if (pointers.current.size === 0) pan.current = null;
        tap.current = null;
      }}
    >
      <div className="absolute inset-0 origin-center will-change-transform" style={view.scale > 1 ? { transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` } : undefined}>
        {children}
      </div>
    </div>
  );
}

/** "2,5×" */
export function zoomLabel(scale: number): string {
  return `${scale.toLocaleString('de-DE', { maximumFractionDigits: 1 })}×`;
}

/** Zoom state that starts over when the picture changes. */
export function useZoom(reset: unknown): [ZoomView, (view: ZoomView) => void] {
  const [view, setView] = useState<ZoomView>(NO_ZOOM);
  useEffect(() => setView(NO_ZOOM), [reset]);
  return [view, setView];
}
