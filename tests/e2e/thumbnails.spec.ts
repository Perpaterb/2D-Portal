import { test, expect, type Page } from '@playwright/test';
import { freshApp, newLevel, buildRoom, placeStartFinish, tool, drawLine } from './helpers';

/** Colours drawn in a level row's thumbnail: how many distinct ones, and whether the start's green is there. */
async function thumbColours(page: Page, id: string): Promise<{ distinct: number; green: boolean; url: string }> {
  return page.locator(`[data-testid=level-row][data-level-id="${id}"] [data-testid=thumb]`).evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<number>();
    let green = false;
    for (let i = 0; i < d.length; i += 4) {
      seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      // the start marker's #4fdc84
      if (Math.abs(d[i] - 0x4f) < 12 && Math.abs(d[i + 1] - 0xdc) < 12 && Math.abs(d[i + 2] - 0x84) < 12) green = true;
    }
    return { distinct: seen.size, green, url: c.toDataURL() };
  });
}

test('US-045: each of my levels shows a picture of itself that changes when the level does', async ({ page }) => {
  await freshApp(page);
  const empty = await newLevel(page, 'Empty');
  await page.getByTestId('back-to-menu').click();
  const blank = await thumbColours(page, empty);
  expect(blank.distinct).toBe(1); // nothing in it: plain background

  const id = await newLevel(page, 'Room');
  await buildRoom(page);
  await placeStartFinish(page);
  await page.getByTestId('back-to-menu').click();
  const room = await thumbColours(page, id);
  expect(room.distinct).toBeGreaterThan(4);
  expect(room.green).toBe(true);
  await expect(page.locator(`[data-level-id="${id}"] [data-testid=thumb]`)).toBeVisible();

  // paint a row of blue blocks into the room: the picture changes
  await page.goto(`/#/edit/${id}`);
  await tool(page, 'b');
  await drawLine(page, [2, -1], [8, -1]);
  await page.getByTestId('back-to-menu').click();
  const blue = await thumbColours(page, id);
  expect(blue.url).not.toBe(room.url);
});
