import { test, expect } from '@playwright/test';
import { freshApp, newLevel, buildRoom, placeStartFinish, startPlaying, tool, drawLine } from './helpers';

const RUN_SPEED = 896; // sub-pixels per tick, src/sim/sim.ts

test('US-050: running on a blue floor built in the editor goes past normal run speed', async ({ page }) => {
  const top = async (blue: boolean) => {
    await freshApp(page);
    await newLevel(page, blue ? 'Blue run' : 'Dark run');
    await buildRoom(page);
    if (blue) {
      await tool(page, 'b');
      await drawLine(page, [-3, 2], [13, 2]);
    }
    await placeStartFinish(page, [-2, 1], [12, 1]);
    await startPlaying(page);
    await page.keyboard.down('d');
    let best = 0;
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(100);
      best = Math.max(best, await page.evaluate(() => window.__holes.sim!.player.vx));
    }
    await page.keyboard.up('d');
    return best;
  };
  expect(await top(false)).toBe(RUN_SPEED);
  expect(await top(true)).toBeGreaterThan(RUN_SPEED * 1.3);
});
