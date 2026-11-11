import { ImageOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { apiBaseUrl, getBlob, imagesNeedFetch } from '../lib/api.ts';
import { cx } from './ui.tsx';

interface HubImageProps {
  /** Hub-relative path, e.g. `/api/cameras/garten/snapshot` or a signed `/api/img?…` URL. Null shows the fallback. */
  src: string | null | undefined;
  alt: string;
  className?: string;
  /** Reload this often (ms) — for camera snapshots. The previous picture stays visible while the next one loads. */
  refreshMs?: number;
  /** Shown when there is no picture. */
  fallback?: React.ReactNode;
  /** Bump to force a reload now. */
  version?: number;
  onLoad?(): void;
}

/**
 * A picture served by the hub.
 *
 * In the browser the session cookie authenticates a plain <img>. The Android
 * app talks to the hub with a bearer token instead, so there the picture is
 * fetched and shown from memory (never written to disk).
 */
export function HubImage({ src, alt, className, refreshMs, fallback, version = 0, onLoad }: HubImageProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const element = useRef<HTMLImageElement>(null);

  // Periodic refresh, paused while the tab is hidden or the picture is off-screen.
  useEffect(() => {
    if (!refreshMs || !src) return;
    let visible = true;
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });
    if (element.current) observer.observe(element.current);
    const timer = window.setInterval(() => {
      if (visible && document.visibilityState === 'visible') setTick((value) => value + 1);
    }, refreshMs);
    return () => {
      window.clearInterval(timer);
      observer.disconnect();
    };
  }, [refreshMs, src]);

  useEffect(() => {
    if (!src) {
      setUrl(null);
      return;
    }
    const cacheBust = refreshMs || version ? `${src.includes('?') ? '&' : '?'}t=${tick}.${version}` : '';
    if (!imagesNeedFetch) {
      // Preload so the visible picture is swapped only when the new one is complete (no flicker).
      const image = new Image();
      const next = apiBaseUrl() + src + cacheBust;
      image.onload = () => {
        setUrl(next);
        setFailed(false);
      };
      image.onerror = () => setFailed(true);
      image.src = next;
      return () => {
        image.onload = null;
        image.onerror = null;
      };
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    getBlob(src + cacheBust, { signal: controller.signal })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setUrl((previous) => {
          if (previous?.startsWith('blob:')) window.setTimeout(() => URL.revokeObjectURL(previous), 1000);
          return objectUrl;
        });
        setFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [src, tick, version, refreshMs]);

  useEffect(
    () => () => {
      setUrl((previous) => {
        if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous);
        return null;
      });
    },
    [],
  );

  if (!url) {
    return (
      <div ref={element as unknown as React.RefObject<HTMLDivElement>} className={cx('flex items-center justify-center bg-sunken text-faint', className)} role="img" aria-label={alt}>
        {failed || !src ? (fallback ?? <ImageOff className="size-6" aria-hidden />) : <span className="size-full animate-pulse bg-surface" />}
      </div>
    );
  }
  return <img ref={element} src={url} alt={alt} className={cx('object-cover', className)} draggable={false} onLoad={onLoad} />;
}
