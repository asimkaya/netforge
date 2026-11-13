import { expect, test, type Locator, type Page } from '@playwright/test';
import { add, connect, open, run } from './helpers.ts';

async function mailApp(page: Page, device: string): Promise<Locator> {
  const w = await open(page, device);
  await w.getByRole('tab', { name: 'Desktop' }).click();
  const back = w.getByRole('button', { name: '← Desktop' });
  if (await back.count()) await back.click();
  await w.getByRole('button', { name: 'Mail' }).click();
  return w;
}

async function setUp(w: Locator, address: string) {
  await w.getByLabel('Your email address').fill(address);
  await w.getByLabel('Mail server (address or name)').fill('10.0.0.25');
  await w.getByRole('button', { name: 'Save' }).click();
}

test('alice mails bob through a mail server', async ({ page }) => {
  await page.goto('/');
  await add(page, 'Switch');
  await add(page, 'PC', 2);
  await add(page, 'Server');
  await connect(page, 'pc1', 'sw1/eth0');
  await connect(page, 'pc2', 'sw1/eth1');
  await connect(page, 'srv1', 'sw1/eth2');
  await run(page, 'pc1', 'ip addr add 10.0.0.1/24 dev eth0');
  await run(page, 'pc2', 'ip addr add 10.0.0.2/24 dev eth0');
  await run(page, 'srv1', 'ip addr add 10.0.0.25/24 dev eth0');

  const srv = await open(page, 'srv1');
  await srv.getByRole('tab', { name: 'Config' }).click();
  await srv.getByRole('button', { name: 'Start postfix' }).click();
  await srv.getByRole('button', { name: 'Start dovecot' }).click();
  await srv.getByRole('button', { name: 'Close srv1' }).click();

  const alice = await mailApp(page, 'pc1');
  await setUp(alice, 'alice@lab');
  await alice.getByRole('button', { name: 'Compose' }).click();
  await alice.getByLabel('To', { exact: true }).fill('bob@lab');
  await alice.getByLabel('Subject').fill('Hello Bob');
  await alice.getByLabel('Message').fill('Sent over SMTP.');
  await alice.getByRole('button', { name: 'Send' }).click();
  await expect(alice.getByRole('status')).toContainText('Sent to bob@lab.');
  await alice.getByRole('button', { name: 'Close pc1' }).click();

  const bob = await mailApp(page, 'pc2');
  await setUp(bob, 'bob@lab');
  await bob.getByRole('button', { name: 'Check mail' }).click();
  await expect(bob.getByRole('status')).toContainText('1 message.');
  await bob.getByRole('list', { name: 'Messages' }).getByRole('button').first().click();
  await expect(bob.getByRole('article')).toContainText('Sent over SMTP.');
  await expect(bob.getByRole('article')).toContainText('From alice@lab to bob@lab');
});
