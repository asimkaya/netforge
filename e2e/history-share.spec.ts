import { expect, test } from '@playwright/test';
import { add, connect, labMenu, open, run } from './helpers.ts';

test('undo and redo edits with buttons and keyboard', async ({ page }) => {
  // Changes within 0.4 s merge into one undo step (a drag is one step), so pause like a person.
  const pause = () => page.waitForTimeout(500);
  await page.goto('/');
  await add(page, 'PC');
  await pause();
  await add(page, 'PC');
  await pause();
  await connect(page, 'pc1', 'pc2');
  await pause();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  await page.keyboard.press('Control+z');
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('device-pc2')).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  // Ctrl+Z while typing undoes text, not the lab.
  const pc1 = await open(page, 'pc1');
  await pc1.getByRole('tab', { name: 'Config' }).click();
  await pc1.getByLabel('Hostname').fill('alice');
  await pc1.getByLabel('Hostname').press('Control+z');
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
});

test('a share link carries the lab to another browser', async ({ page, context, browser }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await add(page, 'Router');
  await add(page, 'PC');
  await connect(page, 'pc1', 'r1/eth2');
  await run(page, 'pc1', 'ip addr add 10.1.2.3/24 dev eth0');
  await labMenu(page, 'Share link');
  await expect(page.getByRole('status')).toContainText('Link copied');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/\/#lab=[A-Za-z0-9_-]+$/);

  // A fresh browser profile: no autosave, so it opens without asking.
  const other = await browser.newContext();
  const friend = await other.newPage();
  await friend.goto(link);
  await expect(friend.getByRole('status')).toContainText('Opened a shared lab.');
  await expect(friend.getByTestId('device-pc1')).toContainText('10.1.2.3/24');
  await expect(friend.getByTestId('port-r1-eth2')).toHaveAttribute('title', /to pc1 eth0/);
  expect(new URL(friend.url()).hash).toBe('');
  await other.close();
});

test('a damaged share link explains itself and changes nothing', async ({ page }) => {
  await page.goto('/#lab=this-is-not-a-lab');
  await expect(page.getByRole('status')).toContainText('This shared link is damaged.');
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
});
