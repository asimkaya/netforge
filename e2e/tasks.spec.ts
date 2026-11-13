import { expect, test, type Page } from '@playwright/test';

async function connect(page: Page, from: string, to: string) {
  const handle = await page
    .getByTestId(`device-${from}`)
    .locator('.react-flow__handle')
    .boundingBox();
  const target = await page.getByTestId(`device-${to}`).boundingBox();
  if (!handle || !target) throw new Error('devices not visible');
  await page.mouse.move(handle.x + 6, handle.y + 6);
  await page.mouse.down();
  await page.mouse.move(target.x + 50, target.y + 40, { steps: 10 });
  await page.mouse.up();
}

async function run(page: Page, device: string, command: string) {
  await page.getByTestId(`device-${device}`).dblclick();
  const input = page.getByRole('textbox', { name: 'Command' });
  await input.fill(command);
  await input.press('Enter');
}

test('a newcomer completes the first guided task', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Welcome to NetForge/ })).toBeVisible();
  await page.getByRole('button', { name: 'Start' }).first().click();

  const task = page.getByRole('region', { name: 'Current task' });
  const current = task.locator('[aria-current="step"]');
  await expect(task).toContainText('0/5');
  await expect(current).toContainText('Add two PCs');

  await page.getByRole('button', { name: /Add PC/ }).click();
  await page.getByRole('button', { name: /Add PC/ }).click();
  await expect(current).toContainText('Connect them with a cable');

  await connect(page, 'pc1', 'pc2');
  await expect(current).toContainText('Give the first PC an IP address');
  await current.getByRole('button', { name: 'Show a hint' }).click();
  await expect(current).toContainText('name of the network port');

  await run(page, 'pc1', 'ip addr add 192.168.1.10/24 dev eth0');
  await run(page, 'pc2', 'ip addr add 192.168.1.20/24 dev eth0');
  await expect(current).toContainText('Ping one PC from the other');

  await run(page, 'pc2', 'ping -c 1 192.168.1.10');
  await expect(task).toContainText('5/5');
  await expect(task).toContainText('Congratulations!');

  // Progress survives a reload.
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Current task' })).toContainText('5/5');
  await page.getByRole('button', { name: 'Back to all tasks' }).click();
  await page.getByTestId('device-pc1').click();
  await page.keyboard.press('Escape');
  await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole('button', { name: 'Play again' })).toBeVisible();
});
