import { useState } from 'react';
import { SPECS, type SpecId } from '../engine/specs.ts';
import {
  CHECK_LABELS,
  SERVICES,
  blankCheck,
  checkError,
  describeCheck,
  type CheckKind,
  type CustomCheck,
  type CustomStep,
  type CustomTask,
  type ServiceName,
} from '../tasks/custom.ts';
import { FIELD, PRIMARY, SECONDARY } from './styles.ts';
import { useLab } from './lab.ts';

const KINDS = Object.keys(CHECK_LABELS) as CheckKind[];

function newStep(): CustomStep {
  return { title: '', detail: '', check: blankCheck('ping') };
}

/** Text input bound to one field of a check. */
function Field({
  label,
  value,
  onChange,
  list,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  list?: string;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={list}
        placeholder={placeholder}
        className={`${FIELD} w-40`}
      />
    </label>
  );
}

/** The inputs of one check kind. Device fields suggest the lab's device names. */
function CheckFields({ check, set }: { check: CustomCheck; set: (c: CustomCheck) => void }) {
  const dev = 'task-editor-devices';
  switch (check.kind) {
    case 'ping':
      return (
        <>
          <Field
            label="Device"
            value={check.from}
            onChange={(from) => set({ ...check, from })}
            list={dev}
          />
          <Field
            label="Reaches (address or device)"
            value={check.to}
            onChange={(to) => set({ ...check, to })}
            list={dev}
            placeholder="10.0.0.2 or srv1"
          />
        </>
      );
    case 'address':
      return (
        <>
          <Field
            label="Device"
            value={check.device}
            onChange={(device) => set({ ...check, device })}
            list={dev}
          />
          <Field
            label="Network"
            value={check.network}
            onChange={(network) => set({ ...check, network })}
            placeholder="192.168.1.0/24"
          />
        </>
      );
    case 'cable':
      return (
        <>
          <Field label="Device" value={check.a} onChange={(a) => set({ ...check, a })} list={dev} />
          <Field
            label="Other device"
            value={check.b}
            onChange={(b) => set({ ...check, b })}
            list={dev}
          />
        </>
      );
    case 'service':
      return (
        <>
          <Field
            label="Device"
            value={check.device}
            onChange={(device) => set({ ...check, device })}
            list={dev}
          />
          <label className="flex flex-col gap-1">
            Service
            <select
              value={check.service}
              onChange={(e) => set({ ...check, service: e.target.value as ServiceName })}
              className={FIELD}
            >
              {SERVICES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </>
      );
    case 'command':
      return (
        <>
          <Field
            label="Device (empty: any)"
            value={check.device}
            onChange={(device) => set({ ...check, device })}
            list={dev}
          />
          <Field
            label="Command contains"
            value={check.text}
            onChange={(text) => set({ ...check, text })}
            placeholder="traceroute"
          />
        </>
      );
    case 'devices':
      return (
        <>
          <label className="flex flex-col gap-1">
            Device type
            <select
              value={check.spec}
              onChange={(e) => set({ ...check, spec: e.target.value as SpecId })}
              className={FIELD}
            >
              {Object.values(SPECS).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <Field
            label="At least"
            value={String(check.count)}
            onChange={(v) => set({ ...check, count: Number(v) })}
          />
        </>
      );
  }
}

function problems(task: CustomTask): string[] {
  const list: string[] = [];
  if (!task.title.trim()) list.push('Give the task a title.');
  if (task.steps.length === 0) list.push('Add at least one step.');
  task.steps.forEach((s, i) => {
    if (!s.title.trim()) list.push(`Step ${i + 1}: give it a title.`);
    const error = checkError(s.check);
    if (error) list.push(`Step ${i + 1}: ${error}`);
  });
  return list;
}

/** Writes or edits a task that is saved with the lab and shared with it. */
export function TaskEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: CustomTask | null;
  onSave: (task: CustomTask) => void;
  onCancel: () => void;
}) {
  const { net } = useLab();
  const [task, setTask] = useState<CustomTask>(
    () =>
      initial ?? {
        id: `custom-${Date.now().toString(36)}`,
        title: '',
        summary: '',
        steps: [newStep()],
        done: '',
      },
  );
  const issues = problems(task);
  const setStep = (i: number, step: CustomStep) =>
    setTask({ ...task, steps: task.steps.map((s, j) => (j === i ? step : s)) });

  return (
    <section aria-label="Task editor" className="space-y-3 p-4 text-xs">
      <h2 className="text-base font-semibold">{initial ? 'Edit task' : 'New task'}</h2>
      <p className="text-(--nf-muted)">
        Build the starting network on the canvas first: the task is saved with this lab, and a
        shared link or exported file carries it too.
      </p>
      <datalist id="task-editor-devices">
        {[...net.devices.values()].map((d) => (
          <option key={d.id} value={d.name} />
        ))}
      </datalist>
      <label className="flex flex-col gap-1">
        Title
        <input
          value={task.title}
          onChange={(e) => setTask({ ...task, title: e.target.value })}
          className={FIELD}
        />
      </label>
      <label className="flex flex-col gap-1">
        Summary
        <input
          value={task.summary}
          onChange={(e) => setTask({ ...task, summary: e.target.value })}
          className={FIELD}
        />
      </label>
      <ol className="space-y-2">
        {task.steps.map((step, i) => (
          <li
            key={i}
            className="space-y-2 border-t border-(--nf-border) pt-3"
            aria-label={`Step ${i + 1}`}
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold">Step {i + 1}</span>
              <button
                type="button"
                className={SECONDARY}
                onClick={() => setTask({ ...task, steps: task.steps.filter((_, j) => j !== i) })}
              >
                Remove step
              </button>
            </div>
            <label className="flex flex-col gap-1">
              Step title
              <input
                value={step.title}
                onChange={(e) => setStep(i, { ...step, title: e.target.value })}
                className={FIELD}
              />
            </label>
            <label className="flex flex-col gap-1">
              Instructions (use `backticks` for commands)
              <textarea
                value={step.detail}
                onChange={(e) => setStep(i, { ...step, detail: e.target.value })}
                rows={2}
                className={FIELD}
              />
            </label>
            <label className="flex flex-col gap-1">
              Hint (optional)
              <input
                value={step.hint ?? ''}
                onChange={(e) => {
                  const base = { title: step.title, detail: step.detail, check: step.check };
                  setStep(i, e.target.value ? { ...base, hint: e.target.value } : base);
                }}
                className={FIELD}
              />
            </label>
            <label className="flex flex-col gap-1">
              Done when
              <select
                value={step.check.kind}
                onChange={(e) =>
                  setStep(i, { ...step, check: blankCheck(e.target.value as CheckKind) })
                }
                className={FIELD}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {CHECK_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-2">
              <CheckFields check={step.check} set={(check) => setStep(i, { ...step, check })} />
            </div>
            {!checkError(step.check) && (
              <p className="text-(--nf-muted)">{describeCheck(step.check)}</p>
            )}
          </li>
        ))}
      </ol>
      <button
        type="button"
        className={SECONDARY}
        onClick={() => setTask({ ...task, steps: [...task.steps, newStep()] })}
      >
        Add step
      </button>
      <label className="flex flex-col gap-1">
        Message when done
        <input
          value={task.done}
          onChange={(e) => setTask({ ...task, done: e.target.value })}
          className={FIELD}
        />
      </label>
      {issues.length > 0 && (
        <ul
          className="list-inside list-disc border-l-[3px] border-(--nf-warn) pl-2"
          aria-label="Problems"
        >
          {issues.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className={PRIMARY}
          disabled={issues.length > 0}
          onClick={() => onSave(task)}
        >
          Save task
        </button>
        <button type="button" className={SECONDARY} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
