import { expect, test } from '@playwright/test';
import { add, run, taskCenter } from './helpers.ts';

test('a learner fixes the wrong gateway and proves it', async ({ page }) => {
  await page.goto('/');
  await taskCenter(page, 'Troubleshoot');
  await page.getByRole('button', { name: 'Start: No way out for pc3' }).click();
  // An empty canvas loads the broken network without asking.
  await expect(page.getByRole('alertdialog')).toHaveCount(0);

  const task = page.getByRole('region', { name: 'Current task' });
  const current = task.locator('[aria-current="step"]');
  await expect(task).toContainText('0/3');
  await expect(task).toContainText('pc3 cannot reach the Internet');
  await expect(current).toContainText('Reproduce the problem');

  const w = await run(page, 'pc3', 'ping -c 1 198.18.0.10');
  const log = w.getByRole('log');
  await expect(log).toContainText('Destination Host Unreachable');
  await expect(task).toContainText('1/3');

  await w.getByRole('button', { name: 'Why did this fail?' }).click();
  await expect(w.getByRole('region', { name: 'Failure explanation' })).toContainText(
    'pc3 could not find the MAC address of its gateway 192.168.10.254',
  );

  // Hints come one at a time.
  await task.getByRole('button', { name: 'Show a hint' }).click();
  await expect(task).toContainText('Hint 1');
  await expect(task).not.toContainText('Hint 2');
  await task.getByRole('button', { name: 'Show another hint' }).click();
  await expect(task).toContainText('Hint 2');

  await run(page, 'pc3', 'ip route del default');
  await expect(current).toContainText('Find the fault and fix it');
  await run(page, 'pc3', 'ip route add default via 192.168.10.1');
  await expect(current).toContainText('Prove it');

  await run(page, 'pc3', 'ping -c 1 198.18.0.10');
  await expect(log).toContainText('1 packets transmitted, 1 received');
  await expect(task).toContainText('3/3');
  await expect(task).toContainText('A default gateway must be a router’s address');
});

test('starting a challenge on a busy canvas offers only to replace or cancel', async ({ page }) => {
  await page.goto('/');
  await add(page, 'PC');
  await expect(page.getByTestId('device-pc1')).toBeVisible();
  await taskCenter(page, 'Troubleshoot');
  await page.getByRole('button', { name: 'Start: No way out for pc3' }).click();

  const ask = page.getByRole('alertdialog');
  await expect(ask.getByRole('button', { name: 'Load the broken network' })).toBeVisible();
  await expect(ask.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(ask.getByRole('button')).toHaveCount(2);
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByTestId('device-pc3')).toHaveCount(0);

  await page.getByRole('button', { name: 'Start: No way out for pc3' }).click();
  await ask.getByRole('button', { name: 'Load the broken network' }).click();
  await expect(page.getByRole('region', { name: 'Current task' })).toContainText('0/3');
  await expect(page.getByTestId('device-pc3')).toBeVisible();
});
