import { describe, expect, it } from 'vitest';
import { Network } from '../engine/network.ts';
import type { CustomTask } from '../tasks/custom.ts';
import { getLab, loadLab, openLab } from './lab.ts';

const task: CustomTask = { id: 'custom-fix-it', title: 'Fix it', summary: '', steps: [], done: '' };

describe('openLab', () => {
  it("keeps this browser's progress and takes the file's custom tasks", () => {
    loadLab({
      net: new Network(),
      layout: {},
      tasks: { active: 'first-ping', steps: { 'first-ping': 3, routing: 5 } },
    });
    openLab({
      net: new Network(),
      layout: {},
      tasks: { active: 'custom-fix-it', steps: { routing: 0 }, custom: [task] },
    });
    expect(getLab().tasks).toEqual({
      active: 'custom-fix-it',
      steps: { 'first-ping': 3, routing: 5 },
      custom: [task],
    });
  });

  it('does not keep a built-in task running on a lab it was not built for', () => {
    loadLab({ net: new Network(), layout: {}, tasks: { active: 'routing', steps: {} } });
    openLab({ net: new Network(), layout: {}, tasks: { active: 'routing', steps: {} } });
    expect(getLab().tasks.active).toBeNull();
  });
});
