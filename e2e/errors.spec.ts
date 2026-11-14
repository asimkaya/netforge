import { expect, test } from '@playwright/test';
import { add, run, win } from './helpers.ts';

/**
 * Makes the terminal throw while drawing one specific line: the terminal colours past
 * prompts with a regular expression, so a booby-trapped RegExp#exec reaches its render.
 */
const BOOBY_TRAP = () => {
  const exec = RegExp.prototype.exec;
  RegExp.prototype.exec = function (this: RegExp, text: string) {
    if (typeof text === 'string' && text.includes('crash-the-view')) throw new Error('test crash');
    return exec.call(this, text);
  };
};

test('a view that fails to render shows a message in its window, not a blank app', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(BOOBY_TRAP);
  await page.goto('/');
  await add(page, 'PC', 2);
  await run(page, 'pc1', 'echo crash-the-view');

  const pc1 = win(page, 'pc1');
  await expect(pc1.getByRole('alert')).toContainText('This view stopped working.');
  await pc1.getByText('Technical details').click();
  await expect(pc1.getByRole('alert')).toContainText('test crash');
  // The rest of the app still works.
  await expect(page.getByTestId('device-pc2')).toBeVisible();
  await page.getByTestId('device-pc2').dispatchEvent('click');
  await expect(win(page, 'pc2')).toBeVisible();
  // Another tab of the broken window renders again (pc2's window may cover it: close it).
  await win(page, 'pc2').getByRole('button', { name: 'Close pc2' }).click();
  await pc1.getByRole('tab', { name: 'Physical' }).click();
  await expect(pc1.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
});
