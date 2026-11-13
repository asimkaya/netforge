import { useRef } from 'react';
import { Network } from '../engine/network.ts';
import { getLab, loadLab, notify } from './lab.ts';
import { ProjectError, parseProject } from './project.ts';
import { downloadLab } from './storage.ts';

const button =
  'rounded border border-(--nf-border) px-3 py-1 text-xs hover:border-(--nf-accent) focus-visible:outline-2 focus-visible:outline-(--nf-accent)';

function confirmReplace(): boolean {
  return (
    getLab().net.devices.size === 0 ||
    window.confirm(
      'This replaces your current lab. Export it first if you want to keep it. Continue?',
    )
  );
}

/** New / Import / Export buttons in the header. */
export function LabMenu() {
  const fileInput = useRef<HTMLInputElement>(null);

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
