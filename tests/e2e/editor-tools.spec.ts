import { test, expect, type Page } from '@playwright/test';
import {
  freshApp, newLevel, tool, drawLine, clickCell, cellCentre, toScreen, buildRoom, placeStartFinish, startPlaying,
  storedLevel, holdKey,
} from './helpers';

const T = 32;

type Stored = { data: { tiles: [number, number, number][]; objects: { id: number; kind: string; x?: number; y?: number; cx?: number; cy?: number; channel?: number }[] } };

async function saved(page: Page, id: string): Promise<Stored['data']> {
  await page.waitForTimeout(400); // the editor saves 250 ms after the last change
  return ((await storedLevel(page, id)) as Stored).data;
}

async function dragCells(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const [x0, y0] = await cellCentre(page, ...from);
  const [x1, y1] = await cellCentre(page, ...to);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 8 });
  await page.mouse.up();
}

const area = (page: Page) => page.evaluate(() => window.__holes.editor!.area ?? null);
const hasTile = (d: Stored['data'], cx: number, cy: number, kind?: number) =>
  d.tiles.some((t) => t[0] === cx && t[1] === cy && (kind === undefined || t[2] === kind));

test('US-034: Select and Erase are at the top of the toolbar, and Erase is a trash can', async ({ page }) => {
  await freshApp(page);
  await newLevel(page, 'Toolbar');
  const tools = page.locator('[data-testid=toolbar] .tool');
  await expect(tools.nth(0)).toHaveAttribute('data-tool', 'select');
  await expect(tools.nth(1)).toHaveAttribute('data-tool', 'erase');
  const bg = await page.locator('.icon-erase').evaluate((e) => getComputedStyle(e).backgroundImage);
  expect(bg).toContain('svg');
  // the trash can is a drawn icon, not the old red outline box
  expect(await page.locator('.icon-erase').evaluate((e) => getComputedStyle(e).borderTopWidth)).toBe('0px');
});

test('US-033: blue, orange and white blocks are painted walls in the editor and in play', async ({ page }) => {
  await freshApp(page);
  const id = await newLevel(page, 'Blocks');
  await buildRoom(page);
  await tool(page, 'b');
  await drawLine(page, [0, 2], [3, 2]);
  await tool(page, 'o');
  await drawLine(page, [4, 2], [6, 2]);
  await tool(page, 'w');
  await drawLine(page, [7, 2], [9, 2]);
  await placeStartFinish(page, [1, 1], [11, 1]);
  const d = await saved(page, id);
  expect(hasTile(d, 1, 2, 3)).toBe(true);
  expect(hasTile(d, 5, 2, 4)).toBe(true);
  expect(hasTile(d, 8, 2, 5)).toBe(true);

  await startPlaying(page);
  // the sim holds them as dark walls with paint on every face, so the existing paint rules apply
  const faces = await page.evaluate(() => {
    const sim = window.__holes.sim!;
    const key = (cx: number, cy: number) => (cx + 2 ** 20) * 2 ** 21 + (cy + 2 ** 20);
    return [1, 5, 8].map((cx) => [sim.tiles.get(key(cx, 2)), sim.paint.get(key(cx, 2) * 4 + 3)]);
  });
  expect(faces).toEqual([[2, 1], [2, 2], [2, 3]]);
});

test('US-032 US-035: select a box, resize it, move it over things without harm, duplicate, delete, undo', async ({ page }) => {
  await freshApp(page);
  const id = await newLevel(page, 'Selection');
  await tool(page, '1');
  await drawLine(page, [0, 3], [3, 3]);
  await tool(page, '5');
  await clickCell(page, 1, 2); // a box standing on the wall
  await tool(page, '6');
  await clickCell(page, 2, 2); // a plate next to it
  await tool(page, '2');
  await clickCell(page, 8, 3); // a dark wall in the path of the move
  await tool(page, 'v');

  // drag a rectangle over the wall row and the objects
  await dragCells(page, [0, 2], [2, 3]);
  expect(await area(page)).toEqual({ x0: 0, y0: 2, x1: 3, y1: 4 });
  await expect(page.getByTestId('area-info')).toContainText('3 × 2 cells');

  // grow it by dragging the right edge one cell out
  const [ex, ey] = await toScreen(page, 3 * T, 3 * T);
  await page.mouse.move(ex, ey);
  await page.mouse.down();
  const [ex2] = await toScreen(page, 4 * T, 3 * T);
  await page.mouse.move(ex2, ey, { steps: 4 });
  await page.mouse.up();
  expect(await area(page)).toEqual({ x0: 0, y0: 2, x1: 4, y1: 4 });
  await expect(page.getByTestId('area-info')).toContainText('4 × 2 cells · 6 things');

  // move it right across the dark wall and on past it: the dark wall survives
  await dragCells(page, [1, 3], [7, 3]);
  await dragCells(page, [7, 3], [11, 3]);
  expect(await area(page)).toEqual({ x0: 10, y0: 2, x1: 14, y1: 4 });
  let d = await saved(page, id);
  expect(hasTile(d, 8, 3, 2)).toBe(true);
  expect(hasTile(d, 0, 3)).toBe(false);
  for (let cx = 10; cx < 14; cx++) expect(hasTile(d, cx, 3, 1)).toBe(true);
  const box = d.objects.find((o) => o.kind === 'box')!;
  expect(box.x).toBe(11 * T + T / 2);

  // duplicate: a full copy (same channel) next to it, as the new selection
  await page.keyboard.press('Control+d');
  d = await saved(page, id);
  expect(d.tiles.filter((t) => t[2] === 1)).toHaveLength(8);
  const plates = d.objects.filter((o) => o.kind === 'plate');
  expect(plates).toHaveLength(2);
  expect(plates[0].channel).toBe(plates[1].channel);
  expect(d.objects.filter((o) => o.kind === 'box')).toHaveLength(2);
  const copyArea = (await area(page))!;
  expect(copyArea.x0).not.toBe(10);

  // delete the copy, then undo brings it back
  await page.keyboard.press('Delete');
  expect(await area(page)).toBeNull();
  d = await saved(page, id);
  expect(d.objects.filter((o) => o.kind === 'box')).toHaveLength(1);
  expect(d.tiles.filter((t) => t[2] === 1)).toHaveLength(4);
  await page.getByTestId('undo').click();
  d = await saved(page, id);
  expect(d.objects.filter((o) => o.kind === 'box')).toHaveLength(2);

  // Esc lets go; a click on empty space draws nothing
  await page.keyboard.press('Escape');
  expect(await area(page)).toBeNull();
  await clickCell(page, -5, -5);
  expect(await area(page)).toBeNull();
});

test('US-035: objects cannot be placed or dragged on top of each other', async ({ page }) => {
  await freshApp(page);
  const id = await newLevel(page, 'No overlap');
  await tool(page, '1');
  await drawLine(page, [-2, 2], [8, 2]);
  await placeStartFinish(page, [0, 1], [5, 1]);
  // a finish, a box and a dispenser on top of the start are all refused
  for (const key of ['4', '5', '8']) {
    await tool(page, key);
    await clickCell(page, 0, 1);
  }
  let d = await saved(page, id);
  expect(d.objects.map((o) => o.kind).sort()).toEqual(['finish', 'start']);
  await expect(page.locator('.toast').first()).toContainText('Something is already there');

  // a selection holding the start can't be moved onto the finish: it stops short
  await tool(page, 'v');
  await dragCells(page, [0, 1], [0, 1]); // one cell is a click: nothing selected
  expect(await area(page)).toBeNull();
  await dragCells(page, [-1, 0], [1, 1]);
  await dragCells(page, [0, 1], [5, 1]);
  d = await saved(page, id);
  const start = d.objects.find((o) => o.kind === 'start')!;
  const finish = d.objects.find((o) => o.kind === 'finish')!;
  expect(Math.abs(start.x! - finish.x!)).toBeGreaterThanOrEqual(T);
});

test('US-031: Q restarts the run, back to the untimed start', async ({ page }) => {
  await freshApp(page);
  await newLevel(page, 'Restart');
  await buildRoom(page);
  await placeStartFinish(page, [0, 1], [11, 1]);
  await startPlaying(page);
  const x0 = await page.evaluate(() => window.__holes.sim!.player.x);
  await holdKey(page, 'd', 400);
  expect(await page.evaluate(() => window.__holes.sim!.player.x)).toBeGreaterThan(x0);
  await page.keyboard.press('q');
  await expect(page.getByTestId('ready')).toBeVisible();
  await expect(page.getByTestId('timer')).toHaveText('00:00.000');
  expect(await page.evaluate(() => [window.__holes.sim!.player.x, window.__holes.sim!.started])).toEqual([x0, false]);
});
