import { expect, test } from '@playwright/test';
import { add, connect, open } from './helpers.ts';

test('Spanning Tree lets two switches share a redundant cable', async ({ page }) => {
  await page.goto('/');
  await add(page, 'Switch', 2);
  await connect(page, 'sw1/eth0', 'sw2/eth0');

  // Without STP the second cable is refused.
  await connect(page, 'sw1/eth1', 'sw2/eth1');
  await expect(page.getByRole('status').filter({ hasText: 'Turn on Spanning Tree' })).toBeVisible();

  for (const name of ['sw1', 'sw2']) {
    const sw = await open(page, name);
    await sw.getByRole('tab', { name: 'Config' }).click();
    await sw
      .getByRole('region', { name: 'Spanning Tree (STP)' })
      .getByLabel('Spanning Tree', { exact: true })
      .check();
    await sw.getByRole('button', { name: `Close ${name}` }).click();
  }
  await connect(page, 'sw1/eth1', 'sw2/eth1');

  const sw2 = await open(page, 'sw2');
  await sw2.getByRole('tab', { name: 'Config' }).click();
  const stp = sw2.getByRole('region', { name: 'Spanning Tree (STP)' });
  await expect(stp).toContainText('Root bridge: sw1, reached through eth0');
  await expect(stp.getByRole('row', { name: /eth1/ })).toContainText('alternate');
  await expect(stp.getByRole('row', { name: /eth1/ })).toContainText('blocking');

  // The loop keeps STP on.
  await stp.getByLabel('Spanning Tree', { exact: true }).click();
  await expect(stp.getByRole('alert')).toContainText('part of a loop');
  await expect(stp.getByLabel('Spanning Tree', { exact: true })).toBeChecked();
});

test('the forward delay can be shortened from the Config tab', async ({ page }) => {
  await page.goto('/');
  await add(page, 'Switch');
  const sw = await open(page, 'sw1');
  await sw.getByRole('tab', { name: 'Config' }).click();
  const stp = sw.getByRole('region', { name: 'Spanning Tree (STP)' });
  await expect(stp).toContainText('listens and learns for 30 s');
  await stp.getByLabel('Forward delay (2 to 30 seconds)').fill('2');
  await stp.getByRole('button', { name: 'Set', exact: true }).first().click();
  await expect(stp).toContainText('listens and learns for 4 s');
  await expect(stp).toContainText('forward_delay 200');
});
