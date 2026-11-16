import { describe, expect, it } from 'vitest';
import { Network } from '../engine/network.ts';
import type { CustomTask } from '../tasks/custom.ts';
import { MAX_TERMINAL_LINES, getLab, loadLab, openLab, runCommand, session } from './lab.ts';

const task: CustomTask = { id: 'custom-fix-it', title: 'Fix it', summary: '', steps: [], done: '' };

describe('terminal', () => {
  it('keeps the last MAX_TERMINAL_LINES lines of output', () => {
    const net = new Network();
    const pc = net.addDevice('pc');
    loadLab({ net, layout: {}, tasks: { active: null, steps: {} } });
    for (let i = 0; i < 1100; i++) runCommand(pc.id, 'echo hi');
    const lines = session(pc.id).lines;
    expect(lines).toHaveLength(MAX_TERMINAL_LINES);
    expect(lines.at(-1)).toBe('hi');
    expect(getLab().commands.length).toBeLessThanOrEqual(500);
  });
});

describe('openLab', () => {
  it('merges progress, keeping the furthest step of each task, and takes the custom tasks', () => {
    loadLab({
      net: new Network(),
      layout: {},
      tasks: { active: 'first-ping', steps: { 'first-ping': 3, routing: 5 } },
    });
    openLab({
      net: new Network(),
      layout: {},
      tasks: { active: 'custom-fix-it', steps: { routing: 0, vlans: 2 }, custom: [task] },
    });
    expect(getLab().tasks).toEqual({
      active: 'custom-fix-it',
      steps: { 'first-ping': 3, routing: 5, vlans: 2 },
      custom: [task],
    });
  });
});
