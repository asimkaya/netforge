import { expect, test } from '@playwright/test';
import { add, connect, open, run } from './helpers.ts';

test('a PC browses a page served by a server, edited in the Text Editor', async ({ page }) => {
  await page.goto('/');
  await add(page, 'PC');
  await add(page, 'Server');
  await connect(page, 'pc1', 'srv1');
  await run(page, 'pc1', 'ip addr add 10.0.0.1/24 dev eth0');
  await run(page, 'srv1', 'ip addr add 10.0.0.80/24 dev eth0');

  // Start the web server from the Config tab.
  const srv = await open(page, 'srv1');
  await srv.getByRole('tab', { name: 'Config' }).click();
  await srv.getByRole('button', { name: 'Start web server' }).click();
  await expect(srv).toContainText('Serving /var/www/html on port 80.');

  // Browse to it from the PC.
  const pc = await open(page, 'pc1');
  await pc.getByRole('tab', { name: 'Desktop' }).click();
  await pc.getByRole('button', { name: '← Desktop' }).click();
  await pc.getByRole('button', { name: 'Web Browser' }).click();
  await pc.getByLabel('Address').fill('http://10.0.0.80/');
  await pc.getByRole('button', { name: 'Go' }).click();
  const frame = pc.frameLocator('iframe[title^="Page"]');
  await expect(frame.getByRole('heading', { name: 'It works!' })).toBeVisible();
  await expect(pc.getByLabel('Response status')).toContainText('HTTP 200 OK');

  // Change the page on the server, with a script that must not run.
  await open(page, 'srv1');
  await srv.getByRole('tab', { name: 'Desktop' }).click();
  await srv.getByRole('button', { name: '← Desktop' }).click();
  await srv.getByRole('button', { name: 'Text Editor' }).click();
  await srv.getByRole('button', { name: '/var/www/html/index.html' }).click();
  await srv
    .getByLabel('File contents')
    .fill('<h1>Hello from NetForge</h1><script>document.body.innerHTML="hacked"</script>');
  await srv.getByRole('button', { name: 'Save' }).click();
  await expect(srv.getByRole('status')).toContainText('Saved /var/www/html/index.html.');

  await open(page, 'pc1');
  await pc.getByRole('button', { name: 'Go' }).click();
  await expect(frame.getByRole('heading', { name: 'Hello from NetForge' })).toBeVisible();
  await expect(frame.locator('body')).not.toContainText('hacked');

  // A server that isn't there.
  await pc.getByLabel('Address').fill('http://10.0.0.99/');
  await pc.getByRole('button', { name: 'Go' }).click();
  await expect(pc.getByRole('alert')).toContainText('No route to host', { timeout: 10_000 });
});
