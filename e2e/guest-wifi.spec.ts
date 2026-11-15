import { expect, test, type Page } from '@playwright/test';
import { add, connect, finish, run, taskCenter } from './helpers.ts';

const BEFORE = [
  'first-ping',
  'meet-the-switch',
  'two-networks',
  'dhcp',
  'first-print',
  'lobby-camera',
  'meeting-room-wifi',
  'intranet',
  'vlans',
  'inter-vlan',
  'ospf',
  'nat',
];

/** Drags a device next to another one, inside its dashed range circle. */
async function dragNear(page: Page, device: string, anchor: string, dy: number) {
  const box = await page.getByTestId(`device-${device}`).boundingBox();
  const near = await page.getByTestId(`device-${anchor}`).boundingBox();
  if (!box || !near) throw new Error('devices not visible');
  await page.mouse.move(box.x + 20, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(near.x + near.width / 2, near.y + near.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
}

test('Wi-Fi for visitors: a guest subnet, the Internet, and a firewall rule against the office', async ({
  page,
}) => {
  await page.goto('/');
  await finish(page, BEFORE);
  await taskCenter(page);
  await page.getByRole('button', { name: 'Start: Wi-Fi for visitors' }).click();
  const task = page.getByRole('region', { name: 'Current task' });
  await expect(task).toContainText('0/5');
  await expect(task).toContainText('From Sam, founder');

  // sw1 is full, so the home router hangs off a second switch.
  await add(page, 'Switch');
  await connect(page, 'sw1/eth8', 'sw2/eth8');
  await add(page, 'Home Router');
  await connect(page, 'home1/eth0', 'sw2/eth0');
  await expect(task).toContainText('1/5', { timeout: 20_000 });

  // The box still has the office's own subnet: that is not a guest network.
  await run(page, 'home1', 'ip addr flush dev br0');
  await run(page, 'home1', 'ip addr add 192.168.50.1/24 dev br0');
  await expect(task).toContainText('1/5');
  await run(page, 'home1', 'killall dnsmasq');
  const home = await run(page, 'home1', 'dnsmasq --dhcp-range=192.168.50.100,192.168.50.199');
  await expect(task).toContainText('2/5');
  // Windows can cover devices: close this one before dragging the phone.
  await home.getByRole('button', { name: 'Close home1' }).click();

  await add(page, 'Phone');
  await dragNear(page, 'phone2', 'home1', 90);
  await page.getByTestId('device-phone2').click({ position: { x: 20, y: 12 } });
  await run(page, 'phone2', 'nmcli dev wifi connect HomeWiFi password netforge123');
  const phone = await run(page, 'phone2', 'dhclient wlan0');
  await expect(phone).toContainText('bound to 192.168.50.', { timeout: 15_000 });
  await expect(task).toContainText('3/5');

  await run(page, 'phone2', 'ping -c 1 198.18.0.10');
  await expect(task).toContainText('4/5', { timeout: 15_000 });

  // Without the rule the visitor still reaches the server: that does not finish the step.
  await run(page, 'phone2', 'ping -c 1 192.168.1.5');
  await expect(phone).toContainText('1 received', { timeout: 15_000 });
  await expect(task).toContainText('4/5');
  await run(
    page,
    'home1',
    'nft insert rule ip filter forward iifname "br0" ip daddr 192.168.0.0/16 drop',
  );
  await expect(task).toContainText('4/5');
  await run(page, 'phone2', 'ping -c 1 192.168.1.5');
  await expect(task).toContainText('5/5', { timeout: 20_000 });
  await expect(task).toContainText('Sam: “Visitors have their own Wi-Fi');
});
