import { useEffect } from 'react';
import { focusOf, type Focus } from '../tasks/focus.ts';
import { advance, findTask } from '../tasks/tasks.ts';
import { notify, setTasks, useLab } from './lab.ts';

/** Re-checks the active task after every change and records new progress. */
export function useTaskProgress(): void {
  const { net, commands, tasks } = useLab();
  const task = findTask(tasks.active, tasks.custom);
  const completed = task ? (tasks.steps[task.id] ?? 0) : 0;
  const next = task ? advance(task, { net, commands }, completed) : 0;
  useEffect(() => {
    if (!task || next === completed) return;
    setTasks({ ...tasks, steps: { ...tasks.steps, [task.id]: next } });
    const upNext = task.steps[next];
    if (!upNext) notify(`🎉 Task complete: ${task.title}`);
    else notify(`✓ Step ${next} done. Next: ${upNext.title}`);
  });
}

/** What the current step of the active task points at, or null without a task. */
export function useTaskFocus(): Focus | null {
  const { net, tasks } = useLab();
  const task = findTask(tasks.active, tasks.custom);
  const step = task?.steps[tasks.steps[task.id] ?? 0];
  return step ? focusOf(step, net) : null;
}
