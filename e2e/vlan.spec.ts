import { expect, test, type Locator } from '@playwright/test';
import { add, connect, open, run } from './helpers.ts';

async function setPort(vlans: Locator, port: string, mode: 'Access' | 'Trunk', ids: string) {
  await vlans.getByLabel(`${port} mode`).selectOption({ label: mode });
  await vlans.getByLabel(`${port} VLANs`).fill(ids);
  await vlans.getByLabel(`${port} VLANs`).press('Enter');
}

test('VLANs split a switch and a router on a stick routes between them', async ({ page }) => {
  await page.goto('/');
  await add(page, 'Switch');
  await add(page, 'PC', 2);
  await add(page, 'Router');
  await connect(page, 'pc1', 'sw1/eth0');
  await connect(page, 'pc2', 'sw1/eth1');
  await connect(page, 'r1/eth0', 'sw1/eth7');

  const sw = await open(page, 'sw1');
  await sw.getByRole('tab', { name: 'Config' }).click();
  const vlans = sw.getByRole('region', { name: 'VLANs' });
  await vlans.getByLabel('VLAN filtering').check();
  await setPort(vlans, 'eth0', 'Access', '10');
  await setPort(vlans, 'eth1', 'Access', '20');
  await setPort(vlans, 'eth7', 'Trunk', '10,20');
  await expect(vlans.getByLabel('eth7 VLANs')).toHaveValue('10,20');
  await sw.getByRole('button', { name: 'Close sw1' }).click();

  const r1 = await open(page, 'r1');
  await r1.getByRole('tab', { name: 'Config' }).click();
  const subs = r1.getByRole('region', { name: 'VLAN interfaces' });
  for (const id of ['10', '20']) {
    await subs.getByLabel('VLAN id').fill(id);
    await subs.getByRole('button', { name: 'Add VLAN interface' }).click();
    await expect(subs).toContainText(`eth0.${id}`);
  }
  await r1.getByRole('button', { name: 'Close r1' }).click();
  await run(page, 'r1', 'ip addr add 192.168.10.1/24 dev eth0.10');
  await run(page, 'r1', 'ip addr add 192.168.20.1/24 dev eth0.20');

  await run(page, 'pc2', 'ip addr add 192.168.20.2/24 dev eth0');
  await run(page, 'pc2', 'ip route add default via 192.168.20.1');
  await run(page, 'pc1', 'ip addr add 192.168.10.2/24 dev eth0');
  await run(page, 'pc1', 'ip route add default via 192.168.10.1');
  const term = await run(page, 'pc1', 'ping -c 1 192.168.20.2');
  await expect(term.getByRole('log')).toContainText('1 received');

  const shell = await run(page, 'sw1', 'bridge vlan show');
  await expect(shell.getByRole('log')).toContainText('eth0              10 PVID Egress Untagged');
});
