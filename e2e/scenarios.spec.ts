import { expect, test } from '@playwright/test';
import { run } from './helpers.ts';

test('ready networks open with one click and work at once', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Networks' }).click();

  await page.getByRole('button', { name: 'Open Home network' }).click();
  await expect(page.getByRole('status')).toContainText('Opened "Home network"');
  await expect(page.getByTestId('device-home1')).toContainText('2 clients');
  await expect(page.getByRole('listitem', { name: 'Home network' })).toContainText(
    'ping 198.18.0.10',
  );
  const term = await run(page, 'pc1', 'ping -c 1 198.18.0.10');
  await expect(term.getByRole('log')).toContainText('1 received');
  await term.getByRole('button', { name: 'Close pc1' }).click();

  // Opening another one replaces the lab, after asking.
  await page.getByRole('button', { name: 'Open Small office' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Replace' }).click();
  await expect(page.getByTestId('device-sw1')).toBeVisible();
  await expect(page.getByTestId('device-home1')).toHaveCount(0);
  await expect(page.getByTestId('device-pc4')).toContainText('192.168.10.103/24');
});

test('the company router forwards Internet names to the Internet DNS server', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Networks' }).click();
  await page.getByRole('button', { name: 'Open Company with VLANs and a branch' }).click();
  await expect(page.getByRole('status')).toContainText('Opened');
  const term = await run(page, 'pc1', 'ping -c 1 www.example.com');
  await expect(term.getByRole('log')).toContainText('PING www.example.com (198.18.0.10)');
  await expect(term.getByRole('log')).toContainText('1 received');
});

test('the three side panel tabs share one row', async ({ page }) => {
  await page.goto('/');
  const tabs = page.getByRole('tab');
  const ys = [];
  for (const name of ['Tasks', 'Networks', 'Troubleshoot']) {
    ys.push((await tabs.filter({ hasText: name }).first().boundingBox())?.y);
  }
  expect(new Set(ys).size).toBe(1);
});
