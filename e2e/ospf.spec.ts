import { expect, test } from '@playwright/test';
import { add, connect, open, run } from './helpers.ts';

test('two routers learn each other’s networks with OSPF', async ({ page }) => {
  await page.goto('/');
  await add(page, 'Router', 2);
  await add(page, 'PC', 2);
  await connect(page, 'r1/eth1', 'r2/eth1');
  await connect(page, 'pc1', 'r1/eth0');
  await connect(page, 'pc2', 'r2/eth0');
  await run(page, 'r1', 'ip addr add 10.0.0.1/30 dev eth1');
  await run(page, 'r1', 'ip addr add 192.168.1.1/24 dev eth0');
  await run(page, 'r2', 'ip addr add 10.0.0.2/30 dev eth1');
  await run(page, 'r2', 'ip addr add 192.168.2.1/24 dev eth0');
  await run(page, 'pc1', 'ip addr add 192.168.1.10/24 dev eth0');
  await run(page, 'pc1', 'ip route add default via 192.168.1.1');
  await run(page, 'pc2', 'ip addr add 192.168.2.10/24 dev eth0');
  await run(page, 'pc2', 'ip route add default via 192.168.2.1');

  // r2 starts BIRD from the shell, r1 from its Config tab.
  await run(page, 'r2', 'bird');
  const r1 = await open(page, 'r1');
  await r1.getByRole('tab', { name: 'Config' }).click();
  const ospf = r1.getByRole('region', { name: 'Dynamic routing (OSPF)' });
  await ospf.getByRole('button', { name: 'Start OSPF (bird)' }).click();
  await expect(ospf.getByRole('list', { name: 'OSPF neighbors' })).toContainText(
    /10\.0\.0\.2 on eth1\s*Full/,
  );
  await expect(ospf.getByRole('list', { name: 'OSPF routes' })).toContainText(
    '192.168.2.0/24 via 10.0.0.2 (eth1), cost 20',
  );
  await r1.getByRole('button', { name: 'Close r1' }).click();

  const term = await run(page, 'pc1', 'ping -c 1 192.168.2.10');
  await expect(term.getByRole('log')).toContainText('1 received');
});
