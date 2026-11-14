import { useSyncExternalStore } from 'react';

export type ThemeMode = 'light' | 'dark';

const KEY = 'netforge.theme';

/** The theme in effect: whatever index.html's inline script set before first paint. */
export function getTheme(): ThemeMode {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function setTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // Storage can be blocked; the choice then lasts until reload.
  }
  for (const listener of listeners) listener();
}

const listeners = new Set<() => void>();

export function useTheme(): ThemeMode {
  return useSyncExternalStore((cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }, getTheme);
}
