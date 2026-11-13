import { expect, test } from '@playwright/test';
import { add, connect, open, run, win } from './helpers.ts';

test('a laptop joins Wi-Fi, gets an address and reaches the router', async ({ page }) => {
  await page.goto('/');
  await add(page, 'Router');
  await add(page, 'Access Point');
  await add(page, 'Laptop');
  await connect(page, 'ap1/eth0', 'r1/eth0');
  await run(page, 'r1', 'ip addr add 192.168.1.1/24 dev eth0');
  await run(page, 'r1', 'dnsmasq --dhcp-range=192.168.1.100,192.168.1.199');
  await win(page, 'r1').getByRole('button', { name: 'Close r1' }).click();

  // The access point starts broadcasting right away; its range is drawn on the canvas.
  await expect(page.getByTestId('device-ap1')).toContainText('NetForge · 0 clients');

  // Drag the laptop inside the access point's dashed range circle.
  const box = await page.getByTestId('device-laptop1').boundingBox();
  const apBox = await page.getByTestId('device-ap1').boundingBox();
  if (!box || !apBox) throw new Error('devices not visible');
  await page.mouse.move(box.x + 30, box.y + 70);
  await page.mouse.down();
  await page.mouse.move(apBox.x - 60, apBox.y + 200, { steps: 8 });
  await page.mouse.up();

  // A real click (React Flow ignores synthetic clicks right after a drag).
  await page.getByTestId('device-laptop1').click({ position: { x: 20, y: 12 } });
  const laptop = await open(page, 'laptop1');
  await laptop.getByRole('button', { name: 'Wi-Fi' }).click();
  const networks = laptop.getByRole('list', { name: 'Wi-Fi networks' });
  await networks.getByRole('button', { name: 'Connect' }).click();
  await laptop.getByLabel('Wi-Fi password').fill('wrong-password');
  await laptop.getByRole('button', { name: 'Join' }).click();
  await expect(laptop.getByRole('status')).toContainText('Secrets were required');
  await laptop.getByLabel('Wi-Fi password').fill('netforge123');
  await laptop.getByRole('button', { name: 'Join' }).click();
  await expect(laptop).toContainText('Connected to NetForge via ap1.');
  await expect(page.getByTestId('device-ap1')).toContainText('1 client');

  await laptop.getByRole('button', { name: '← Desktop' }).click();
  await laptop.getByRole('button', { name: 'IP Configuration' }).click();
  await laptop.getByRole('button', { name: 'Get an address automatically' }).click();
  await expect(laptop.getByLabel('DHCP log')).toContainText('bound to 192.168.1.100');
  const term = await run(page, 'laptop1', 'ping -c 1 192.168.1.1');
  await expect(term.getByRole('log')).toContainText('1 received');
});
