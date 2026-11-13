import { expect, test, type Page } from '@playwright/test';

async function connect(page: Page, from: string, to: string) {
  const handle = page.getByTestId(`device-${from}`).locator('.react-flow__handle');
  const target = page.getByTestId(`device-${to}`);
  const a = await handle.boundingBox();
  const b = await target.boundingBox();
  if (!a || !b) throw new Error('devices not visible');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();
}

async function terminal(page: Page, device: string, command: string) {
  await page.getByTestId(`device-${device}`).dblclick();
  const input = page.getByRole('textbox', { name: 'Command' });
  await input.fill(command);
  await input.press('Enter');
}

test('two PCs on one cable can ping each other', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Add PC/ }).click();
  await page.getByRole('button', { name: /Add PC/ }).click();

  await connect(page, 'pc1', 'pc2');
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  await terminal(page, 'pc1', 'ip addr add 192.168.1.10/24 dev eth0');
  await expect(page.getByTestId('device-pc1')).toContainText('192.168.1.10/24');
  await terminal(page, 'pc2', 'ip addr add 192.168.1.20/24 dev eth0');
  await terminal(page, 'pc2', 'ping -c 2 192.168.1.10');

  const log = page.getByRole('log');
  await expect(log).toContainText('64 bytes from 192.168.1.10: icmp_seq=1');
  await expect(log).toContainText('2 packets transmitted, 2 received, 0% packet loss');
});

test('Ctrl+C stops a running ping', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Add PC/ }).click();
  await terminal(page, 'pc1', 'ip addr add 10.0.0.1/24 dev eth0');
  await terminal(page, 'pc1', 'ping 10.0.0.1');
  const log = page.getByRole('log');
  await expect(log).toContainText('icmp_seq=1');
  await page.keyboard.press('Control+c');
  await expect(log).toContainText('^C');
  await expect(log).toContainText('--- 10.0.0.1 ping statistics ---');
  await expect(page.getByRole('textbox', { name: 'Command' })).toBeFocused();
});

test('a second cable that would form a loop is refused with a message', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Add Switch/ }).click();
  await page.getByRole('button', { name: /Add Switch/ }).click();
  await connect(page, 'sw1', 'sw2');
  await connect(page, 'sw2', 'sw1');
  await expect(page.getByRole('status')).toContainText('switching loop');
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
});
