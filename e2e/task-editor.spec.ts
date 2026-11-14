import { expect, test } from '@playwright/test';
import { add, connect, run, taskCenter } from './helpers.ts';

test('a teacher writes a task for the lab and a learner plays it', async ({ page }) => {
  await page.goto('/');
  await add(page, 'PC', 2);

  // The teacher writes a two-step task about the network on the canvas.
  await taskCenter(page);
  await page.getByRole('button', { name: 'Create a task' }).click();
  const editor = page.getByRole('region', { name: 'Task editor' });
  await editor.getByLabel('Title', { exact: true }).fill('Link the PCs');
  const step1 = editor.getByRole('listitem', { name: 'Step 1' });
  await step1.getByLabel('Step title').fill('Cable them');
  await step1.getByLabel('Done when').selectOption({ label: 'Two devices are cabled together' });
  await step1.getByLabel('Device', { exact: true }).fill('pc1');
  await step1.getByLabel('Other device').fill('pc2');
  await editor.getByRole('button', { name: 'Add step' }).click();
  const step2 = editor.getByRole('listitem', { name: 'Step 2' });
  await step2.getByLabel('Step title').fill('Ping across');
  await expect(editor.getByRole('list', { name: 'Problems' })).toContainText('Step 2: Choose');
  await step2.getByLabel('Device', { exact: true }).fill('pc1');
  await step2.getByLabel('Reaches (address or device)').fill('pc2');
  await expect(step2).toContainText('✓ pc1 gets a ping reply from pc2');
  await editor.getByRole('button', { name: 'Save task' }).click();

  // A learner starts it on the same lab.
  const lab = page.getByRole('region', { name: 'Tasks in this lab' });
  await lab.getByRole('button', { name: 'Start Link the PCs' }).click();
  const task = page.getByRole('region', { name: 'Current task' });
  await expect(task).toContainText('0/2');
  await connect(page, 'pc1', 'pc2');
  await expect(task).toContainText('1/2');
  await run(page, 'pc1', 'ip addr add 10.0.0.1/24 dev eth0');
  await run(page, 'pc2', 'ip addr add 10.0.0.2/24 dev eth0');
  await run(page, 'pc1', 'ping -c 1 10.0.0.2');
  await expect(task).toContainText('2/2');
  await expect(task).toContainText('Task complete. Well done!');
});
