import { expect, test } from '@playwright/test';
import { add, connect, open, run } from './helpers.ts';

test('a home router shares its Internet connection with NAT and forwards a port', async ({
  page,
}) => {
  await page.goto('/');
  await add(page, 'Internet');
  await add(page, 'Router');
  await add(page, 'Server');
  await connect(page, 'r1/eth1', 'internet1/eth0');
  await connect(page, 'srv1', 'r1/eth0');
  await run(page, 'r1', 'dhclient eth1');
  await run(page, 'r1', 'ip addr add 192.168.1.1/24 dev eth0');
  await run(page, 'srv1', 'ip addr add 192.168.1.20/24 dev eth0');
  await run(page, 'srv1', 'ip route add default via 192.168.1.1');
  await run(page, 'srv1', 'httpd');

  const r1 = await open(page, 'r1');
  await r1.getByRole('tab', { name: 'Config' }).click();
  const fw = r1.getByRole('region', { name: 'Firewall and NAT (nftables)' });
  await expect(fw.getByLabel('Internet side')).toHaveValue('eth1');
  await fw.getByRole('button', { name: 'Share this connection (NAT)' }).click();
  await expect(fw).toContainText('NAT is on');
  await expect(fw.getByRole('textbox', { name: /Ruleset/ })).toHaveValue(
    /oifname "eth1" masquerade/,
  );
  await fw.getByLabel('Forward to (IP or IP:port)').fill('192.168.1.20');
  await fw.getByRole('button', { name: 'Forward port' }).click();
  await expect(fw.getByRole('list', { name: 'Port forwards' })).toContainText(
    'tcp 80 → 192.168.1.20',
  );
  await r1.getByRole('button', { name: 'Close r1' }).click();

  let term = await run(page, 'srv1', 'ping -c 1 198.18.0.10');
  await expect(term.getByRole('log')).toContainText('1 received');
  term = await run(page, 'internet1', 'curl -s http://192.0.2.100/');
  await expect(term.getByRole('log')).toContainText('It works!');
});
