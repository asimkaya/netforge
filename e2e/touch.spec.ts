import { expect, test, type Page } from '@playwright/test';
import { win } from './helpers.ts';

test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });

/** Drags a finger from one element's centre to another's, with real touch events. */
async function swipe(page: Page, from: string, to: string) {
  const a = await page.getByTestId(from).boundingBox();
  const b = await page.getByTestId(to).boundingBox();
  if (!a || !b) throw new Error(`cannot see ${from} or ${to}`);
  const cdp = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => [{ x, y, id: 1 }];
  const [x1, y1] = [a.x + a.width / 2, a.y + a.height / 2];
  const [x2, y2] = [b.x + b.width / 2, b.y + b.height / 2];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x1, y1) });
  for (let i = 1; i <= 12; i++) {
    const [x, y] = [x1 + ((x2 - x1) * i) / 12, y1 + ((y2 - y1) * i) / 12];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x, y) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('on a tablet, devices are added, cabled and opened by touch', async ({ page }) => {
  await page.goto('/');
  const addPc = page.getByRole('button', { name: 'Add PC', exact: true });
  await addPc.tap();
  await addPc.tap();
  await expect(page.getByTestId('device-pc2')).toBeVisible();

  await swipe(page, 'port-pc1-eth0', 'port-pc2-eth0');
  await expect(
    page.getByRole('group', { name: 'Cable from pc1 eth0 to pc2 eth0, link up' }),
  ).toBeAttached();

  // One tap right after drawing a cable by finger opens the device.
  await page.getByTestId('device-pc1').tap();
  await expect(win(page, 'pc1')).toBeVisible();
});

test('on a tablet, a plugged cable end is moved by finger', async ({ page }) => {
  await page.goto('/');
  const add = page.getByRole('button', { name: 'Add PC', exact: true });
  await add.tap();
  await add.tap();
  await page.getByRole('button', { name: 'Add Switch', exact: true }).tap();
  await swipe(page, 'port-pc1-eth0', 'port-pc2-eth0');
  await swipe(page, 'port-pc2-eth0', 'port-sw1-eth3');
  await expect(
    page.getByRole('group', { name: 'Cable from pc1 eth0 to sw1 eth3, link up' }),
  ).toBeAttached();
});
