import { expect, test, type Page } from '@playwright/test';
import { add, connect, run, win } from './helpers.ts';

/** pc1 and pc2 on two networks joined by r1; only pc2 knows its gateway. */
async function twoNetworks(page: Page) {
  await page.goto('/');
  await add(page, 'Router');
  await add(page, 'PC', 2);
  await connect(page, 'pc1', 'r1/eth0');
  await connect(page, 'pc2', 'r1/eth1');
  await run(page, 'r1', 'ip addr add 192.168.1.1/24 dev eth0');
  await run(page, 'r1', 'ip addr add 192.168.2.1/24 dev eth1');
  await run(page, 'pc1', 'ip addr add 192.168.1.10/24 dev eth0');
  await run(page, 'pc2', 'ip addr add 192.168.2.20/24 dev eth0');
  await run(page, 'pc2', 'ip route add default via 192.168.2.1');
}

test('a failed ping explains the missing gateway, and the fix works', async ({ page }) => {
  await twoNetworks(page);
  const w = await run(page, 'pc1', 'ping -c 1 192.168.2.20');
  const log = w.getByRole('log');
  await expect(log).toContainText('ping: connect: Network is unreachable');

  // The explanation is not part of the shell: the log stays a plain Linux log.
  const why = w.getByRole('button', { name: 'Why did this fail?' });
  await expect(why).toBeVisible();
  await why.click();
  const panel = w.getByRole('region', { name: 'Failure explanation' });
  await expect(panel).toContainText(
    'pc1 has no default gateway, so it does not know where to send packets for 192.168.2.20.',
  );
  await expect(panel.locator('code')).toHaveText('ip route add default via 192.168.1.1');
  await expect(log).not.toContainText('no default gateway');
  await expect(page.getByTestId('device-pc1')).toHaveClass(/nf-focus/);
  await expect(page.getByTestId('device-r1')).not.toHaveClass(/nf-focus/);

  // Copy the fix into the input, run it, and the same ping works.
  await panel.getByRole('button', { name: 'Copy to input' }).click();
  const input = w.getByRole('textbox', { name: 'Command' });
  await expect(input).toHaveValue('ip route add default via 192.168.1.1');
  await input.press('Enter');
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('device-pc1')).not.toHaveClass(/nf-focus/);
  await input.fill('ping -c 1 192.168.2.20');
  await input.press('Enter');
  await expect(log).toContainText('1 packets transmitted, 1 received');
  await expect(w.getByRole('button', { name: 'Why did this fail?' })).toBeHidden();
});

test('the explanation points at the router whose firewall dropped the ping', async ({ page }) => {
  await twoNetworks(page);
  await run(page, 'pc1', 'ip route add default via 192.168.1.1');
  await run(page, 'r1', 'nft add table ip filter');
  await run(
    page,
    'r1',
    'nft add chain ip filter forward { type filter hook forward priority 0 ; policy drop ; }',
  );
  const w = await run(page, 'pc1', 'ping -c 1 192.168.2.20');
  await w.getByRole('button', { name: 'Why did this fail?' }).click();
  const panel = w.getByRole('region', { name: 'Failure explanation' });
  await expect(panel).toContainText("r1's firewall dropped the ping to 192.168.2.20");
  await expect(page.getByTestId('device-r1')).toHaveClass(/nf-focus/);
  await expect(page.getByTestId('device-pc1')).not.toHaveClass(/nf-focus/);
  // The fix is for r1, so there is nothing to copy into pc1's input.
  await expect(panel.getByRole('button', { name: 'Copy to input' })).toBeHidden();

  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('device-r1')).not.toHaveClass(/nf-focus/);
  // Only the latest failed command offers the explanation.
  await expect(win(page, 'pc1').getByRole('button', { name: 'Why did this fail?' })).toBeVisible();
  await run(page, 'pc1', 'echo hello');
  await expect(win(page, 'pc1').getByRole('button', { name: 'Why did this fail?' })).toBeHidden();
});
