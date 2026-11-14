import { expect, test, type Page } from '@playwright/test';
import { add, connect, run, taskCenter } from './helpers.ts';

/** Imports an empty lab whose progress marks these chapters as done, which unlocks the next. */
async function finish(page: Page, ids: string[]) {
  await page.getByLabel('Import lab file').setInputFiles({
    name: 'progress.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'netforge-lab',
        version: 13,
        network: {
          devices: [],
          links: [],
          counters: { device: 0, link: 0, mac: 0, names: {} },
        },
        layout: {},
        tasks: { active: null, steps: Object.fromEntries(ids.map((id) => [id, 99])) },
      }),
    ),
  });
}

test('a newcomer completes the first guided task', async ({ page }) => {
  await page.goto('/');
  await taskCenter(page);
  await page.getByRole('button', { name: 'Start: Two computers, one cable' }).click();
  await expect(page.getByRole('dialog', { name: 'Task center' })).toHaveCount(0);

  const task = page.getByRole('region', { name: 'Current task' });
  const current = task.locator('[aria-current="step"]');
  await expect(task).toContainText('0/5');
  await expect(current).toContainText('Add two PCs');
  // The step points at what to use: the PC in the palette glows.
  const addPc = page.getByRole('button', { name: 'Add PC' });
  await expect(addPc).toHaveClass(/nf-focus/);
  await expect(page.getByRole('button', { name: 'Add Switch' })).not.toHaveClass(/nf-focus/);

  await add(page, 'PC', 2);
  await expect(current).toContainText('Connect them with a cable');
  await expect(page.getByRole('status')).toContainText('Step 1 done. Next: Connect them');
  await expect(addPc).not.toHaveClass(/nf-focus/);
  await expect(page.getByTestId('device-pc1')).toHaveClass(/nf-focus/);

  await connect(page, 'pc1', 'pc2');
  await expect(current).toContainText('Give the first PC an IP address');
  await current.getByRole('button', { name: 'Show a hint' }).click();
  await expect(current).toContainText('name of the network port');

  await run(page, 'pc1', 'ip addr add 192.168.1.10/24 dev eth0');
  await run(page, 'pc2', 'ip addr add 192.168.1.20/24 dev eth0');
  await expect(current).toContainText('Ping one PC from the other');

  await run(page, 'pc2', 'ping -c 1 192.168.1.10');
  await expect(task).toContainText('5/5');
  await expect(task).toContainText('Congratulations!');

  // Progress survives a reload.
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Current task' })).toContainText('5/5');

  // The next task goes on with the learner's own network: nothing is cleared, nothing asked.
  await page.getByRole('button', { name: 'Next task: Meet the switch' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByTestId('device-pc1')).toBeVisible();
  await expect(page.getByTestId('device-pc2')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Current task' })).toContainText('0/6');
  await expect(current).toContainText('Add a switch');
  await expect(page.getByRole('button', { name: 'Add Switch' })).toHaveClass(/nf-focus/);

  // With the panel hidden, the current step stays on screen and brings the panel back.
  await page.getByRole('button', { name: 'Hide' }).click();
  await expect(page.getByRole('region', { name: 'Current task' })).toHaveCount(0);
  await page.getByRole('button', { name: /Current task step/ }).click();
  await expect(page.getByRole('region', { name: 'Current task' })).toBeVisible();
});

test('starting a task on a busy canvas asks which network to use', async ({ page }) => {
  await page.goto('/');
  await finish(page, [
    'first-ping',
    'meet-the-switch',
    'two-networks',
    'dhcp',
    'vlans',
    'inter-vlan',
    'ospf',
  ]);
  await add(page, 'PC');
  await expect(page.getByTestId('device-pc1')).toBeVisible();
  await taskCenter(page);
  const ask = page.getByRole('alertdialog');
  const start = (name: string) =>
    page.getByRole('button', { name: new RegExp(`^(Start|Play again): ${name}$`) }).click();

  // Cancel changes nothing.
  await start('Reach the Internet through NAT');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Task center' })).toBeVisible();

  // Continue: the task runs on the devices that are there.
  await start('Two computers, one cable');
  await ask.getByRole('button', { name: 'Continue on my network' }).click();
  const task = page.getByRole('region', { name: 'Current task' });
  await expect(task).toContainText('Two computers, one cable');
  await expect(page.getByTestId('device-pc1')).toBeVisible();
  // Leaving the task goes back to the Task center.
  await page.getByRole('button', { name: 'Leave task (keep the lab)' }).click();
  await expect(page.getByRole('dialog', { name: 'Task center' })).toBeVisible();

  // Load the starting network: the lab becomes what the earlier tasks build.
  await start('Reach the Internet through NAT');
  await ask.getByRole('button', { name: 'Load the starting network' }).click();
  await expect(task).toContainText('Reach the Internet through NAT');
  await expect(task).toContainText('0/5');
  await expect(task.locator('[aria-current="step"]')).toContainText('Add the Internet');
  // Devices that only exist in that network.
  await expect(page.getByTestId('device-r2')).toBeVisible();
  await expect(page.getByTestId('device-pc5')).toBeVisible();
  await expect(page.getByTestId('device-sw1')).toBeVisible();
  await expect(page.getByTestId('device-internet1')).toHaveCount(0);
});

test('an empty canvas starts a later task from its prepared network', async ({ page }) => {
  await page.goto('/');
  // A lab file with the chapters before it done unlocks "Route between VLANs".
  await finish(page, ['first-ping', 'meet-the-switch', 'two-networks', 'dhcp', 'vlans']);
  await taskCenter(page);
  await page.getByRole('button', { name: 'Start: Route between VLANs' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByTestId('device-sw1')).toBeVisible();
  await expect(page.getByTestId('device-r1')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Current task' })).toContainText('0/5');
});

test('the empty canvas offers the first task and the ready networks', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('An empty bench.')).toBeVisible();
  await page.getByRole('button', { name: 'Start the first task' }).click();
  await expect(page.getByRole('region', { name: 'Current task' })).toContainText('Add two PCs');

  await page.reload();
  await page.getByRole('button', { name: 'Open a ready network' }).click();
  await expect(page.getByRole('tab', { name: 'Networks' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Escape');
  await add(page, 'PC', 1);
  await expect(page.getByText('An empty bench.')).toHaveCount(0);
});

test('the Task center is a campaign map where later chapters stay locked', async ({ page }) => {
  await page.goto('/');
  // No task runs, so there is no side panel.
  await expect(page.getByRole('region', { name: 'Current task' })).toHaveCount(0);
  const opener = page.getByRole('button', { name: 'Tasks' });
  await opener.click();
  const center = page.getByRole('dialog', { name: 'Task center' });
  await expect(center).toBeVisible();
  await expect(center).toHaveAttribute('aria-modal', 'true');
  await expect(center).toBeFocused();
  for (const act of ['Act 1: Your first day', 'Act 2: The office grows', 'Act 3: Branches']) {
    await expect(center.getByRole('region', { name: new RegExp(act) })).toBeVisible();
  }
  await expect(center).toContainText('0/9 chapters done');

  // Chapter 2 is locked: it says what to finish first and has no Start button.
  const locked = center.getByRole('listitem', { name: 'Meet the switch' });
  await expect(locked).toContainText('Finish Two computers, one cable first');
  await expect(locked.getByRole('button')).toHaveCount(0);

  // Escape closes the popup and focus goes back to the opener.
  await page.keyboard.press('Escape');
  await expect(center).toHaveCount(0);
  await expect(opener).toBeFocused();

  // Starting chapter 1 closes the popup and shows the task in the side panel.
  await opener.click();
  await page.getByRole('button', { name: 'Start: Two computers, one cable' }).click();
  await expect(center).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Current task' })).toContainText('0/5');
});
