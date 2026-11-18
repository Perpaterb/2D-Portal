import { test, expect, type Page } from '@playwright/test';
import { freshApp, newLevel, buildRoom, tool, clickCell, startPlaying, aim, toScreen } from './helpers';

test.beforeEach(async ({ page }) => {
  await freshApp(page);
});

/** Counts canvas pixels in a small world-space box that match a colour test. */
async function countPixels(page: Page, wx0: number, wy0: number, wx1: number, wy1: number, kind: 'yellow' | 'light'): Promise<number> {
  return page.evaluate(
    ({ wx0, wy0, wx1, wy1, kind }) => {
      const cam = window.__holes.cam!;
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=game-canvas]')!;
      const dpr = canvas.width / canvas.clientWidth;
      const sx = (wx: number) => (canvas.clientWidth / 2 + (wx - cam.x) * cam.zoom) * dpr;
      const sy = (wy: number) => (canvas.clientHeight / 2 + (wy - cam.y) * cam.zoom) * dpr;
      const x0 = Math.round(sx(wx0));
      const y0 = Math.round(sy(wy0));
      const w = Math.max(1, Math.round(sx(wx1)) - x0);
      const h = Math.max(1, Math.round(sy(wy1)) - y0);
      const data = canvas.getContext('2d')!.getImageData(x0, y0, w, h).data;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (kind === 'yellow' && r > 200 && g > 170 && b < 120) n++;
        if (kind === 'light' && r > 150 && g > 150 && b > 150) n++;
      }
      return n;
    },
    { wx0, wy0, wx1, wy1, kind },
  );
}

async function fire(page: Page, button: 'left' | 'right', dx: number, dy: number): Promise<void> {
  await aim(page, dx, dy);
  await page.mouse.down({ button });
  await page.mouse.up({ button });
  await page.waitForTimeout(120);
}

test('US-026: each portal shows the world beyond the other one, from where the player looks', async ({ page }) => {
  await newLevel(page, 'Look through');
  await buildRoom(page);
  await tool(page, '3');
  await clickCell(page, 2, 1);
  await tool(page, '4');
  await clickCell(page, 12, 1); // the exit, right next to the right wall
  await startPlaying(page);
  await page.waitForFunction(() => window.__holes.sim!.player.ground);

  // inside the left wall, where the exit will show through the left portal: plain wall for now
  const region: [number, number, number, number] = [-94, 20, -66, 60];
  expect(await countPixels(page, ...region, 'yellow')).toBe(0);
  await fire(page, 'left', -400, -20);
  expect(await page.evaluate(() => window.__holes.views)).toBe(0); // one portal: just a line
  expect(await countPixels(page, ...region, 'yellow')).toBe(0);

  await fire(page, 'right', 400, -20);
  await page.waitForFunction(() => !!window.__holes.sim!.portals[1]);
  await page.waitForFunction(() => (window.__holes.views ?? 0) >= 2);
  // the exit beside the right portal is now seen through the left portal
  expect(await countPixels(page, ...region, 'yellow')).toBeGreaterThan(20);
});

test('US-027: a box half way into a portal also shows coming out of the other one', async ({ page }) => {
  await newLevel(page, 'Half through');
  await buildRoom(page);
  await tool(page, '3');
  await clickCell(page, 2, 1);
  await tool(page, '4');
  await clickCell(page, 7, 1);
  // a box pushed 8 px into the left wall (free placement), resting on the floor
  await page.getByTestId('snap-toggle').click();
  await tool(page, '5');
  const [bx, by] = await toScreen(page, -60, 60);
  await page.mouse.click(bx, by);
  await startPlaying(page);
  await page.waitForFunction(() => window.__holes.sim!.boxes[0].ground);

  // just in front of the right wall at box height: empty room for now
  const exit: [number, number, number, number] = [409, 44, 415, 60];
  await fire(page, 'right', 400, -20);
  expect(await countPixels(page, ...exit, 'light')).toBe(0);
  await fire(page, 'left', -400, -20);
  await page.waitForFunction(() => !!window.__holes.sim!.portals[0]);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__holes.sim!.boxes[0].teleports)).toBe(0); // still half way, at rest
  // the portal's glow pulses over this strip (about 0.6 s a cycle) and tints the box at its
  // brightest, so look across one cycle rather than at a single frame
  await expect.poll(() => countPixels(page, ...exit, 'light'), { timeout: 1500, intervals: [50] }).toBeGreaterThan(10);
});

test('US-027: falling through a floor portal out of a wall turns the view, then eases upright', async ({ page }) => {
  await newLevel(page, 'Turn');
  await buildRoom(page);
  await tool(page, '3');
  await clickCell(page, 2, 1);
  await tool(page, '4');
  await clickCell(page, -2, 1);
  await startPlaying(page);
  await page.waitForFunction(() => window.__holes.sim!.player.ground);
  await fire(page, 'right', 400, -20); // right wall
  // record the camera turn from here on
  await page.evaluate(() => {
    const w = window as unknown as { __turn: { max: number; zeroAt: number; tpAt: number } };
    w.__turn = { max: 0, zeroAt: -1, tpAt: -1 };
    const f = (now: number) => {
      const sim = window.__holes.sim;
      const cam = window.__holes.cam;
      if (sim && cam) {
        if (sim.player.teleports > 0 && w.__turn.tpAt < 0) w.__turn.tpAt = now;
        w.__turn.max = Math.max(w.__turn.max, Math.abs(cam.angle));
        if (w.__turn.tpAt >= 0 && w.__turn.zeroAt < 0 && cam.angle === 0 && cam.sx === 1) w.__turn.zeroAt = now;
      }
      if (window.__holes.screen === 'play') requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  await fire(page, 'left', 0, 100); // floor right under the player
  await page.waitForFunction(() => window.__holes.sim!.player.teleports > 0, null, { timeout: 4000 });
  await page.waitForTimeout(800);
  const turn = await page.evaluate(() => (window as unknown as { __turn: { max: number; zeroAt: number; tpAt: number } }).__turn);
  expect(turn.max).toBeGreaterThan(1.2); // about a quarter turn
  expect(turn.zeroAt).toBeGreaterThan(0);
  expect(turn.zeroAt - turn.tpAt).toBeLessThan(600);
});

test('US-028: jumping beside a floor portal, the fall is pulled into it', async ({ page }) => {
  await newLevel(page, 'Magnet');
  await buildRoom(page);
  await tool(page, '3');
  await clickCell(page, 0, 1); // player centre x = 16
  await tool(page, '4');
  await clickCell(page, 10, 1);
  await startPlaying(page);
  await page.waitForFunction(() => window.__holes.sim!.player.ground);
  await fire(page, 'right', 400, -20);
  await fire(page, 'left', 54, 21); // floor at x = 70: the mouth spans x 32..96, beside the player (7..25)
  const mouth = await page.evaluate(() => window.__holes.sim!.portals[0]);
  expect(mouth).toMatchObject({ cx: 1, cy: 2, n: 3 });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__holes.sim!.player.teleports > 0, null, { timeout: 3000 });
});
