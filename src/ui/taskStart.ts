import { getViewportForBounds, type useReactFlow } from '@xyflow/react';
import { TASKS } from '../tasks/tasks.ts';
import { SOLUTIONS } from '../tasks/solutions.ts';
import { Lab } from './labBuilder.ts';
import { getLab, loadLab } from './lab.ts';
import { boundsOf } from './placement.ts';
import type { Project } from './project.ts';

type Flow = ReturnType<typeof useReactFlow>;

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

/** Zooms the canvas to show a whole network, whatever the view was looking at before. */
export function showAll(flow: Flow, project: Project): void {
  const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
  const placed = [...project.net.devices.values()].flatMap((d) => {
    const at = project.layout[d.id];
    return at ? [{ spec: d.spec.id, at }] : [];
  });
  if (!pane || placed.length === 0) return;
  void flow.setViewport(
    getViewportForBounds(boundsOf(placed), pane.width, pane.height, 0.2, 1, 0.08),
  );
}

/** Replaces the lab with the network a task starts from: what the earlier tasks build. */
export function loadStart(id: string, flow: Flow): void {
  const project = startOf(id);
  loadLab({ ...project, tasks: { active: id, steps: { ...getLab().tasks.steps, [id]: 0 } } });
  showAll(flow, project);
}

/** What the first guided task's Start button does on an empty canvas. */
export function startFirstTask(flow: Flow): void {
  const first = TASKS[0];
  if (first) loadStart(first.id, flow);
}
