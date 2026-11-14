import { expect, test } from '@playwright/test';
import { labMenu } from './helpers.ts';

test('the Lab menu closes on Escape and holds the file actions', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Lab menu' }).click();
  const menu = page.getByRole('menu', { name: 'Lab' });
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Share link',
    'Export',
    'Export as Linux script',
    'Import',
    'Dark theme',
    'New lab',
  ]);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await labMenu(page, 'Share link');
  await expect(page.getByRole('status')).toContainText('ink');
});

test('the dark theme is chosen from the Lab menu and survives a reload', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'light');
  await labMenu(page, 'Dark theme');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await labMenu(page, 'Light theme');
  await expect(html).toHaveAttribute('data-theme', 'light');
});
