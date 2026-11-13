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

/** Opens a device's terminal and runs a command. */
export async function run(page: Page, device: string, command: string) {
  await page.getByTestId(`device-${device}`).dblclick({ position: { x: 20, y: 12 } });
  const input = page.getByRole('textbox', { name: 'Command' });
  await expect(input).toBeVisible();
  await input.fill(command);
  await input.press('Enter');
}

export async function add(page: Page, label: 'PC' | 'Switch', times = 1) {
  for (let i = 0; i < times; i++) {
    await page.getByRole('button', { name: new RegExp(`Add ${label}`) }).click();
  }
}
