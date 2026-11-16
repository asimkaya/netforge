import { expect, test } from '@playwright/test';
import { add, connect, finish, run, taskCenter } from './helpers.ts';

test('a newcomer completes the first guided task', async ({ page }) => {
  await page.goto('/');
  await taskCenter(page);
  await page.getByRole('button', { name: 'Start: Day one: connect two desks' }).click();
  await expect(page.getByRole('dialog', { name: 'Task center' })).toHaveCount(0);

  const task = page.getByRole('region', { name: 'Current task' });
  const current = task.locator('[aria-current="step"]');
  await expect(task).toContainText('0/5');
  await expect(task).toContainText('From Maya, office manager');
  await expect(current).toContainText('Add two PCs');
  // The step points at what to use: the PC in the palette glows.
  const addPc = page.getByRole('button', { name: 'Add PC' });
  await expect(addPc).toHaveClass(/nf-focus/);
  await expect(page.getByRole('button', { name: 'Add Switch' })).not.toHaveClass(/nf-focus/);

  // The step lists its small actions and ticks each one as it is done.
  await expect(current.getByText('0 of 2 done')).toBeVisible();
  await add(page, 'PC');
  await expect(current.getByText('1 of 2 done')).toBeVisible();
  await expect(current).toContainText('Add two PCs');
  await add(page, 'PC');
  await expect(current).toContainText('Connect them with a cable');
  await expect(page.getByRole('status')).toContainText('Step 1 done. Next: Connect them');
  await expect(addPc).not.toHaveClass(/nf-focus/);
  await expect(page.getByTestId('device-pc1')).toHaveClass(/nf-focus/);

  await connect(page, 'pc1', 'pc2');
  await expect(current).toContainText('Give the first PC an IP address');
  // A command comes as a code box with a Copy button, labelled with the device to use.
  await expect(current).toContainText('In pc1’s terminal');
  await expect(
    current.locator('code', { hasText: 'ip addr add 192.168.1.10/24 dev eth0' }),
  ).toBeVisible();
  await expect(current.getByRole('button', { name: 'Copy command' })).toBeVisible();
  await current.getByRole('button', { name: 'Show a hint' }).click();
  await expect(current).toContainText('name of the network port');

  await run(page, 'pc1', 'ip addr add 192.168.1.10/24 dev eth0');
  await run(page, 'pc2', 'ip addr add 192.168.1.20/24 dev eth0');
  await expect(current).toContainText('Ping one PC from the other');

  await run(page, 'pc2', 'ping -c 1 192.168.1.10');
  await expect(task).toContainText('5/5');
  await expect(task).toContainText('Congratulations!');

  // Finishing a chapter celebrates once; chapter 1 alone does not raise the rank yet.
  const party = page.getByRole('dialog', { name: 'Chapter complete!' });
  await expect(party).toBeVisible();
  await expect(party).toContainText('Day one: connect two desks');
  await expect(party).not.toContainText('Promoted');
  await expect(party).toContainText('Unlocked: Room for a third desk');
  await page.keyboard.press('Escape');
  await expect(party).toHaveCount(0);

  // Progress survives a reload, and the celebration does not come back.
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Current task' })).toContainText('5/5');
  await expect(party).toHaveCount(0);
  await taskCenter(page);
  await expect(page.getByRole('dialog', { name: 'Task center' })).toContainText(
    'Rank: Intern · 1 chapter to Junior Admin',
  );
  await page.getByRole('button', { name: 'Close' }).click();

  // The next task goes on with the learner's own network: nothing is cleared, nothing asked.
  await page.getByRole('button', { name: 'Next task: Room for a third desk' }).click();
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
    'first-print',
    'lobby-camera',
    'meeting-room-wifi',
    'intranet',
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
  await start('Get the office online');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Task center' })).toBeVisible();

  // Continue: the task runs on the devices that are there.
  await start('Day one: connect two desks');
  await ask.getByRole('button', { name: 'Continue on my network' }).click();
  const task = page.getByRole('region', { name: 'Current task' });
  await expect(task).toContainText('Day one: connect two desks');
  await expect(page.getByTestId('device-pc1')).toBeVisible();
  // Leaving the task goes back to the Task center.
  await page.getByRole('button', { name: 'Leave task (keep the lab)' }).click();
  await expect(page.getByRole('dialog', { name: 'Task center' })).toBeVisible();

  // Load the starting network: the lab becomes what the earlier tasks build.
  await start('Get the office online');
  await ask.getByRole('button', { name: 'Load the starting network' }).click();
  await expect(task).toContainText('Get the office online');
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
  // A lab file with the chapters before it done unlocks "Let the teams talk again".
  await finish(page, [
    'first-ping',
    'meet-the-switch',
    'two-networks',
    'dhcp',
    'first-print',
    'lobby-camera',
    'meeting-room-wifi',
    'intranet',
    'vlans',
  ]);
  await taskCenter(page);
  await page.getByRole('button', { name: 'Start: Let the teams talk again' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByTestId('device-sw1')).toBeVisible();
  await expect(page.getByTestId('device-r1')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Current task' })).toContainText('0/5');
});

test('the empty canvas offers the first task and the ready networks', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('An empty bench.')).toBeVisible();
  await page.getByRole('button', { name: 'Open the task center' }).click();
  await page.getByRole('button', { name: 'Start: Day one: connect two desks' }).click();
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
  for (const act of ['Act 1: Your first day', 'Act 2: The office grows', 'Act 3: Beyond']) {
    await expect(center.getByRole('region', { name: new RegExp(act) })).toBeVisible();
  }
  await expect(center).toContainText('0/15 chapters done');

  // Chapter 2 is locked: it says what to finish first and has no Start button.
  const locked = center.getByRole('listitem', { name: 'Room for a third desk' });
  await expect(locked).toContainText('Finish Day one: connect two desks first');
  await expect(locked.getByRole('button')).toHaveCount(0);

  // Escape closes the popup and focus goes back to the opener.
  await page.keyboard.press('Escape');
  await expect(center).toHaveCount(0);
  await expect(opener).toBeFocused();

  // Starting chapter 1 closes the popup and shows the task in the side panel.
  await opener.click();
  await page.getByRole('button', { name: 'Start: Day one: connect two desks' }).click();
  await expect(center).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Current task' })).toContainText('0/5');
});

test('a finished checklist explains when earlier work has been undone', async ({ page }) => {
  await page.goto('/');
  await finish(page, ['first-ping']);
  await taskCenter(page);
  await page.getByRole('button', { name: 'Start: Room for a third desk' }).click();
  const current = page
    .getByRole('region', { name: 'Current task' })
    .locator('[aria-current="step"]');
  const notice = current.getByText(/Everything on this list is done, but the step is not complete/);

  // The prepared network has pc1 and pc2 on one cable; move that cable to the switch.
  await add(page, 'Switch');
  await connect(page, 'pc2/eth0', 'sw1/eth0');
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await connect(page, 'pc2/eth0', 'sw1/eth1');
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await expect(current).toContainText('Add a third PC');
  await expect(notice).toHaveCount(0);

  // Unplug pc1: the finished step 2 stays done, but step 3 needs three PCs on the switch.
  await page
    .getByRole('group', { name: /^Cable from (pc1 eth0 to sw1 eth0|sw1 eth0 to pc1 eth0),/ })
    .click({ force: true });
  await page.keyboard.press('Delete');
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await add(page, 'PC');
  await connect(page, 'pc3', 'sw1/eth2');
  await expect(current.getByText('2 of 2 done')).toBeVisible();
  await expect(current).toContainText('Add a third PC');
  await expect(notice).toBeVisible();
  await expect(current.getByRole('status')).toBeVisible();

  await connect(page, 'pc1', 'sw1/eth0');
  await expect(current).toContainText('Give the new PC an address');
  await expect(notice).toHaveCount(0);
});
