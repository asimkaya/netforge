import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function addAndAddress(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Add PC/ }).click();
  await page.getByTestId('device-pc1').dblclick();
  const input = page.getByRole('textbox', { name: 'Command' });
  await input.fill('ip addr add 10.9.8.7/24 dev eth0');
  await input.press('Enter');
  await expect(page.getByTestId('device-pc1')).toContainText('10.9.8.7/24');
}

test('the lab survives a page reload', async ({ page }) => {
  await addAndAddress(page);
  // Autosave is debounced; give it time to reach IndexedDB.
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.getByTestId('device-pc1')).toContainText('10.9.8.7/24');
});

test('export then import restores the same lab', async ({ page }) => {
  await addAndAddress(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  const path = await (await download).path();
  const text = await readFile(path, 'utf8');
  expect(JSON.parse(text)).toMatchObject({ format: 'netforge-lab', version: 1 });

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'New lab' }).click();
  await expect(page.getByTestId('device-pc1')).toHaveCount(0);

  await page.getByLabel('Import lab file').setInputFiles({
    name: 'lab.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect(page.getByTestId('device-pc1')).toContainText('10.9.8.7/24');
});

test('importing a broken file shows an error and keeps the lab', async ({ page }) => {
  await addAndAddress(page);
  await page.getByLabel('Import lab file').setInputFiles({
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"format":"netforge-lab","version":1,"network":{}}'),
  });
  await expect(page.getByRole('status')).toContainText('network.devices');
  await expect(page.getByTestId('device-pc1')).toBeVisible();
});
