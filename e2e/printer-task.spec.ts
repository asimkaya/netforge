import { expect, test } from '@playwright/test';
import { add, connect, finish, run, taskCenter, win } from './helpers.ts';

const BEFORE = ['first-ping', 'meet-the-switch', 'two-networks', 'dhcp'];

test('print a first page: cable a printer, open its page, send a job', async ({ page }) => {
  await page.goto('/');
  await finish(page, BEFORE);
  await taskCenter(page);
  await page.getByRole('button', { name: 'Start: Print your first page' }).click();
  const task = page.getByRole('region', { name: 'Current task' });
  await expect(task).toContainText('0/4');
  await expect(task).toContainText('From Maya, office manager');

  await add(page, 'Printer');
  await connect(page, 'printer1', 'sw1/eth3');
  // DHCP gives it an address in the office network.
  await expect(task).toContainText('2/4', { timeout: 15_000 });
  await run(page, 'pc1', 'curl http://printer1/');
  await expect(win(page, 'pc1')).toContainText('Printer ready', { timeout: 15_000 });
  await expect(task).toContainText('3/4');

  await run(page, 'pc1', 'echo Hello > letter.txt');
  await run(page, 'pc1', 'nc printer1 9100 < letter.txt');
  await expect(task).toContainText('4/4', { timeout: 15_000 });
  await expect(task).toContainText('Maya: “It printed!');
});

test('watch the front door: cable a camera and see frames from a PC', async ({ page }) => {
  await page.goto('/');
  await finish(page, [...BEFORE, 'first-print']);
  await taskCenter(page);
  await page.getByRole('button', { name: 'Start: Watch the front door' }).click();
  const task = page.getByRole('region', { name: 'Current task' });
  await expect(task).toContainText('0/3');
  await expect(task).toContainText('From Sam, founder');

  await add(page, 'IP Camera');
  await connect(page, 'cam1', 'sw1/eth4');
  await expect(task).toContainText('2/3', { timeout: 15_000 });

  const pc = await run(page, 'pc1', 'nc cam1 554');
  await expect(pc).toContainText('frame 2', { timeout: 15_000 });
  await expect(task).toContainText('3/3');
  await pc.getByRole('textbox', { name: 'Command' }).press('Control+c');
  await expect(task).toContainText('Sam: “I can see the lobby');
});
