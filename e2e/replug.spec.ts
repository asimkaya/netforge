import { expect, test, type Page } from '@playwright/test';
import { add, connect } from './helpers.ts';

// Edits within 0.4 s are one undo step, so pause like a person between actions.
const pause = (page: Page) => page.waitForTimeout(500);
const cableBetween = (page: Page, a: string, b: string) =>
  page.getByRole('group', { name: new RegExp(`^Cable from (${a} to ${b}|${b} to ${a}),`) });

test('dragging a plugged port moves that cable end; one undo restores it', async ({ page }) => {
  await page.goto('/');
  await add(page, 'PC', 2);
  await add(page, 'Switch');
  await pause(page);
  await connect(page, 'pc1/eth0', 'pc2/eth0');
  await pause(page);
  await expect(cableBetween(page, 'pc1 eth0', 'pc2 eth0')).toBeAttached();

  await connect(page, 'pc2/eth0', 'sw1/eth3');
  await expect(cableBetween(page, 'pc1 eth0', 'sw1 eth3')).toBeAttached();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await expect(page.getByTestId('port-pc2-eth0')).toHaveAttribute('title', /free/);
  await pause(page);

  await page.keyboard.press('Control+z');
  await expect(cableBetween(page, 'pc1 eth0', 'pc2 eth0')).toBeAttached();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
});

test('a refused move keeps the original cable', async ({ page }) => {
  await page.goto('/');
  await add(page, 'PC', 3);
  await add(page, 'Switch');
  await connect(page, 'pc3/eth0', 'sw1/eth0');
  await connect(page, 'pc1/eth0', 'pc2/eth0');
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);

  await connect(page, 'pc2/eth0', 'sw1/eth0');
  await expect(cableBetween(page, 'pc1 eth0', 'pc2 eth0')).toBeAttached();
  await expect(cableBetween(page, 'pc3 eth0', 'sw1 eth0')).toBeAttached();
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
});

test('dropping a plugged port on the device at its other end is refused without a menu', async ({
  page,
}) => {
  await page.goto('/');
  await add(page, 'PC');
  await add(page, 'Switch');
  await connect(page, 'pc1/eth0', 'sw1/eth3');
  await expect(cableBetween(page, 'pc1 eth0', 'sw1 eth3')).toBeAttached();

  await connect(page, 'pc1/eth0', 'sw1');
  await expect(page.getByText('pc1 eth0 is already cabled to sw1.')).toBeVisible();
  await expect(page.getByText(/Cable from pc1 eth0 to sw1/)).toHaveCount(0);
  await expect(cableBetween(page, 'pc1 eth0', 'sw1 eth3')).toBeAttached();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
});
