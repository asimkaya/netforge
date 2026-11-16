import { expect, test, type Page } from '@playwright/test';
import { labMenu, run } from './helpers.ts';
import { readFile } from 'node:fs/promises';

async function addAndAddress(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Add PC/ }).click();
  await run(page, 'pc1', 'ip addr add 10.9.8.7/24 dev eth0');
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
  await labMenu(page, 'Export');
  const path = await (await download).path();
  const text = await readFile(path, 'utf8');
  expect(JSON.parse(text)).toMatchObject({ format: 'netforge-lab', version: 14 });

  page.once('dialog', (d) => void d.accept());
  await labMenu(page, 'New lab');
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
    buffer: Buffer.from('{"format":"netforge-lab","version":5,"network":{}}'),
  });
  await expect(page.getByRole('status')).toContainText('network.devices');
  await expect(page.getByTestId('device-pc1')).toBeVisible();
});

test('importing a file over 2 MB is refused before it is read', async ({ page }) => {
  await addAndAddress(page);
  await page.getByLabel('Import lab file').setInputFiles({
    name: 'huge.json',
    mimeType: 'application/json',
    buffer: Buffer.alloc(2_000_001, ' '),
  });
  await expect(page.getByRole('status')).toContainText('huge.json is too big');
  await expect(page.getByTestId('device-pc1')).toBeVisible();
});

test('a save that cannot be opened is offered as a download', async ({ page }) => {
  await page.goto('/');
  // Write a save from a "newer version" straight into idb-keyval's store.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('keyval-store');
        open.onupgradeneeded = () => open.result.createObjectStore('keyval');
        open.onsuccess = () => {
          const tx = open.result.transaction('keyval', 'readwrite');
          tx.objectStore('keyval').put('{"format":"netforge-lab","version":999}', 'autosave');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(new Error('write failed'));
        };
      }),
  );
  await page.reload();
  await expect(page.getByRole('status')).toContainText('could not be opened');
  await page.getByRole('button', { name: 'Lab menu' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Download unreadable save' }).click();
  expect(await readFile(await (await download).path(), 'utf8')).toContain('"version":999');
});
