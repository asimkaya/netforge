import { expect, test } from '@playwright/test';
import { add, connect, open, run } from './helpers.ts';

test('a home router gets online by itself and shares the Internet with a PC', async ({ page }) => {
  await page.goto('/');
  await add(page, 'Internet');
  await add(page, 'Home Router');
  await add(page, 'PC');
  await expect(page.getByTestId('device-home1')).toContainText('HomeWiFi · 0 clients');
  await connect(page, 'home1/eth0', 'internet1/eth0');
  await connect(page, 'pc1', 'home1/eth1');

  const pc1 = await open(page, 'pc1');
  await pc1.getByRole('button', { name: 'IP Configuration' }).click();
  await pc1.getByRole('button', { name: 'Get an address automatically' }).click();
  await expect(pc1.getByLabel('DHCP log')).toContainText('bound to 192.168.1.100');
  await pc1.getByRole('button', { name: 'Close pc1' }).click();

  const term = await run(page, 'pc1', 'ping -c 1 198.18.0.10');
  await expect(term.getByRole('log')).toContainText('1 received');
  const router = await run(page, 'home1', 'ip -4 addr show eth0');
  await expect(router.getByRole('log')).toContainText('inet 192.0.2.100/24');
  await page.screenshot({ path: 'test-results/homerouter.png' });
});
