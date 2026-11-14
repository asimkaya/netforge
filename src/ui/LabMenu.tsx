import { useEffect, useRef, useState } from 'react';
import { Network } from '../engine/network.ts';
import { redo, undo, useHistory } from './history.ts';
import { getLab, loadLab, notify } from './lab.ts';
import { ProjectError, parseProject, serializeProject } from './project.ts';
import { LONG_LINK, encodeLab, shareUrl } from './share.ts';
import { downloadLab, downloadLinuxScript, confirmReplace } from './storage.ts';
import { checkReportFile, downloadReport } from './reportActions.ts';
import { setTheme, useTheme } from './themeMode.ts';

const icon =
  'grid h-7 w-7 shrink-0 place-items-center rounded border border-(--nf-border) hover:bg-(--nf-raised) disabled:opacity-40 disabled:hover:bg-transparent';
const item =
  'block w-full px-3 py-1.5 text-left hover:bg-(--nf-raised) focus-visible:bg-(--nf-raised) focus-visible:outline-none';

/** A curved arrow; Redo is the same drawing mirrored. */
function Arrow({ flip = false }: { flip?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-4 w-4 ${flip ? '-scale-x-100' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 3 2.5 6.5 6 10" />
      <path d="M3 6.5h6.5a4 4 0 0 1 0 8H7" />
    </svg>
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

/** Undo and redo buttons, the Lab menu (share, export, import, new), plus the Ctrl+Z / Ctrl+Y shortcuts. */
export function LabMenu() {
  const fileInput = useRef<HTMLInputElement>(null);
  const reportInput = useRef<HTMLInputElement>(null);
  const { canUndo, canRedo } = useHistory();
  const theme = useTheme();

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

  const [open, setOpen] = useState(false);
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-1">
        <button
          type="button"
          className={icon}
          onClick={undo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
          aria-label="Undo"
        >
          <Arrow />
        </button>
        <button
          type="button"
          className={icon}
          onClick={redo}
          disabled={!canRedo}
          title="Redo (Ctrl+Y)"
          aria-label="Redo"
        >
          <Arrow flip />
        </button>
      </div>
      <div
        className="relative"
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Lab menu"
          onClick={() => setOpen(!open)}
          className="flex h-7 shrink-0 items-center gap-1 rounded border border-(--nf-border) px-3 text-xs hover:bg-(--nf-raised) max-sm:px-2"
        >
          Lab
          <svg viewBox="0 0 10 6" className="h-1.5 w-2.5" fill="currentColor" aria-hidden>
            <path d="M0 0h10L5 6z" />
          </svg>
        </button>
        {open && (
          <>
            {/* A click anywhere else closes the menu. */}
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div
              role="menu"
              aria-label="Lab"
              className="absolute right-0 z-50 mt-1 w-48 rounded-md border border-(--nf-border) bg-(--nf-surface) py-1 text-xs shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={pick(() => void copyShareLink())}
              >
                Share link
              </button>
              <button type="button" role="menuitem" className={item} onClick={pick(downloadLab)}>
                Export
              </button>
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={pick(downloadLinuxScript)}
              >
                Export as Linux script
              </button>
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={() => {
                  setOpen(false);
                  fileInput.current?.click();
                }}
              >
                Import
              </button>
              <hr className="my-1 border-(--nf-border)" />
              <button type="button" role="menuitem" className={item} onClick={pick(downloadReport)}>
                Download progress report
              </button>
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={() => {
                  setOpen(false);
                  reportInput.current?.click();
                }}
              >
                Check a report
              </button>
              <hr className="my-1 border-(--nf-border)" />
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={pick(() => setTheme(theme === 'dark' ? 'light' : 'dark'))}
              >
                {theme === 'dark' ? 'Light theme' : 'Dark theme'}
              </button>
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={pick(() => {
                  if (confirmReplace()) {
                    loadLab({
                      net: new Network(),
                      layout: {},
                      tasks: { ...getLab().tasks, active: null },
                    });
                  }
                })}
              >
                New lab
              </button>
            </div>
          </>
        )}
      </div>
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
      <input
        ref={reportInput}
        type="file"
        accept=".html,text/html"
        className="hidden"
        aria-label="Check a report file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void checkReportFile(file);
        }}
      />
    </div>
  );
}
