import { TASKS } from '../tasks/tasks.ts';
import { SOLUTIONS } from '../tasks/solutions.ts';
import { Lab } from './labBuilder.ts';
import type { Project } from './project.ts';

/**
 * The network a task starts from: an empty lab with the solutions of all earlier tasks
 * applied, so it is exactly what a learner has built by finishing them.
 */
export function startOf(taskId: string): Project {
  const lab = new Lab();
  for (const task of TASKS) {
    if (task.id === taskId) break;
    lab.apply(SOLUTIONS[task.id] ?? []);
  }
  return lab.done();
}
