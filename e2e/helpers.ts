import { expect, type Page } from '@playwright/test';

/** Drags a cable from a device's port onto another port (`pc2/eth0`) or device body (`pc2`). */
export async function connect(page: Page, from: string, to: string) {
  const [fromDevice, fromPort = 'eth0'] = from.split('/');
  const [toDevice, toPort] = to.split('/');
  const source = page.getByTestId(`port-${fromDevice}-${fromPort}`);
  const target = toPort
    ? page.getByTestId(`port-${toDevice}-${toPort}`)
    : page.getByTestId(`device-${toDevice}`);
  const a = await source.boundingBox();
  const b = await target.boundingBox();
  if (!a || !b) throw new Error(`cannot see ${from} or ${to}`);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  // Aim at the target's center (for a body drop, the upper part, away from its ports).
  const y = toPort ? b.y + b.height / 2 : b.y + Math.min(20, b.height / 4);
  await page.mouse.move(b.x + b.width / 2, y, { steps: 12 });
  await page.mouse.up();
}

/** The window of a device (it may not be open yet). */
export function win(page: Page, device: string) {
  return page.getByRole('dialog', { name: device, exact: true });
}

/**
 * Opens a device's window (or brings it to the front) like a click on the device. The event
 * is dispatched to the node so a window covering the device on screen doesn't get in the way.
 */
export async function open(page: Page, device: string) {
  const w = win(page, device);
  await page.getByTestId(`device-${device}`).dispatchEvent('click');
  await expect(w).toBeVisible();
  return w;
}

/** Opens the device's shell: Desktop → Terminal on PCs, the CLI tab on switches. */
export async function terminal(page: Page, device: string) {
  const w = await open(page, device);
  const desktop = w.getByRole('tab', { name: 'Desktop' });
  if (await desktop.count()) {
    await desktop.click();
    // Another app may be open: go back to the app grid first.
    const back = w.getByRole('button', { name: '← Desktop' });
    if ((await back.count()) && !(await w.getByRole('textbox', { name: 'Command' }).count())) {
      await back.click();
    }
    const app = w.getByRole('button', { name: 'Terminal' });
    if (await app.count()) await app.click();
  } else {
    await w.getByRole('tab', { name: 'CLI' }).click();
  }
  await expect(w.getByRole('textbox', { name: 'Command' })).toBeVisible();
  return w;
}

/** Runs a command in a device's terminal and returns its window. */
export async function run(page: Page, device: string, command: string) {
  const w = await terminal(page, device);
  const input = w.getByRole('textbox', { name: 'Command' });
  await input.fill(command);
  await input.press('Enter');
  return w;
}

export async function add(
  page: Page,
  label:
    | 'PC'
    | 'Laptop'
    | 'Phone'
    | 'Server'
    | 'Printer'
    | 'IP Camera'
    | 'Switch'
    | '24-port Switch'
    | 'L3 Switch'
    | 'Access Point'
    | 'Router'
    | 'Home Router'
    | 'Internet',
  times = 1,
) {
  for (let i = 0; i < times; i++) {
    await page.getByRole('button', { name: new RegExp(`Add ${label}`) }).click();
  }
}

/** Picks an item (Share link, Export, Import, New lab) from the Lab menu in the top bar. */
export async function labMenu(page: Page, item: string) {
  await page.getByRole('button', { name: 'Lab menu' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}
