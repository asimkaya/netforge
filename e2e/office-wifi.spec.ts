import { expect, test, type Page } from '@playwright/test';
import { add, connect, finish, open, run, taskCenter, win } from './helpers.ts';

const BEFORE = ['first-ping', 'meet-the-switch', 'two-networks', 'dhcp', 'first-print'];

/** Drags a device next to another one (the access point), inside its dashed range circle. */
async function dragNear(page: Page, device: string, anchor: string, dy: number) {
  const box = await page.getByTestId(`device-${device}`).boundingBox();
  const near = await page.getByTestId(`device-${anchor}`).boundingBox();
  if (!box || !near) throw new Error('devices not visible');
  await page.mouse.move(box.x + 20, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(near.x + near.width / 2, near.y + near.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
}

async function joinWifi(page: Page, device: string) {
  // A real click (React Flow ignores synthetic clicks right after a drag).
  await page.getByTestId(`device-${device}`).click({ position: { x: 20, y: 12 } });
  const w = await open(page, device);
  await w.getByRole('button', { name: 'Wi-Fi' }).click();
  await w
    .getByRole('list', { name: 'Wi-Fi networks' })
    .getByRole('button', { name: 'Connect' })
    .click();
  await w.getByLabel('Wi-Fi password').fill('meeting-room-1');
  await w.getByRole('button', { name: 'Join' }).click();
  await expect(w).toContainText('Connected to Office via ap1.');
  await w.getByRole('button', { name: '← Desktop' }).click();
  await w.getByRole('button', { name: 'IP Configuration' }).click();
  await w.getByRole('button', { name: 'Get an address automatically' }).click();
  await expect(w.getByLabel('DHCP log')).toContainText('bound to 192.168.1.');
  await w.getByRole('button', { name: `Close ${device}` }).click();
}

test('Wi-Fi for the meeting room: own name and password, a laptop and a phone join', async ({
  page,
}) => {
  await page.goto('/');
  await finish(page, [...BEFORE, 'lobby-camera']);
  await taskCenter(page);
  await page.getByRole('button', { name: 'Start: Wi-Fi for the meeting room' }).click();
  const task = page.getByRole('region', { name: 'Current task' });
  await expect(task).toContainText('0/5');
  await expect(task).toContainText('From Maya, office manager');

  await add(page, 'Access Point');
  await connect(page, 'ap1/eth0', 'sw1/eth5');
  await expect(task).toContainText('1/5');

  // The factory name does not count; the office's own name and password do.
  const ap = await open(page, 'ap1');
  await ap.getByRole('tab', { name: 'Config' }).click();
  await ap.getByLabel('Network name (SSID)').fill('Office');
  await ap.getByLabel('WPA2 password').fill('meeting-room-1');
  await ap.getByRole('button', { name: 'Save and restart' }).click();
  await expect(task).toContainText('2/5');
  await ap.getByRole('button', { name: 'Close ap1' }).click();

  await add(page, 'Laptop');
  await add(page, 'Phone');
  await dragNear(page, 'laptop1', 'ap1', -90);
  await dragNear(page, 'phone1', 'ap1', 90);
  await joinWifi(page, 'laptop1');
  // One client is not enough: the step wants a laptop and a phone.
  await expect(task).toContainText('2/5');
  await joinWifi(page, 'phone1');
  await expect(task).toContainText('4/5', { timeout: 15_000 });

  const phone = await run(page, 'phone1', 'curl http://printer1/');
  await expect(phone).toContainText('Printer ready', { timeout: 15_000 });
  await expect(task).toContainText('5/5');
  await expect(task).toContainText('Maya: “The meeting room has Wi-Fi now');
});

test('Our own intranet: a server with a fixed address and a page opened over Wi-Fi', async ({
  page,
}) => {
  await page.goto('/');
  await finish(page, [...BEFORE, 'lobby-camera', 'meeting-room-wifi']);
  await taskCenter(page);
  await page.getByRole('button', { name: 'Start: Our own intranet' }).click();
  const task = page.getByRole('region', { name: 'Current task' });
  await expect(task).toContainText('0/4');
  await expect(task).toContainText('From Sam, founder');

  await add(page, 'Server');
  await connect(page, 'srv1', 'sw1/eth6');
  await run(page, 'srv1', 'ip addr add 192.168.1.150/24 dev eth0');
  await run(page, 'srv1', 'ip route add default via 192.168.1.1');
  // An address inside the DHCP range is not a fixed one.
  await expect(task).toContainText('0/4');
  await run(page, 'srv1', 'ip addr flush dev eth0');
  await run(page, 'srv1', 'ip addr add 192.168.1.5/24 dev eth0');
  await run(page, 'srv1', 'ip route add default via 192.168.1.1');
  await expect(task).toContainText('1/4');

  const srv = await open(page, 'srv1');
  await srv.getByRole('tab', { name: 'Config' }).click();
  await srv.getByRole('button', { name: 'Start web server' }).click();
  await expect(task).toContainText('2/4');

  await srv.getByRole('tab', { name: 'Desktop' }).click();
  await srv.getByRole('button', { name: '← Desktop' }).click();
  await srv.getByRole('button', { name: 'Text Editor' }).click();
  await srv.getByRole('button', { name: '/var/www/html/index.html' }).click();
  await srv.getByLabel('File contents').fill('<h1>Our intranet</h1>');
  await srv.getByRole('button', { name: 'Save' }).click();
  await expect(task).toContainText('3/4');
  await srv.getByRole('button', { name: 'Close srv1' }).click();

  const phone = await run(page, 'phone1', 'curl http://192.168.1.5/');
  await expect(phone).toContainText('Our intranet', { timeout: 15_000 });
  await expect(task).toContainText('4/4');
  await expect(task).toContainText('Sam: “Now everybody starts the day');
  await expect(win(page, 'srv1')).toHaveCount(0);
});
