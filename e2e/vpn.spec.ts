import { expect, test, type Locator } from '@playwright/test';
import { add, connect, open, run, win } from './helpers.ts';

async function wgSection(page: Parameters<typeof open>[0], name: string): Promise<Locator> {
  const w = await open(page, name);
  await w.getByRole('tab', { name: 'Config' }).click();
  return w.getByRole('region', { name: 'WireGuard VPN' });
}

test('two offices are joined with a WireGuard VPN built from the Config tab', async ({ page }) => {
  await page.goto('/');
  await add(page, 'Internet');
  await add(page, 'Router', 2);
  await add(page, 'PC', 2);
  await connect(page, 'r1/eth1', 'internet1/eth0');
  await connect(page, 'r2/eth1', 'internet1/eth1');
  await connect(page, 'pc1', 'r1/eth0');
  await connect(page, 'pc2', 'r2/eth0');
  for (const [r, lan] of [
    ['r1', '1'],
    ['r2', '2'],
  ] as const) {
    await run(page, r, 'dhclient eth1');
    await run(page, r, `ip addr add 192.168.${lan}.1/24 dev eth0`);
  }
  for (const [pc, lan] of [
    ['pc1', '1'],
    ['pc2', '2'],
  ] as const) {
    await run(page, pc, `ip addr add 192.168.${lan}.10/24 dev eth0`);
    await run(page, pc, `ip route add default via 192.168.${lan}.1`);
  }

  const keys: string[] = [];
  for (const [r, addr] of [
    ['r1', '10.8.0.1/24'],
    ['r2', '10.8.0.2/24'],
  ] as const) {
    const vpn = await wgSection(page, r);
    await vpn.getByLabel('Tunnel address').fill(addr);
    await vpn.getByRole('button', { name: 'Create wg0' }).click();
    keys.push((await vpn.getByLabel('WireGuard public key').textContent()) ?? '');
    await win(page, r)
      .getByRole('button', { name: `Close ${r}` })
      .click();
  }

  const peers = [
    ['r1', keys[1], '198.51.100.100:51820', '10.8.0.2/32, 192.168.2.0/24'],
    ['r2', keys[0], '192.0.2.100:51820', '10.8.0.1/32, 192.168.1.0/24'],
  ] as const;
  for (const [r, key, endpoint, allowed] of peers) {
    const vpn = await wgSection(page, r);
    await vpn.getByLabel('Peer public key').fill(key ?? '');
    await vpn.getByLabel('Endpoint').fill(endpoint);
    await vpn.getByLabel('Allowed IPs').fill(allowed);
    await vpn.getByRole('button', { name: 'Add peer' }).click();
    await expect(vpn.getByRole('list', { name: 'WireGuard peers' })).toContainText(endpoint);
    await win(page, r)
      .getByRole('button', { name: `Close ${r}` })
      .click();
  }

  const term = await run(page, 'pc1', 'ping -c 1 192.168.2.10');
  await expect(term.getByRole('log')).toContainText('1 received');
  const show = await run(page, 'r1', 'wg show');
  await expect(show.getByRole('log')).toContainText('latest handshake');
});
