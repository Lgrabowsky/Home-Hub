import { create } from 'zustand';

/**
 * Labs: features to try before they become a regular part of the app.
 * The switches are kept on this device only.
 */

export type LabsFeature = 'house3d';

interface LabsStore {
  house3d: boolean;
  set(feature: LabsFeature, value: boolean): void;
}

const STORAGE_KEY = 'hh-labs';

function load(): Record<LabsFeature, boolean> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Record<LabsFeature, unknown>>) : {};
    return { house3d: parsed.house3d === true };
  } catch {
    return { house3d: false };
  }
}

export const useLabs = create<LabsStore>((set, getState) => ({
  ...load(),
  set(feature, value) {
    set({ [feature]: value });
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ house3d: getState().house3d }));
    } catch {
      /* private window: the switch lasts for this visit */
    }
  },
}));
