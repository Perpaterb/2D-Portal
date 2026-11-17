import { test, expect } from '@playwright/test';
import {
  freshApp, newLevel, tool, drawLine, clickCell, buildRoom, placeStartFinish, setChannel, toScreen, storedLevel, cellCentre,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await freshApp(page);
});

test('US-001: main menu lists my levels and can create, rename, duplicate and delete', async ({ page }) => {
  await expect(page.locator('h1.logo')).toHaveText('2dholes');
  await expect(page.getByTestId('global-levels')).toBeVisible();
  await newLevel(page, 'First test');
  await expect(page.getByTestId('level-title')).toHaveText('First test');
  await page.getByTestId('back-to-menu').click();

  const row = page.getByTestId('level-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('level-name')).toHaveText('First test');
  await expect(row.getByTestId('level-edited')).toHaveText(/^Edited \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}, \d{2}:\d{2}$/);
  await expect(row.getByTestId('level-playable')).toHaveText('Not playable');
  await expect(row.getByTestId('level-best')).toHaveText('No best time');

  await row.getByRole('button', { name: 'Rename' }).click();
  await page.getByTestId('modal-input').fill('Renamed');
  await page.getByTestId('modal-input').press('Enter');
  await expect(row.getByTestId('level-name')).toHaveText('Renamed');

  await row.getByRole('button', { name: 'Duplicate' }).click();
  await expect(page.getByTestId('level-row')).toHaveCount(2);
  await expect(page.getByTestId('level-name').filter({ hasText: 'Renamed (copy)' })).toHaveCount(1);

  await page.getByTestId('level-row').first().getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('level-row')).toHaveCount(2);
  await page.getByTestId('level-row').first().getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('level-row')).toHaveCount(1);
});

test('US-002: levels survive a page refresh', async ({ page }) => {
  const id = await newLevel(page, 'Keep me');
  await tool(page, '1');
  await drawLine(page, [0, 0], [5, 0]);
  await page.waitForTimeout(500); // autosave debounce
  await page.reload();
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__holes.editor?.tiles)).toBe(6);
  await page.getByTestId('back-to-menu').click();
  await expect(page.getByTestId('level-name')).toHaveText('Keep me');
  const stored = (await storedLevel(page, id)) as { data: { tiles: unknown[] } };
  expect(stored.data.tiles).toHaveLength(6);
});

test('US-003: middle mouse pans, the wheel zooms, and the canvas has no edge', async ({ page }) => {
  const id = await newLevel(page, 'Endless');
  const canvas = (await page.getByTestId('editor-canvas').boundingBox())!;
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;
  // pan a long way, several times
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(cx + 400, cy);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(cx - 400, cy, { steps: 4 });
    await page.mouse.up({ button: 'middle' });
  }
  const cam = await page.evaluate(() => window.__holes.editor!.cam);
  expect(cam.x).toBeGreaterThan(4000);
  // build far from the origin
  await tool(page, '1');
  const tileX = Math.floor(cam.x / 32);
  await clickCell(page, tileX, 0);
  await page.waitForTimeout(400);
  const stored = (await storedLevel(page, id)) as { data: { tiles: [number, number, number][] } };
  expect(stored.data.tiles[0][0]).toBe(tileX);

  const before = cam.zoom;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -300);
  await expect.poll(() => page.evaluate(() => window.__holes.editor!.cam.zoom)).toBeGreaterThan(before);
});

test('US-004: place walls and objects, erase with right click, undo and redo, snap toggle', async ({ page }) => {
  const id = await newLevel(page, 'Tools');
  await expect(page.locator('.mode-chip')).toHaveText('Creator');
  await tool(page, '1');
  await drawLine(page, [0, 3], [9, 3]);
  await tool(page, '2');
  await drawLine(page, [0, 4], [4, 4]);
  await expect.poll(() => page.evaluate(() => window.__holes.editor!.tiles)).toBe(15);
  await drawLine(page, [0, 3], [2, 3], 'right');
  await expect.poll(() => page.evaluate(() => window.__holes.editor!.tiles)).toBe(12);
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => window.__holes.editor!.tiles)).toBe(15);
  await page.keyboard.press('Control+y');
  await expect.poll(() => page.evaluate(() => window.__holes.editor!.tiles)).toBe(12);

  for (const key of ['3', '4', '5', '6', '7', '8', '9', '0']) {
    await tool(page, key);
    await clickCell(page, Number(key === '0' ? 10 : key), 1);
  }
  await expect.poll(() => page.evaluate(() => window.__holes.editor!.objects)).toBe(8);

  // snap on: a box lands on the cell floor centre
  await expect(page.getByTestId('snap-toggle')).toHaveText('Snap to grid: On');
  await tool(page, '5');
  const [sx, sy] = await toScreen(page, 32 * 12 + 7, 32 * 1 + 5);
  await page.mouse.click(sx, sy);
  // snap off: free placement keeps the exact point
  await page.getByTestId('snap-toggle').click();
  await expect(page.getByTestId('snap-toggle')).toHaveText('Snap to grid: Off');
  const [fx, fy] = await toScreen(page, 32 * 14 + 7, 32 * 1 + 5);
  await page.mouse.click(fx, fy);
  // walls still snap with snap off
  await tool(page, '1');
  const [wx, wy] = await toScreen(page, 32 * 8 + 9, 32 * 6 + 11);
  await page.mouse.click(wx, wy);
  await page.waitForTimeout(400);
  const stored = (await storedLevel(page, id)) as { data: { tiles: [number, number, number][]; objects: { kind: string; x: number; y: number }[] } };
  const boxes = stored.data.objects.filter((o) => o.kind === 'box');
  expect(boxes.map((b) => [b.x, b.y])).toEqual([[5 * 32 + 16, 64], [12 * 32 + 16, 64], [14 * 32 + 7, 37]]);
  expect(stored.data.tiles).toContainEqual([8, 6, 1]);
});

test('US-005: plates, doors and dispensers take a channel', async ({ page }) => {
  const id = await newLevel(page, 'Wiring');
  await tool(page, '6');
  await clickCell(page, 1, 1);
  await setChannel(page, 4);
  await tool(page, '7');
  await clickCell(page, 3, 1);
  await setChannel(page, 4);
  await tool(page, '8');
  await clickCell(page, 5, 1);
  await setChannel(page, 4);
  await page.getByTestId('default-off').click();
  await page.getByTestId('cap-input').fill('40');
  await page.getByTestId('cap-input').press('Enter');
  await page.waitForTimeout(400);
  const stored = (await storedLevel(page, id)) as { data: { objects: { kind: string; channel: number; defaultOn?: boolean; cap?: number }[] } };
  expect(stored.data.objects.map((o) => o.channel)).toEqual([4, 4, 4]);
  const disp = stored.data.objects.find((o) => o.kind === 'dispenser')!;
  expect(disp.defaultOn).toBe(false);
  expect(disp.cap).toBe(40);
  // selecting shows the properties of that object
  await tool(page, 'v');
  const [x, y] = await cellCentre(page, 3, 1);
  await page.mouse.click(x, y);
  await expect(page.getByTestId('props')).toContainText('Multi-lock door');
});

test('US-006: Play is enabled only with one start and a finish; Esc returns to the editor unchanged', async ({ page }) => {
  await newLevel(page, 'Playable');
  const play = page.getByTestId('play');
  await expect(play).toBeDisabled();
  await expect(page.locator('.play-wrap')).toHaveAttribute('title', /Add a start, Add at least one finish/);
  await buildRoom(page);
  await placeStartFinish(page);
  await expect(play).toBeEnabled();
  const tilesBefore = await page.evaluate(() => window.__holes.editor!.tiles);
  await play.click();
  await expect(page.getByTestId('game-canvas')).toBeVisible();
  await expect(page.getByTestId('timer')).toBeVisible();
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  expect(await page.evaluate(() => window.__holes.editor!.tiles)).toBe(tilesBefore);
  await expect(page.getByTestId('back-to-menu')).toBeVisible();
  await page.getByTestId('back-to-menu').click();
  await expect(page.getByTestId('level-playable')).toHaveText('Playable');
});
