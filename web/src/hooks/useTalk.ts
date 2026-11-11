import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '../components/toast.tsx';
import { TalkError, TalkSession, type TalkState } from '../lib/live.ts';
import { haptic } from '../lib/platform.ts';

/** Nobody means to leave a microphone open: talking ends by itself after this long. */
const MAX_TALK_MS = 3 * 60_000;

/**
 * Push-to-talk / tap-to-talk for a camera or door station.
 * `state` is `idle`, `connecting` or `live`; the microphone is released as
 * soon as talking stops or the component goes away.
 */
export function useTalk(entityId: string): { state: TalkState; start(): void; stop(): void; toggle(): void } {
  const [state, setState] = useState<TalkState>('idle');
  const session = useRef<TalkSession | null>(null);
  const timer = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    const current = session.current;
    session.current = null;
    current?.stop();
    setState('idle');
  }, []);

  const start = useCallback(() => {
    if (session.current) return;
    const next = new TalkSession(entityId, (value) => {
      if (session.current === next) setState(value);
    });
    session.current = next;
    haptic('medium');
    next.start().then(
      () => {
        if (session.current !== next) return;
        timer.current = window.setTimeout(() => {
          toast.info('Das Mikrofon wurde nach 3 Minuten automatisch ausgeschaltet.');
          stop();
        }, MAX_TALK_MS);
      },
      (err: unknown) => {
        if (session.current === next) {
          session.current = null;
          setState('idle');
        }
        toast.error(err instanceof TalkError ? err.message : 'Die Sprechverbindung kam nicht zustande.');
      },
    );
  }, [entityId, stop]);

  const toggle = useCallback(() => (session.current ? stop() : start()), [start, stop]);

  // Release the microphone when leaving the screen or switching devices.
  useEffect(() => stop, [entityId, stop]);

  return { state, start, stop, toggle };
}
