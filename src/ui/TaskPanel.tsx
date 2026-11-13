import { useState } from 'react';
import { Network } from '../engine/network.ts';
import type { CustomTask } from '../tasks/custom.ts';
import { TASKS, findTask } from '../tasks/tasks.ts';
import { TaskEditor } from './TaskEditor.tsx';
import { getLab, loadLab, setTasks, useLab } from './lab.ts';

/** Renders `code` spans inside task text. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        i % 2 === 1 ? (
          <code
            key={i}
            className="rounded bg-(--nf-bg) px-1 font-mono text-[12px] text-emerald-300"
          >
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

function startTask(id: string): void {
  const lab = getLab();
  const replace =
    lab.net.devices.size === 0 ||
    window.confirm(
      'Starting a task clears the canvas. Export your lab first if you want to keep it. Continue?',
    );
  if (!replace) return;
  loadLab({
    net: new Network(),
    layout: {},
    tasks: { active: id, steps: { ...lab.tasks.steps, [id]: 0 } },
  });
}

/** Plays one of the lab's own tasks on the network as it is (no clearing). */
function startCustom(id: string): void {
  const { tasks } = getLab();
  setTasks({ ...tasks, active: id, steps: { ...tasks.steps, [id]: 0 } });
}

function removeCustom(task: CustomTask): void {
  if (!window.confirm(`Delete the task "${task.title}"?`)) return;
  const { tasks } = getLab();
  setTasks({
    ...tasks,
    active: tasks.active === task.id ? null : tasks.active,
    custom: (tasks.custom ?? []).filter((t) => t.id !== task.id),
  });
}

function CustomTasks({ onEdit }: { onEdit: (task: CustomTask | 'new') => void }) {
  const { tasks } = useLab();
  const custom = tasks.custom ?? [];
  return (
    <section aria-label="Tasks in this lab" className="space-y-2">
      <h3 className="text-xs font-semibold tracking-wider text-(--nf-muted) uppercase">
        Tasks in this lab
      </h3>
      {custom.length === 0 && (
        <p className="text-xs text-(--nf-muted)">
          Teachers: build a network, then write a task for it. It travels with the lab file and the
          share link.
        </p>
      )}
      <ul className="space-y-2">
        {custom.map((t) => (
          <li key={t.id} className="rounded-lg border border-(--nf-border) p-3">
            <h4 className="font-semibold">
              {(tasks.steps[t.id] ?? 0) >= t.steps.length && (
                <span aria-label="completed">✅ </span>
              )}
              {t.title}
            </h4>
            {t.summary && <p className="mt-1 text-xs text-(--nf-muted)">{t.summary}</p>}
            <div className="mt-2 flex gap-2 text-xs">
              <button
                type="button"
                onClick={() => startCustom(t.id)}
                className="rounded bg-(--nf-accent) px-3 py-1 font-semibold text-slate-950 hover:opacity-90"
              >
                Start {t.title}
              </button>
              <button type="button" onClick={() => onEdit(t)} className="underline">
                Edit
              </button>
              <button type="button" onClick={() => removeCustom(t)} className="underline">
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => onEdit('new')}
        className="rounded border border-(--nf-border) px-3 py-1 text-xs hover:border-(--nf-accent)"
      >
        Create a task
      </button>
    </section>
  );
}

function TaskList({ onEdit }: { onEdit: (task: CustomTask | 'new') => void }) {
  const { tasks } = useLab();
  return (
    <div className="space-y-4 p-4 text-sm">
      <div className="space-y-2">
        <h2 className="text-base font-semibold">Welcome to NetForge 👋</h2>
        <p className="text-(--nf-muted)">
          Build networks, wire them up and watch packets move. Start with a guided task, or just
          drag devices onto the canvas and click one to open it.
        </p>
      </div>
      <ul className="space-y-2">
        {TASKS.map((t) => {
          const done = (tasks.steps[t.id] ?? 0) >= t.steps.length;
          return (
            <li key={t.id} className="rounded-lg border border-(--nf-border) p-3">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-semibold">
                  {done && <span aria-label="completed">✅ </span>}
                  {t.title}
                </h3>
              </div>
              <p className="mt-1 text-xs text-(--nf-muted)">{t.summary}</p>
              <button
                type="button"
                onClick={() => startTask(t.id)}
                className="mt-2 rounded bg-(--nf-accent) px-3 py-1 text-xs font-semibold text-slate-950 hover:opacity-90"
              >
                {done ? 'Play again' : 'Start'}
              </button>
            </li>
          );
        })}
      </ul>
      <CustomTasks onEdit={onEdit} />
    </div>
  );
}

function ActiveTask() {
  const { tasks } = useLab();
  const [hintFor, setHintFor] = useState<number | null>(null);
  const task = findTask(tasks.active, tasks.custom);
  if (!task) return null;
  const completed = tasks.steps[task.id] ?? 0;
  const finished = completed >= task.steps.length;
  const quit = () => setTasks({ ...tasks, active: null });

  return (
    <section
      className="space-y-3 border-b border-(--nf-border) p-4 text-sm"
      aria-label="Current task"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">{task.title}</h2>
        <span className="text-xs text-(--nf-muted)">
          {Math.min(completed, task.steps.length)}/{task.steps.length}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-(--nf-bg)" aria-hidden>
        <div
          className="h-full bg-emerald-400 transition-all"
          style={{ width: `${(completed / task.steps.length) * 100}%` }}
        />
      </div>
      <ol className="space-y-2">
        {task.steps.map((step, i) => {
          const state = i < completed ? 'done' : i === completed ? 'current' : 'todo';
          return (
            <li
              key={step.title}
              aria-current={state === 'current' ? 'step' : undefined}
              className={`rounded p-2 ${state === 'current' ? 'bg-(--nf-bg)' : ''} ${
                state === 'todo' ? 'opacity-50' : ''
              }`}
            >
              <div className="flex gap-2">
                <span aria-hidden>
                  {state === 'done' ? '✅' : state === 'current' ? '👉' : '⬜'}
                </span>
                <span
                  className={state === 'done' ? 'text-(--nf-muted) line-through' : 'font-medium'}
                >
                  {step.title}
                </span>
              </div>
              {state === 'current' && (
                <div className="mt-1 ml-6 space-y-1 text-xs">
                  <p>
                    <Rich text={step.detail} />
                  </p>
                  {step.hint &&
                    (hintFor === i ? (
                      <p className="text-(--nf-muted)">
                        💡 <Rich text={step.hint} />
                      </p>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setHintFor(i)}
                        className="text-(--nf-accent) underline"
                      >
                        Show a hint
                      </button>
                    ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {finished && (
        <p
          className="rounded border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs"
          role="status"
        >
          <Rich text={task.done} />
        </p>
      )}
      <button type="button" onClick={quit} className="text-xs text-(--nf-muted) underline">
        {finished ? 'Back to all tasks' : 'Leave task (keep the lab)'}
      </button>
    </section>
  );
}

/** Right sidebar: the current task, the task editor, or the welcome text and task list. */
export function Sidebar() {
  const { tasks } = useLab();
  const [editing, setEditing] = useState<CustomTask | 'new' | null>(null);
  if (editing) {
    return (
      <TaskEditor
        initial={editing === 'new' ? null : editing}
        onCancel={() => setEditing(null)}
        onSave={(task) => {
          const custom = getLab().tasks.custom ?? [];
          const others = custom.filter((t) => t.id !== task.id);
          const at = custom.findIndex((t) => t.id === task.id);
          const next =
            at < 0 ? [...custom, task] : custom.map((t) => (t.id === task.id ? task : t));
          setTasks({ ...getLab().tasks, custom: at < 0 ? [...others, task] : next });
          setEditing(null);
        }}
      />
    );
  }
  return findTask(tasks.active, tasks.custom) ? <ActiveTask /> : <TaskList onEdit={setEditing} />;
}
