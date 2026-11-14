import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Network } from '../engine/network.ts';
import { startHistory, undo } from './history.ts';
import { addDevice, getLab, loadLab, removeDevice, select, setSelection } from './lab.ts';
import { emptyProgress } from './project.ts';

const names = () => [...getLab().net.devices.values()].map((d) => d.name);

describe('selection', () => {
  let stop: () => void;
  beforeAll(() => {
    vi.useFakeTimers();
    stop = startHistory();
  });
  afterAll(() => {
    stop();
    vi.useRealTimers();
  });

  it('keeps several devices selected, the last one being the clicked one', () => {
    loadLab({ net: new Network(), layout: {}, tasks: emptyProgress() });
    addDevice('pc', { x: 0, y: 0 });
    addDevice('pc', { x: 200, y: 0 });
    setSelection(['d1', 'd2']);
    expect(getLab().selection).toEqual(['d1', 'd2']);
    expect(getLab().selected).toBe('d2');
    select('d1');
    expect(getLab().selection).toEqual(['d1']);
    select(null);
    expect(getLab().selected).toBeNull();
  });

  it('deleting the selection is one undo step and clears the selection', () => {
    loadLab({ net: new Network(), layout: {}, tasks: emptyProgress() });
    addDevice('pc', { x: 0, y: 0 });
    addDevice('pc', { x: 200, y: 0 });
    addDevice('switch', { x: 0, y: 200 });
    vi.advanceTimersByTime(500);
    setSelection(['d1', 'd3']);
    for (const id of getLab().selection) removeDevice(id);
    vi.advanceTimersByTime(500);
    expect(names()).toEqual(['pc2']);
    expect(getLab().selection).toEqual([]);
    undo();
    expect(names()).toEqual(['pc1', 'pc2', 'sw1']);
  });
});
