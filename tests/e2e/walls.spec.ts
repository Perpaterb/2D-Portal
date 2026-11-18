import { test, expect, type Page } from '@playwright/test';
import { freshApp, newLevel, tool, drawLine, clickCell, buildRoom, placeStartFinish, startPlaying, storedLevel } from './helpers';

type Tiles = { data: { tiles: unknown[][] } };

async function tiles(page: Page, id: string): Promise<unknown[][]> {
  await page.waitForTimeout(400);
  return ((await storedLevel(page, id)) as Tiles).data.tiles;
}

async function chooseWall(page: Page, ...steps: string[]): Promise<void> {
  await page.locator('[data-tool=wall]').click();
  await expect(page.getByTestId('wall-flyout')).toBeVisible();
  for (const s of steps) await page.getByTestId(s).click();
  await expect(page.getByTestId('wall-flyout')).toBeHidden();
}

test('US-036 US-037: the wall pop-out places full blocks, single coloured sides and slopes', async ({ page }) => {
  await freshApp(page);
  const id = await newLevel(page, 'Pop-out');
  const label = page.locator('[data-tool=wall] .tool-label');

  // full orange block
  await chooseWall(page, 'fly-full', 'fly-colour-4');
  await expect(label).toHaveText('Orange wall');
  await clickCell(page, 0, 0);

  // one side: a white top on the orange block, then a blue right side on the same block
  await chooseWall(page, 'fly-side', 'fly-side-3', 'fly-colour-1');
  await expect(label).toHaveText('White top side');
  await clickCell(page, 0, 0);
  await chooseWall(page, 'fly-side', 'fly-side-0', 'fly-colour-3');
  await clickCell(page, 0, 0);
  // and on an empty cell it makes a dark block with just that side coloured
  await clickCell(page, 3, 0);

  // a dark slope rising to the right
  await chooseWall(page, 'fly-slope', 'fly-shape-1', 'fly-colour-2');
  await expect(label).toHaveText('Dark grey slope');
  await clickCell(page, 5, 0);

  const t = await tiles(page, id);
  expect(t).toContainEqual([0, 0, 4, 0, [3, 0, 0, 1]]);
  expect(t).toContainEqual([3, 0, 2, 0, [3, 0, 0, 0]]);
  expect(t).toContainEqual([5, 0, 2, 1]);

  // the choice is remembered, and 1 / 2 / B / O still pick full blocks
  await page.reload();
  await expect(label).toHaveText('Dark grey slope');
  await tool(page, '1');
  await expect(label).toHaveText('White wall');
  await tool(page, 'b');
  await expect(label).toHaveText('Blue wall');
  // Esc closes the pop-out without changing anything
  await page.locator('[data-tool=wall]').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('wall-flyout')).toBeHidden();
  await expect(label).toHaveText('Blue wall');
});

test('US-038: the player walks up a slope built in the editor, over a block and on to the finish', async ({ page }) => {
  await freshApp(page);
  await newLevel(page, 'Ramp');
  await buildRoom(page);
  await chooseWall(page, 'fly-slope', 'fly-shape-1', 'fly-colour-2');
  await clickCell(page, 4, 1);
  await tool(page, '2');
  await drawLine(page, [5, 1], [7, 1]);
  await placeStartFinish(page, [0, 1], [10, 1]);
  await startPlaying(page);
  await page.keyboard.down('d');
  // on top of the block the feet are one cell up, with no jump pressed
  await page.waitForFunction(() => {
    const p = window.__holes.sim!.player;
    return p.x > 6 * 32 * 256 && p.y + p.hh === 1 * 32 * 256 && p.ground;
  }, null, { timeout: 6000 });
  await expect(page.getByTestId('finish-overlay')).toBeVisible({ timeout: 8000 });
  await page.keyboard.up('d');
});
