import { Suspense, useState } from 'react';
import type { CustomTask } from '../tasks/custom.ts';
import { TASKS, findTask } from '../tasks/tasks.ts';
import { TaskEditor } from './lazyViews.ts';
import { continueTask, getLab, setTasks, useLab } from './lab.ts';
import { downloadReport } from './reportActions.ts';
import { Marker, PartsList, Progress, Rich } from './taskParts.tsx';
import { LINK, PRIMARY, SECONDARY } from './styles.ts';

export type Tab = 'tasks' | 'networks' | 'troubleshooting';

function ActiveTask({ onLeave, onHide }: { onLeave: () => void; onHide: () => void }) {
  const { tasks, net, commands } = useLab();
  const [hintFor, setHintFor] = useState<number | null>(null);
  // Challenges reveal their hints one by one.
  const [hintsShown, setHintsShown] = useState(0);
  const task = findTask(tasks.active, tasks.custom);
  if (!task) return null;
  const completed = tasks.steps[task.id] ?? 0;
  const finished = completed >= task.steps.length;
  const quit = () => {
    setTasks({ ...tasks, active: null });
    onLeave();
  };
  const at = TASKS.findIndex((t) => t.id === task.id);
  const following = at < 0 ? undefined : TASKS[at + 1];
  const hints = task.hints ?? [];

  return (
    <section className="space-y-3 p-4 text-sm" aria-label="Current task">
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={quit} className="text-xs text-(--nf-muted) hover:underline">
          ← {finished ? 'Back to all tasks' : 'Leave task (keep the lab)'}
        </button>
        <button
          type="button"
          onClick={onHide}
          className="text-xs text-(--nf-muted) hover:underline"
        >
          Hide
        </button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{task.title}</h2>
        <span className="shrink-0 font-mono text-xs text-(--nf-muted)">
          {Math.min(completed, task.steps.length)}/{task.steps.length}
        </span>
      </div>
      <Progress value={completed} max={task.steps.length} />
      {task.brief && (
        <blockquote className="rounded border border-(--nf-border) bg-(--nf-raised) p-3 text-xs">
          <p className="mb-1 font-semibold">From {task.brief.from}</p>
          <p>{task.brief.text}</p>
        </blockquote>
      )}
      {task.symptom && (
        <p className="border-l-[3px] border-(--nf-warn) bg-(--nf-raised) p-2 text-xs">
          <span className="font-semibold">The complaint: </span>
          {task.symptom}
        </p>
      )}
      <ol>
        {task.steps.map((step, i) => {
          const state = i < completed ? 'done' : i === completed ? 'current' : 'todo';
          return (
            <li
              key={step.title}
              aria-current={state === 'current' ? 'step' : undefined}
              className="relative pb-3 pl-8 last:pb-0"
            >
              {i < task.steps.length - 1 && (
                <span
                  aria-hidden
                  className="absolute top-6 bottom-0 left-[9px] w-px bg-(--nf-border)"
                />
              )}
              <span className="absolute top-0 left-0">
                <Marker n={i + 1} state={state} />
              </span>
              <span
                className={`block leading-5 ${
                  state === 'done'
                    ? 'text-(--nf-muted) line-through'
                    : state === 'current'
                      ? 'font-semibold'
                      : 'text-(--nf-muted)'
                }`}
              >
                {step.title}
              </span>
              {state === 'current' && (
                <div className="mt-1 space-y-2 text-xs">
                  <p>
                    <Rich text={step.detail} />
                  </p>
                  {step.parts && step.parts.length > 0 && (
                    <PartsList parts={step.parts} ctx={{ net, commands }} />
                  )}
                  {step.hint &&
                    (hintFor === i ? (
                      <p className="ml-1 border-l border-(--nf-border) pl-3 text-(--nf-muted)">
                        <Rich text={step.hint} />
                      </p>
                    ) : (
                      <button type="button" onClick={() => setHintFor(i)} className={LINK}>
                        Show a hint
                      </button>
                    ))}
                  <p className="text-(--nf-muted)">
                    The highlighted parts of the screen show where to work. This step ticks itself
                    off when it is done.
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {!finished && hints.length > 0 && (
        <div className="space-y-2 text-xs">
          {hints.slice(0, hintsShown).map((hint, i) => (
            <p key={hint} className="border-l border-(--nf-border) pl-3 text-(--nf-muted)">
              <span className="font-semibold text-(--nf-text)">Hint {i + 1}: </span>
              <Rich text={hint} />
            </p>
          ))}
          {hintsShown < hints.length && (
            <button type="button" onClick={() => setHintsShown(hintsShown + 1)} className={LINK}>
              {hintsShown === 0 ? 'Show a hint' : 'Show another hint'}
            </button>
          )}
        </div>
      )}
      {finished && (
        <div className="space-y-2 border-l-[3px] border-(--nf-ok) bg-(--nf-raised) p-3 text-xs">
          <p role="status">
            <Rich text={task.done} />
          </p>
          <div className="flex flex-wrap gap-2">
            {following && (
              <button type="button" className={PRIMARY} onClick={() => continueTask(following.id)}>
                Next task: {following.title}
              </button>
            )}
            <button type="button" className={SECONDARY} onClick={downloadReport}>
              Download progress report
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The current step in one line, floating over the canvas. Shown while the side panel is
 * hidden (always the case on phones), so a running task never disappears from view.
 */
export function Coach({ onOpen }: { onOpen: () => void }) {
  const { tasks } = useLab();
  const task = findTask(tasks.active, tasks.custom);
  const completed = task ? (tasks.steps[task.id] ?? 0) : 0;
  const step = task?.steps[completed];
  if (!task || !step) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Current task step: ${step.title}. Show the task panel.`}
      className="absolute bottom-3 left-1/2 z-20 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded border border-(--nf-border) bg-(--nf-surface) py-1.5 pr-3 pl-2 text-xs shadow-lg hover:bg-(--nf-raised)"
    >
      <Marker n={completed + 1} state="current" />
      <span className="truncate">
        <span className="text-(--nf-muted)">
          Step {completed + 1}/{task.steps.length}:
        </span>{' '}
        {step.title}
      </span>
    </button>
  );
}

/** Right sidebar: the running task or the task editor (the App only shows it for those). */
export function Sidebar({
  editing,
  setEditing,
  onLeave,
  onHide,
}: {
  editing: CustomTask | 'new' | null;
  setEditing: (task: CustomTask | 'new' | null) => void;
  /** The learner left the task: back to the Task center. */
  onLeave: () => void;
  onHide: () => void;
}) {
  const { tasks } = useLab();
  if (editing) {
    return (
      <Suspense fallback={<p className="p-4 text-sm text-(--nf-muted)">Loading…</p>}>
        <TaskEditor
          initial={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSave={(task) => {
            const custom = getLab().tasks.custom ?? [];
            const at = custom.findIndex((t) => t.id === task.id);
            setTasks({
              ...getLab().tasks,
              custom: at < 0 ? [...custom, task] : custom.map((t) => (t.id === task.id ? task : t)),
            });
            setEditing(null);
          }}
        />
      </Suspense>
    );
  }
  return <ActiveTask key={tasks.active} onLeave={onLeave} onHide={onHide} />;
}
