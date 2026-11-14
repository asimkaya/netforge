import { expect, test } from '@playwright/test';
import { add } from './helpers.ts';

test('the web app manifest names the app and has icons', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  );
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest).toMatchObject({
    name: 'NetForge',
    short_name: 'NetForge',
    start_url: '/',
    display: 'standalone',
  });
  const icons = manifest.icons as { src: string; sizes: string; purpose?: string }[];
  expect(icons.map((i) => i.sizes)).toEqual(['192x192', '512x512', '512x512']);
  expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
  for (const icon of icons) {
    const response = await request.get(icon.src);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('image/png');
  }
});

test('after the first visit the app opens and works without a network', async ({
  page,
  context,
}) => {
  await page.goto('/');
  // The worker installs and takes control of the page.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: /Add PC/ })).toBeVisible();
  await add(page, 'PC', 1);
  await expect(page.getByTestId('device-pc1')).toBeVisible();
  await context.setOffline(false);
});
