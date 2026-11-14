import { useReactFlow } from '@xyflow/react';
import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { ACTS, chapterState } from '../tasks/campaign.ts';
import { CHALLENGES } from '../tasks/challenges.ts';
import type { CustomTask } from '../tasks/custom.ts';
import { TASKS, findTask } from '../tasks/tasks.ts';
import { loadChallenge } from './challengeStart.ts';
import { continueTask, getLab, loadLab, notify, setTasks, useLab } from './lab.ts';
import { SCENARIOS } from './scenarios.ts';
import { LINK, SECONDARY } from './styles.ts';
import type { Tab } from './TaskPanel.tsx';
import { loadStart, showAll } from './taskStart.ts';
import { Check, Progress, ReplaceButton, Rich } from './taskParts.tsx';

interface Actions {
  /** A task, challenge or network was started: close the Task center. */
  onStarted: () => void;
  onEdit: (task: CustomTask | 'new') => void;
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

function CustomTasks({ onStarted, onEdit }: Actions) {
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
              <button
                type="button"
                onClick={() => {
                  startCustom(t.id);
                  onStarted();
                }}
                className={SECONDARY}
              >
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

function Lock() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      role="img"
      aria-label="locked"
    >
      <rect x="3" y="7" width="10" height="7" rx="1" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

function Campaign({ onStarted, onEdit }: Actions) {
  const { tasks } = useLab();
  const flow = useReactFlow();
  const doneCount = TASKS.filter((t) => chapterState(t.id, tasks.steps) === 'done').length;
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-xs text-(--nf-muted)">
          The chapters build one network that grows from chapter to chapter, and every step checks
          your work. Finish a chapter to unlock the next.
        </p>
        <div className="flex items-center gap-2 text-xs text-(--nf-muted)">
          <div className="flex-1">
            <Progress value={doneCount} max={TASKS.length} />
          </div>
          {doneCount}/{TASKS.length} chapters done
        </div>
      </div>
      {ACTS.map((act) => (
        <section key={act.id} aria-label={act.title} className="space-y-2">
          <h3 className="text-base font-semibold">{act.title}</h3>
          <ol className="grid gap-3 sm:grid-cols-2">
            {act.taskIds.map((id) => {
              const at = TASKS.findIndex((t) => t.id === id);
              const t = TASKS[at];
              if (!t) return null;
              const state = chapterState(id, tasks.steps);
              const before = TASKS[at - 1];
              const look =
                state === 'available'
                  ? 'border-(--nf-accent) bg-(--nf-raised)'
                  : state === 'locked'
                    ? 'border-(--nf-border) opacity-60'
                    : 'border-(--nf-border)';
              return (
                <li
                  key={id}
                  aria-label={t.title}
                  className={`flex flex-col gap-2 rounded border-2 p-3 ${look}`}
                >
                  <div className="flex items-start gap-2">
                    <span className="font-label w-5 shrink-0 text-base leading-5 font-semibold text-(--nf-muted)">
                      {at + 1}
                    </span>
                    <h4 className="min-w-0 flex-1 leading-5 font-semibold">{t.title}</h4>
                    {state === 'done' && (
                      <span className="flex items-center gap-1 text-xs text-(--nf-ok)">
                        <Check /> Done
                      </span>
                    )}
                    {state === 'locked' && (
                      <span className="text-(--nf-muted)">
                        <Lock />
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-(--nf-muted)">{t.summary}</p>
                  <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                    {state === 'locked' ? (
                      <span className="text-xs text-(--nf-muted)">
                        Finish {before?.title} first
                      </span>
                    ) : (
                      <ReplaceButton
                        primary={state === 'available'}
                        onConfirm={() => {
                          loadStart(id, flow);
                          onStarted();
                        }}
                        keep={{
                          label: 'Continue on my network',
                          onKeep: () => {
                            continueTask(id);
                            onStarted();
                          },
                        }}
                        replaceLabel="Load the starting network"
                        label={`${state === 'done' ? 'Play again' : 'Start'}: ${t.title}`}
                      >
                        {state === 'done' ? 'Play again' : 'Start'}
                      </ReplaceButton>
                    )}
                    <span className="text-xs text-(--nf-muted)">{t.steps.length} steps</span>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      <CustomTasks onStarted={onStarted} onEdit={onEdit} />
    </div>
  );
}

function Scenarios({ onStarted }: { onStarted: () => void }) {
  const flow = useReactFlow();
  const open = (scenario: (typeof SCENARIOS)[number]) => {
    const project = scenario.build();
    loadLab({ ...project, tasks: { active: null, steps: getLab().tasks.steps } });
    notify(`Opened "${scenario.title}". Everything is set up: click a device to look inside.`);
    showAll(flow, project);
    onStarted();
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
            <details className="mt-2 text-xs">
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

function Troubleshooting({ onStarted }: { onStarted: () => void }) {
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
                  onConfirm={() => {
                    loadChallenge(c, flow);
                    onStarted();
                  }}
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

const TABS: { id: Tab; label: string }[] = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'networks', label: 'Networks' },
  { id: 'troubleshooting', label: 'Troubleshoot' },
];

const FOCUSABLE = 'button:not([disabled]), summary, input, select, textarea, [tabindex="0"]';

/** The large popup with the campaign map, ready networks and troubleshooting challenges. */
export function TaskCenter({
  tab,
  setTab,
  onClose,
  onStarted,
  onEdit,
}: Actions & { tab: Tab; setTab: (tab: Tab) => void; onClose: () => void }) {
  const heading = useId();
  const card = useRef<HTMLDivElement>(null);

  // Focus moves into the dialog, and back to the opener when it closes.
  useEffect(() => {
    const opener = document.activeElement;
    card.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Tab' && card.current) {
      // Keep focus inside the dialog.
      const items = [...card.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (!first || !last) return;
      if (e.shiftKey && (at === first || at === card.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center md:bg-black/50 md:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby={heading}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex h-full w-full flex-col overflow-hidden bg-(--nf-surface) text-sm text-(--nf-text) outline-none md:h-auto md:max-h-full md:max-w-4xl md:rounded-lg md:border md:border-(--nf-border) md:shadow-xl"
      >
        <div className="flex items-center justify-between gap-2 border-b border-(--nf-border) px-4 py-3">
          <h2 id={heading} className="text-lg font-semibold">
            Task center
          </h2>
          <button type="button" onClick={onClose} className={SECONDARY}>
            Close
          </button>
        </div>
        <div className="space-y-4 overflow-y-auto p-4">
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
          {tab === 'tasks' && <Campaign onStarted={onStarted} onEdit={onEdit} />}
          {tab === 'networks' && <Scenarios onStarted={onStarted} />}
          {tab === 'troubleshooting' && <Troubleshooting onStarted={onStarted} />}
        </div>
      </div>
    </div>
  );
}
