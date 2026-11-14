import { getViewportForBounds, useReactFlow } from '@xyflow/react';
import { useState, type ReactNode } from 'react';
import type { CustomTask } from '../tasks/custom.ts';
import { TASKS, findTask, type Task } from '../tasks/tasks.ts';
import { TaskEditor } from './TaskEditor.tsx';
import { continueTask, getLab, loadLab, notify, setTasks, useLab } from './lab.ts';
import { boundsOf } from './placement.ts';
import type { Project } from './project.ts';
import { SCENARIOS, type Scenario } from './scenarios.ts';
import { startOf } from './taskStart.ts';

const PRIMARY =
  'rounded bg-(--nf-accent) px-3 py-1 text-xs font-semibold text-slate-950 hover:opacity-90';
const SECONDARY =
  'rounded border border-(--nf-border) px-3 py-1 text-xs hover:border-(--nf-accent)';
const CARD = 'rounded-lg border bg-(--nf-bg)/40 p-3';

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

/**
 * A button for actions that replace the lab. With devices on the canvas it first asks,
 * right where it was clicked, instead of opening a browser dialog. With `keep` it offers a
 * third way: carry on with the network that is there.
 */
function ReplaceButton({
  onConfirm,
  label,
  keep,
  replaceLabel = 'Replace',
  children,
}: {
  onConfirm: () => void;
  /** Accessible name, when the visible text alone does not say what it starts. */
  label?: string;
  keep?: { label: string; onKeep: () => void };
  replaceLabel?: string;
  children: ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button
        type="button"
        className={PRIMARY}
        aria-label={label}
        onClick={() => (getLab().net.devices.size === 0 ? onConfirm() : setAsking(true))}
      >
        {children}
      </button>
    );
  }
  const answer = (action: () => void) => () => {
    setAsking(false);
    action();
  };
  return (
    <div
      role="alertdialog"
      aria-label={
        keep ? 'Which network should the task use?' : 'Replace the network on the canvas?'
      }
      className="w-full space-y-2 rounded border border-amber-500/50 bg-amber-500/10 p-2 text-xs"
    >
      <p>
        {keep
          ? 'There are devices on the canvas. Work on them, or start from the network this task expects? Loading it replaces yours: export yours first (Lab menu) to keep it.'
          : 'This replaces the network on the canvas. Export it first (Lab menu) to keep it.'}
      </p>
      <div className="flex flex-wrap gap-2">
        {keep && (
          <button type="button" className={PRIMARY} onClick={answer(keep.onKeep)}>
            {keep.label}
          </button>
        )}
        <button type="button" className={keep ? SECONDARY : PRIMARY} onClick={answer(onConfirm)}>
          {replaceLabel}
        </button>
        <button type="button" className={SECONDARY} onClick={() => setAsking(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Zooms the canvas to show a whole network, whatever the view was looking at before. */
function showAll(flow: ReturnType<typeof useReactFlow>, project: Project): void {
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
function loadStart(id: string, flow: ReturnType<typeof useReactFlow>): void {
  const project = startOf(id);
  loadLab({ ...project, tasks: { active: id, steps: { ...getLab().tasks.steps, [id]: 0 } } });
  showAll(flow, project);
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

/** A round step or lesson number that turns into a check mark when done. */
function Badge({ n, state }: { n: number; state: 'done' | 'current' | 'todo' }) {
  const look =
    state === 'done'
      ? 'bg-emerald-500 text-slate-950'
      : state === 'current'
        ? 'bg-(--nf-accent) text-slate-950'
        : 'border border-(--nf-border) text-(--nf-muted)';
  return (
    <span
      aria-hidden
      className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold ${look}`}
    >
      {state === 'done' ? '✓' : n}
    </span>
  );
}

function Progress({ value, max }: { value: number; max: number }) {
  return (
    <div className="h-1.5 overflow-hidden rounded bg-(--nf-bg)" aria-hidden>
      <div
        className="h-full bg-emerald-400 transition-all"
        style={{ width: `${(Math.min(value, max) / max) * 100}%` }}
      />
    </div>
  );
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
          <li key={t.id} className={`${CARD} border-(--nf-border)`}>
            <h4 className="font-semibold">
              {(tasks.steps[t.id] ?? 0) >= t.steps.length && (
                <span aria-label="completed">✅ </span>
              )}
              {t.title}
            </h4>
            {t.summary && <p className="mt-1 text-xs text-(--nf-muted)">{t.summary}</p>}
            <div className="mt-2 flex items-center gap-3 text-xs">
              <button type="button" onClick={() => startCustom(t.id)} className={PRIMARY}>
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
      <button type="button" onClick={() => onEdit('new')} className={SECONDARY}>
        Create a task
      </button>
    </section>
  );
}

function GuidedTasks({ onEdit }: { onEdit: (task: CustomTask | 'new') => void }) {
  const { tasks } = useLab();
  const flow = useReactFlow();
  const isDone = (t: Task) => (tasks.steps[t.id] ?? 0) >= t.steps.length;
  const doneCount = TASKS.filter(isDone).length;
  const next = TASKS.find((t) => !isDone(t));
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-xs text-(--nf-muted)">
          The tasks build one network that grows from task to task, and every step checks your work.
        </p>
        <div className="flex items-center gap-2 text-xs text-(--nf-muted)">
          <div className="flex-1">
            <Progress value={doneCount} max={TASKS.length} />
          </div>
          {doneCount}/{TASKS.length} done
        </div>
      </div>
      <ol className="space-y-2">
        {TASKS.map((t, i) => {
          const done = isDone(t);
          const upNext = t === next;
          return (
            <li
              key={t.id}
              className={`${CARD} ${upNext ? 'border-(--nf-accent)/60' : 'border-(--nf-border)'}`}
            >
              <div className="flex items-start gap-2">
                <Badge n={i + 1} state={done ? 'done' : upNext ? 'current' : 'todo'} />
                <div className="min-w-0 flex-1">
                  <h3 className="leading-5 font-semibold">
                    {done && <span className="sr-only">Completed: </span>}
                    {t.title}
                  </h3>
                  <p className="mt-0.5 text-xs text-(--nf-muted)">{t.summary}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <ReplaceButton
                      onConfirm={() => loadStart(t.id, flow)}
                      keep={{ label: 'Continue on my network', onKeep: () => continueTask(t.id) }}
                      replaceLabel="Load the starting network"
                      label={`${done ? 'Play again' : 'Start'}: ${t.title}`}
                    >
                      {done ? 'Play again' : 'Start'}
                    </ReplaceButton>
                    <span className="text-[11px] text-(--nf-muted)">{t.steps.length} steps</span>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <CustomTasks onEdit={onEdit} />
    </div>
  );
}

const LEVEL_LOOK: Record<Scenario['level'], string> = {
  Basic: 'bg-emerald-500/15 text-emerald-300',
  Intermediate: 'bg-amber-500/15 text-amber-300',
  Advanced: 'bg-rose-500/15 text-rose-300',
};

function Scenarios() {
  // The network opened last keeps its "what to try" list unfolded.
  const [opened, setOpened] = useState<string | null>(null);
  const flow = useReactFlow();
  const open = (scenario: Scenario) => {
    const project = scenario.build();
    loadLab({ ...project, tasks: { active: null, steps: getLab().tasks.steps } });
    setOpened(scenario.id);
    notify(`Opened "${scenario.title}". Everything is set up: click a device to look inside.`);
    showAll(flow, project);
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-(--nf-muted)">
        Finished networks to explore, break and extend. Nothing to set up: open one and start poking
        around.
      </p>
      <ul className="space-y-2">
        {SCENARIOS.map((s) => (
          <li key={s.id} className={`${CARD} border-(--nf-border)`} aria-label={s.title}>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${LEVEL_LOOK[s.level]}`}
            >
              {s.level}
            </span>
            <h3 className="mt-1.5 font-semibold">{s.title}</h3>
            <p className="mt-0.5 text-xs text-(--nf-muted)">{s.summary}</p>
            <details className="mt-2 text-xs" open={opened === s.id}>
              <summary className="cursor-pointer text-(--nf-accent)">What to try</summary>
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {s.tryIt.map((line) => (
                  <li key={line}>
                    <Rich text={line} />
                  </li>
                ))}
              </ul>
            </details>
            <div className="mt-2">
              <ReplaceButton onConfirm={() => open(s)}>Open {s.title}</ReplaceButton>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Tab = 'tasks' | 'networks';
const TABS: { id: Tab; label: string }[] = [
  { id: 'tasks', label: 'Guided tasks' },
  { id: 'networks', label: 'Ready networks' },
];

function Home({ onEdit }: { onEdit: (task: CustomTask | 'new') => void }) {
  const [tab, setTab] = useState<Tab>('tasks');
  return (
    <div className="space-y-4 p-4 text-sm">
      <h2 className="text-base font-semibold">Welcome to NetForge 👋</h2>
      <div role="tablist" className="flex rounded-lg border border-(--nf-border) p-0.5 text-xs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 rounded-md px-2 py-1 ${
              tab === t.id ? 'bg-(--nf-accent) font-semibold text-slate-950' : 'text-(--nf-muted)'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'tasks' ? <GuidedTasks onEdit={onEdit} /> : <Scenarios />}
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
  const following = TASKS[TASKS.findIndex((t) => t.id === task.id) + 1];

  return (
    <section className="space-y-3 p-4 text-sm" aria-label="Current task">
      <button type="button" onClick={quit} className="text-xs text-(--nf-muted) hover:underline">
        ← {finished ? 'Back to all tasks' : 'Leave task (keep the lab)'}
      </button>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{task.title}</h2>
        <span className="shrink-0 rounded bg-(--nf-bg) px-1.5 py-0.5 font-mono text-xs">
          {Math.min(completed, task.steps.length)}/{task.steps.length}
        </span>
      </div>
      <Progress value={completed} max={task.steps.length} />
      <ol className="space-y-1">
        {task.steps.map((step, i) => {
          const state = i < completed ? 'done' : i === completed ? 'current' : 'todo';
          return (
            <li
              key={step.title}
              aria-current={state === 'current' ? 'step' : undefined}
              className={`rounded-lg p-2 ${
                state === 'current' ? 'border border-(--nf-accent)/60 bg-(--nf-bg)' : ''
              } ${state === 'todo' ? 'opacity-50' : ''}`}
            >
              <div className="flex gap-2">
                <Badge n={i + 1} state={state} />
                <span
                  className={`leading-5 ${state === 'done' ? 'text-(--nf-muted) line-through' : 'font-medium'}`}
                >
                  {step.title}
                </span>
              </div>
              {state === 'current' && (
                <div className="mt-1 ml-7 space-y-1.5 text-xs">
                  <p>
                    <Rich text={step.detail} />
                  </p>
                  {step.hint &&
                    (hintFor === i ? (
                      <p className="rounded bg-(--nf-surface) p-2 text-(--nf-muted)">
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
                  <p className="text-[11px] text-(--nf-muted)">
                    The glowing parts of the screen show where to work. This step ticks itself off
                    when it is done.
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {finished && (
        <div className="space-y-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs">
          <p role="status">
            <Rich text={task.done} />
          </p>
          {following && (
            <button type="button" className={PRIMARY} onClick={() => continueTask(following.id)}>
              Next task: {following.title}
            </button>
          )}
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
      className="absolute bottom-3 left-1/2 z-20 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-full border border-(--nf-accent)/60 bg-(--nf-surface) py-1.5 pr-4 pl-2 text-xs shadow-lg hover:border-(--nf-accent)"
    >
      <Badge n={completed + 1} state="current" />
      <span className="truncate">
        <span className="text-(--nf-muted)">
          Step {completed + 1}/{task.steps.length}:
        </span>{' '}
        {step.title}
      </span>
    </button>
  );
}

/** Right sidebar: the current task, the task editor, or the welcome text and lists. */
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
  return findTask(tasks.active, tasks.custom) ? (
    <ActiveTask key={tasks.active} />
  ) : (
    <Home onEdit={setEditing} />
  );
}
