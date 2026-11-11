import { RefreshCw, VideoOff } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { StreamQuality } from '@home-hub/shared';
import { LiveStream, type LiveStatus } from '../lib/live.ts';
import { HubImage } from './HubImage.tsx';
import { Button, cx, Spinner } from './ui.tsx';

interface LiveViewProps {
  /** `cam:<id>` or `door:<id>`. */
  entityId: string;
  quality?: StreamQuality;
  /** Hub path of a still picture shown until the video plays (and when it cannot). */
  poster?: string | null;
  /** Sound from the device. Starts muted; browsers only allow sound after the user tapped something. */
  muted?: boolean;
  /** `cover` fills the frame (tiles), `contain` shows the whole picture (detail view). */
  fit?: 'cover' | 'contain';
  className?: string;
  alt: string;
  onStatus?(status: LiveStatus): void;
  /** Controls drawn on top of the picture. */
  children?: ReactNode;
}

const IDLE: LiveStatus = { phase: 'idle', mode: null, message: null, quality: 'main', hasAudio: false };

/**
 * Live picture of a camera or door station. Shows the latest snapshot at once,
 * replaces it with moving video as soon as the stream is up, and recovers on
 * its own when the connection drops.
 */
export function LiveView({ entityId, quality = 'main', poster, muted = true, fit = 'contain', className, alt, onStatus, children }: LiveViewProps) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<LiveStream | null>(null);
  const notify = useRef(onStatus);
  notify.current = onStatus;
  const [status, setStatus] = useState<LiveStatus>(IDLE);
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const live = new LiveStream(element, {
      entityId,
      quality,
      onStatus: (next) => {
        setStatus(next);
        notify.current?.(next);
      },
    });
    stream.current = live;
    live.start();
    return () => {
      stream.current = null;
      live.stop();
    };
  }, [entityId, quality, attempt]);

  useEffect(() => {
    if (video.current) video.current.muted = muted;
  }, [muted, status.phase]);

  // Only mention "connecting" when it takes noticeably long.
  useEffect(() => {
    setSlow(false);
    if (status.phase !== 'connecting') return;
    const timer = window.setTimeout(() => setSlow(true), 2500);
    return () => window.clearTimeout(timer);
  }, [status.phase]);

  const playing = status.phase === 'playing';
  return (
    <div className={cx('relative overflow-hidden bg-black', className)}>
      {poster !== undefined && (
        <HubImage
          src={poster}
          alt={alt}
          refreshMs={playing ? undefined : 5000}
          className={cx('absolute inset-0 size-full', fit === 'cover' ? 'object-cover' : 'object-contain')}
          fallback={<VideoOff className="size-8" aria-hidden />}
        />
      )}
      <video
        ref={video}
        autoPlay
        playsInline
        muted
        disablePictureInPicture
        aria-label={alt}
        className={cx('absolute inset-0 size-full transition-opacity duration-300', fit === 'cover' ? 'object-cover' : 'object-contain', playing ? 'opacity-100' : 'opacity-0')}
      />

      {status.phase === 'connecting' && slow && (
        <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white backdrop-blur" role="status">
          <Spinner className="size-3.5 text-white" />
          Live-Bild wird geladen …
        </div>
      )}
      {playing && (
        <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-white backdrop-blur">
          <span className="size-1.5 animate-pulse rounded-full bg-danger" aria-hidden />
          Live
        </div>
      )}
      {status.phase === 'failed' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/65 p-5 text-center text-white backdrop-blur-sm" role="alert">
          <VideoOff className="size-7 opacity-80" aria-hidden />
          <p className="max-w-xs text-sm">{status.message ?? 'Das Live-Bild ist gerade nicht verfügbar.'}</p>
          <Button size="sm" icon={RefreshCw} onClick={() => setAttempt((value) => value + 1)}>
            Erneut versuchen
          </Button>
        </div>
      )}
      {children}
    </div>
  );
}
