import { expect, test } from '@playwright/test';
import { add, connect, run, terminal } from './helpers.ts';

test('a PC logs in to a server over SSH and runs commands there', async ({ page }) => {
  await page.goto('/');
  await add(page, 'PC');
  await add(page, 'Server');
  await connect(page, 'pc1', 'srv1');
  await run(page, 'pc1', 'ip addr add 10.0.0.1/24 dev eth0');
  await run(page, 'srv1', 'ip addr add 10.0.0.2/24 dev eth0');
  await run(page, 'srv1', 'sshd');

  const pc1 = await run(page, 'pc1', 'ssh root@10.0.0.2');
  const log = pc1.getByRole('log');
  await expect(log).toContainText("root@10.0.0.2's password:");
  const password = pc1.getByLabel('Password');
  await password.fill('netforge');
  await password.press('Enter');
  await expect(log).toContainText('Welcome to NetForge');
  await expect(log).not.toContainText('netforge');

  const command = pc1.getByRole('textbox', { name: 'Command' });
  await command.fill('hostname');
  await command.press('Enter');
  await expect(log).toContainText('root@srv1:~# hostname');
  await expect(log.getByText('srv1', { exact: true })).toBeVisible();
  await command.fill('exit');
  await command.press('Enter');
  await expect(log).toContainText('Connection to 10.0.0.2 closed.');
  await expect((await terminal(page, 'pc1')).getByText('root@pc1:~#').last()).toBeVisible();
});
