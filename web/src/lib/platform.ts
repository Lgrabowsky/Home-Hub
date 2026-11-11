import { Capacitor } from '@capacitor/core';

/**
 * Differences between running in a browser (served by the hub, same origin)
 * and inside the packaged Android app (Capacitor: app files are local, the
 * hub is a remote server).
 */

export const isNative = Capacitor.isNativePlatform();

/**
 * Small key/value store for things that must survive restarts.
 * In the app: Android Keystore-backed secure storage (session token, hub address).
 * In the browser: localStorage — only harmless preferences are kept there; the
 * session lives in an HttpOnly cookie that scripts cannot read.
 */
export const deviceStore = {
  async get(key: string): Promise<string | null> {
    try {
      if (isNative) {
        const { SecureStorage } = await import('@aparajita/capacitor-secure-storage');
        return await SecureStorage.getItem(key);
      }
      return localStorage.getItem(`hh.${key}`);
    } catch {
      return null;
    }
  },

  async set(key: string, value: string): Promise<void> {
    try {
      if (isNative) {
        const { SecureStorage } = await import('@aparajita/capacitor-secure-storage');
        await SecureStorage.setItem(key, value);
      } else {
        localStorage.setItem(`hh.${key}`, value);
      }
    } catch {
      /* storage unavailable (private mode): the value simply does not persist */
    }
  },

  async remove(key: string): Promise<void> {
    try {
      if (isNative) {
        const { SecureStorage } = await import('@aparajita/capacitor-secure-storage');
        await SecureStorage.removeItem(key);
      } else {
        localStorage.removeItem(`hh.${key}`);
      }
    } catch {
      /* nothing to remove */
    }
  },
};

/** A short, human readable name for this device, shown in the list of signed-in devices. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua)
      ? 'iOS'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /Mac OS X/i.test(ua)
          ? 'macOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : 'Gerät';
  if (isNative) return `Home Hub App (${os})`;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${browser} (${os})`;
}

/** Light tactile feedback in the app; a no-op in browsers. */
export function haptic(kind: 'light' | 'medium' | 'success' | 'warning' = 'light'): void {
  if (!isNative) return;
  void import('@capacitor/haptics').then(({ Haptics, ImpactStyle, NotificationType }) => {
    if (kind === 'success') return Haptics.notification({ type: NotificationType.Success });
    if (kind === 'warning') return Haptics.notification({ type: NotificationType.Warning });
    return Haptics.impact({ style: kind === 'medium' ? ImpactStyle.Medium : ImpactStyle.Light });
  }).catch(() => {});
}

/** Calls `handler` whenever the app/tab comes back to the foreground. Returns an unsubscribe function. */
export function onResume(handler: () => void): () => void {
  const onVisible = () => {
    if (document.visibilityState === 'visible') handler();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', handler);
  window.addEventListener('pageshow', handler);
  let removeNative: (() => void) | null = null;
  if (isNative) {
    void import('@capacitor/app').then(({ App }) =>
      App.addListener('appStateChange', (state) => {
        if (state.isActive) handler();
      }).then((handle) => {
        removeNative = () => void handle.remove();
      }),
    );
  }
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', handler);
    window.removeEventListener('pageshow', handler);
    removeNative?.();
  };
}
