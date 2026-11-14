import { useSyncExternalStore } from 'react';
import { applyUpdate, subscribeUpdate, updateReady } from './offline.ts';

/** Shown when a new version of NetForge has been downloaded in the background. */
export function UpdateToast() {
  const ready = useSyncExternalStore(subscribeUpdate, updateReady);
  if (!ready) return null;
  return (
    <div
      role="status"
      className="fixed right-3 bottom-3 z-40 flex items-center gap-3 rounded-md border border-(--nf-border) bg-(--nf-surface) py-2 pr-2 pl-3 text-xs shadow-lg"
    >
      A new version is ready
      <button
        type="button"
        onClick={applyUpdate}
        className="rounded bg-(--nf-accent) px-3 py-1 text-xs font-semibold text-(--nf-on-accent) hover:opacity-90"
      >
        Reload
      </button>
    </div>
  );
}
