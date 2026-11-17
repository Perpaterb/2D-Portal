import { test, expect, type Page } from '@playwright/test';
import { freshApp, newLevel, buildRoom, placeStartFinish, startClock } from './helpers';

const URL_ = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PASSWORD = process.env.ADMIN_PASSWORD;
const hasBackend = !!(URL_ && SERVICE && PASSWORD);

/** Test setup only: clear the global tables so each test starts from nothing. */
async function wipeBackend(): Promise<void> {
  for (const t of ['admin_attempts', 'global_levels']) {
    const r = await fetch(`${URL_}/rest/v1/${t}?id=not.is.null`, {
      method: 'DELETE', headers: { apikey: SERVICE!, Authorization: `Bearer ${SERVICE}` },
    });
    if (!r.ok) throw new Error(`wipe ${t}: ${r.status}`);
  }
}

test.beforeEach(async ({ page }) => {
  if (!hasBackend) throw new Error('Global tests need the local Supabase stack: run npm run test:e2e (scripts/test-e2e.sh)');
  await wipeBackend();
  await freshApp(page);
});

async function unlock(page: Page, password: string): Promise<void> {
  await page.getByTestId('admin-button').click();
  await page.getByTestId('modal-input').fill(password);
  await page.getByTestId('modal-input').press('Enter');
}

async function makeGlobalLevel(page: Page, name: string): Promise<void> {
  await newLevel(page, name);
  await buildRoom(page);
  await placeStartFinish(page);
  await page.getByTestId('back-to-menu').click();
  await unlock(page, PASSWORD!);
  await expect(page.getByTestId('admin-button')).toHaveText('Admin unlocked · Lock');
  await page.getByTestId('add-global').click();
  await expect(page.getByTestId('global-row')).toHaveCount(1);
}

/** Plays the open global level to the finish: starts the clock, waits (on the clock) if asked, then holds D. */
async function runToFinish(page: Page, waitMs = 0): Promise<void> {
  await startClock(page);
  if (waitMs) await page.waitForTimeout(waitMs);
  await page.keyboard.down('d');
  await expect(page.getByTestId('finish-overlay')).toBeVisible({ timeout: 10000 });
  await page.keyboard.up('d');
}

async function submitName(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId('name-entry')).toBeFocused();
  for (let i = 0; i < 8; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
}

test('US-021 US-022: admin unlock checks the password, adds a level, and the global copy is play-only', async ({ page }) => {
  await newLevel(page, 'Global one');
  await buildRoom(page);
  await placeStartFinish(page);
  await page.getByTestId('back-to-menu').click();
  await expect(page.getByTestId('add-global')).toHaveCount(0);

  await unlock(page, 'definitely wrong');
  await expect(page.locator('.toast')).toContainText('Wrong password');
  await expect(page.getByTestId('admin-button')).toHaveText('Unlock admin');

  await unlock(page, PASSWORD!);
  await expect(page.getByTestId('admin-button')).toHaveText('Admin unlocked · Lock');
  await page.getByTestId('add-global').click();
  await expect(page.getByTestId('global-name')).toHaveText('Global one');
  await expect(page.getByTestId('update-global')).toBeDisabled(); // up to date
  await expect(page.getByTestId('level-global')).toHaveText('Global');

  // unlocked for this tab only, survives a refresh, and Lock ends it
  await page.reload();
  await expect(page.getByTestId('admin-button')).toHaveText('Admin unlocked · Lock');
  await page.getByTestId('admin-button').click();
  await expect(page.getByTestId('update-global')).toHaveCount(0);
  await expect(page.getByTestId('delete-global')).toHaveCount(0);

  // anyone can play it, but only play: Esc goes back to the menu, not an editor
  await page.getByTestId('play-global').click();
  await expect(page.getByTestId('ghost-panel')).toContainText('No times yet');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('global-levels')).toBeVisible();
  await expect(page.getByTestId('editor-canvas')).toHaveCount(0);
});

test('US-024 US-029: finish, enter an arcade name, server-timed leaderboard, and coloured ghosts with eyes', async ({ page }) => {
  await makeGlobalLevel(page, 'Race me');

  // first run: RACER
  await page.getByTestId('play-global').click();
  await runToFinish(page);
  const time = (await page.getByTestId('final-time').textContent())!;
  await submitName(page, 'racer');
  await expect(page.getByTestId('submit-status')).toHaveText(`RACER: rank 1 with ${time}`);
  await expect(page.getByTestId('ghost-row')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // second, slower run: SLOWPOKE
  await page.getByTestId('play-global').click();
  await runToFinish(page, 600);
  await submitName(page, 'slowpoke');
  await expect(page.getByTestId('submit-status')).toContainText('SLOWPOKE: rank 2');
  await page.keyboard.press('Escape');

  // the menu shows the record and the top 10
  await expect(page.getByTestId('global-record')).toHaveText(`Record ${time} RACER`);
  await page.getByTestId('toggle-top').click();
  await expect(page.getByTestId('leaderboard-row')).toHaveCount(2);
  await expect(page.getByTestId('leaderboard-row').first()).toContainText('RACER');

  // ghosts: eyes start closed; open both, each its own colour, both running
  await page.getByTestId('play-global').click();
  await page.waitForFunction(() => window.__holes.screen === 'play');
  await expect(page.getByTestId('ghost-row')).toHaveCount(2);
  expect(await page.evaluate(() => window.__holes.ghosts.length)).toBe(0);
  await page.getByTestId('eye').nth(0).click();
  await page.getByTestId('eye').nth(1).click();
  await page.waitForFunction(() => window.__holes.ghosts.length === 2);
  const colours = await page.evaluate(() => window.__holes.ghosts.map((g) => g.colour));
  expect(new Set(colours).size).toBe(2);
  // US-030: the ghosts wait at the start with the world until the player acts
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__holes.ghosts.every((g) => g.tick === 0))).toBe(true);
  await startClock(page);
  await page.waitForFunction(() => window.__holes.ghosts.some((g) => g.x > 5 * 32 * 256));

  // the name tag above a ghost is drawn in its colour
  const tagPixels = await page.evaluate(() => {
    const g = window.__holes.ghosts.find((x) => x.name === 'RACER')!;
    const cam = window.__holes.cam!;
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=game-canvas]')!;
    const dpr = canvas.width / canvas.clientWidth;
    const cx = (canvas.clientWidth / 2 + (g.x / 256 - cam.x) * cam.zoom) * dpr;
    const cy = (canvas.clientHeight / 2 + ((g.y / 256) - 21 - 15 - cam.y) * cam.zoom) * dpr;
    const d = canvas.getContext('2d')!.getImageData(Math.round(cx - 30), Math.round(cy - 15), 60, 30).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 220 && d[i + 1] > 80 && d[i + 1] < 140 && d[i + 2] > 80 && d[i + 2] < 140) n++;
    return n;
  });
  expect(tagPixels).toBeGreaterThan(5);

  // eyes are remembered for this level; closing one removes that ghost
  await page.keyboard.press('Escape');
  await page.getByTestId('play-global').click();
  await page.waitForFunction(() => window.__holes.ghosts.length === 2);
  await page.getByTestId('eye').nth(1).click();
  await page.waitForFunction(() => window.__holes.ghosts.length === 1);
  expect(await page.evaluate(() => window.__holes.ghosts[0].name)).toBe('RACER');
});

test('US-024 US-023: watch a leaderboard replay; the admin removes an entry and then the level', async ({ page }) => {
  await makeGlobalLevel(page, 'Doomed');
  await page.getByTestId('play-global').click();
  await runToFinish(page);
  const time = (await page.getByTestId('final-time').textContent())!;
  await submitName(page, 'rude');
  await expect(page.getByTestId('submit-status')).toContainText('RUDE: rank 1');
  await page.keyboard.press('Escape');

  await page.getByTestId('toggle-top').click();
  await page.getByTestId('watch-run').click();
  await expect(page.getByTestId('finish-overlay')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('final-time')).toHaveText(time);
  await page.keyboard.press('Escape');

  await page.getByTestId('toggle-top').click();
  await page.getByTestId('delete-run').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByTestId('global-record')).toHaveText('No times yet');

  await page.getByTestId('delete-global').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('global-row')).toHaveCount(0);
  await expect(page.getByTestId('add-global')).toBeVisible(); // the local level is still there
});
