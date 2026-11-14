import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { labMenu, open, run } from './helpers.ts';

test('the lab exports as a Linux script and each device shows its commands', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Add PC/ }).click();
  await run(page, 'pc1', 'ip addr add 10.9.8.7/24 dev eth0');

  const download = page.waitForEvent('download');
  await labMenu(page, 'Export as Linux script');
  const file = await download;
  expect(file.suggestedFilename()).toBe('netforge-lab.sh');
  const text = await readFile(await file.path(), 'utf8');
  expect(text).toContain('case "$(hostname)" in');
  expect(text).toContain('ip addr add 10.9.8.7/24 dev eth0');

  const w = await open(page, 'pc1');
  await w.getByRole('tab', { name: 'Config' }).click();
  const commands = w.getByLabel('Linux commands').last();
  await expect(commands).toContainText('ip addr add 10.9.8.7/24 dev eth0');
  await expect(w.getByRole('button', { name: 'Copy' })).toBeVisible();
});
