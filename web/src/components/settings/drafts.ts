import { create } from 'zustand';
import type { IntegrationSettingsMap, SettingsKey } from '@home-hub/shared';
import { useSession } from '../../store/session.ts';

/**
 * Unsaved edits of the device settings.
 *
 * They survive leaving the page: the tab bar is always one tap away, and
 * finding a half-filled form as you left it beats a "discard?" dialog on every
 * navigation. Kept in memory only — a draft can hold a freshly typed password.
 */
type Drafts = { [K in SettingsKey]?: IntegrationSettingsMap[K] };

export const useDrafts = create<{ drafts: Drafts }>(() => ({ drafts: {} }));

export function setDraft<K extends SettingsKey>(key: K, value: IntegrationSettingsMap[K] | null): void {
  useDrafts.setState((state) => {
    const drafts: Drafts = { ...state.drafts };
    if (value === null) delete drafts[key];
    else drafts[key] = value;
    return { drafts };
  });
}

// Signing out or locking the app must not leave typed passwords behind.
useSession.subscribe((state) => {
  if (state.phase !== 'ready' && Object.keys(useDrafts.getState().drafts).length > 0) useDrafts.setState({ drafts: {} });
});
