import { expect, test } from '@playwright/test';
import { add, connect, open } from './helpers.ts';

test('a PC joins the internet with DHCP, browses a site and captures the traffic', async ({
  page,
}) => {
  await page.goto('/');
  await add(page, 'Internet');
  await add(page, 'PC');
  await connect(page, 'pc1', 'internet1/eth1');

  const pc = await open(page, 'pc1');
  await pc.getByRole('button', { name: 'IP Configuration' }).click();
  await pc.getByRole('button', { name: 'Get an address automatically' }).click();
  await expect(pc.getByLabel('DHCP log')).toContainText('bound to 198.51.100.100');

  await pc.getByRole('button', { name: '← Desktop' }).click();
  await pc.getByRole('button', { name: 'Web Browser' }).click();
  await pc.getByLabel('Address').fill('www.example.com');
  await pc.getByRole('button', { name: 'Go' }).click();
  await expect(
    pc
      .frameLocator('iframe[title^="Page"]')
      .getByRole('heading', { name: 'Hello from the Internet' }),
  ).toBeVisible();

  await pc.getByRole('button', { name: '← Desktop' }).click();
  await pc.getByRole('button', { name: 'Packet Capture' }).click();
  await pc.getByRole('combobox').selectOption('http');
  // The handshake on port 80 counts as HTTP too; pick the request itself.
  await pc.getByRole('row', { name: /HTTP: GET \/ HTTP\/1\.1/ }).click();
  await expect(pc).toContainText('HTTP data');
  await expect(pc).toContainText('Host: www.example.com');
});
