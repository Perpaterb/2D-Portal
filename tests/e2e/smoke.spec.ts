import { test, expect } from '@playwright/test';
import { freshApp, newLevel, buildRoom, placeStartFinish, startPlaying } from './helpers';

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
