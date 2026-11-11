import { create } from 'zustand';
import {
  API_VERSION,
  DEFAULT_PREFS,
  hasPermission,
  type BootstrapInfo,
  type LoginResponse,
  type MeResponse,
  type Permission,
  type SessionInfo,
  type TotpEnableResponse,
  type UserInfo,
  type UserPrefs,
} from '@home-hub/shared';
import { ApiError, configureApi, get, post, put } from '../lib/api.ts';
import { HubUrlError, normaliseHubUrl } from '../lib/hubUrl.ts';
import { deviceName, deviceStore, isNative, onResume } from '../lib/platform.ts';
import { startRealtime, stopRealtime } from '../lib/realtime.ts';
import { useHub } from './hub.ts';

/**
 * Where the app is in its life cycle:
 *
 *   loading      finding out
 *   connect      (app only) no hub address stored yet
 *   unreachable  the hub does not answer
 *   outdated     hub and app speak different API versions
 *   setup        fresh hub: create the first administrator
 *   login        sign in
 *   enroll       signed in, but two-factor set-up is still required
 *   locked       (app only) waiting for fingerprint / face
 *   ready        everything works
 */
export type Phase = 'loading' | 'connect' | 'unreachable' | 'outdated' | 'setup' | 'login' | 'enroll' | 'locked' | 'ready';

interface Credentials {
  username: string;
  password: string;
  code?: string;
}

interface SessionStore {
  phase: Phase;
  hubUrl: string;
  bootstrap: BootstrapInfo | null;
  user: UserInfo | null;
  session: SessionInfo | null;
  prefs: UserPrefs;
  /** App lock with biometrics is switched on (app only). */
  lockEnabled: boolean;

  init(): Promise<void>;
  /** (App) stores the hub address after checking that a hub answers there. */
  connectHub(url: string): Promise<void>;
  /** (App) forgets the hub and the session on this device. */
  forgetHub(): Promise<void>;
  setup(input: Credentials & { setupCode: string; displayName?: string }): Promise<void>;
  /** Resolves with `totp_required` when a code is needed next. */
  login(input: Credentials): Promise<'ok' | 'totp_required'>;
  finishEnrollment(result: TotpEnableResponse): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
  savePrefs(partial: Partial<UserPrefs>): Promise<void>;
  setLockEnabled(enabled: boolean): Promise<void>;
  unlock(): Promise<boolean>;
  can(permission: Permission): boolean;
}

const BACKGROUND_LOCK_MS = 60_000;
let hiddenAt = 0;
let resumeHooked = false;

function normaliseHubUrlOrThrow(input: string): string {
  try {
    return normaliseHubUrl(input).origin;
  } catch (err) {
    if (err instanceof HubUrlError) throw new ApiError(0, 'invalid', err.message);
    throw err;
  }
}

export const useSession = create<SessionStore>((set, getState) => {
  /** Called by the API layer / realtime client when the hub says the session is gone. */
  const signedOut = () => {
    if (!['ready', 'locked', 'enroll'].includes(getState().phase)) return;
    stopRealtime();
    useHub.getState().reset();
    if (isNative) {
      configureApi({ token: null });
      void deviceStore.remove('token');
    }
    set({ phase: 'login', user: null, session: null, prefs: DEFAULT_PREFS });
  };

  const adoptToken = async (token: string | undefined) => {
    if (!isNative || !token) return;
    configureApi({ token });
    await deviceStore.set('token', token);
  };

  const enterApp = async (me: MeResponse) => {
    set({ user: me.user, session: me.session, prefs: me.prefs });
    if (me.enrollRequired) {
      set({ phase: 'enroll' });
      return;
    }
    if (isNative && getState().lockEnabled && getState().phase !== 'ready') {
      set({ phase: 'locked' });
      return;
    }
    set({ phase: 'ready' });
    startRealtime({ onSessionEnded: signedOut });
  };

  const hookResume = () => {
    if (resumeHooked) return;
    resumeHooked = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    });
    onResume(() => {
      const state = getState();
      if (state.phase === 'unreachable') void state.init();
      if (isNative && state.lockEnabled && state.phase === 'ready' && hiddenAt && Date.now() - hiddenAt > BACKGROUND_LOCK_MS) {
        stopRealtime();
        set({ phase: 'locked' });
      }
      hiddenAt = 0;
    });
  };

  return {
    phase: 'loading',
    hubUrl: '',
    bootstrap: null,
    user: null,
    session: null,
    prefs: DEFAULT_PREFS,
    lockEnabled: false,

    async init() {
      hookResume();
      configureApi({ onUnauthorized: signedOut });
      if (isNative) {
        const [hubUrl, token, lock] = await Promise.all([deviceStore.get('hubUrl'), deviceStore.get('token'), deviceStore.get('lock')]);
        set({ lockEnabled: lock === '1' });
        if (!hubUrl) {
          set({ phase: 'connect' });
          return;
        }
        configureApi({ baseUrl: hubUrl, token });
        set({ hubUrl });
      }

      let bootstrap: BootstrapInfo;
      try {
        bootstrap = await get<BootstrapInfo>('/api/bootstrap', { timeoutMs: 8000, quiet401: true });
      } catch {
        set({ phase: 'unreachable' });
        return;
      }
      set({ bootstrap });
      if (bootstrap.apiVersion !== API_VERSION) {
        set({ phase: 'outdated' });
        return;
      }
      if (bootstrap.setupRequired) {
        set({ phase: 'setup' });
        return;
      }
      if (bootstrap.session === 'none') {
        set({ phase: 'login' });
        return;
      }
      try {
        await enterApp(await get<MeResponse>('/api/auth/me', { quiet401: true }));
      } catch (err) {
        set({ phase: err instanceof ApiError && err.isNetwork ? 'unreachable' : 'login' });
      }
    },

    async connectHub(input) {
      const hubUrl = normaliseHubUrlOrThrow(input);
      configureApi({ baseUrl: hubUrl, token: null });
      let bootstrap: BootstrapInfo;
      try {
        bootstrap = await get<BootstrapInfo>('/api/bootstrap', { timeoutMs: 8000, quiet401: true });
      } catch {
        throw new ApiError(0, 'network', 'Unter dieser Adresse antwortet kein Home Hub. Stimmt die Adresse und bist du online?');
      }
      if (typeof bootstrap?.apiVersion !== 'number') {
        throw new ApiError(0, 'invalid', 'Unter dieser Adresse antwortet kein Home Hub.');
      }
      await deviceStore.set('hubUrl', hubUrl);
      set({ hubUrl });
      await getState().init();
    },

    async forgetHub() {
      stopRealtime();
      useHub.getState().reset();
      await Promise.all([deviceStore.remove('hubUrl'), deviceStore.remove('token')]);
      configureApi({ baseUrl: '', token: null });
      set({ phase: 'connect', hubUrl: '', user: null, session: null, bootstrap: null });
    },

    async setup(input) {
      const response = await post<LoginResponse>(
        '/api/setup',
        { ...input, client: isNative ? 'native' : 'web', deviceName: deviceName() },
        { quiet401: true },
      );
      if (response.status === 'totp_required') return;
      await adoptToken(response.token);
      await enterApp(await get<MeResponse>('/api/auth/me'));
    },

    async login(input) {
      const response = await post<LoginResponse>(
        '/api/auth/login',
        { ...input, code: input.code || undefined, client: isNative ? 'native' : 'web', deviceName: deviceName() },
        { quiet401: true },
      );
      if (response.status === 'totp_required') return 'totp_required';
      await adoptToken(response.token);
      // Signing in just proved who is holding the device: no extra biometric prompt now.
      set({ phase: 'login' });
      const me = await get<MeResponse>('/api/auth/me');
      set({ user: me.user, session: me.session, prefs: me.prefs });
      if (me.enrollRequired) {
        set({ phase: 'enroll' });
      } else {
        set({ phase: 'ready' });
        startRealtime({ onSessionEnded: signedOut });
      }
      return 'ok';
    },

    async finishEnrollment(result) {
      // The hub replaced the temporary enrolment session by a full one.
      await adoptToken(result.token);
      const me = await get<MeResponse>('/api/auth/me');
      set({ user: me.user, session: me.session, prefs: me.prefs, phase: 'ready' });
      startRealtime({ onSessionEnded: signedOut });
    },

    async logout() {
      stopRealtime();
      try {
        await post('/api/auth/logout', {}, { quiet401: true });
      } catch {
        /* the session is discarded locally either way */
      }
      useHub.getState().reset();
      if (isNative) {
        configureApi({ token: null });
        await deviceStore.remove('token');
      }
      set({ phase: 'login', user: null, session: null, prefs: DEFAULT_PREFS });
    },

    async refresh() {
      const me = await get<MeResponse>('/api/auth/me');
      set({ user: me.user, session: me.session, prefs: me.prefs });
    },

    async savePrefs(partial) {
      const next = { ...getState().prefs, ...partial };
      set({ prefs: next }); // optimistic: favourites should react instantly
      try {
        const { prefs } = await put<{ prefs: UserPrefs }>('/api/prefs', next);
        set({ prefs });
      } catch (err) {
        void getState().refresh().catch(() => {});
        throw err;
      }
    },

    async setLockEnabled(enabled) {
      if (enabled) {
        const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
        const check = await BiometricAuth.checkBiometry();
        if (!check.isAvailable && !check.deviceIsSecure) {
          throw new ApiError(0, 'unavailable', 'Auf diesem Gerät ist weder Fingerabdruck/Gesicht noch eine Displaysperre eingerichtet.');
        }
        await BiometricAuth.authenticate({
          reason: 'App-Sperre aktivieren',
          androidTitle: 'Home Hub',
          androidSubtitle: 'App-Sperre aktivieren',
          cancelTitle: 'Abbrechen',
          allowDeviceCredential: true,
        });
      }
      await deviceStore.set('lock', enabled ? '1' : '0');
      set({ lockEnabled: enabled });
    },

    async unlock() {
      try {
        const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
        await BiometricAuth.authenticate({
          reason: 'Home Hub entsperren',
          androidTitle: 'Home Hub',
          androidSubtitle: 'Entsperren, um dein Zuhause zu steuern',
          cancelTitle: 'Abbrechen',
          allowDeviceCredential: true,
        });
      } catch {
        return false;
      }
      set({ phase: 'ready' });
      startRealtime({ onSessionEnded: signedOut });
      // The session may have ended while the app was locked.
      void getState().refresh().catch(() => {});
      return true;
    },

    can(permission) {
      const { user } = getState();
      return user ? hasPermission(user, permission) : false;
    },
  };
});

/** Convenience hook: does the signed-in user hold a permission? */
export function useCan(permission: Permission): boolean {
  return useSession((state) => (state.user ? hasPermission(state.user, permission) : false));
}

export function useIsAdmin(): boolean {
  return useSession((state) => state.user?.role === 'admin');
}
