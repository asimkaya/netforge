import { useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from 'react';
import { loadLab, notify } from './lab.ts';
import { parseProject } from './project.ts';
import type { CheckedReport, ReportEntry } from './report.ts';
import { getPanel, rememberName, save, show, subscribePanel } from './reportActions.ts';
import { confirmReplace } from './storage.ts';

const PRIMARY =
  'rounded bg-(--nf-accent) px-3 py-1 text-xs font-semibold text-(--nf-on-accent) hover:opacity-90';
const SECONDARY = 'rounded border border-(--nf-border) px-3 py-1 text-xs hover:bg-(--nf-raised)';
const FIELD =
  'rounded border border-(--nf-border) bg-(--nf-surface) px-2 py-1 text-xs text-(--nf-text)';

const SURFACE =
  'absolute top-14 right-4 z-35 w-80 max-w-[calc(100%-2rem)] space-y-3 rounded-md border border-(--nf-border) bg-(--nf-surface) p-4 text-xs shadow-lg';

const closeOnEscape = (e: KeyboardEvent<HTMLElement>) => {
  if (e.key === 'Escape') show(null);
};

function NamePrompt() {
  const [name, setName] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    rememberName(name.trim());
    show(null);
    void save(name.trim());
  };
  return (
    <form
      role="dialog"
      aria-label="Progress report"
      onSubmit={submit}
      onKeyDown={closeOnEscape}
      className={SURFACE}
    >
      <label className="flex flex-col gap-1">
        Your name (optional, shown on the report)
        <input
          autoFocus
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          className={FIELD}
        />
      </label>
      <p className="text-(--nf-muted)">NetForge asks once and remembers it in this browser.</p>
      <div className="flex gap-2">
        <button type="submit" className={PRIMARY}>
          Download report
        </button>
        <button type="button" className={SECONDARY} onClick={() => show(null)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Entries({ title, list }: { title: string; list: readonly ReportEntry[] }) {
  return (
    <section aria-label={title} className="space-y-1">
      <h3 className="font-semibold">{title}</h3>
      <ul>
        {list.map((e) => (
          <li key={e.id} className="flex justify-between gap-2">
            <span>{e.title}</span>
            <span className={e.steps >= e.total ? 'font-semibold text-(--nf-accent)' : ''}>
              {e.steps >= e.total ? 'Done' : `${e.steps} of ${e.total} steps`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Result({ checked }: { checked: CheckedReport }) {
  const { report, intact, code } = checked;
  const open = () => {
    if (!confirmReplace()) return;
    loadLab(parseProject(checked.labText));
    show(null);
    notify('Opened the lab from the report.');
  };
  return (
    <section
      role="dialog"
      aria-label="Report check"
      onKeyDown={closeOnEscape}
      className={`${SURFACE} max-h-[80vh] overflow-y-auto`}
    >
      <p
        role="status"
        className={`border-l-[3px] bg-(--nf-raised) p-2 ${intact ? 'border-(--nf-ok)' : 'border-(--nf-bad)'}`}
      >
        {intact
          ? 'Not edited: the verification code matches this report.'
          : 'Edited after it was made: the verification code does not match this report.'}
      </p>
      <p>
        {report.name === '' ? 'Name not given' : report.name} · {report.date} · <code>{code}</code>
      </p>
      <Entries title="Guided tasks" list={report.tasks} />
      <Entries title="Troubleshooting challenges" list={report.challenges} />
      <p className="text-(--nf-muted)">
        The code shows the file was not edited by hand. It does not prove who did the work: anyone
        with NetForge can make a report.
      </p>
      <div className="flex gap-2">
        <button type="button" className={PRIMARY} onClick={open}>
          Open the embedded lab
        </button>
        <button type="button" className={SECONDARY} onClick={() => show(null)}>
          Close
        </button>
      </div>
    </section>
  );
}

/** The small floating prompt or result; mounted once in the app. */
export function ReportPanel() {
  const current = useSyncExternalStore(subscribePanel, getPanel);
  if (!current) return null;
  return current.kind === 'name' ? <NamePrompt /> : <Result checked={current.checked} />;
}
