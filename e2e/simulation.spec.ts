import { expect, test, type Page } from '@playwright/test';

async function run(page: Page, device: string, command: string) {
  await page.getByTestId(`device-${device}`).dblclick();
  const input = page.getByRole('textbox', { name: 'Command' });
  await input.fill(command);
  await input.press('Enter');
}

test('simulation mode steps through a ping frame by frame', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Add PC/ }).click();
  await page.getByRole('button', { name: /Add PC/ }).click();
  const handle = await page.getByTestId('device-pc1').locator('.react-flow__handle').boundingBox();
  const target = await page.getByTestId('device-pc2').boundingBox();
  if (!handle || !target) throw new Error('devices not visible');
  await page.mouse.move(handle.x + 6, handle.y + 6);
  await page.mouse.down();
  await page.mouse.move(target.x + 50, target.y + 40, { steps: 10 });
  await page.mouse.up();

  await run(page, 'pc1', 'ip addr add 10.0.0.1/24 dev eth0');
  await run(page, 'pc2', 'ip addr add 10.0.0.2/24 dev eth0');
  await page.getByRole('radio', { name: 'Simulation' }).click();
  await run(page, 'pc1', 'ping -c 1 10.0.0.2');

  const events = page.getByRole('region', { name: 'Simulation events' });
  const rows = events.locator('tbody tr');
  await expect(rows).toHaveCount(0);
  await expect(page.getByRole('log')).not.toContainText('64 bytes from');

  const step = events.getByRole('button', { name: 'Step' });
  await step.click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('pc1 → pc2');
  await expect(rows.first()).toContainText('ARP, Request who-has 10.0.0.2 tell 10.0.0.1');
  await expect(events).toContainText('Address Resolution Protocol');

  for (let i = 0; i < 3; i++) await step.click();
  await expect(rows).toHaveCount(4);
  await expect(rows.last()).toContainText('ICMP echo reply');
  await expect(events).toContainText('0 (Echo reply)');

  // The ping only progressed because we stepped it; the reply ends it, like on Linux.
  await expect(page.getByRole('log')).toContainText('1 packets transmitted, 1 received');
  await expect(step).toBeDisabled();
});
