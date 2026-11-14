import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { add, connect, labMenu, run, taskCenter } from './helpers.ts';

test('a finished task makes a report that "Check a report" confirms, and edits are caught', async ({
  page,
}) => {
  await page.goto('/');
  await taskCenter(page);
  await page.getByRole('button', { name: 'Start: Day one: connect two desks' }).click();
  await add(page, 'PC', 2);
  await connect(page, 'pc1', 'pc2');
  await run(page, 'pc1', 'ip addr add 192.168.1.10/24 dev eth0');
  await run(page, 'pc2', 'ip addr add 192.168.1.20/24 dev eth0');
  await run(page, 'pc2', 'ping -c 1 192.168.1.10');
  await expect(page.getByRole('region', { name: 'Current task' })).toContainText('5/5');

  // The first time, the report asks for a name; it can be skipped by leaving it empty.
  const download = page.waitForEvent('download');
  await labMenu(page, 'Download progress report');
  const prompt = page.getByRole('dialog', { name: 'Progress report' });
  await prompt.getByLabel(/Your name/).fill('Ada Lovelace');
  await prompt.getByRole('button', { name: 'Download report' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^netforge-report-\d{4}-\d{2}-\d{2}\.html$/);
  const text = await readFile(await file.path(), 'utf8');
  expect(text).toContain('Ada Lovelace');

  // The name is remembered and can be changed for the next report.
  await labMenu(page, 'Download progress report');
  await expect(prompt.getByLabel(/Your name/)).toHaveValue('Ada Lovelace');
  await prompt.getByLabel(/Your name/).fill('Grace Hopper');
  const again = page.waitForEvent('download');
  await prompt.getByRole('button', { name: 'Download report' }).click();
  expect(await readFile((await (await again).path()) ?? '', 'utf8')).toContain('Grace Hopper');
  await expect(prompt).toHaveCount(0);

  const checkInput = page.getByLabel('Check a report file');
  await checkInput.setInputFiles({
    name: 'report.html',
    mimeType: 'text/html',
    buffer: Buffer.from(text),
  });
  const result = page.getByRole('dialog', { name: 'Report check' });
  await expect(result).toContainText('Not edited');
  await expect(result).toContainText('Ada Lovelace');
  await expect(
    result.getByRole('listitem').filter({ hasText: 'Day one: connect two desks' }),
  ).toContainText('Done');
  await expect(result).toContainText('does not prove who did the work');

  // Changing the learner's name by hand is caught.
  await checkInput.setInputFiles({
    name: 'report.html',
    mimeType: 'text/html',
    buffer: Buffer.from(text.replace('<p>Ada Lovelace</p>', '<p>Grace Hopper</p>')),
  });
  await expect(result).toContainText('Edited after it was made');

  // The embedded lab opens after the usual replace-the-lab confirmation.
  page.once('dialog', (d) => void d.accept());
  await labMenu(page, 'New lab');
  await expect(page.getByTestId('device-pc1')).toHaveCount(0);
  await checkInput.setInputFiles({
    name: 'report.html',
    mimeType: 'text/html',
    buffer: Buffer.from(text),
  });
  await result.getByRole('button', { name: 'Open the embedded lab' }).click();
  await expect(page.getByTestId('device-pc1')).toContainText('192.168.1.10/24');
});
