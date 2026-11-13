import { useSyncExternalStore } from 'react';
import { Network } from '../engine/network.ts';
import { run, type Process } from '../engine/shell.ts';

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

export interface CommandRecord {
  device: string;
  line: string;
}

export interface LabState {
  net: Network;
  layout: Record<string, Point>;
  selected: string | null;
  terminal: string | null;
  mode: Mode;
  /** Commands the user ran, oldest first (guided tasks read this). */
  commands: CommandRecord[];
  /** Short message shown as a toast. */
  notice: string | null;
}

/**
 * The single UI-side store: the live Network plus UI-only state.
 * The Network is mutable; `tick` changes whenever anything observable does.
 */
let state: LabState = freshState(new Network(), {});
let tick = 0;
const listeners = new Set<() => void>();
const sessions = new Map<string, TerminalSession>();
let unsubscribeNet = state.net.subscribe(emit);

function freshState(net: Network, layout: Record<string, Point>): LabState {
  return {
    net,
    layout,
    selected: null,
    terminal: null,
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
export function loadLab(
  net: Network,
  layout: Record<string, Point>,
  commands: CommandRecord[] = [],
): void {
  for (const session of sessions.values()) session.process?.interrupt();
  sessions.clear();
  unsubscribeNet();
  state = { ...freshState(net, layout), mode: state.mode, commands };
  unsubscribeNet = net.subscribe(emit);
  emit();
}

export function addDevice(kind: 'host' | 'switch', at: Point): void {
  const device = kind === 'host' ? state.net.addHost() : state.net.addSwitch();
  update({ layout: { ...state.layout, [device.id]: at }, selected: device.id });
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
    terminal: state.terminal === id ? null : state.terminal,
  });
}

export function select(id: string | null): void {
  if (state.selected !== id) update({ selected: id });
}

export function openTerminal(id: string | null): void {
  update({ terminal: id, ...(id ? { selected: id } : {}) });
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
