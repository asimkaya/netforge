import { useSyncExternalStore } from 'react';
import { Network } from '../engine/network.ts';
import type { Port } from '../engine/port.ts';
import { run, type Process } from '../engine/shell.ts';
import type { SpecId } from '../engine/specs.ts';
import { emptyProgress, type Project, type TaskProgress } from './project.ts';

export interface Point {
  x: number;
  y: number;
}

export type Mode = 'realtime' | 'simulation';

export interface TerminalSession {
  lines: string[];
  history: string[];
  process: Process | null;
}

export type WindowTab = 'physical' | 'config' | 'desktop' | 'cli';
export type AppId = 'terminal' | 'ipconfig' | 'browser' | 'editor' | 'mail';

/** A device window floating over the canvas. */
export interface DeviceWindow {
  device: string;
  /** Top-left corner inside the canvas, in px. */
  x: number;
  y: number;
  /** Stacking order: the highest is in front. */
  z: number;
  tab: WindowTab;
  /** App open on the Desktop tab, or null for the app grid. */
  app: AppId | null;
  minimized: boolean;
}

export interface CommandRecord {
  device: string;
  line: string;
}

export interface LabState {
  net: Network;
  layout: Record<string, Point>;
  selected: string | null;
  windows: DeviceWindow[];
  mode: Mode;
  /** Commands the user ran, oldest first (guided tasks read this). */
  commands: CommandRecord[];
  /** Short message shown as a toast. */
  notice: string | null;
  tasks: TaskProgress;
}

/**
 * The single UI-side store: the live Network plus UI-only state.
 * The Network is mutable; `tick` changes whenever anything observable does.
 */
let state: LabState = freshState({ net: new Network(), layout: {}, tasks: emptyProgress() });
let tick = 0;
const listeners = new Set<() => void>();
const sessions = new Map<string, TerminalSession>();
let unsubscribeNet = state.net.subscribe(emit);

function freshState({ net, layout, tasks }: Project): LabState {
  return {
    net,
    layout,
    tasks,
    selected: null,
    windows: [],
    mode: 'realtime',
    commands: [],
    notice: null,
  };
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;

export function notify(text: string): void {
  clearTimeout(noticeTimer);
  update({ notice: text });
  noticeTimer = setTimeout(() => update({ notice: null }), 5000);
}

function emit(): void {
  tick++;
  for (const listener of listeners) listener();
}

function update(patch: Partial<LabState>): void {
  state = { ...state, ...patch };
  emit();
}

export function getLab(): LabState {
  return state;
}

export function subscribeLab(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders the caller whenever the lab changes. */
export function useLab(): LabState {
  useSyncExternalStore(subscribeLab, () => tick);
  return state;
}

/** Replaces the whole lab (new task, import, restore from storage). */
export function loadLab(project: Project, options: { keepWindows?: boolean } = {}): void {
  for (const session of sessions.values()) {
    session.process?.interrupt();
    session.process = null;
  }
  // Undo/redo keep open windows and terminal history for devices that still exist.
  if (!options.keepWindows) sessions.clear();
  const has = (id: string | null) => id !== null && project.net.devices.has(id);
  unsubscribeNet();
  state = {
    ...freshState(project),
    mode: state.mode,
    ...(options.keepWindows
      ? {
          windows: state.windows.filter((w) => has(w.device)),
          selected: has(state.selected) ? state.selected : null,
        }
      : {}),
  };
  unsubscribeNet = project.net.subscribe(emit);
  emit();
}

export function addDevice(spec: SpecId, at: Point): void {
  const device = state.net.addDevice(spec);
  update({ layout: { ...state.layout, [device.id]: at }, selected: device.id });
}

/** Cables two ports; a refused cable is explained in a toast. */
export function cable(a: Port, b: Port): void {
  try {
    state.net.connect(a, b);
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error));
  }
}

export function moveDevice(id: string, to: Point): void {
  update({ layout: { ...state.layout, [id]: to } });
}

export function removeDevice(id: string): void {
  const device = state.net.devices.get(id);
  if (!device) return;
  sessions.get(id)?.process?.interrupt();
  sessions.delete(id);
  const layout = Object.fromEntries(Object.entries(state.layout).filter(([key]) => key !== id));
  state.net.removeDevice(device);
  update({
    layout,
    selected: state.selected === id ? null : state.selected,
    windows: state.windows.filter((w) => w.device !== id),
  });
}

export function select(id: string | null): void {
  if (state.selected !== id) update({ selected: id });
}

/** End hosts get a desktop with apps; network gear gets a CLI tab instead. */
export function hasDesktop(spec: SpecId): boolean {
  return spec === 'pc' || spec === 'server';
}

let topZ = 1;

function patchWindow(id: string, patch: Partial<DeviceWindow>): void {
  update({ windows: state.windows.map((w) => (w.device === id ? { ...w, ...patch } : w)) });
}

/** Opens (or brings back) a device's window, optionally on a given tab and app. */
export function openWindow(
  id: string,
  view: Partial<Pick<DeviceWindow, 'tab' | 'app'>> = {},
  /** Where a new window goes (canvas px); without it, new windows cascade from the corner. */
  at?: Point,
): void {
  const device = state.net.devices.get(id);
  if (!device) return;
  const z = ++topZ;
  const existing = state.windows.find((w) => w.device === id);
  if (existing) {
    patchWindow(id, { ...view, z, minimized: false });
  } else {
    // Cascade new windows so they don't hide each other completely.
    const n = state.windows.length % 6;
    const win: DeviceWindow = {
      device: id,
      x: at?.x ?? 24 + n * 40,
      y: at?.y ?? 24 + n * 40,
      z,
      tab: hasDesktop(device.spec.id) ? 'desktop' : 'physical',
      app: null,
      minimized: false,
      ...view,
    };
    update({ windows: [...state.windows, win] });
  }
  select(id);
}

/** Opens the device's terminal: the Desktop app on hosts, the CLI tab elsewhere. */
export function openTerminal(id: string): void {
  const device = state.net.devices.get(id);
  openWindow(
    id,
    device && hasDesktop(device.spec.id) ? { tab: 'desktop', app: 'terminal' } : { tab: 'cli' },
  );
}

export function closeWindow(id: string): void {
  update({ windows: state.windows.filter((w) => w.device !== id) });
}

export function focusWindow(id: string): void {
  const win = state.windows.find((w) => w.device === id);
  if (win && win.z !== topZ) patchWindow(id, { z: ++topZ });
}

export function moveWindow(id: string, x: number, y: number): void {
  patchWindow(id, { x, y });
}

export function setWindowView(id: string, view: Partial<Pick<DeviceWindow, 'tab' | 'app'>>): void {
  patchWindow(id, view);
}

export function minimizeWindow(id: string, minimized = true): void {
  patchWindow(id, minimized ? { minimized } : { minimized, z: ++topZ });
}

export function setTasks(tasks: TaskProgress): void {
  update({ tasks });
}

export function setMode(mode: Mode): void {
  update({ mode });
}

export function session(id: string): TerminalSession {
  let s = sessions.get(id);
  if (!s) {
    s = { lines: [], history: [], process: null };
    sessions.set(id, s);
  }
  return s;
}

/** Runs a command line in a device's terminal. */
export function runCommand(id: string, line: string): void {
  const device = state.net.devices.get(id);
  const s = session(id);
  if (!device || s.process) return;
  s.lines.push(`${prompt(device.name)}${line}`);
  const trimmed = line.trim();
  if (trimmed) s.history.push(trimmed);
  if (trimmed === 'clear') {
    s.lines = [];
  } else if (trimmed) {
    state.commands = [...state.commands, { device: id, line: trimmed }];
    const proc = run(state.net, device, trimmed, {
      out: (text) => {
        s.lines.push(text);
        emit();
      },
      exit: () => {
        s.process = null;
        emit();
      },
    });
    if (proc) s.process = proc;
  }
  emit();
}

export function interruptCommand(id: string): void {
  const s = sessions.get(id);
  if (!s?.process) return;
  s.lines.push('^C');
  s.process.interrupt();
  s.process = null;
  emit();
}

export function prompt(name: string): string {
  return `root@${name}:~# `;
}
