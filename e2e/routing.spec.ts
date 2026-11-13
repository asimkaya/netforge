import { expect, test, type Locator } from '@playwright/test';
import { add, connect, open, run, win } from './helpers.ts';

async function addAddress(section: Locator, address: string, prefix = '24') {
  await section.getByLabel('IPv4 address').fill(address);
  await section.getByLabel('Prefix (subnet mask)').selectOption(prefix);
  await section.getByRole('button', { name: 'Add address' }).click();
}

test('a router built from forms connects two networks; PCs get addresses with DHCP', async ({
  page,
}) => {
  await page.goto('/');
  await add(page, 'Router');
  await add(page, 'PC', 2);
  await connect(page, 'pc1', 'r1/eth0');
  await connect(page, 'pc2', 'r1/eth1');

  // Router addresses from the Config tab.
  const r1 = await open(page, 'r1');
  await r1.getByRole('tab', { name: 'Config' }).click();
  const addresses = r1.getByRole('region', { name: 'Addresses' });
  await addAddress(addresses.locator('section', { hasText: 'eth0' }).first(), '192.168.1.1');
  await addAddress(addresses.locator('section', { hasText: 'eth1' }).first(), '192.168.2.1');
  await expect(r1.getByRole('table').first()).toContainText('192.168.2.0/24');

  // A DHCP server for the first network, also from the Config tab.
  const services = r1.getByRole('region', { name: 'DHCP and DNS server (dnsmasq)' });
  await expect(services.getByLabel('First address to hand out')).toHaveValue('192.168.1.100');
  await services.getByRole('button', { name: 'Start server' }).click();
  await expect(services).toContainText('Running: dnsmasq --dhcp-range=192.168.1.100,192.168.1.199');
  await r1.getByRole('button', { name: 'Close r1' }).click();

  // pc1 asks for an address.
  const pc1 = await open(page, 'pc1');
  await pc1.getByRole('button', { name: 'IP Configuration' }).click();
  await pc1.getByRole('button', { name: 'Get an address automatically' }).click();
  await expect(pc1.getByLabel('DHCP log')).toContainText('bound to 192.168.1.100');
  await expect(pc1.getByLabel('Default gateway')).toHaveValue('192.168.1.1');
  await pc1.getByRole('button', { name: 'Close pc1' }).click();

  // pc2 is set by hand, gateway included.
  const pc2 = await open(page, 'pc2');
  await pc2.getByRole('button', { name: 'IP Configuration' }).click();
  await addAddress(pc2, '192.168.2.20');
  await pc2.getByLabel('Default gateway').fill('192.168.2.1');
  await pc2.getByRole('button', { name: 'Save gateway' }).click();
  await expect(pc2.getByRole('status')).toContainText('Default gateway saved.');

  const term = await run(page, 'pc1', 'ping -c 1 192.168.2.20');
  await expect(term.getByRole('log')).toContainText('ttl=63');
  await run(page, 'pc1', 'traceroute 192.168.2.20');
  await expect(win(page, 'pc1').getByRole('log')).toContainText(' 1  192.168.1.1 (192.168.1.1)');
  await expect(win(page, 'pc1').getByRole('log')).toContainText(' 2  192.168.2.20 (192.168.2.20)');
});
