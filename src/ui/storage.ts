import { get, set } from 'idb-keyval';
import { getLab, loadLab, subscribeLab } from './lab.ts';
import { parseProject, serializeProject } from './project.ts';

const AUTOSAVE_KEY = 'autosave';
/** Where an autosave that failed to load is kept, so it is never silently overwritten. */
const BROKEN_KEY = 'autosave-unreadable';
const SAVE_DELAY_MS = 500;

/** Restores the last session from IndexedDB, if any. */
export async function restoreAutosave(): Promise<void> {
  let text: unknown;
  try {
    text = await get(AUTOSAVE_KEY);
  } catch (error) {
    console.warn('NetForge: browser storage is unavailable; work will not be saved.', error);
    return;
  }
  if (typeof text !== 'string') return;
  try {
    loadLab(parseProject(text));
  } catch (error) {
    console.error('NetForge: the saved lab could not be loaded. A copy was kept.', error);
    await set(BROKEN_KEY, text).catch(() => undefined);
  }
}

/** Saves the lab shortly after every change. Returns a stop function. */
export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSaved = '';
  const save = () => {
    const text = serializeProject(getLab());
    if (text === lastSaved) return;
    lastSaved = text;
    set(AUTOSAVE_KEY, text).catch((error: unknown) => {
      console.warn('NetForge: autosave failed.', error);
    });
  };
  const unsubscribe = subscribeLab(() => {
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_DELAY_MS);
  });
  // Ask the browser not to evict our data under storage pressure.
  void navigator.storage?.persist?.().catch(() => false);
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}

export function downloadLab(): void {
  const blob = new Blob([serializeProject(getLab())], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `netforge-lab-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
