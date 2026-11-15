import { useSyncExternalStore } from 'react';
import {
  commandFailed,
  explainFailure,
  type CommandRun,
  type Explanation,
} from '../engine/explain.ts';
import { Network } from '../engine/network.ts';
import type { Device } from '../engine/device.ts';
import type { Port } from '../engine/port.ts';
import { complete, run, type Process } from '../engine/shell.ts';
import type { SpecId } from '../engine/specs.ts';
import { checkWireless } from '../engine/wifi.ts';
import { clearEvidence } from '../tasks/tasks.ts';
import { LIMITS, NOTE_ID, ZONE_ID, freshId, type Note, type Zone } from './annotations.ts';
import { FOOTPRINT } from './placement.ts';
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
  /** Lines typed while a command was running; they run when it exits, like type-ahead. */
  queue: string[];
  /** The latest command if it failed (ping, curl...) and "Why did this fail?" can explain it. */
  failed: CommandRun | null;
  /** The running command was stopped with Ctrl+C, so its result says nothing. */
  interrupted: boolean;
}

export type WindowTab = 'physical' | 'config' | 'desktop' | 'cli';
export type AppId =
  'terminal' | 'ipconfig' | 'browser' | 'editor' | 'mail' | 'capture' | 'wifi' | 'print' | 'camera';

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
  notes: Note[];
  zones: Zone[];
  /** The device clicked last, or null: device windows and the like follow this one. */
  selected: string | null;
  /** Everything selected on the canvas (devices, notes and zones), in the order it was picked. */
  selection: string[];
  windows: DeviceWindow[];
  mode: Mode;
  /** Commands the user ran, oldest first (guided tasks read this). */
  commands: CommandRecord[];
  /** Short message shown as a toast. */
  notice: string | null;
  tasks: TaskProgress;
  /** The explanation shown under a terminal, until it is closed or the next command runs. */
  why: { terminal: string; explanation: Explanation } | null;
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
attachLocate(state.net);

/** Gives the engine device centers on the canvas, for Wi-Fi range. */
function attachLocate(net: Network): void {
  net.locate = (id) => {
    const at = state.layout[id];
    const device = net.devices.get(id);
    if (!at || !device) return null;
    const size = FOOTPRINT[device.spec.id];
    return { x: at.x + size.w / 2, y: at.y + size.h / 2 };
  };
}

function freshState({ net, layout, notes = [], zones = [], tasks }: Project): LabState {
  return {
    net,
    layout,
    notes,
    zones,
    tasks,
    selected: null,
    selection: [],
    windows: [],
    mode: 'realtime',
    commands: [],
    notice: null,
    why: null,
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
const beforeLoad = new Set<() => void>();

/** Runs `hook` just before another lab replaces the current one (undo saves the old one). */
export function onBeforeLoad(hook: () => void): () => void {
  beforeLoad.add(hook);
  return () => beforeLoad.delete(hook);
}

export function loadLab(project: Project, options: { keepWindows?: boolean } = {}): void {
  for (const hook of beforeLoad) hook();
  for (const session of sessions.values()) {
    session.queue = [];
    session.process?.interrupt();
    session.process = null;
  }
  // Undo/redo keep open windows and terminal history for devices that still exist.
  if (!options.keepWindows) sessions.clear();
  const has = (id: string | null) =>
    id !== null &&
    (project.net.devices.has(id) ||
      (project.notes ?? []).some((n) => n.id === id) ||
      (project.zones ?? []).some((z) => z.id === id));
  const selection = state.selection.filter(has);
  unsubscribeNet();
  state = {
    ...freshState(project),
    mode: state.mode,
    ...(options.keepWindows
      ? {
          windows: state.windows.filter((w) => has(w.device)),
          selected: project.net.devices.has(state.selected ?? '') ? state.selected : null,
          selection,
        }
      : {}),
  };
  unsubscribeNet = project.net.subscribe(emit);
  attachLocate(project.net);
  emit();
}

export function addDevice(spec: SpecId, at: Point): void {
  const device = state.net.addDevice(spec);
  update({
    layout: { ...state.layout, [device.id]: at },
    selected: device.id,
    selection: [device.id],
  });
}

/** True (with a toast) when `a` is plugged into `device`; moving that end would loop the cable. */
export function cabledTo(a: Port, device: Device): boolean {
  const old = a.link;
  const far = old && (old.a === a ? old.b : old.a);
  if (!far || far.device !== device || a.device === device) return false;
  notify(`${a.device.name} ${a.name} is already cabled to ${device.name}.`);
  return true;
}

/**
 * Cables `a` to `b`. When `a` is already plugged, its cable moves: the far end stays put and
 * only this end is re-plugged into `b`. A refused move puts the old cable back.
 */
export function cable(a: Port, b: Port): void {
  if (cabledTo(a, b.device)) return;
  const old = a.link;
  const far = old && (old.a === a ? old.b : old.a);
  if (old && (a === b || far === b)) return;
  try {
    if (old && far) state.net.disconnect(old);
    state.net.connect(far ?? a, b);
  } catch (error) {
    if (far) state.net.connect(far, a);
    notify(error instanceof Error ? error.message : String(error));
  }
}

export function moveDevice(id: string, to: Point): void {
  update({ layout: { ...state.layout, [id]: to } });
  // Walking away from an access point drops the Wi-Fi link.
  checkWireless(state.net);
}

export function removeDevice(id: string): void {
  const device = state.net.devices.get(id);
  if (!device) return;
  const old = sessions.get(id);
  if (old) old.queue = [];
  old?.process?.interrupt();
  sessions.delete(id);
  const layout = Object.fromEntries(Object.entries(state.layout).filter(([key]) => key !== id));
  state.net.removeDevice(device);
  update({
    layout,
    selected: state.selected === id ? null : state.selected,
    selection: state.selection.filter((s) => s !== id),
    windows: state.windows.filter((w) => w.device !== id),
    ...(state.why?.terminal === id || state.why?.explanation.deviceId === id ? { why: null } : {}),
  });
}

/** Whether something with this id (a device, note or zone) is on the canvas. */
export function exists(id: string): boolean {
  return (
    state.net.devices.has(id) ||
    state.notes.some((n) => n.id === id) ||
    state.zones.some((z) => z.id === id)
  );
}

/** Selects exactly these items; the last one becomes the clicked device. */
export function setSelection(ids: string[]): void {
  const same =
    ids.length === state.selection.length && ids.every((id, i) => id === state.selection[i]);
  if (same) return;
  const device = [...ids].reverse().find((id) => state.net.devices.has(id));
  update({ selection: ids, selected: device ?? null });
}

export function select(id: string | null): void {
  setSelection(id === null ? [] : [id]);
}

/** Adds an empty note whose top-left corner is at `at`. */
export function addNote(at: Point): void {
  if (state.notes.length >= LIMITS.notes) return notify('This lab has too many notes already.');
  const note: Note = { id: freshId('n', state.notes), ...at, w: LIMITS.noteWidth.start, text: '' };
  update({ notes: [...state.notes, note], selection: [note.id], selected: null });
}

/** Adds a zone titled "Zone" whose top-left corner is at `at`. */
export function addZone(at: Point): void {
  if (state.zones.length >= LIMITS.zones) return notify('This lab has too many zones already.');
  const zone: Zone = {
    id: freshId('z', state.zones),
    ...at,
    w: LIMITS.zoneWidth.start,
    h: LIMITS.zoneHeight.start,
    title: 'Zone',
    tint: state.zones.length % LIMITS.zoneTints,
  };
  update({ zones: [...state.zones, zone], selection: [zone.id], selected: null });
}

export function updateNote(id: string, patch: Partial<Omit<Note, 'id'>>): void {
  update({ notes: state.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)) });
}

export function updateZone(id: string, patch: Partial<Omit<Zone, 'id'>>): void {
  update({ zones: state.zones.map((z) => (z.id === id ? { ...z, ...patch } : z)) });
}

export function removeAnnotation(id: string): void {
  update({
    notes: state.notes.filter((n) => n.id !== id),
    zones: state.zones.filter((z) => z.id !== id),
    selection: state.selection.filter((s) => s !== id),
  });
}

/** Moves a note or zone to a new top-left corner. */
export function moveAnnotation(id: string, to: Point): void {
  if (NOTE_ID.test(id)) updateNote(id, to);
  else if (ZONE_ID.test(id)) updateZone(id, to);
}

/** End hosts get a desktop with apps; network gear gets a CLI tab instead. */
export function hasDesktop(spec: SpecId): boolean {
  return spec === 'pc' || spec === 'server' || spec === 'laptop' || spec === 'phone';
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

/** Printers and cameras are appliances: they have no shell, only Physical and Config. */
export function hasCli(spec: SpecId): boolean {
  return !hasDesktop(spec) && spec !== 'printer' && spec !== 'camera';
}

/** Opens the device's terminal: the Desktop app on hosts, the CLI tab elsewhere. */
export function openTerminal(id: string): void {
  const device = state.net.devices.get(id);
  openWindow(
    id,
    device && hasDesktop(device.spec.id)
      ? { tab: 'desktop', app: 'terminal' }
      : device && !hasCli(device.spec.id)
        ? { tab: 'physical' }
        : { tab: 'cli' },
  );
}

export function closeWindow(id: string): void {
  update({
    windows: state.windows.filter((w) => w.device !== id),
    ...(state.why?.terminal === id ? { why: null } : {}),
  });
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

/**
 * Starts a built-in task on the network as it is. Answered pings and commands from earlier
 * work are forgotten, so the task's steps only count what the learner does from here on.
 */
export function continueTask(id: string): void {
  clearEvidence(state.net);
  update({
    commands: [],
    tasks: { ...state.tasks, active: id, steps: { ...state.tasks.steps, [id]: 0 } },
  });
}

export function setMode(mode: Mode): void {
  update({ mode });
}

export function session(id: string): TerminalSession {
  let s = sessions.get(id);
  if (!s) {
    s = { lines: [], history: [], process: null, queue: [], failed: null, interrupted: false };
    sessions.set(id, s);
  }
  return s;
}

/** Runs a command line in a device's terminal. */
export function runCommand(id: string, line: string): void {
  const device = state.net.devices.get(id);
  const s = session(id);
  if (!device) return;
  if (s.process) {
    // Typed ahead: echo it now, run it when the current command exits.
    s.lines.push(line);
    s.queue.push(line);
    emit();
    return;
  }
  s.lines.push(`${prompt(device.name)}${line}`);
  s.failed = null;
  s.interrupted = false;
  if (state.why?.terminal === id) state = { ...state, why: null };
  const trimmed = line.trim();
  if (trimmed) s.history.push(trimmed);
  if (trimmed === 'clear') {
    s.lines = [];
  } else if (trimmed) {
    state.commands = [...state.commands, { device: id, line: trimmed }];
    // A command may exit before run() returns (ping with no route): then it must not
    // be kept as the running process.
    let exited = false;
    const output: string[] = [];
    const after = state.net.dropSeq;
    const proc = run(state.net, device, trimmed, {
      history: s.history,
      out: (text) => {
        s.lines.push(text);
        output.push(text);
        if (output.length > MAX_CAPTURED) output.shift();
        emit();
      },
      exit: () => {
        exited = true;
        s.process = null;
        if (!s.interrupted && commandFailed(trimmed, output)) {
          s.failed = { line: trimmed, output, after, until: state.net.dropSeq };
        }
        const next = s.queue.shift();
        if (next !== undefined) runCommand(id, next);
        emit();
      },
    });
    if (proc && !exited) s.process = proc;
  }
  if (!s.process) {
    const next = s.queue.shift();
    if (next !== undefined) runCommand(id, next);
  }
  emit();
}

/**
 * Tab in a terminal: returns the input with its last word completed as far as the
 * candidates agree, and lists them when there are several, like bash.
 */
export function completeInput(id: string, input: string): string {
  const device = state.net.devices.get(id);
  if (!device) return input;
  const found = complete(device, input);
  const [first] = found;
  if (first === undefined) return input;
  const last = input.split(/\s+/).at(-1) ?? '';
  let common = first;
  for (const c of found) while (!c.startsWith(common)) common = common.slice(0, -1);
  if (found.length > 1 && common === last) {
    session(id).lines.push(`${prompt(device.name)}${input}`, found.join('  '));
    emit();
  }
  const done = found.length === 1 && !common.endsWith('/') ? ' ' : '';
  return input.slice(0, input.length - last.length) + common + done;
}

export function interruptCommand(id: string): void {
  const s = sessions.get(id);
  if (!s?.process) return;
  s.lines.push('^C');
  s.interrupted = true;
  s.queue = [];
  if (s.process.signal) {
    // Interactive programs (ssh) handle Ctrl+C themselves and keep running.
    s.process.signal();
  } else {
    s.process.interrupt();
    s.process = null;
  }
  emit();
}

/** Sends a typed line to the interactive program running in a terminal (like ssh). */
export function sendInput(id: string, line: string): void {
  const s = sessions.get(id);
  const proc = s?.process;
  if (!s || !proc?.input) return;
  const secret = proc.secret?.() ?? false;
  s.lines.push(`${proc.prompt?.() ?? ''}${secret ? '' : line}`);
  if (!secret && line.trim()) s.history.push(line.trim());
  proc.input(line);
  emit();
}

/** Lines of output kept to decide whether a command failed. */
const MAX_CAPTURED = 400;

/** Explains the failed command of a terminal in a panel there, and points at the culprit. */
export function explainLastFailure(id: string): void {
  const failed = sessions.get(id)?.failed;
  const device = state.net.devices.get(id);
  if (!failed || !device) return;
  const explanation = explainFailure(state.net, device, failed);
  if (explanation) update({ why: { terminal: id, explanation } });
}

export function closeExplanation(): void {
  if (state.why) update({ why: null });
}

export function prompt(name: string): string {
  return `root@${name}:~# `;
}
