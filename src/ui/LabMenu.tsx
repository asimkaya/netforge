import { useEffect, useRef } from 'react';
import { Network } from '../engine/network.ts';
import { redo, undo, useHistory } from './history.ts';
import { getLab, loadLab, notify } from './lab.ts';
import { ProjectError, parseProject, serializeProject } from './project.ts';
import { LONG_LINK, encodeLab, shareUrl } from './share.ts';
import { downloadLab } from './storage.ts';

const button =
  'shrink-0 rounded border border-(--nf-border) px-3 py-1 text-xs whitespace-nowrap hover:border-(--nf-accent) focus-visible:outline-2 focus-visible:outline-(--nf-accent) disabled:opacity-40 disabled:hover:border-(--nf-border)';

function confirmReplace(): boolean {
  return (
    getLab().net.devices.size === 0 ||
    window.confirm(
      'This replaces your current lab. Export it first if you want to keep it. Continue?',
    )
  );
}

const EDITABLE = 'input, textarea, select, [contenteditable="true"]';

async function copyShareLink(): Promise<void> {
  const url = shareUrl(await encodeLab(serializeProject(getLab())), window.location);
  try {
    await navigator.clipboard.writeText(url);
    notify(
      url.length > LONG_LINK
        ? `Link copied, but it is long (${url.length} characters). For big labs, Export a file.`
        : 'Link copied. Anyone who opens it gets a copy of this lab.',
    );
  } catch {
    notify('Could not copy the link. Your browser blocked the clipboard.');
  }
}

/** Undo, redo, share, new, import and export, plus the Ctrl+Z / Ctrl+Y shortcuts. */
export function LabMenu() {
  const fileInput = useRef<HTMLInputElement>(null);
  const { canUndo, canRedo } = useHistory();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.target as Element).closest?.(EDITABLE)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) undo();
      else if (key === 'y' || (key === 'z' && e.shiftKey)) redo();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const importFile = async (file: File) => {
    try {
      const project = parseProject(await file.text());
      if (!confirmReplace()) return;
      loadLab(project);
      notify(`Imported ${file.name}.`);
    } catch (error) {
      notify(error instanceof ProjectError ? error.message : 'Could not read that file.');
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className={button}
        onClick={undo}
        disabled={!canUndo}
        title="Undo (Ctrl+Z)"
      >
        Undo
      </button>
      <button
        type="button"
        className={button}
        onClick={redo}
        disabled={!canRedo}
        title="Redo (Ctrl+Y)"
      >
        Redo
      </button>
      <button type="button" className={button} onClick={() => void copyShareLink()}>
        Share link
      </button>
      <button
        type="button"
        className={button}
        onClick={() => {
          if (confirmReplace()) {
            loadLab({ net: new Network(), layout: {}, tasks: { ...getLab().tasks, active: null } });
          }
        }}
      >
        New lab
      </button>
      <button type="button" className={button} onClick={() => fileInput.current?.click()}>
        Import
      </button>
      <button type="button" className={button} onClick={downloadLab}>
        Export
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        className="hidden"
        aria-label="Import lab file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void importFile(file);
        }}
      />
    </div>
  );
}
