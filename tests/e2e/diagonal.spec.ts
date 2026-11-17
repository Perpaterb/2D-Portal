import { test, expect, type Page } from '@playwright/test';
import { freshApp, newLevel, tool, drawLine, clickCell, buildRoom, placeStartFinish, startPlaying, aim } from './helpers';

async function chooseWall(page: Page, ...steps: string[]): Promise<void> {
  await page.locator('[data-tool=wall]').click();
  for (const s of steps) await page.getByTestId(s).click();
}

async function fire(page: Page, button: 'left' | 'right', dx: number, dy: number): Promise<void> {
  await aim(page, dx, dy);
  await page.mouse.down({ button });
  await page.mouse.up({ button });
  await page.waitForTimeout(150);
}

test('US-039: a portal on a white ramp sends you through at 45°; the view turns and eases back upright', async ({ page }) => {
  await freshApp(page);
  await newLevel(page, 'Diagonal');
  await buildRoom(page);
  // a white ramp rising right: slopes at (5,1), (6,0), (7,-1) on a dark fill, then a platform
  await chooseWall(page, 'fly-slope', 'fly-shape-1', 'fly-colour-1');
  await clickCell(page, 5, 1);
  await clickCell(page, 6, 0);
  await clickCell(page, 7, -1);
  await tool(page, '2');
  await clickCell(page, 6, 1);
  await drawLine(page, [7, 0], [7, 1]);
  for (let cy = -1; cy <= 1; cy++) await drawLine(page, [8, cy], [12, cy]);
  await placeStartFinish(page, [0, 1], [11, -2]);
  await startPlaying(page);

  // blue portal onto the ramp's face, nearly level from the start
  await fire(page, 'left', 165, 0);
  const p0 = await page.evaluate(() => window.__holes.sim!.portals[0]);
  expect(p0).not.toBeNull();
  expect(p0!.n).toBeGreaterThanOrEqual(4); // a diagonal portal
  expect([p0!.px, p0!.py]).toEqual([6 * 32 * 256, 1 * 32 * 256]);
  // orange portal on the left wall
  await fire(page, 'right', -200, 0);
  expect(await page.evaluate(() => window.__holes.sim!.portals[1]?.n)).toBe(0);
  // looking at the ramp portal shows the world beyond the other one
  await page.waitForFunction(() => (window.__holes.views ?? 0) >= 1);

  await page.keyboard.down('d');
  await page.waitForFunction(() => window.__holes.sim!.player.teleports > 0, null, { timeout: 5000 });
  await page.keyboard.up('d');
  // straight after, the view is turned by about 45°; it eases back upright
  const turned = await page.evaluate(() => Math.abs(window.__holes.cam!.angle));
  expect(turned).toBeGreaterThan(0.3);
  expect(turned).toBeLessThan(0.8);
  await page.waitForFunction(() => window.__holes.cam!.angle === 0, null, { timeout: 2000 });
  await page.screenshot({ path: process.env.LOOK_SHOT ?? 'test-results/diagonal.png' });
});
