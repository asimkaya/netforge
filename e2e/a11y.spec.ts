import { expect, test } from '@playwright/test';
import { add, win } from './helpers.ts';

test('devices and cables have names, and a cable can be made with the keyboard', async ({
  page,
}) => {
  await page.goto('/');
  await add(page, 'PC', 2);
  const pc1 = page.getByRole('group', { name: 'pc1, PC, 0 of 1 ports cabled' });
  await expect(pc1).toBeVisible();

  // Focus the device and open it with Enter, as a keyboard user would.
  await pc1.focus();
  await page.keyboard.press('Enter');
  const w = win(page, 'pc1');
  await w.getByRole('tab', { name: 'Physical' }).focus();
  await page.keyboard.press('Enter');
  await w.getByLabel('Connect eth0 to').focus();
  await w.getByLabel('Connect eth0 to').selectOption({ label: 'pc2 eth0' });

  // The cable may sit under pc1's window; what matters is that it is in the tree with its name.
  await expect(
    page.getByRole('group', { name: 'Cable from pc1 eth0 to pc2 eth0, link up' }),
  ).toBeAttached();
  await expect(page.getByRole('group', { name: 'pc1, PC, 1 of 1 ports cabled' })).toBeVisible();
});
