import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Network } from '../engine/network.ts';
import { addDevice, loadLab } from './lab.ts';
import { emptyProgress } from './project.ts';

const store = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: (key: string) => Promise.resolve(store.get(key)),
  set: (key: string, value: unknown) => {
    store.set(key, value);
    return Promise.resolve();
  },
}));
vi.stubGlobal('window', new EventTarget());

// Imported after the mocks above are in place.
const storage = await import('./storage.ts');

describe('autosave', () => {
  let stop: () => void;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    store.clear();
    loadLab({ net: new Network(), layout: {}, tasks: emptyProgress() });
    stop = storage.startAutosave();
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it('saves within 2 s even while the lab never stops changing', () => {
    for (let t = 0; t < 2500; t += 300) {
      addDevice('pc', { x: t, y: 0 });
      vi.advanceTimersByTime(300);
    }
    expect(store.get('autosave')).toContain('"pc');
  });

  it('saves edits that have not settled when the page is closed', () => {
    addDevice('pc', { x: 0, y: 0 });
    expect(store.has('autosave')).toBe(false);
    window.dispatchEvent(new Event('pagehide'));
    expect(store.get('autosave')).toContain('"pc1"');
  });
});

describe('restoring a save that cannot be read', () => {
  it('offers it for download and never overwrites the first kept copy', async () => {
    expect(storage.unreadableSave).toBeNull();
    store.set('autosave', '{"format":"netforge-lab","version":999}');
    await storage.restoreAutosave();
    expect(storage.unreadableSave).toContain('999');
    expect(store.get('autosave-unreadable')).toContain('999');

    store.set('autosave', 'not json');
    await storage.restoreAutosave();
    expect(store.get('autosave-unreadable')).toContain('999');
  });
});
