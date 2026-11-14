import { useSyncExternalStore } from 'react';
import { getLab, loadLab, subscribeLab } from './lab.ts';
import { emptyProgress, parseProject, serializeProject, type Project } from './project.ts';

/** Changes that land within this window become one undo step (e.g. dragging a device). */
const SETTLE_MS = 400;
const LIMIT = 100;

let past: string[] = [];
let future: string[] = [];
let current: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let version = 0;
/** The network history belongs to; another one means a different lab was loaded. */
let tracked = getLab().net;
let applying = false;
const listeners = new Set<() => void>();

/** The parts of the lab undo covers: devices, cables, settings, layout (not task progress). */
function snapshot(): string {
  const { net, layout, notes, zones } = getLab();
  return serializeProject({ net, layout, notes, zones, tasks: emptyProgress() });
}

function notify(): void {
  version++;
  for (const listener of listeners) listener();
}

/** Records the lab now if it changed since the last step. */
export function record(): void {
  clearTimeout(timer);
  const next = snapshot();
  if (current === null) {
    current = next;
    return;
  }
  if (next === current) return;
  past = [...past, current].slice(-LIMIT);
  future = [];
  current = next;
  notify();
}

function apply(text: string): void {
  const { net, layout, notes, zones } = parseProject(text);
  applying = true;
  try {
    loadLab({ net, layout, notes, zones, tasks: getLab().tasks }, { keepWindows: true });
  } finally {
    applying = false;
  }
  tracked = net;
  current = text;
  notify();
}

/**
 * Swaps in a rebuilt lab (a paste) as one undo step. Open windows and terminals stay,
 * like with undo itself.
 */
export function replaceLab(project: Project): void {
  record();
  applying = true;
  try {
    loadLab({ ...project, tasks: getLab().tasks }, { keepWindows: true });
  } finally {
    applying = false;
  }
  tracked = project.net;
  record();
}

export function undo(): void {
  record();
  const previous = past.at(-1);
  if (previous === undefined || current === null) return;
  past = past.slice(0, -1);
  future = [current, ...future];
  apply(previous);
}

export function redo(): void {
  record();
  const [next, ...rest] = future;
  if (next === undefined || current === null) return;
  future = rest;
  past = [...past, current];
  apply(next);
}

/** Starts a fresh history from the current lab. */
export function resetHistory(): void {
  clearTimeout(timer);
  tracked = getLab().net;
  past = [];
  future = [];
  current = snapshot();
  notify();
}

/** Watches the lab and records an undo step once changes settle. */
export function startHistory(): () => void {
  resetHistory();
  return subscribeLab(() => {
    if (getLab().net !== tracked && !applying) {
      // New lab, import, task start or shared link: undo starts over.
      resetHistory();
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(record, SETTLE_MS);
  });
}

export function useHistory(): { canUndo: boolean; canRedo: boolean } {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  return { canUndo: past.length > 0, canRedo: future.length > 0 };
}
