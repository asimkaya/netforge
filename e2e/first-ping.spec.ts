import { expect, test } from '@playwright/test';
import { add, connect, run } from './helpers.ts';

test('two PCs on one cable can ping each other', async ({ page }) => {
  await page.goto('/');
  await add(page, 'PC', 2);

  await connect(page, 'pc1', 'pc2');
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  await run(page, 'pc1', 'ip addr add 192.168.1.10/24 dev eth0');
  await expect(page.getByTestId('device-pc1')).toContainText('192.168.1.10/24');
  await run(page, 'pc2', 'ip addr add 192.168.1.20/24 dev eth0');
  await run(page, 'pc2', 'ping -c 2 192.168.1.10');

  const log = page.getByRole('log');
  await expect(log).toContainText('64 bytes from 192.168.1.10: icmp_seq=1');
  await expect(log).toContainText('2 packets transmitted, 2 received, 0% packet loss');
});

test('Ctrl+C stops a running ping', async ({ page }) => {
  await page.goto('/');
  await add(page, 'PC');
  await run(page, 'pc1', 'ip addr add 10.0.0.1/24 dev eth0');
  await run(page, 'pc1', 'ping 10.0.0.1');
  const log = page.getByRole('log');
  await expect(log).toContainText('icmp_seq=1');
  await page.keyboard.press('Control+c');
  await expect(log).toContainText('^C');
  await expect(log).toContainText('--- 10.0.0.1 ping statistics ---');
  await expect(page.getByRole('textbox', { name: 'Command' })).toBeFocused();
});

test('a second cable that would form a loop is refused with a message', async ({ page }) => {
  await page.goto('/');
  await add(page, 'Switch', 2);
  await connect(page, 'sw1/eth0', 'sw2/eth0');
  await connect(page, 'sw2/eth1', 'sw1/eth1');
  await expect(page.getByRole('status')).toContainText('switching loop');
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
});

test('cables go into the port you choose', async ({ page }) => {
  await page.goto('/');
  await add(page, 'Switch');
  await add(page, 'PC', 2);

  // Port to port.
  await connect(page, 'pc1', 'sw1/eth5');
  // Dropped on the switch body: a menu asks which port.
  await connect(page, 'pc2', 'sw1');
  const menu = page.getByRole('menu', { name: 'Choose a port on sw1' });
  await expect(menu.getByRole('menuitem', { name: /eth5.*in use: pc1 eth0/ })).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: /eth8.*different cable/ })).toBeDisabled();
  await menu.getByRole('menuitem', { name: /^eth2/ }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);

  await page.getByTestId('device-sw1').click({ position: { x: 20, y: 10 } });
  const ports = page.getByRole('list').first();
  await expect(ports).toContainText('→ pc1 eth0');
  await expect(ports).toContainText('→ pc2 eth0');
  await expect(page.getByTestId('port-sw1-eth5')).toHaveAttribute('title', /to pc1 eth0/);

  // A copper port does not take a fiber cable.
  await add(page, 'Switch');
  await connect(page, 'sw2/eth8', 'sw1/eth0');
  await expect(page.getByRole('status')).toContainText('need different cables');
  // Fiber to fiber works, chosen from the inspector without a mouse drag.
  await page.getByTestId('device-sw2').click({ position: { x: 20, y: 10 } });
  await page.getByRole('combobox', { name: 'Connect eth8 to' }).selectOption({ label: 'sw1 eth9' });
  await expect(page.locator('.react-flow__edge')).toHaveCount(3);
});
