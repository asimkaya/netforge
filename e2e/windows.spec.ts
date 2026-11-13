import { expect, test } from '@playwright/test';
import { add, connect, open, run, win } from './helpers.ts';

test('a click opens the device window; tabs show hardware, settings and apps', async ({ page }) => {
  await page.goto('/');
  await add(page, 'PC', 2);
  await connect(page, 'pc1', 'pc2');

  // A real click on the device opens its window on the Desktop tab.
  await page.getByTestId('device-pc1').click({ position: { x: 20, y: 12 } });
  const pc1 = win(page, 'pc1');
  await expect(pc1.getByRole('tab', { name: 'Desktop' })).toHaveAttribute('aria-selected', 'true');

  await pc1.getByRole('tab', { name: 'Physical' }).click();
  await expect(pc1.getByRole('row', { name: /eth0/ })).toContainText('→ pc2 eth0');

  await pc1.getByRole('tab', { name: 'Config' }).click();
  await pc1.getByLabel('Hostname').fill('alice');
  await pc1.getByLabel('Hostname').press('Enter');
  const alice = win(page, 'alice');
  await expect(alice).toBeVisible();

  // IP Configuration edits the same settings as `ip addr`.
  await alice.getByRole('tab', { name: 'Desktop' }).click();
  await alice.getByRole('button', { name: 'IP Configuration' }).click();
  await alice.getByLabel('IPv4 address').fill('10.0.0.300');
  await alice.getByRole('button', { name: 'Add address' }).click();
  await expect(alice.getByRole('alert')).toContainText('Enter an IPv4 address');
  await alice.getByLabel('IPv4 address').fill('10.0.0.1');
  await alice.getByRole('button', { name: 'Add address' }).click();
  await expect(alice).toContainText('10.0.0.1/24 mask 255.255.255.0');
  await expect(page.getByTestId('device-alice')).toContainText('10.0.0.1/24');

  // Two windows at once: pc2 pings alice from its terminal.
  await run(page, 'pc2', 'ip addr add 10.0.0.2/24 dev eth0');
  await run(page, 'pc2', 'ping -c 1 10.0.0.1');
  await expect(win(page, 'pc2').getByRole('log')).toContainText('1 received');
  await open(page, 'alice');
  await alice.getByRole('button', { name: '← Desktop' }).click();
  await alice.getByRole('button', { name: 'IP Configuration' }).click();
  await expect(alice).toContainText('10.0.0.2');
});

test('windows can be moved, stacked, minimized and closed', async ({ page }) => {
  await page.goto('/');
  await add(page, 'PC');
  await add(page, 'Switch');
  const pc = await open(page, 'pc1');
  const sw = await open(page, 'sw1');
  await expect(sw.getByRole('tab', { name: 'CLI' })).toBeVisible();

  // The last opened window is in front; clicking the other brings it forward.
  const z = async (w: typeof pc) => Number(await w.evaluate((el) => getComputedStyle(el).zIndex));
  expect(await z(sw)).toBeGreaterThan(await z(pc));
  // Clicking the device (or anywhere in its window) brings the window forward.
  await open(page, 'pc1');
  expect(await z(pc)).toBeGreaterThan(await z(sw));
  await sw.getByRole('tab', { name: 'Physical' }).dispatchEvent('pointerdown');
  expect(await z(sw)).toBeGreaterThan(await z(pc));
  await open(page, 'pc1');

  // Drag by the title bar.
  const before = await pc.boundingBox();
  const title = await pc.getByRole('heading', { name: 'pc1' }).boundingBox();
  if (!before || !title) throw new Error('window not visible');
  await page.mouse.move(title.x + 5, title.y + 5);
  await page.mouse.down();
  await page.mouse.move(title.x + 105, title.y + 45, { steps: 5 });
  await page.mouse.up();
  const after = await pc.boundingBox();
  expect(Math.round((after?.x ?? 0) - before.x)).toBe(100);
  expect(Math.round((after?.y ?? 0) - before.y)).toBe(40);

  await pc.getByRole('button', { name: 'Minimize pc1' }).click();
  await expect(pc).toBeHidden();
  await page
    .getByRole('navigation', { name: 'Minimized windows' })
    .getByRole('button', { name: 'pc1' })
    .click();
  await expect(pc).toBeVisible();

  await open(page, 'sw1');
  await sw.getByRole('button', { name: 'Close sw1' }).click();
  await expect(sw).toBeHidden();
});

test('right-click menu and keyboard open devices', async ({ page }) => {
  await page.goto('/');
  await add(page, 'PC', 2);

  await page.getByTestId('device-pc2').click({ button: 'right', position: { x: 20, y: 12 } });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.getByTestId('device-pc2')).toHaveCount(0);

  await page.locator('.react-flow__node').first().focus();
  await page.keyboard.press('Enter');
  await expect(win(page, 'pc1')).toBeVisible();
});
