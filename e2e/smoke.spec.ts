import { expect, test } from '@playwright/test';

test('app loads with an empty topology canvas and no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');

  await expect(page).toHaveTitle('NetForge');
  await expect(page.getByRole('heading', { name: 'NetForge', exact: true })).toBeVisible();
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
  expect(errors).toEqual([]);
});
