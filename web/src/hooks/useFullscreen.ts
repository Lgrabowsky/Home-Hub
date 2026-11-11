import { useCallback, useEffect, useState, type RefObject } from 'react';

/** Fullscreen for an element (the camera picture). Falls back gracefully where the API is missing (iPhone Safari). */
export function useFullscreen(target: RefObject<HTMLElement | null>): { active: boolean; supported: boolean; toggle(): void } {
  const [active, setActive] = useState(false);
  const supported = typeof document !== 'undefined' && Boolean(document.fullscreenEnabled);

  useEffect(() => {
    const onChange = () => setActive(document.fullscreenElement === target.current && target.current !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [target]);

  const toggle = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void target.current?.requestFullscreen?.().catch(() => {});
  }, [target]);

  return { active, supported, toggle };
}
