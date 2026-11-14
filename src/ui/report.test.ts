import { describe, expect, test } from 'vitest';
import { Lab } from './labBuilder.ts';
import { parseProject } from './project.ts';
import {
  REPORT_LIMIT,
  ReportError,
  canonicalJson,
  checkReport,
  makeReport,
  reportCode,
  reportData,
} from './report.ts';

async function sample(name = 'Ada') {
  const lab = new Lab();
  lab.add('pc', 40, 40);
  const project = lab.done();
  project.tasks = { active: null, steps: { 'first-ping': 5, 'meet-the-switch': 2 } };
  return makeReport(project, name, '2026-11-14');
}

describe('the report code', () => {
  test('canonical JSON ignores key order and spacing', () => {
    expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: 'x' })).toBe(
      canonicalJson(JSON.parse('{ "a": "x", "b": [1, {"c": 2, "d": 1}] }')),
    );
  });

  test('is 12 hex characters and changes with the data or the lab', async () => {
    const report = reportData({ active: null, steps: {} }, 'Ada', '2026-11-14');
    const code = await reportCode(report, { a: 1 });
    expect(code).toMatch(/^[0-9a-f]{12}$/);
    expect(await reportCode(report, { a: 1 })).toBe(code);
    expect(await reportCode({ ...report, name: 'Bob' }, { a: 1 })).not.toBe(code);
    expect(await reportCode(report, { a: 2 })).not.toBe(code);
  });
});

describe('checking a report', () => {
  test('an untouched report passes and lists the finished task', async () => {
    const checked = await checkReport(await sample());
    expect(checked.intact).toBe(true);
    expect(checked.report.name).toBe('Ada');
    expect(checked.report.date).toBe('2026-11-14');
    const first = checked.report.tasks.find((t) => t.id === 'first-ping');
    expect(first).toMatchObject({ steps: 5, total: 5 });
    expect(checked.report.tasks.find((t) => t.id === 'meet-the-switch')).toMatchObject({
      steps: 2,
    });
    expect(parseProject(checked.labText).net.devices.size).toBe(1);
  });

  test('an edited summary is detected', async () => {
    const text = (await sample()).replace('<td class="done">Done</td>', '<td>Not started</td>');
    expect((await checkReport(text)).intact).toBe(false);
    const renamed = (await sample()).replace('<p>Ada</p>', '<p>Grace</p>');
    expect((await checkReport(renamed)).intact).toBe(false);
  });

  test('edited report data or an edited code is detected', async () => {
    const text = await sample();
    const steps = text.replace('"steps":2', '"steps":3');
    expect(steps).not.toBe(text);
    expect((await checkReport(steps)).intact).toBe(false);
    const code = (await checkReport(text)).code;
    expect((await checkReport(text.replaceAll(code, '000000000000'))).intact).toBe(false);
  });

  test('an edited lab is detected', async () => {
    const text = await sample();
    const edited = text.replace('"name":"pc1"', '"name":"pc9"');
    expect(edited).not.toBe(text);
    expect((await checkReport(edited)).intact).toBe(false);
  });

  test('files that are not reports are refused', async () => {
    await expect(checkReport('<html>hello</html>')).rejects.toThrow(ReportError);
    await expect(checkReport('x'.repeat(REPORT_LIMIT + 1))).rejects.toThrow('too large');
    const broken = (await sample()).replace('"format":"netforge-lab"', '"format":"other"');
    await expect(checkReport(broken)).rejects.toThrow('cannot be opened');
  });
});

describe('the report page', () => {
  test('shows the learner name as text, never as markup', async () => {
    const name = '<script>alert(1)</script>';
    const text = await sample(name);
    expect(text).toContain('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(text).not.toContain('<script>alert');
    // The data block escapes `<` too, and the name survives a round trip unchanged.
    const checked = await checkReport(text);
    expect(checked.intact).toBe(true);
    expect(checked.report.name).toBe(name);
  });

  test('has no executable script, only the data block', async () => {
    const text = await sample();
    expect(text.match(/<script/g)).toHaveLength(1);
    expect(text).toContain('<script type="application/json" id="netforge-report">');
  });
});
