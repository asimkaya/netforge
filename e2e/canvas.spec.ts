import { expect, test, type Page } from '@playwright/test';
import { add, connect } from './helpers.ts';

/** Shift+drag on the empty canvas around the given devices. */
async function boxSelect(page: Page, devices: string[]) {
  const boxes = await Promise.all(
    devices.map((d) => page.getByTestId(`device-${d}`).boundingBox()),
  );
  const found = boxes.flatMap((b) => (b ? [b] : []));
  const left = Math.min(...found.map((b) => b.x)) - 25;
  const top = Math.min(...found.map((b) => b.y)) - 25;
  const right = Math.max(...found.map((b) => b.x + b.width)) + 25;
  const bottom = Math.max(...found.map((b) => b.y + b.height)) + 25;
  await page.keyboard.down('Shift');
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(right, bottom, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
}

test('box-select, copy, paste and undo a group of devices', async ({ page }) => {
  await page.goto('/');
  await add(page, 'PC', 2);
  await add(page, 'Switch');
  await connect(page, 'pc1', 'sw1/eth0');
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  await boxSelect(page, ['pc1', 'pc2', 'sw1']);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(3);

  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('ControlOrMeta+v');
  for (const name of ['pc3', 'pc4', 'sw2']) {
    await expect(page.getByTestId(`device-${name}`)).toBeVisible();
  }
  // The cable between pc1 and sw1 was copied between the copies; nothing else was cabled.
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(3);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('device-pc3')).toHaveCount(0);
  await expect(page.getByTestId('device-sw2')).toHaveCount(0);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
});

test('Ctrl+A selects everything and Delete removes it in one undo step', async ({ page }) => {
  await page.goto('/');
  await add(page, 'PC', 2);
  // Edits within 400 ms are one undo step, so let the adds settle first.
  await page.waitForTimeout(600);
  await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+a');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('device-pc1')).toHaveCount(0);
  await expect(page.getByTestId('device-pc2')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('device-pc1')).toBeVisible();
  await expect(page.getByTestId('device-pc2')).toBeVisible();
});

test('Duplicate in the device menu copies the device', async ({ page }) => {
  await page.goto('/');
  await add(page, 'PC');
  await page.getByTestId('device-pc1').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(page.getByTestId('device-pc2')).toBeVisible();
});

test('a note keeps its text across a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add Note' }).click();
  await page.getByTestId('note-n1').dblclick();
  await page.getByRole('textbox', { name: 'Note text' }).fill('Core switch\nin rack 2');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('note-n1')).toContainText('in rack 2');
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.getByTestId('note-n1')).toContainText('Core switch');
});

test('a zone can be renamed and a device on top of it still opens', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add Zone' }).click();
  await page.getByTestId('zone-z1').getByText('Zone', { exact: true }).dblclick();
  await page.getByRole('textbox', { name: 'Zone title' }).fill('Office');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('zone-z1')).toContainText('Office');

  await add(page, 'PC');
  const zone = await page.getByTestId('zone-z1').boundingBox();
  const pc = await page.getByTestId('device-pc1').boundingBox();
  if (!zone || !pc) throw new Error('cannot see the zone or the PC');
  expect(pc.x).toBeLessThan(zone.x + zone.width);
  expect(pc.y).toBeLessThan(zone.y + zone.height);
  expect(pc.x + pc.width).toBeGreaterThan(zone.x);
  expect(pc.y + pc.height).toBeGreaterThan(zone.y);
  await page.mouse.click(pc.x + pc.width / 2, pc.y + pc.height / 2);
  await expect(page.getByRole('dialog', { name: 'pc1', exact: true })).toBeVisible();
});

test('the palette is grouped and fits a 1440x900 window without scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const palette = page.locator('aside').first();
  await expect(palette.getByRole('heading', { name: 'End devices' })).toBeVisible();
  await expect(palette.getByRole('heading', { name: 'Network' })).toBeVisible();
  await expect(palette.getByRole('heading', { name: 'Annotate' })).toBeVisible();
  for (const name of ['Add PC', 'Add IP Camera', 'Add Internet', 'Add Note', 'Add Zone']) {
    await expect(palette.getByRole('button', { name })).toBeVisible();
  }
  const fits = await palette.evaluate((el) => el.scrollHeight <= el.clientHeight);
  expect(fits).toBe(true);
});
