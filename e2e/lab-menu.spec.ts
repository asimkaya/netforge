import { expect, test } from '@playwright/test';
import { labMenu } from './helpers.ts';

test('the Lab menu closes on Escape and holds the file actions', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Lab menu' }).click();
  const menu = page.getByRole('menu', { name: 'Lab' });
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Share link',
    'Export',
    'Import',
    'New lab',
  ]);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await labMenu(page, 'Share link');
  await expect(page.getByRole('status')).toContainText('ink');
});
