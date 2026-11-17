import { expect, type Page } from '@playwright/test';

const T = 32;

export async function freshApp(page: Page): Promise<void> {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.goto('./#/');
  await expect(page.getByTestId('my-levels')).toBeVisible();
}

export async function newLevel(page: Page, name: string): Promise<string> {
  await page.getByTestId('new-level').click();
  const input = page.getByTestId('modal-input');
  await input.fill(name);
  await input.press('Enter');
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  const m = /#\/edit\/([\w-]+)/.exec(page.url());
  return m![1];
}

/** Screen position of a world point in the editor. */
export async function toScreen(page: Page, wx: number, wy: number): Promise<[number, number]> {
  const box = (await page.getByTestId('editor-canvas').boundingBox())!;
  const cam = await page.evaluate(() => window.__holes.editor!.cam);
  return [box.x + box.width / 2 + (wx - cam.x) * cam.zoom, box.y + box.height / 2 + (wy - cam.y) * cam.zoom];
}

export async function cellCentre(page: Page, cx: number, cy: number): Promise<[number, number]> {
  return toScreen(page, cx * T + T / 2, cy * T + T / 2);
}

export async function tool(page: Page, key: string): Promise<void> {
  await page.getByTestId('editor-canvas').hover({ position: { x: 5, y: 5 } });
  await page.keyboard.press(key);
}

/** Drag-paint walls along a straight line of cells with the current tool. */
export async function drawLine(page: Page, from: [number, number], to: [number, number], button: 'left' | 'right' = 'left'): Promise<void> {
  const [x0, y0] = await cellCentre(page, ...from);
  const [x1, y1] = await cellCentre(page, ...to);
  await page.mouse.move(x0, y0);
  await page.mouse.down({ button });
  await page.mouse.move(x1, y1, { steps: 6 });
  await page.mouse.up({ button });
}

export async function clickCell(page: Page, cx: number, cy: number, button: 'left' | 'right' = 'left'): Promise<void> {
  const [x, y] = await cellCentre(page, cx, cy);
  await page.mouse.click(x, y, { button });
}

/** A walled room: interior x -2..12, y top..1, floor at y = 2. */
export async function buildRoom(page: Page, top = -4): Promise<void> {
  await tool(page, '1');
  await drawLine(page, [-3, 2], [13, 2]);
  await drawLine(page, [-3, top - 1], [13, top - 1]);
  await drawLine(page, [-3, top], [-3, 1]);
  await drawLine(page, [13, top], [13, 1]);
}

export async function placeStartFinish(page: Page, start: [number, number] = [0, 1], finish: [number, number] = [10, 1]): Promise<void> {
  await tool(page, '3');
  await clickCell(page, ...start);
  await tool(page, '4');
  await clickCell(page, ...finish);
}

export async function setChannel(page: Page, channel: number): Promise<void> {
  await page.locator(`[data-testid=channel-swatches] [data-channel="${channel}"]`).click();
}

export async function startPlaying(page: Page): Promise<void> {
  await page.getByTestId('play').click();
  await expect(page.getByTestId('game-canvas')).toBeVisible();
  await startClock(page);
}

/**
 * US-030: the world waits, untimed, until the first action. Checks that, then starts it the way a
 * player would. E (pick up) changes nothing when no box is in reach, so it starts the clock cleanly.
 */
export async function startClock(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__holes.screen === 'play' && !!window.__holes.sim);
  await expect(page.getByTestId('ready')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('timer')).toHaveText('00:00.000');
  expect(await page.evaluate(() => window.__holes.sim!.tick)).toBe(0);
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__holes.sim!.tick > 5);
  await expect(page.getByTestId('ready')).toBeHidden();
  expect(await page.evaluate(() => window.__holes.sim!.player.holding)).toBeNull();
}

/** Moves the mouse in play relative to the screen centre (= the player). */
export async function aim(page: Page, dx: number, dy: number): Promise<void> {
  const box = (await page.getByTestId('game-canvas').boundingBox())!;
  const zoom = 1.4;
  await page.mouse.move(box.x + box.width / 2 + dx * zoom, box.y + box.height / 2 + dy * zoom);
}

export async function holdKey(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

export function simValue<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(`(() => { const sim = window.__holes.sim; return (${fn}); })()`) as Promise<T>;
}

export async function storedLevel(page: Page, id: string): Promise<unknown> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), `2dholes.level.${id}`);
}
