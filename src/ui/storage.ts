import { get, set } from 'idb-keyval';
import { getLab, loadLab, notify, subscribeLab } from './lab.ts';
import { parseProject, serializeProject } from './project.ts';
import { SHARE_PREFIX, decodeLab } from './share.ts';

const AUTOSAVE_KEY = 'autosave';
/** Where an autosave that failed to load is kept, so it is never silently overwritten. */
const BROKEN_KEY = 'autosave-unreadable';
const SAVE_DELAY_MS = 500;
/** The lab that was open before a shared link replaced it. */
const BEFORE_SHARE_KEY = 'before-shared-link';

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

/** Saves data as a file through the browser's download. */
export function downloadFile(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadLab(): void {
  const name = `netforge-lab-${new Date().toISOString().slice(0, 10)}.json`;
  downloadFile(name, serializeProject(getLab()), 'application/json');
}

/**
 * Opens a lab from a `#lab=` link. Asks before replacing a lab that has devices, keeps a copy
 * of the replaced one, and removes the hash so a reload doesn't import it again.
 */
export async function openSharedLink(): Promise<void> {
  const { hash, pathname, search } = window.location;
  if (!hash.startsWith(SHARE_PREFIX)) return;
  window.history.replaceState(null, '', pathname + search);
  try {
    const project = parseProject(await decodeLab(hash.slice(SHARE_PREFIX.length)));
    const current = getLab();
    if (
      current.net.devices.size > 0 &&
      !window.confirm('Open the shared lab? It replaces the lab you were working on.')
    ) {
      return;
    }
    await set(BEFORE_SHARE_KEY, serializeProject(current)).catch(() => undefined);
    loadLab({ ...project, tasks: current.tasks });
    notify('Opened a shared lab.');
  } catch (error) {
    // ProjectError and decode errors carry messages written for the user.
    notify(error instanceof Error ? error.message : 'Could not open the shared lab.');
  }
}
