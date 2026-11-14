import { useReactFlow } from '@xyflow/react';
import { Suspense, useState, type ReactNode } from 'react';
import type { CustomTask } from '../tasks/custom.ts';
import { CHALLENGES } from '../tasks/challenges.ts';
import { TASKS, findTask, type Task } from '../tasks/tasks.ts';
import { TaskEditor } from './lazyViews.ts';
import { continueTask, getLab, loadLab, notify, setTasks, useLab } from './lab.ts';
import { loadChallenge } from './challengeStart.ts';
import { SCENARIOS } from './scenarios.ts';
import { loadStart, showAll } from './taskStart.ts';
import { downloadReport } from './reportActions.ts';

const PRIMARY =
  'rounded bg-(--nf-accent) px-3 py-1 text-xs font-semibold text-(--nf-on-accent) hover:opacity-90';
const SECONDARY = 'rounded border border-(--nf-border) px-3 py-1 text-xs hover:bg-(--nf-raised)';
const LINK = 'text-(--nf-accent) hover:underline';

function Check({ label }: { label?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d="m3 8.5 3.2 3.2L13 4.8" />
    </svg>
  );
}

/** Renders `code` spans inside task text. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded-sm bg-(--nf-raised) px-1 font-mono text-[12px]">
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
  primary = false,
  children,
}: {
  onConfirm: () => void;
  /** Accessible name, when the visible text alone does not say what it starts. */
  label?: string;
  keep?: { label: string; onKeep: () => void };
  replaceLabel?: string;
  /** The emphasised look, for the one action the learner should take next. */
  primary?: boolean;
  children: ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button
        type="button"
        className={primary ? PRIMARY : SECONDARY}
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
      className="w-full space-y-2 border-l-[3px] border-(--nf-warn) bg-(--nf-raised) p-2 text-xs"
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

/** A step number that turns into a check mark when done. */
function Marker({ n, state }: { n: number; state: 'done' | 'current' | 'todo' }) {
  const look =
    state === 'done'
      ? 'border-(--nf-accent) bg-(--nf-accent) text-(--nf-on-accent)'
      : state === 'current'
        ? 'border-(--nf-accent) text-(--nf-text)'
        : 'border-(--nf-border) text-(--nf-muted)';
  return (
    <span
      aria-hidden
      className={`font-label grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 text-[11px] leading-none font-semibold ${look}`}
    >
      {state === 'done' ? <Check /> : n}
    </span>
  );
}

function Progress({ value, max }: { value: number; max: number }) {
  return (
    <div className="h-1 overflow-hidden bg-(--nf-raised)" aria-hidden>
      <div
        className="h-full bg-(--nf-accent) transition-all"
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
      <h3 className="text-base font-semibold">Tasks in this lab</h3>
      {custom.length === 0 && (
        <p className="text-xs text-(--nf-muted)">
          Teachers: build a network, then write a task for it. It travels with the lab file and the
          share link.
        </p>
      )}
      <ul className="divide-y divide-(--nf-border) border-y border-(--nf-border)">
        {custom.map((t) => (
          <li key={t.id} className="py-3">
            <h4 className="flex items-center gap-1 font-semibold">
              {(tasks.steps[t.id] ?? 0) >= t.steps.length && (
                <span className="text-(--nf-ok)">
                  <Check label="completed" />
                </span>
              )}
              {t.title}
            </h4>
            {t.summary && <p className="mt-1 text-xs text-(--nf-muted)">{t.summary}</p>}
            <div className="mt-2 flex items-center gap-3 text-xs">
              <button type="button" onClick={() => startCustom(t.id)} className={SECONDARY}>
                Start {t.title}
              </button>
              <button type="button" onClick={() => onEdit(t)} className={LINK}>
                Edit
              </button>
              <button type="button" onClick={() => removeCustom(t)} className={LINK}>
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
      <ol className="divide-y divide-(--nf-border) border-y border-(--nf-border)">
        {TASKS.map((t, i) => {
          const done = isDone(t);
          const upNext = t === next;
          return (
            <li key={t.id} className="relative flex items-start gap-3 py-3 pl-3">
              {upNext && (
                <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-(--nf-accent)" />
              )}
              <span className="font-label w-5 shrink-0 text-base leading-5 font-semibold text-(--nf-muted)">
                {done ? (
                  <span className="text-(--nf-ok)">
                    <Check />
                  </span>
                ) : (
                  i + 1
                )}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className={`leading-5 font-semibold ${done ? 'text-(--nf-muted)' : ''}`}>
                  {done && <span className="sr-only">Completed: </span>}
                  {t.title}
                </h3>
                <p className="mt-0.5 text-xs text-(--nf-muted)">{t.summary}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <ReplaceButton
                    primary={upNext}
                    onConfirm={() => loadStart(t.id, flow)}
                    keep={{ label: 'Continue on my network', onKeep: () => continueTask(t.id) }}
                    replaceLabel="Load the starting network"
                    label={`${done ? 'Play again' : 'Start'}: ${t.title}`}
                  >
                    {done ? 'Play again' : 'Start'}
                  </ReplaceButton>
                  <span className="text-xs text-(--nf-muted)">{t.steps.length} steps</span>
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

function Scenarios() {
  // The network opened last keeps its "what to try" list unfolded.
  const [opened, setOpened] = useState<string | null>(null);
  const flow = useReactFlow();
  const open = (scenario: (typeof SCENARIOS)[number]) => {
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
      <ul className="divide-y divide-(--nf-border) border-y border-(--nf-border)">
        {SCENARIOS.map((s) => (
          <li key={s.id} className="py-3" aria-label={s.title}>
            <p className="text-xs text-(--nf-muted)">{s.level}</p>
            <h3 className="font-semibold">{s.title}</h3>
            <p className="mt-0.5 text-xs text-(--nf-muted)">{s.summary}</p>
            <details className="mt-2 text-xs" open={opened === s.id}>
              <summary className="cursor-pointer text-(--nf-accent) hover:underline">
                What to try
              </summary>
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

function Troubleshooting() {
  const { tasks } = useLab();
  const flow = useReactFlow();
  const isDone = (id: string) => (tasks.steps[id] ?? 0) >= (findTask(id)?.steps.length ?? 1);
  const doneCount = CHALLENGES.filter((c) => isDone(c.id)).length;
  const next = CHALLENGES.find((c) => !isDone(c.id));
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-xs text-(--nf-muted)">
          Each challenge hands you a network that used to work. Reproduce the complaint, find the
          fault and fix it. The failure explanation in the terminal and three hints are there to
          help.
        </p>
        <div className="flex items-center gap-2 text-xs text-(--nf-muted)">
          <div className="flex-1">
            <Progress value={doneCount} max={CHALLENGES.length} />
          </div>
          {doneCount}/{CHALLENGES.length} fixed
        </div>
      </div>
      <ul className="divide-y divide-(--nf-border) border-y border-(--nf-border)">
        {CHALLENGES.map((c) => {
          const done = isDone(c.id);
          return (
            <li key={c.id} className="relative py-3 pl-3" aria-label={c.title}>
              {c === next && (
                <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-(--nf-accent)" />
              )}
              <p className="text-xs text-(--nf-muted)">{c.level}</p>
              <h3
                className={`flex items-center gap-1 font-semibold ${done ? 'text-(--nf-muted)' : ''}`}
              >
                {done && (
                  <span className="text-(--nf-ok)">
                    <Check label="completed" />
                  </span>
                )}
                {c.title}
              </h3>
              <p className="mt-0.5 text-xs text-(--nf-muted)">{c.symptom}</p>
              <div className="mt-2">
                <ReplaceButton
                  primary={c === next}
                  onConfirm={() => loadChallenge(c, flow)}
                  replaceLabel="Load the broken network"
                  label={`${done ? 'Play again' : 'Start'}: ${c.title}`}
                >
                  {done ? 'Play again' : 'Start'}
                </ReplaceButton>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export type Tab = 'tasks' | 'networks' | 'troubleshooting';
const TABS: { id: Tab; label: string }[] = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'networks', label: 'Networks' },
  { id: 'troubleshooting', label: 'Troubleshoot' },
];

function Home({
  onEdit,
  tab,
  setTab,
}: {
  onEdit: (task: CustomTask | 'new') => void;
  tab: Tab;
  setTab: (tab: Tab) => void;
}) {
  return (
    <div className="space-y-4 p-4 text-sm">
      <h2 className="text-base font-semibold">Welcome to NetForge</h2>
      <div role="tablist" className="flex border-b border-(--nf-border) text-sm">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px flex-1 border-b-2 px-2 py-1.5 whitespace-nowrap ${
              tab === t.id
                ? 'border-(--nf-accent) font-medium text-(--nf-text)'
                : 'border-transparent text-(--nf-muted) hover:text-(--nf-text)'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'tasks' && <GuidedTasks onEdit={onEdit} />}
      {tab === 'networks' && <Scenarios />}
      {tab === 'troubleshooting' && <Troubleshooting />}
    </div>
  );
}

function ActiveTask() {
  const { tasks } = useLab();
  const [hintFor, setHintFor] = useState<number | null>(null);
  // Challenges reveal their hints one by one.
  const [hintsShown, setHintsShown] = useState(0);
  const task = findTask(tasks.active, tasks.custom);
  if (!task) return null;
  const completed = tasks.steps[task.id] ?? 0;
  const finished = completed >= task.steps.length;
  const quit = () => setTasks({ ...tasks, active: null });
  const at = TASKS.findIndex((t) => t.id === task.id);
  const following = at < 0 ? undefined : TASKS[at + 1];
  const hints = task.hints ?? [];

  return (
    <section className="space-y-3 p-4 text-sm" aria-label="Current task">
      <button type="button" onClick={quit} className="text-xs text-(--nf-muted) hover:underline">
        ← {finished ? 'Back to all tasks' : 'Leave task (keep the lab)'}
      </button>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{task.title}</h2>
        <span className="shrink-0 font-mono text-xs text-(--nf-muted)">
          {Math.min(completed, task.steps.length)}/{task.steps.length}
        </span>
      </div>
      <Progress value={completed} max={task.steps.length} />
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

/** Right sidebar: the current task, the task editor, or the welcome text and lists. */
export function Sidebar({ tab, setTab }: { tab: Tab; setTab: (tab: Tab) => void }) {
  const { tasks } = useLab();
  const [editing, setEditing] = useState<CustomTask | 'new' | null>(null);
  if (editing) {
    return (
      <Suspense fallback={<p className="p-4 text-sm text-(--nf-muted)">Loading…</p>}>
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
      </Suspense>
    );
  }
  return findTask(tasks.active, tasks.custom) ? (
    <ActiveTask key={tasks.active} />
  ) : (
    <Home onEdit={setEditing} tab={tab} setTab={setTab} />
  );
}
