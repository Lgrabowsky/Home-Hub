import { create } from 'zustand';
import { isNative } from './platform.ts';

export type ThemeChoice = 'system' | 'dark' | 'light';

const KEY = 'hh.theme';

function resolve(choice: ThemeChoice): 'dark' | 'light' {
  if (choice !== 'system') return choice;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function apply(choice: ThemeChoice): void {
  const theme = resolve(choice);
  document.documentElement.dataset.theme = theme;
  const color = theme === 'dark' ? '#0a0d12' : '#f2f4f8';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
  if (isNative) {
    void import('@capacitor/status-bar')
      .then(({ StatusBar, Style }) => StatusBar.setStyle({ style: theme === 'dark' ? Style.Dark : Style.Light }))
      .catch(() => {});
  }
}

function stored(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'dark' || value === 'light' ? value : 'system';
  } catch {
    return 'system';
  }
}

export const useTheme = create<{ choice: ThemeChoice; setChoice(choice: ThemeChoice): void }>((set) => ({
  choice: stored(),
  setChoice(choice) {
    try {
      localStorage.setItem(KEY, choice);
    } catch {
      /* not persisted */
    }
    apply(choice);
    set({ choice });
  },
}));

/** Call once at start-up, before the first render. */
export function initTheme(): void {
  apply(useTheme.getState().choice);
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (useTheme.getState().choice === 'system') apply('system');
  });
}
