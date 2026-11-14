import { useState } from 'react';
import type { Device } from '../../engine/device.ts';
import { normalizePath } from '../../engine/fs.ts';
import { useLab } from '../lab.ts';
import { FIELD, PRIMARY, SECONDARY } from './IpConfig.tsx';

/** Opens, edits and saves the device's text files (the same files `cat` and httpd see). */
export function TextEditor({ device }: { device: Device }) {
  useLab();
  const fs = device.fs;
  const [path, setPath] = useState('/var/www/html/index.html');
  const [text, setText] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (!fs) return null;

  const open = (target: string) => {
    const clean = normalizePath(target);
    if (clean === null) {
      setMessage('That is not a valid path.');
      return;
    }
    setPath(clean);
    const content = fs.read(clean);
    setText(content ?? '');
    setMessage(content === undefined ? `New file ${clean}.` : `Opened ${clean}.`);
  };

  const save = () => {
    const clean = normalizePath(path);
    if (clean === null || text === null) {
      setMessage('Open or name a file first.');
      return;
    }
    const error = fs.write(clean, text);
    setMessage(error ?? `Saved ${clean}.`);
  };

  const files = [...fs.files.keys()].sort();
  return (
    <div className="flex h-full min-h-0 text-xs">
      <nav
        aria-label="Files"
        className="w-44 shrink-0 overflow-y-auto border-r border-(--nf-border) p-2"
      >
        <h3 className="mb-1 text-sm font-semibold">Files</h3>
        {files.length === 0 && <p className="text-(--nf-muted)">No files yet.</p>}
        <ul className="space-y-0.5 font-mono">
          {files.map((f) => (
            <li key={f}>
              <button
                type="button"
                onClick={() => open(f)}
                className={`w-full truncate rounded px-1 text-left hover:bg-(--nf-raised) ${f === path ? 'text-(--nf-accent)' : ''}`}
                title={f}
              >
                {f}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-2">
        <div className="flex gap-2">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            aria-label="File path"
            className={`${FIELD} min-w-0 flex-1`}
          />
          <button type="button" onClick={() => open(path)} className={SECONDARY}>
            Open
          </button>
          <button type="button" onClick={save} disabled={text === null} className={PRIMARY}>
            Save
          </button>
        </div>
        <textarea
          value={text ?? ''}
          onChange={(e) => setText(e.target.value)}
          disabled={text === null}
          aria-label="File contents"
          spellCheck={false}
          placeholder="Open a file from the list, or type a path and press Open."
          className={`${FIELD} min-h-0 flex-1 resize-none leading-5`}
        />
        {message && (
          <p role="status" className="text-(--nf-muted)">
            {message}
          </p>
        )}
      </div>
    </div>
  );
}
