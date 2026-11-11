import { BellRing, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { DoorEntity } from '@home-hub/shared';
import { haptic } from '../lib/platform.ts';
import { OpenDoorSlider } from '../pages/security/DoorPage.tsx';
import { useHub } from '../store/hub.ts';
import { useCan } from '../store/session.ts';
import { LiveView } from './LiveView.tsx';
import { TalkButton } from './security/controls.tsx';
import { Button } from './ui.tsx';

const DISMISS_AFTER_MS = 60_000;

/** A short two-tone chime, synthesised — no audio file, and silent if the browser does not allow sound yet. */
function chime(): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const context = new Ctor();
    const now = context.currentTime;
    for (const [index, frequency] of [659.25, 523.25].entries()) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      const start = now + index * 0.45;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 1.1);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 1.2);
    }
    window.setTimeout(() => void context.close().catch(() => {}), 2500);
  } catch {
    /* sound is a bonus */
  }
}

/**
 * "Es klingelt": appears on whatever screen the user is on, shows who is at
 * the door and offers the two things one wants then — talk and open.
 */
export function DoorbellOverlay() {
  const ring = useHub((state) => state.ring);
  const door = useHub((state) => (ring ? (state.entities[`door:${ring.doorId}`] as DoorEntity | undefined) : undefined));
  const canView = useCan('doors.view');
  const canOpen = useCan('doors.open');
  const { pathname } = useLocation();
  const [talking, setTalking] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const dismiss = () => useHub.getState().setRing(null);

  const active = Boolean(ring && canView && pathname !== `/sicherheit/tuer/${ring.doorId}`);

  useEffect(() => {
    if (!ring) return;
    if (!canView) {
      dismiss();
      return;
    }
    if (!active) return;
    chime();
    haptic('warning');
    panel.current?.focus();
    // Every new ring (new timestamp) restarts the countdown.
    const timer = window.setTimeout(dismiss, DISMISS_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [ring, canView, active]);

  if (!ring || !active) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/80 backdrop-blur-sm sm:items-center sm:p-6" role="presentation">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={`Es klingelt: ${ring.doorName}`}
        tabIndex={-1}
        className="safe-bottom flex max-h-dvh w-full animate-sheet-up flex-col overflow-y-auto rounded-t-[1.75rem] bg-surface shadow-float outline-none sm:max-w-xl sm:rounded-[1.75rem]"
        onKeyDown={(event) => {
          if (event.key === 'Escape') dismiss();
        }}
      >
        <div className="flex items-center gap-3 px-5 pb-3 pt-5">
          <span className="flex size-11 shrink-0 animate-ring items-center justify-center rounded-full bg-accent text-accent-fg">
            <BellRing className="size-5.5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted">Es klingelt</p>
            <h2 className="truncate text-xl font-bold">{ring.doorName}</h2>
          </div>
          <Button variant="ghost" icon={X} onClick={dismiss}>
            Schließen
          </Button>
        </div>

        <LiveView
          entityId={`door:${ring.doorId}`}
          alt={`Live-Bild ${ring.doorName}`}
          poster={`/api/doors/${encodeURIComponent(ring.doorId)}/snapshot`}
          muted={talking}
          className="aspect-video w-full"
        />

        <div className="flex items-center gap-4 p-5">
          {door?.features.talk !== false && <TalkButton entityId={`door:${ring.doorId}`} onTalking={setTalking} />}
          <div className="min-w-0 flex-1 space-y-2.5">
            {door && canOpen ? (
              door.relays.map((relay) => (
                <OpenDoorSlider key={relay.id} door={door} relayId={relay.id} relayName={relay.name} onOpened={() => window.setTimeout(dismiss, 1500)} />
              ))
            ) : (
              <p className="text-sm text-muted">Halte die Sprechtaste, um zu antworten.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
