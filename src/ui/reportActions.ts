import { getLab, notify } from './lab.ts';
import {
  REPORT_LIMIT,
  ReportError,
  checkReport,
  makeReport,
  type CheckedReport,
} from './report.ts';
import { downloadFile } from './storage.ts';

/** The progress report in the UI: what the panel shows, downloading, and checking a file. */

const NAME_KEY = 'netforge-learner-name';
export type Panel = { kind: 'name' } | { kind: 'result'; checked: CheckedReport } | null;

let panel: Panel = null;
const listeners = new Set<() => void>();
export function show(next: Panel): void {
  panel = next;
  for (const listener of listeners) listener();
}

/** The remembered name; null if none was ever given (an empty string means "no name"). */
function rememberedName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

export function rememberName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Without storage the name is simply asked again next time.
  }
}

export async function save(name: string): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  try {
    const html = await makeReport(getLab(), name, date);
    downloadFile(`netforge-report-${date}.html`, html, 'text/html');
    notify('Report saved. Hand the file to your teacher.');
  } catch {
    notify('Could not make the report.');
  }
}

/** Lab menu and end of a task: downloads the report, asking for a name the first time. */
export function downloadReport(): void {
  const name = rememberedName();
  if (name === null) show({ kind: 'name' });
  else void save(name);
}

/** Lab menu → Check a report: reads the picked file and shows what it says. */
export async function checkReportFile(file: File): Promise<void> {
  if (file.size > REPORT_LIMIT) {
    notify('This file is too large to be a report.');
    return;
  }
  try {
    show({ kind: 'result', checked: await checkReport(await file.text()) });
  } catch (error) {
    notify(error instanceof ReportError ? error.message : 'Could not read that file.');
  }
}

export function subscribePanel(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getPanel = (): Panel => panel;
