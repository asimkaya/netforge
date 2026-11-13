import { useEffect } from 'react';
import { advance, findTask } from '../tasks/tasks.ts';
import { notify, setTasks, useLab } from './lab.ts';

/** Re-checks the active task after every change and records new progress. */
export function useTaskProgress(): void {
  const { net, commands, tasks } = useLab();
  const task = findTask(tasks.active);
  const completed = task ? (tasks.steps[task.id] ?? 0) : 0;
  const next = task ? advance(task, { net, commands }, completed) : 0;
  useEffect(() => {
    if (!task || next === completed) return;
    setTasks({ ...tasks, steps: { ...tasks.steps, [task.id]: next } });
    if (next === task.steps.length) notify(`🎉 Task complete: ${task.title}`);
  });
}
