import { expect, test } from '@playwright/test';
import { finish, run, taskCenter } from './helpers.ts';

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
  'guest-wifi',
];

test('Lock the server room door: SSH for the IT desk only, the web page for everyone', async ({
  page,
}) => {
  await page.goto('/');
  await finish(page, BEFORE);
  await taskCenter(page);
  await page.getByRole('button', { name: 'Start: Lock the server room door' }).click();
  const task = page.getByRole('region', { name: 'Current task' });
  await expect(task).toContainText('0/5');
  await expect(task).toContainText('From Alex, IT desk');

  await run(page, 'srv1', 'sshd');
  const srv = await run(page, 'srv1', 'ss -tln');
  await expect(srv).toContainText('0.0.0.0:22');
  await expect(task).toContainText('1/5');

  // Before the lockdown, anyone in the office reaches SSH.
  const pc1 = await run(page, 'pc1', 'nc -z 192.168.1.5 22');
  await expect(pc1).toContainText('succeeded!');
  await expect(task).toContainText('2/5');

  await run(page, 'srv1', 'echo root:Blue-Kettle-42 | chpasswd');
  await expect(task).toContainText('3/5');

  for (const line of [
    'nft add table inet filter',
    'nft add chain inet filter input { type filter hook input priority 0 ; policy drop ; }',
    'nft add rule inet filter input ct state established,related accept',
    'nft add rule inet filter input tcp dport 80 accept',
    'nft add rule inet filter input ip saddr 192.168.2.10 tcp dport 22 accept',
  ]) {
    await run(page, 'srv1', line);
  }
  await expect(task).toContainText('4/5');

  // The same check from pc1 is now dropped; the intranet page still loads.
  await run(page, 'pc1', 'nc -z 192.168.1.5 22');
  await expect(pc1).toContainText('Connection timed out', { timeout: 30_000 });
  await run(page, 'pc1', 'curl -s http://192.168.1.5/');
  await expect(pc1).toContainText('Our intranet', { timeout: 15_000 });
  await expect(task).toContainText('4/5');
  const pc4 = await run(page, 'pc4', 'nc -z 192.168.1.5 22');
  await expect(pc4).toContainText('succeeded!');
  await expect(task).toContainText('5/5', { timeout: 15_000 });
  await expect(task).toContainText('Alex: “Only my desk can log in now');
});
