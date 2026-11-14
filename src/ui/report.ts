import { CHALLENGE_TASKS } from '../tasks/challenges.ts';
import { TASKS, type Task } from '../tasks/tasks.ts';
import { ProjectError, parseProject, serializeProject, type Project } from './project.ts';
import { MAX_DECODED_BYTES } from './share.ts';
import { REPORT_CSS } from './theme.ts';

/**
 * The progress report: one HTML file a learner hands to a teacher. There is no server, so it
 * proves nothing about who did the work; its code only shows that the file was not edited by
 * hand afterwards. The same logic builds a report and checks one.
 */

export const REPORT_FORMAT = 'netforge-report';
const REPORT_VERSION = 1;
/** A report may not be larger than a shared lab may expand to. */
export const REPORT_LIMIT = MAX_DECODED_BYTES;
const NAME_LIMIT = 80;

export interface ReportEntry {
  id: string;
  title: string;
  /** Steps completed, and the number the task has. */
  steps: number;
  total: number;
}

export interface ReportData {
  /** The learner's name; may be empty. */
  name: string;
  /** The day the report was made, `YYYY-MM-DD`. */
  date: string;
  tasks: ReportEntry[];
  challenges: ReportEntry[];
}

/** A report file that cannot be read, worded for the user. */
export class ReportError extends Error {}

const entries = (list: readonly Task[], progress: Project['tasks']): ReportEntry[] =>
  list.map((t) => ({
    id: t.id,
    title: t.title,
    steps: Math.min(progress.steps[t.id] ?? 0, t.steps.length),
    total: t.steps.length,
  }));

/** What a report says: the learner, the day and how far each task and challenge got. */
export function reportData(progress: Project['tasks'], name: string, date: string): ReportData {
  return {
    name: name.trim().slice(0, NAME_LIMIT),
    date,
    tasks: entries(TASKS, progress),
    challenges: entries(CHALLENGE_TASKS, progress),
  };
}

/** JSON with sorted keys and no spaces: the same data always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const fields = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The first 12 hex characters of SHA-256 over the report data and the embedded lab. */
export async function reportCode(report: ReportData, lab: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ report, lab }));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function status(e: ReportEntry): { text: string; done: boolean } {
  if (e.steps >= e.total) return { text: 'Done', done: true };
  return { text: e.steps === 0 ? 'Not started' : 'In progress', done: false };
}

function table(title: string, list: readonly ReportEntry[]): string {
  const done = list.filter((e) => status(e).done).length;
  const rows = list.map((e) => {
    const s = status(e);
    return `<tr><td>${escapeHtml(e.title)}</td><td${s.done ? ' class="done"' : ''}>${s.text}</td><td>${e.steps} of ${e.total}</td></tr>`;
  });
  return `<h2>${title}: ${done} of ${list.length} done</h2>
<table>
<thead><tr><th>Name</th><th>Status</th><th>Steps</th></tr></thead>
<tbody>
${rows.join('\n')}
</tbody>
</table>`;
}

/** The report file. The data block is JSON for NetForge to read; `<` is escaped inside it. */
export function reportHtml(report: ReportData, lab: unknown, code: string): string {
  const payload = JSON.stringify({
    format: REPORT_FORMAT,
    version: REPORT_VERSION,
    code,
    report,
    lab,
  }).replaceAll('<', '\\u003c');
  const who = report.name === '' ? 'Name not given' : escapeHtml(report.name);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NetForge progress report</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<main>
<h1>NetForge progress report</h1>
<p>${who}</p>
<p class="muted">${escapeHtml(report.date)}</p>
<p>Verification code: <code class="code">${code}</code></p>
${table('Guided tasks', report.tasks)}
${table('Troubleshooting challenges', report.challenges)}
<p class="note">To check this report, open NetForge and choose Lab, then Check a report, and pick this file. The code shows that the file was not edited by hand after NetForge made it. It does not prove who did the work: anyone with NetForge can make a report. This file holds a copy of the lab, which NetForge can open.</p>
</main>
<script type="application/json" id="netforge-report">${payload}</script>
</body>
</html>
`;
}

/** Builds the report file for the lab as it is now. */
export async function makeReport(project: Project, name: string, date: string): Promise<string> {
  const report = reportData(project.tasks, name, date);
  const lab: unknown = JSON.parse(serializeProject(project));
  return reportHtml(report, lab, await reportCode(report, lab));
}

function readEntries(value: unknown): ReportEntry[] | null {
  if (!Array.isArray(value) || value.length > 500) return null;
  const list: ReportEntry[] = [];
  for (const e of value as Record<string, unknown>[]) {
    const ok =
      e !== null &&
      typeof e === 'object' &&
      typeof e.id === 'string' &&
      typeof e.title === 'string' &&
      e.title.length <= 200 &&
      Number.isInteger(e.steps) &&
      Number.isInteger(e.total) &&
      (e.steps as number) >= 0 &&
      (e.steps as number) <= (e.total as number);
    if (!ok) return null;
    list.push({
      id: String(e.id).slice(0, 80),
      title: String(e.title),
      steps: e.steps as number,
      total: e.total as number,
    });
  }
  return list;
}

export interface CheckedReport {
  report: ReportData;
  /** The code the file claims, and the one recomputed from what it holds. */
  claimed: string;
  code: string;
  /** False when the data, the code or the page text was changed after NetForge wrote it. */
  intact: boolean;
  /** The embedded lab as a lab file, already validated. */
  labText: string;
}

/** Reads and verifies a report file. Throws ReportError with a message for the user. */
export async function checkReport(text: string): Promise<CheckedReport> {
  if (text.length > REPORT_LIMIT) throw new ReportError('This file is too large to be a report.');
  const block = /<script type="application\/json" id="netforge-report">([\s\S]*?)<\/script>/.exec(
    text,
  );
  let payload: Record<string, unknown> | null;
  try {
    payload = block ? (JSON.parse(block[1] ?? '') as Record<string, unknown>) : null;
  } catch {
    payload = null;
  }
  const raw = payload?.report as Record<string, unknown> | undefined;
  const tasks = readEntries(raw?.tasks);
  const challenges = readEntries(raw?.challenges);
  if (
    payload?.format !== REPORT_FORMAT ||
    payload.version !== REPORT_VERSION ||
    typeof payload.code !== 'string' ||
    typeof raw?.name !== 'string' ||
    typeof raw.date !== 'string' ||
    raw.name.length > NAME_LIMIT ||
    raw.date.length > 10 ||
    !tasks ||
    !challenges
  ) {
    throw new ReportError('This is not a NetForge progress report.');
  }
  const report: ReportData = { name: raw.name, date: raw.date, tasks, challenges };
  // The lab inside is untrusted input like any lab file.
  const labText = JSON.stringify(payload.lab);
  try {
    parseProject(labText);
  } catch (error) {
    if (error instanceof ProjectError) {
      throw new ReportError(`The lab inside this report cannot be opened. ${error.message}`);
    }
    throw error;
  }
  const code = await reportCode(report, payload.lab);
  const same = reportHtml(report, payload.lab, code) === text.replaceAll('\r\n', '\n');
  return { report, claimed: payload.code, code, intact: code === payload.code && same, labText };
}
