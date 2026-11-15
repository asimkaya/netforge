import { expect, test, type Locator } from '@playwright/test';
import { add, connect, open, run } from './helpers.ts';

async function setPort(vlans: Locator, port: string, mode: 'Access' | 'Trunk', ids: string) {
  await vlans.getByLabel(`${port} mode`).selectOption({ label: mode });
  await vlans.getByLabel(`${port} VLANs`).fill(ids);
  await vlans.getByLabel(`${port} VLANs`).press('Enter');
}

test('a printer, a camera and the 24-port and L3 switches can be added and cabled', async ({
  page,
}) => {
  await page.goto('/');
  await add(page, '24-port Switch');
  await add(page, 'L3 Switch');
  await add(page, 'Printer');
  await add(page, 'IP Camera');
  await connect(page, 'printer1', 'sw1/eth0');
  await connect(page, 'cam1', 'sw1/eth23');
  await connect(page, 'l3sw1/eth24', 'sw1/eth27');
  await expect(page.getByTestId('device-sw1')).toContainText('24× Ethernet');
  await expect(page.getByTestId('device-sw1')).toContainText('4× SFP');

  const printer = await open(page, 'printer1');
  await expect(printer.getByRole('tab')).toHaveText(['Physical', 'Config']);
  await printer.getByRole('tab', { name: 'Config' }).click();
  await expect(printer.getByRole('region', { name: 'Printing' })).toContainText('Pages printed: 0');
  await printer.getByRole('button', { name: 'Close printer1' }).click();

  const camera = await open(page, 'cam1');
  await expect(camera.getByRole('tab')).toHaveText(['Physical', 'Config']);
  await camera.getByRole('tab', { name: 'Config' }).click();
  await expect(camera.getByRole('region', { name: 'Streaming' })).toContainText('Viewers');
});

test('a PC prints a page and the printer counts it', async ({ page }) => {
  await page.goto('/');
  await add(page, 'Home Router');
  await add(page, 'PC');
  await add(page, 'Printer');
  await connect(page, 'pc1', 'home1/eth1');
  await connect(page, 'printer1', 'home1/eth2');

  // The printer asks the router's DHCP server for an address when it is plugged in.
  const shown = page.getByTestId('address-printer1');
  await expect(shown).toHaveText(/^192\.168\.1\.\d+$/);
  const address = (await shown.textContent()) ?? '';
  await expect(page.getByTestId('pages-printer1')).toHaveText('0 pages');

  await run(page, 'pc1', 'ip addr add 192.168.1.50/24 dev eth0');
  await run(page, 'pc1', 'echo hello > job.txt');
  const term = await run(page, 'pc1', `nc ${address} 9100 < job.txt`);
  await expect(page.getByTestId('pages-printer1')).toHaveText('1 page');

  await run(page, 'pc1', `curl -s http://${address}/`);
  await expect(term.getByRole('log')).toContainText('Pages printed: 1');
});

test('the Print and Camera Viewer apps use the printer and the camera', async ({ page }) => {
  await page.goto('/');
  await add(page, 'Home Router');
  await add(page, 'PC');
  await add(page, 'Printer');
  await add(page, 'IP Camera');
  await connect(page, 'pc1', 'home1/eth1');
  await connect(page, 'printer1', 'home1/eth2');
  await connect(page, 'cam1', 'home1/eth3');
  await expect(page.getByTestId('address-printer1')).toHaveText(/^192\.168\.1\.\d+$/);
  const pc = await open(page, 'pc1');
  await pc.getByRole('button', { name: 'IP Configuration' }).click();
  await pc.getByRole('button', { name: 'Get an address automatically' }).click();
  await expect(pc.getByLabel('DHCP log')).toContainText('bound to 192.168.1.');
  // Names come from the router's DHCP and DNS, like `nc printer1 9100`.
  const printer = 'printer1';
  const camera = 'cam1';
  await pc.getByRole('button', { name: '← Desktop' }).click();
  await pc.getByRole('button', { name: /^Print/ }).click();
  await pc.getByLabel('Printer').fill(printer);
  await pc.getByLabel('Document').fill('Hello from the app');
  await pc.getByRole('button', { name: 'Print', exact: true }).click();
  await expect(pc.getByRole('status')).toContainText(/Sent to printer1 \(192\.168\.1\.\d+\)/);
  await expect(page.getByTestId('pages-printer1')).toHaveText('1 page');

  await pc.getByRole('button', { name: '← Desktop' }).click();
  await pc.getByRole('button', { name: /^Camera Viewer/ }).click();
  await pc.getByLabel('Camera').fill(camera);
  await pc.getByRole('button', { name: 'Connect' }).click();
  await expect(pc.getByRole('status')).toContainText('Streaming: frame 2', { timeout: 15_000 });
  await pc.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByTestId('device-cam1')).toContainText('no viewers', { timeout: 15_000 });
});

test('an L3 switch routes between two VLANs without a router', async ({ page }) => {
  await page.goto('/');
  await add(page, 'L3 Switch');
  await add(page, 'PC', 2);
  await connect(page, 'pc1', 'l3sw1/eth0');
  await connect(page, 'pc2', 'l3sw1/eth1');

  const sw = await open(page, 'l3sw1');
  await sw.getByRole('tab', { name: 'Config' }).click();
  const vlans = sw.getByRole('region', { name: 'VLANs' });
  await vlans.getByLabel('VLAN filtering').check();
  await setPort(vlans, 'eth0', 'Access', '10');
  await setPort(vlans, 'eth1', 'Access', '20');
  const subs = sw.getByRole('region', { name: 'VLAN interfaces' });
  for (const id of ['10', '20']) {
    await subs.getByLabel('VLAN id').fill(id);
    await subs.getByRole('button', { name: 'Add VLAN interface' }).click();
    await expect(subs).toContainText(`br0.${id}`);
  }
  await sw.getByRole('button', { name: 'Close l3sw1' }).click();
  await run(page, 'l3sw1', 'ip addr add 192.168.10.1/24 dev br0.10');
  await run(page, 'l3sw1', 'ip addr add 192.168.20.1/24 dev br0.20');

  await run(page, 'pc2', 'ip addr add 192.168.20.2/24 dev eth0');
  await run(page, 'pc2', 'ip route add default via 192.168.20.1');
  await run(page, 'pc1', 'ip addr add 192.168.10.2/24 dev eth0');
  await run(page, 'pc1', 'ip route add default via 192.168.10.1');
  const term = await run(page, 'pc1', 'ping -c 1 192.168.20.2');
  await expect(term.getByRole('log')).toContainText('1 received');
});
