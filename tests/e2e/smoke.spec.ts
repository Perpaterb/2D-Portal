import { test, expect } from '@playwright/test';
import { freshApp, newLevel, buildRoom, placeStartFinish, startPlaying, startClock } from './helpers';

// Runs against any environment via ./scripts/smoke.sh --target <url>
test('@smoke US-025: the site loads, a level can be built, played to the finish and timed', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await freshApp(page);
  await expect(page.locator('h1.logo')).toHaveText('2dholes');
  await newLevel(page, 'Smoke');
  await buildRoom(page);
  await placeStartFinish(page);
  await startPlaying(page);
  await page.keyboard.down('d');
  await expect(page.getByTestId('finish-overlay')).toBeVisible({ timeout: 10000 });
  await page.keyboard.up('d');
  await expect(page.getByTestId('final-time')).toHaveText(/^\d\d:\d\d\.\d{3}$/);
  await page.keyboard.press('Escape');
  await page.getByTestId('back-to-menu').click();
  await expect(page.getByTestId('level-best')).toHaveText(/^Best \d\d:\d\d\.\d{3}$/);
  expect(errors).toEqual([]);
});

test('@smoke US-025: the live site reaches the global levels server, and a global level opens', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await freshApp(page);
  const panel = page.getByTestId('global-levels');
  await expect(panel).not.toContainText('not connected');
  // wait until the first query has answered one way or the other
  await expect(panel.getByTestId('global-loading')).toHaveCount(0, { timeout: 15000 });
  await expect(panel.getByTestId('global-error')).toHaveCount(0);
  await expect(panel.getByTestId('global-row').first().or(panel.getByText('No global levels yet.'))).toBeVisible();
  await expect(page.locator('.toast')).toHaveCount(0);
  if ((await panel.getByTestId('global-row').count()) > 0) {
    await panel.getByTestId('play-global').first().click();
    await expect(page.getByTestId('ghost-panel')).toBeVisible({ timeout: 15000 });
    await startClock(page);
    await page.waitForFunction(() => (window.__holes.sim?.tick ?? 0) > 30);
    await page.keyboard.press('Escape');
  }
  expect(errors).toEqual([]);
});
