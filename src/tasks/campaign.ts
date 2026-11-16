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
    taskIds: [
      'two-networks',
      'dhcp',
      'first-print',
      'lobby-camera',
      'meeting-room-wifi',
      'intranet',
      'vlans',
      'inter-vlan',
    ],
  },
  {
    id: 'branches',
    title: 'Act 3: Beyond the office',
    taskIds: ['ospf', 'nat', 'guest-wifi', 'server-lockdown', 'vpn'],
  },
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

export interface Rank {
  title: string;
  /** Chapters that must be done to hold this rank. */
  at: number;
}

/** Chapters up to the end of the first `acts` acts. */
const chaptersThrough = (acts: number) =>
  ACTS.slice(0, acts).reduce((n, a) => n + a.taskIds.length, 0);

/** Ranks follow the story: Act 1 done, half of Act 2, all of Act 2, everything. */
const act1 = chaptersThrough(1);
const act2 = chaptersThrough(2);
export const RANKS: Rank[] = [
  { title: 'Intern', at: 0 },
  { title: 'Junior Admin', at: act1 },
  { title: 'Network Technician', at: act1 + Math.ceil((act2 - act1) / 2) },
  { title: 'Network Engineer', at: act2 },
  { title: 'Network Architect', at: TASKS.length },
];

export function doneChapters(steps: Record<string, number>): number {
  return TASKS.filter((t) => isDone(t.id, steps)).length;
}

/** The rank for a number of done chapters, the one after it and how many chapters it needs. */
export function rankOf(doneCount: number): { rank: Rank; next: Rank | null; needed: number } {
  const earned = RANKS.filter((r) => r.at <= doneCount);
  const rank = earned[earned.length - 1] ?? { title: 'Intern', at: 0 };
  const next = RANKS.find((r) => r.at > doneCount) ?? null;
  return { rank, next, needed: next ? next.at - doneCount : 0 };
}
