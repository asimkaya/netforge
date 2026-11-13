import { expect, test } from '@playwright/test';
import { add, connect, open, run } from './helpers.ts';

test('PCs configure IPv6 from router advertisements and ping across', async ({ page }) => {
  await page.goto('/');
  await add(page, 'Router');
  await add(page, 'PC', 2);
  await connect(page, 'pc1', 'r1/eth0');
  await connect(page, 'pc2', 'r1/eth1');

  const r1 = await open(page, 'r1');
  await r1.getByRole('tab', { name: 'Config' }).click();
  const radvd = r1.getByRole('region', { name: 'IPv6 router advertisements (radvd)' });
  await radvd.getByLabel('eth0 IPv6 prefix').fill('2001:db8:1::/64');
  await radvd.getByLabel('eth1 IPv6 prefix').fill('2001:db8:2::/64');
  await radvd.getByRole('button', { name: 'Start radvd' }).click();
  await expect(radvd.getByRole('status')).toContainText('radvd announces eth0, eth1.');
  await r1.getByRole('button', { name: 'Close r1' }).click();

  const pc2 = await open(page, 'pc2');
  await pc2.getByRole('button', { name: 'IP Configuration' }).click();
  await expect(pc2).toContainText('automatic (SLAAC)');
  await pc2.getByLabel('IPv6 address for eth0').fill('2001:db8:2::20');
  await pc2.getByRole('button', { name: 'Add IPv6 address' }).click();
  await expect(pc2).toContainText('2001:db8:2::20/64');
  await pc2.getByRole('button', { name: 'Close pc2' }).click();

  const term = await run(page, 'pc1', 'ping -c 1 2001:db8:2::20');
  await expect(term.getByRole('log')).toContainText(
    '64 bytes from 2001:db8:2::20: icmp_seq=1 ttl=63',
  );
});
