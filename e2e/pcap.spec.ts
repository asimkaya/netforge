import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { add, connect, open, run } from './helpers.ts';

test('the Packet Capture app saves a pcap file for Wireshark', async ({ page }) => {
  await page.goto('/');
  await add(page, 'PC', 2);
  await connect(page, 'pc1', 'pc2');
  await run(page, 'pc1', 'ip addr add 10.0.0.1/24 dev eth0');
  await run(page, 'pc2', 'ip addr add 10.0.0.2/24 dev eth0');
  const term = await run(page, 'pc1', 'ping -c 1 10.0.0.2');
  await expect(term.getByRole('log')).toContainText('1 received');

  const pc1 = await open(page, 'pc1');
  await pc1.getByRole('button', { name: '← Desktop' }).click();
  await pc1.getByRole('button', { name: 'Packet Capture' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    pc1.getByRole('button', { name: 'Save as .pcap' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('pc1.pcap');
  const bytes = await readFile((await download.path()) ?? '');
  expect([...bytes.subarray(0, 4)]).toEqual([0xd4, 0xc3, 0xb2, 0xa1]);
  expect(bytes.length).toBeGreaterThan(24 + 4 * 16);
});
