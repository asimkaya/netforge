import { useEffect, useSyncExternalStore } from 'react';
import { doneChapters, rankOf } from '../tasks/campaign.ts';
import { focusOf, type Focus } from '../tasks/focus.ts';
import { advance, findTask, TASKS } from '../tasks/tasks.ts';
import { notify, setTasks, useLab } from './lab.ts';

export interface Celebration {
  id: string;
  /** The new rank when this chapter raised it. */
  promoted: string | null;
}

// UI-only state outside React, so the effect below can set it without a render loop.
let shown: Celebration | null = null;
const listeners = new Set<() => void>();
function show(next: Celebration | null): void {
  shown = next;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/**
 * Re-checks the active task after every change and records new progress. Returns the
 * celebration to show when a built-in chapter was just finished (UI state, not saved).
 */
export function useTaskProgress(): { celebration: Celebration | null; dismiss: () => void } {
  const celebration = useSyncExternalStore(subscribe, () => shown);
  const { net, commands, tasks } = useLab();
  const task = findTask(tasks.active, tasks.custom);
  const completed = task ? (tasks.steps[task.id] ?? 0) : 0;
  const next = task ? advance(task, { net, commands }, completed) : 0;
  useEffect(() => {
    if (!task || next === completed) return;
    setTasks({ ...tasks, steps: { ...tasks.steps, [task.id]: next } });
    const upNext = task.steps[next];
    if (upNext) notify(`✓ Step ${next} done. Next: ${upNext.title}`);
    else if (TASKS.some((t) => t.id === task.id)) {
      const before = rankOf(doneChapters(tasks.steps)).rank;
      const after = rankOf(doneChapters({ ...tasks.steps, [task.id]: next })).rank;
      show({ id: task.id, promoted: after !== before ? after.title : null });
    } else notify(`🎉 Task complete: ${task.title}`);
  });
  return { celebration, dismiss: () => show(null) };
}

/** What the current step of the active task points at, or null without a task. */
export function useTaskFocus(): Focus | null {
  const { net, tasks } = useLab();
  const task = findTask(tasks.active, tasks.custom);
  const step = task?.steps[tasks.steps[task.id] ?? 0];
  return step ? focusOf(step, net) : null;
}
