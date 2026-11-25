import { useMemo } from 'react';
import { create } from 'zustand';
import { SERVICE_LABELS, type AlarmEntity, type ServiceId } from '@home-hub/shared';
import { useHub } from '../store/hub.ts';
import { useCan, useIsAdmin } from '../store/session.ts';

/**
 * Everything out of the ordinary, in one place: services that cannot reach their devices, alarms
 * that went off. Banners can be dismissed; a dismissed notice stays in the notification centre and
 * comes back as a banner when its problem changes or returns after it was gone.
 */

export interface AppNotice {
  /** Stable for one problem: `service:reolink`, `alarm:gekko:…`. */
  id: string;
  /** Changes when the problem does (then a dismissed notice shows again). */
  fingerprint: string;
  tone: 'danger' | 'warn';
  title: string;
  text: string;
  /** Since when (ms), if known. */
  since: number | null;
  link: { to: string; label: string } | null;
  /** Shown as a banner on the start page (alarms have their own chip there). */
  banner: boolean;
}

/** Settings page of a service (the video service has none: diagnostics). */
const SETTINGS: Partial<Record<ServiceId, string>> = {
  mygekko: '/einstellungen/dienste/mygekko',
  knx: '/einstellungen/dienste/knx',
  doorbird: '/einstellungen/dienste/doorbird',
  reolink: '/einstellungen/dienste/reolink',
  govee: '/einstellungen/dienste/govee',
  sonos: '/einstellungen/dienste/sonos',
  spotify: '/einstellungen/dienste/spotify',
};

/** The notices of the moment, most serious first. */
export function useNotices(): AppNotice[] {
  const services = useHub((state) => state.services);
  const entities = useHub((state) => state.entities);
  const isAdmin = useIsAdmin();
  const canSecurity = useCan('security.view');
  return useMemo(() => {
    const notices: AppNotice[] = [];
    if (canSecurity) {
      for (const entity of Object.values(entities)) {
        if (entity.kind !== 'alarm' || !(entity as AlarmEntity).triggered) continue;
        notices.push({
          id: `alarm:${entity.id}`,
          fingerprint: 'triggered',
          tone: 'danger',
          title: `Alarm: ${entity.name}`,
          text: 'hat ausgelöst.',
          since: null,
          link: { to: '/sicherheit', label: 'Sicherheit' },
          banner: false,
        });
      }
    }
    for (const service of Object.values(services)) {
      if (!service || (service.status !== 'offline' && service.status !== 'degraded')) continue;
      const settings = SETTINGS[service.id];
      notices.push({
        id: `service:${service.id}`,
        fingerprint: `${service.status}|${service.message ?? ''}`,
        tone: service.status === 'offline' ? 'danger' : 'warn',
        title: SERVICE_LABELS[service.id],
        text: service.message ?? 'gerade nicht erreichbar.',
        since: service.since,
        link: isAdmin ? (settings ? { to: settings, label: 'Einstellungen' } : { to: '/einstellungen/diagnose', label: 'Diagnose' }) : null,
        banner: true,
      });
    }
    return notices.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'danger' ? -1 : 1));
  }, [services, entities, isAdmin, canSecurity]);
}

// --- Dismissed notices (on this device) ------------------------------------------------------------

const STORAGE_KEY = 'hh-notices-dismissed';

function load(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

function save(dismissed: Record<string, string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(dismissed));
  } catch {
    /* private window: dismissed for this visit */
  }
}

interface DismissedStore {
  dismissed: Record<string, string>;
  dismiss(notices: AppNotice[]): void;
  restore(id: string): void;
  /** Forgets notices whose problem is gone, so they show again if it returns. */
  prune(current: AppNotice[]): void;
}

export const useDismissed = create<DismissedStore>((set, get) => ({
  dismissed: load(),
  dismiss(notices) {
    const dismissed = { ...get().dismissed };
    for (const notice of notices) dismissed[notice.id] = notice.fingerprint;
    set({ dismissed });
    save(dismissed);
  },
  restore(id) {
    const dismissed = { ...get().dismissed };
    delete dismissed[id];
    set({ dismissed });
    save(dismissed);
  },
  prune(current) {
    const active = new Set(current.map((notice) => notice.id));
    const dismissed = get().dismissed;
    const kept = Object.fromEntries(Object.entries(dismissed).filter(([id]) => active.has(id)));
    if (Object.keys(kept).length === Object.keys(dismissed).length) return;
    set({ dismissed: kept });
    save(kept);
  },
}));

export function isDismissed(notice: AppNotice, dismissed: Record<string, string>): boolean {
  return dismissed[notice.id] === notice.fingerprint;
}
