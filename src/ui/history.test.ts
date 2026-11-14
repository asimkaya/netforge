import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Network } from '../engine/network.ts';
import { redo, startHistory, undo } from './history.ts';
import { addDevice, getLab, loadLab, moveDevice, setTasks } from './lab.ts';
import { emptyProgress } from './project.ts';

const names = () => [...getLab().net.devices.values()].map((d) => d.name);
const settle = () => vi.advanceTimersByTime(500);

describe('undo and redo', () => {
  let stop: () => void;
  beforeAll(() => {
    vi.useFakeTimers();
    stop = startHistory();
  });
  afterAll(() => {
    stop();
    vi.useRealTimers();
  });

  it('steps back and forth through edits', () => {
    loadLab({ net: new Network(), layout: {}, tasks: emptyProgress() });
    addDevice('pc', { x: 0, y: 0 });
    settle();
    addDevice('switch', { x: 100, y: 0 });
    settle();
    expect(names()).toEqual(['pc1', 'sw1']);
    undo();
    expect(names()).toEqual(['pc1']);
    undo();
    expect(names()).toEqual([]);
    undo(); // nothing left: no change
    expect(names()).toEqual([]);
    redo();
    redo();
    expect(names()).toEqual(['pc1', 'sw1']);
  });

  it('brings back the lab another one replaced, with edits not yet settled', () => {
    loadLab({ net: new Network(), layout: {}, tasks: emptyProgress() });
    addDevice('pc', { x: 0, y: 0 });
    settle();
    addDevice('router', { x: 100, y: 0 }); // still within the settle window
    const other = new Network();
    other.addDevice('switch');
    loadLab({ net: other, layout: {}, tasks: emptyProgress() });
    expect(names()).toEqual(['sw1']);
    undo();
    expect(names()).toEqual(['pc1', 'r1']);
    redo();
    expect(names()).toEqual(['sw1']);
  });

  it('merges quick changes such as a drag into one step', () => {
    loadLab({ net: new Network(), layout: {}, tasks: emptyProgress() });
    addDevice('pc', { x: 0, y: 0 });
    settle();
    const id = [...getLab().net.devices.keys()][0] ?? '';
    for (let x = 1; x <= 20; x++) moveDevice(id, { x, y: 0 });
    settle();
    undo();
    expect(getLab().layout[id]).toEqual({ x: 0, y: 0 });
  });

  it('drops the redo steps after a new edit, and undoes an edit not yet settled', () => {
    loadLab({ net: new Network(), layout: {}, tasks: emptyProgress() });
    addDevice('pc', { x: 0, y: 0 });
    settle();
    undo();
    addDevice('router', { x: 0, y: 0 });
    redo(); // the undone PC is gone for good
    expect(names()).toEqual(['r1']);
    undo(); // the router is undone even though it was added a moment ago
    expect(names()).toEqual([]);
  });

  it('starts over when another lab is loaded and leaves task progress alone', () => {
    loadLab({ net: new Network(), layout: {}, tasks: emptyProgress() });
    addDevice('pc', { x: 0, y: 0 });
    settle();
    setTasks({ active: 'first-ping', steps: { 'first-ping': 2 } });
    settle();
    undo();
    expect(names()).toEqual([]);
    expect(getLab().tasks.steps['first-ping']).toBe(2);
    loadLab({ net: new Network(), layout: {}, tasks: emptyProgress() });
    undo();
    redo();
    expect(names()).toEqual([]);
  });
});
