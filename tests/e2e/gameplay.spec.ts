import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  freshApp, newLevel, tool, drawLine, clickCell, buildRoom, placeStartFinish, setChannel, startPlaying, aim,
  holdKey, simValue, storedLevel,
} from './helpers';
import { runReplay, parseReplay, formatTicks } from '../../src/sim/replay';
import { parseLevel } from '../../src/sim/level';

test.beforeEach(async ({ page }) => {
  await freshApp(page);
});

const CELL_KEY = '((cx, cy) => (cx + 1048576) * 2097152 + (cy + 1048576))';

async function waitSim(page: Page, cond: string, timeout = 8000): Promise<void> {
  await page.waitForFunction(`(() => { const sim = window.__holes.sim; const cellKey = ${CELL_KEY}; return !!sim && (${cond}); })()`, null, { timeout });
}

test('US-007 US-008 US-009: run, jump, fire both portals and walk through one', async ({ page }) => {
  await newLevel(page, 'Portals');
  await buildRoom(page);
  await placeStartFinish(page);
  await startPlaying(page);

  const x0 = await simValue<number>(page, 'sim.player.x');
  await holdKey(page, 'd', 400);
  expect(await simValue<number>(page, 'sim.player.x')).toBeGreaterThan(x0 + 20 * 256);

  const yGround = await simValue<number>(page, 'sim.player.y');
  await page.keyboard.down('Space');
  await waitSim(page, `sim.player.y < ${yGround - 20 * 256}`, 2000);
  await page.keyboard.up('Space');
  await waitSim(page, 'sim.player.ground', 3000);

  await aim(page, -400, 0);
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  await waitSim(page, 'sim.portals[0] && sim.portals[0].cx === -3 && sim.portals[0].n === 0', 2000);
  await aim(page, 400, 0);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await waitSim(page, 'sim.portals[1] && sim.portals[1].cx === 13 && sim.portals[1].n === 2', 2000);

  await page.keyboard.down('a');
  await waitSim(page, 'sim.player.teleports > 0', 6000);
  await page.keyboard.up('a');
  // came out of the right wall, still heading left, speed within the cap
  expect(await simValue<number>(page, 'sim.player.x')).toBeGreaterThan(9 * 32 * 256);
  expect(await simValue<number>(page, 'Math.abs(sim.player.vx)')).toBeLessThanOrEqual(20 * 256);
});

test('US-018 US-019 US-020: finish, timer, replay files that reproduce the run, and no ghosts on local levels', async ({ page }) => {
  const id = await newLevel(page, 'Speedrun');
  await buildRoom(page);
  await placeStartFinish(page);
  await startPlaying(page);
  await expect(page.getByTestId('timer')).toHaveText(/^00:0\d\.\d{3}$/);

  await page.keyboard.down('d');
  await expect(page.getByTestId('finish-overlay')).toBeVisible({ timeout: 8000 });
  await page.keyboard.up('d');
  const time = (await page.getByTestId('final-time').textContent())!;
  expect(time).toMatch(/^00:0\d\.\d{3}$/);
  const liveTicks = await simValue<number>(page, 'sim.finishTick');
  expect(time).toBe(formatTicks(liveTicks));

  // save the replay file
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('save-replay').click()]);
  const replayFile = JSON.parse(readFileSync((await download.path())!, 'utf8'));
  expect(replayFile.format).toBe('2dholes-replay');

  // the same replay re-run in Node gives the same time and the same end state as Chromium
  const stored = (await storedLevel(page, id)) as { data: unknown };
  const node = runReplay(parseLevel(stored.data), parseReplay(replayFile));
  expect(node.finished).toBe(true);
  expect(node.ticks).toBe(liveTicks);
  const browserHash = await simValue<string>(page, 'sim.stateHash()');
  expect(node.stateHash).toBe(browserHash);

  // watch it back
  await page.getByTestId('watch-replay').click();
  await expect(page.getByTestId('finish-overlay')).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('final-time')).toHaveText(time);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('editor-canvas')).toBeVisible();

  // load the replay file from disk and watch it
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('load-replay').click()]);
  await chooser.setFiles((await download.path())!);
  await expect(page.getByTestId('game-canvas')).toBeVisible();
  await expect(page.getByTestId('finish-overlay')).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('final-time')).toHaveText(time);
  await page.keyboard.press('Escape');

  // best time is in the menu, and survives a refresh
  await page.getByTestId('back-to-menu').click();
  await expect(page.getByTestId('level-best')).toHaveText(`Best ${time}`);
  await page.reload();
  await expect(page.getByTestId('level-best')).toHaveText(`Best ${time}`);

  // play again: local levels have no ghosts and no ghost panel (US-020)
  await page.getByTestId('level-row').getByRole('button', { name: 'Edit' }).click();
  await startPlaying(page);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__holes.ghosts.length)).toBe(0);
  await expect(page.getByTestId('ghost-panel')).toHaveCount(0);
});

test('US-019: a replay for a different version of the level is refused', async ({ page }) => {
  await newLevel(page, 'Versioned');
  await buildRoom(page);
  await placeStartFinish(page);
  await startPlaying(page);
  await page.keyboard.down('d');
  await expect(page.getByTestId('finish-overlay')).toBeVisible({ timeout: 8000 });
  await page.keyboard.up('d');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('save-replay').click()]);
  await page.keyboard.press('Escape');
  await tool(page, '1');
  await clickCell(page, 5, -2); // edit the level
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('load-replay').click()]);
  await chooser.setFiles((await download.path())!);
  await expect(page.locator('.toast')).toContainText('different');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
});

/**
 * A level with every mechanic, built through the editor:
 * plates and multi-lock doors, boxes, and blue / orange / white dispensers.
 */
async function buildMechanics(page: Page): Promise<void> {
  await buildRoom(page, -10);
  await tool(page, '2');
  await clickCell(page, 11, 2);
  await clickCell(page, 12, 2);
  await placeStartFinish(page);
  // channel 0: a plate under the start and a plate with a box on it open the doors at x = 8
  await tool(page, '6');
  await clickCell(page, 0, 1);
  await setChannel(page, 0);
  await clickCell(page, 5, 1);
  await tool(page, '7');
  await clickCell(page, 8, 1);
  await clickCell(page, 8, 0);
  await tool(page, '5');
  await clickCell(page, 5, 1);
  await clickCell(page, 1, 1);
  await clickCell(page, 6, -8); // high up, to drop onto orange
  // channel 1: a plate nobody stands on, and its door
  await tool(page, '6');
  await clickCell(page, 3, 1);
  await setChannel(page, 1);
  await tool(page, '7');
  await clickCell(page, 12, 1);
  // dispensers on an unused channel so they stay in their default (on) state
  await tool(page, '8');
  await clickCell(page, 0, -3);
  await setChannel(page, 7);
  await page.getByTestId('cap-input').fill('10');
  await page.getByTestId('cap-input').press('Enter');
  await tool(page, '9');
  await clickCell(page, 6, -3);
  await tool(page, '0');
  await clickCell(page, 11, -9);
}

test('US-010 to US-017: plates, multi-lock doors, boxes, dispensers, paint and its effects', async ({ page }) => {
  await newLevel(page, 'Mechanics');
  await buildMechanics(page);
  // US-016 (before): the dark floor at x = 11 refuses a portal while it is unpainted. That refused
  // shot is the first action (a box sits beside the start, so E would pick it up).
  const target = { x: 11 * 32 + 16 - 16, y: 64 - 43 };
  await startPlaying(page, async () => {
    await aim(page, target.x, target.y);
    await page.mouse.down();
    await page.mouse.up();
  });

  // watch the high box for a bounce from the first moment
  await page.evaluate(() => {
    const w = window as unknown as { __minVy: number };
    w.__minVy = 0;
    const f = () => {
      const sim = window.__holes.sim;
      if (!sim) return;
      const high = sim.boxes.find((b) => Math.abs(b.x - (6 * 32 + 16) * 256) < 4 * 256);
      if (high && high.teleports === 0 && sim.tick > 30) w.__minVy = Math.min(w.__minVy, high.vy);
      if (window.__holes.screen === 'play') requestAnimationFrame(f);
    };
    f();
  });

  expect(await simValue<number | undefined>(page, `sim.paint.get(${CELL_KEY}(11, 2) * 4 + 3)`)).toBeUndefined();
  await waitSim(page, 'sim.lastShot !== null', 2000);
  expect(await simValue<boolean>(page, 'sim.lastShot.ok')).toBe(false);
  expect(await simValue<unknown>(page, 'sim.portals[0]')).toBeNull();

  // US-011 / US-012: both channel-0 plates pressed, so both doors are open; channel 1 is shut
  expect(await simValue<boolean[]>(page, 'sim.plates.map((p) => p.pressed)')).toEqual([true, true, false]);
  expect(await simValue<boolean[]>(page, 'sim.doors.map((d) => d.open)')).toEqual([true, true, false]);

  // US-014: each liquid paints the colours that are not its own
  await waitSim(page, `sim.paint.get(cellKey(0, 2) * 4 + 3) === 1`); // blue on white
  await waitSim(page, `sim.paint.get(cellKey(6, 2) * 4 + 3) === 2`); // orange on white
  await waitSim(page, `sim.paint.get(cellKey(11, 2) * 4 + 3) === 3`); // white on dark

  // US-016 (after): the same dark floor, painted white, now takes the portal
  await page.mouse.down();
  await page.mouse.up();
  await waitSim(page, 'sim.portals[0] && sim.portals[0].n === 3', 2000);

  // US-015: the player stands on blue gel and slides after letting go
  await waitSim(page, 'sim.player.ground && sim.player.groundPaint === 1');
  await holdKey(page, 'a', 300); // left: open floor (a box sits just to the right)
  await page.waitForTimeout(200);
  expect(await simValue<number>(page, 'sim.player.vx')).toBeLessThan(0);

  // US-010: pick up the nearby box; firing is blocked while holding it
  await page.keyboard.press('e');
  await waitSim(page, 'sim.player.holding !== null', 2000);
  await aim(page, -300, 0);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(150);
  expect(await simValue<number>(page, 'sim.portals[0].n')).toBe(3);
  await page.keyboard.press('e');
  await waitSim(page, 'sim.player.holding === null', 2000);

  // US-017: the box dropped from high up bounced off the orange floor
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { __minVy: number }).__minVy)).toBeLessThan(-2 * 256);

  // US-013: the blue dispenser (cap 10) keeps pouring at its cap; the oldest goes
  expect(await simValue<number>(page, 'sim.dispensers[0].cap')).toBe(10);
  await waitSim(page, 'sim.dispensers[0].poured > 40');
  const caps = await simValue<{ alive: number; cap: number }[]>(page, 'sim.dispensers.map((d) => ({ alive: d.alive, cap: d.cap }))');
  for (const c of caps) expect(c.alive).toBeLessThanOrEqual(c.cap);
  expect(caps[0].alive).toBeGreaterThan(0);

  // US-012: step off the plate under the start and the doors lock again
  await page.keyboard.down('a');
  await waitSim(page, '!sim.plates[0].pressed', 4000);
  await page.keyboard.up('a');
  await waitSim(page, 'sim.doors.every((d) => !d.open)', 2000);
});

test('US-013: a dispenser that is off by default turns on while its plate is pressed', async ({ page }) => {
  await newLevel(page, 'Switch');
  await buildRoom(page);
  await placeStartFinish(page);
  await tool(page, '6');
  await clickCell(page, 0, 1); // under the start
  await setChannel(page, 2);
  await tool(page, '0');
  await clickCell(page, 6, -2);
  await setChannel(page, 2);
  await page.getByTestId('default-off').click();
  await startPlaying(page);
  await waitSim(page, 'sim.dispensers[0].on && sim.particleSeq > 5', 3000);
  await page.keyboard.down('d');
  await waitSim(page, '!sim.plates[0].pressed', 4000);
  await page.keyboard.up('d');
  await waitSim(page, '!sim.dispensers[0].on', 2000);
  const poured = await simValue<number>(page, 'sim.particleSeq');
  const alive = await simValue<number>(page, 'sim.aliveParticles()');
  await page.waitForTimeout(1000);
  // off: nothing new pours, and liquid already out stays (white on white never paints)
  expect(await simValue<number>(page, 'sim.particleSeq')).toBe(poured);
  expect(await simValue<number>(page, 'sim.aliveParticles()')).toBe(alive);
  expect(alive).toBeGreaterThan(0);
});

test('drawn editor lines match what is played', async ({ page }) => {
  await newLevel(page, 'Parity');
  await tool(page, '1');
  await drawLine(page, [-2, 2], [8, 2]);
  await placeStartFinish(page, [0, 1], [6, 1]);
  await startPlaying(page);
  expect(await simValue<number>(page, 'sim.tiles.size')).toBe(11);
});
