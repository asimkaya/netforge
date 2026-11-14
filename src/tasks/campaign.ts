import { TASKS } from './tasks.ts';

export interface Act {
  id: string;
  title: string;
  taskIds: string[];
}

/** The guided chapters grouped into acts, in the order of `TASKS`. */
export const ACTS: Act[] = [
  { id: 'day-one', title: 'Act 1: Your first day', taskIds: ['first-ping', 'meet-the-switch'] },
  {
    id: 'growing-office',
    title: 'Act 2: The office grows',
    taskIds: ['two-networks', 'dhcp', 'vlans', 'inter-vlan'],
  },
  { id: 'branches', title: 'Act 3: Beyond the office', taskIds: ['ospf', 'nat', 'vpn'] },
];

export type ChapterState = 'done' | 'available' | 'locked';

const isDone = (id: string, steps: Record<string, number>): boolean => {
  const task = TASKS.find((t) => t.id === id);
  return !!task && (steps[id] ?? 0) >= task.steps.length;
};

/** A chapter is locked until the one before it is done; the first is always open. */
export function chapterState(id: string, steps: Record<string, number>): ChapterState {
  if (isDone(id, steps)) return 'done';
  const at = TASKS.findIndex((t) => t.id === id);
  const before = TASKS[at - 1];
  return before && !isDone(before.id, steps) ? 'locked' : 'available';
}
