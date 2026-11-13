import { expect, test } from '@playwright/test';
import { add, connect, run } from './helpers.ts';

test('simulation mode steps through a ping frame by frame', async ({ page }) => {
  await page.goto('/');
  await add(page, 'PC', 2);
  await connect(page, 'pc1', 'pc2');

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
