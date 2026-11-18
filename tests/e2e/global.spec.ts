import { test, expect, type Page, type Locator } from '@playwright/test';
import { freshApp, newLevel, buildRoom, placeStartFinish, startClock, startPlaying } from './helpers';

const URL_ = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PASSWORD = process.env.ADMIN_PASSWORD;
const hasBackend = !!(URL_ && SERVICE && PASSWORD);

/** Test setup only: clear the global tables so each test starts from nothing. */
async function wipeBackend(): Promise<void> {
  for (const t of ['admin_attempts', 'level_requests', 'global_levels', 'global_folders']) {
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

async function unlocked(page: Page): Promise<void> {
  if ((await page.getByTestId('admin-button').textContent()) === 'Admin unlocked · Lock') return;
  await unlock(page, PASSWORD!);
  await expect(page.getByTestId('admin-button')).toHaveText('Admin unlocked · Lock');
}

/** Holds D from a ready play screen until the finish. */
async function runToFinish(page: Page, waitMs = 0): Promise<void> {
  await startClock(page);
  if (waitMs) await page.waitForTimeout(waitMs);
  await page.keyboard.down('d');
  await expect(page.getByTestId('finish-overlay')).toBeVisible({ timeout: 10000 });
  await page.keyboard.up('d');
}

/** A local level, played to the finish from the editor (so this browser holds a finishing run), back on the menu. */
async function finishedLevel(page: Page, name: string): Promise<string> {
  await page.goto('./#/');
  const id = await newLevel(page, name);
  await buildRoom(page);
  await placeStartFinish(page);
  await startPlaying(page);
  await page.keyboard.down('d');
  await expect(page.getByTestId('finish-overlay')).toBeVisible({ timeout: 10000 });
  await page.keyboard.up('d');
  await page.keyboard.press('Escape');
  await page.getByTestId('back-to-menu').click();
  return id;
}

const row = (page: Page, id: string) => page.locator(`[data-testid=level-row][data-level-id="${id}"]`);

async function submitToGlobal(page: Page, id: string, name?: string): Promise<void> {
  await row(page, id).getByTestId('submit-global').click();
  if (name) await page.getByTestId('modal-input').fill(name);
  await page.getByTestId('modal-input').press('Enter');
  await expect(page.locator('.toast').last()).toContainText('for review');
}

async function openGlobal(page: Page): Promise<void> {
  await page.goto('./#/');
  await page.getByTestId('open-global').click();
  await expect(page.getByTestId('global-loading')).toHaveCount(0, { timeout: 15000 });
}

const globalRow = (page: Page, name: string) => page.getByTestId('global-row').filter({ has: page.getByTestId('global-name').getByText(name, { exact: true }) });
const folderRow = (page: Page, name: string) => page.getByTestId('folder-row').filter({ has: page.getByTestId('folder-name').getByText(name, { exact: true }) });
const names = (page: Page) => page.getByTestId('global-name').allTextContents();
const folderNames = (page: Page) => page.getByTestId('folder-name').allTextContents();

/** The whole way in: finish, submit, admin approves. Leaves the admin unlocked on the global page. */
async function makeGlobalLevel(page: Page, name: string): Promise<void> {
  const id = await finishedLevel(page, name);
  await submitToGlobal(page, id);
  await openGlobal(page);
  await unlocked(page);
  await page.getByTestId('request-row').filter({ hasText: name }).getByTestId('approve').click();
  await expect(globalRow(page, name)).toHaveCount(1);
}

async function newFolder(page: Page, name: string): Promise<void> {
  await page.getByTestId('new-folder').click();
  await page.getByTestId('modal-input').fill(name);
  await page.getByTestId('modal-input').press('Enter');
  await expect(folderRow(page, name)).toHaveCount(1);
}

/** HTML drag and drop, dropping at a height given as a fraction of the target's. */
async function dragOnto(from: Locator, to: Locator, fy = 0.6): Promise<void> {
  const box = (await to.boundingBox())!;
  await from.dragTo(to, { targetPosition: { x: Math.min(40, box.width / 2), y: box.height * fy } });
}

test('US-021 US-022: admin unlock checks the password; nobody else sees admin tools; global levels are play-only', async ({ page }) => {
  await unlock(page, 'definitely wrong');
  await expect(page.locator('.toast')).toContainText('Wrong password');
  await expect(page.getByTestId('admin-button')).toHaveText('Unlock admin');

  await makeGlobalLevel(page, 'Global one');
  // unlocked for this tab only, survives a refresh, and Lock ends it
  await page.reload();
  await expect(page.getByTestId('admin-button')).toHaveText('Admin unlocked · Lock');
  await page.getByTestId('admin-button').click();
  await expect(page.getByTestId('requests')).toBeHidden();
  await expect(page.getByTestId('delete-global')).toHaveCount(0);
  await expect(page.getByTestId('new-folder')).toHaveCount(0);

  // anyone can play it, but only play: Esc goes back to the global page, not an editor
  await page.getByTestId('play-global').click();
  await expect(page.getByTestId('ghost-panel')).toContainText('No times yet');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('global-list')).toBeVisible();
  await expect(page.getByTestId('editor-canvas')).toHaveCount(0);
});

test('US-042: the menu opens the global page; folders open with a breadcrumb path and lead back', async ({ page }) => {
  await expect(page.getByTestId('global-levels').getByTestId('open-global')).toBeVisible();
  await expect(page.getByTestId('global-row')).toHaveCount(0); // the list lives on its own page now
  await makeGlobalLevel(page, 'Top level');
  await newFolder(page, 'Puzzles');
  await folderRow(page, 'Puzzles').click();
  await expect(page).toHaveURL(/#\/global\/[\w-]+$/);
  await newFolder(page, 'Hard');
  await folderRow(page, 'Hard').getByTestId('open-folder').click();
  await expect(page.getByTestId('crumb')).toHaveText(['Global', 'Puzzles', 'Hard']);
  await expect(page.getByText('This folder is empty.')).toBeVisible();
  // a reload stays in the folder
  await page.reload();
  await expect(page.getByTestId('crumb')).toHaveText(['Global', 'Puzzles', 'Hard']);
  await page.getByTestId('crumb').filter({ hasText: 'Puzzles' }).click();
  await expect(page.getByTestId('crumb')).toHaveText(['Global', 'Puzzles']);
  await page.getByTestId('up-level').click();
  await expect(page.getByTestId('crumb')).toHaveText(['Global']);
  await expect(globalRow(page, 'Top level')).toHaveCount(1);
  await expect(globalRow(page, 'Top level').getByTestId('global-author')).toHaveText('by TESTER');
  await page.getByTestId('back-to-menu').click();
  await expect(page.getByTestId('my-levels')).toBeVisible();
});

test('US-043 US-040: the admin drags levels and folders in, out, and into order; deleting a folder keeps what was in it', async ({ page, browser }) => {
  for (const n of ['Alpha', 'Bravo', 'Charlie']) await makeGlobalLevel(page, n);
  expect(await names(page)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  await newFolder(page, 'Easy');
  await newFolder(page, 'Hard');

  // reorder: Charlie dropped on Alpha goes just before it
  await dragOnto(globalRow(page, 'Charlie'), globalRow(page, 'Alpha'));
  await expect.poll(() => names(page)).toEqual(['Charlie', 'Alpha', 'Bravo']);
  // and the end zone sends one to the bottom
  await dragOnto(globalRow(page, 'Charlie'), page.getByTestId('drop-end'));
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Bravo', 'Charlie']);

  // into a folder
  await dragOnto(globalRow(page, 'Bravo'), folderRow(page, 'Easy'));
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Charlie']);
  await expect(folderRow(page, 'Easy')).toContainText('1 level');
  // folders reorder by dropping on another folder's top edge, and nest by dropping in the middle
  await dragOnto(folderRow(page, 'Hard'), folderRow(page, 'Easy'), 0.1);
  await expect.poll(() => folderNames(page)).toEqual(['Hard', 'Easy']);
  await dragOnto(folderRow(page, 'Easy'), folderRow(page, 'Hard'));
  await expect.poll(() => folderNames(page)).toEqual(['Hard']);

  // inside Hard › Easy: Bravo comes out by the "up" row, then by the Global breadcrumb
  await folderRow(page, 'Hard').click();
  await folderRow(page, 'Easy').click();
  await expect(page.getByTestId('crumb')).toHaveText(['Global', 'Hard', 'Easy']);
  await dragOnto(globalRow(page, 'Bravo'), page.getByTestId('up-level'));
  await expect(globalRow(page, 'Bravo')).toHaveCount(0);
  await page.getByTestId('up-level').click();
  await expect(globalRow(page, 'Bravo')).toHaveCount(1);
  await dragOnto(globalRow(page, 'Bravo'), page.getByTestId('crumb').filter({ hasText: 'Global' }));
  await expect(globalRow(page, 'Bravo')).toHaveCount(0);

  // a folder can't go inside its own folder: search "a" lists Hard and Easy (which is inside Hard) side by side
  await page.getByTestId('crumb').filter({ hasText: 'Global' }).click();
  await expect.poll(() => folderNames(page)).toEqual(['Hard']);
  await page.getByTestId('global-search').fill('a');
  await expect.poll(() => folderNames(page)).toEqual(['Hard', 'Easy']);
  await dragOnto(folderRow(page, 'Hard'), folderRow(page, 'Easy'));
  await expect(page.locator('.toast').last()).toContainText("can't go inside itself");
  await page.getByTestId('global-search').fill('');
  expect(await folderNames(page)).toEqual(['Hard']);

  // someone else sees the same order and folders, with no admin tools and nothing draggable
  const visitor = await (await browser.newContext()).newPage();
  await freshApp(visitor);
  await openGlobal(visitor);
  await expect.poll(() => names(visitor)).toEqual(['Alpha', 'Charlie', 'Bravo']);
  expect(await folderNames(visitor)).toEqual(['Hard']);
  expect(await globalRow(visitor, 'Alpha').getAttribute('draggable')).toBeNull();

  // deleting Hard moves Easy (with nothing lost) up to Global
  await folderRow(page, 'Hard').getByTestId('delete-folder').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => folderNames(page)).toEqual(['Easy']);
  await expect(folderRow(page, 'Easy')).toContainText('0 levels');
  // and renaming a folder
  await folderRow(page, 'Easy').getByTestId('rename-folder').click();
  await page.getByTestId('modal-input').fill('Starter');
  await page.getByTestId('modal-input').press('Enter');
  await expect.poll(() => folderNames(page)).toEqual(['Starter']);
});

test('US-044: search finds levels and folders in any folder, with their path', async ({ page }) => {
  await makeGlobalLevel(page, 'Deep dive');
  await makeGlobalLevel(page, 'Shallow end');
  await newFolder(page, 'Ocean');
  await dragOnto(globalRow(page, 'Deep dive'), folderRow(page, 'Ocean'));
  await expect(globalRow(page, 'Deep dive')).toHaveCount(0);

  await page.getByTestId('global-search').fill('deep');
  await expect(globalRow(page, 'Deep dive')).toHaveCount(1);
  await expect(globalRow(page, 'Deep dive').getByTestId('result-path')).toHaveText('Global › Ocean');
  await expect(globalRow(page, 'Shallow end')).toHaveCount(0);
  await page.getByTestId('global-search').fill('OCEAN');
  await expect(folderRow(page, 'Ocean')).toHaveCount(1);
  await expect(page.getByTestId('global-row')).toHaveCount(0);
  await page.getByTestId('global-search').fill('nothing like this');
  await expect(page.getByTestId('no-results')).toBeVisible();

  // a level result plays straight away; a folder result opens the folder
  await page.getByTestId('global-search').fill('deep');
  await globalRow(page, 'Deep dive').getByTestId('play-global').click();
  await expect(page.getByTestId('ghost-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('global-search').fill('ocean');
  await folderRow(page, 'Ocean').click();
  await expect(page.getByTestId('crumb')).toHaveText(['Global', 'Ocean']);
});

test('US-046 US-047 US-045: anyone submits a finished level; the admin play-tests and approves or rejects it', async ({ page }) => {
  const id = await newLevel(page, 'Fresh');
  await buildRoom(page);
  await placeStartFinish(page);
  await page.getByTestId('back-to-menu').click();
  // not finished yet: refused with a reason
  await row(page, id).getByTestId('submit-global').click();
  await expect(page.locator('.toast').last()).toContainText('Finish this level first');
  await expect(page.getByTestId('add-global')).toHaveCount(0);
  await expect(page.getByTestId('update-global')).toHaveCount(0);

  const keep = await finishedLevel(page, 'Keeper');
  const drop = await finishedLevel(page, 'Dropper');
  await submitToGlobal(page, keep, 'Keeper level');
  await submitToGlobal(page, drop);

  // a visitor sees neither yet, and no queue
  await openGlobal(page);
  await expect(page.getByTestId('global-row')).toHaveCount(0);
  await expect(page.getByTestId('requests')).toBeHidden();

  await unlocked(page);
  await expect(page.getByTestId('requests-title')).toHaveText('Requests (2)');
  const req = page.getByTestId('request-row').filter({ hasText: 'Keeper level' });
  await expect(req.getByTestId('request-author')).toHaveText('by TESTER');
  // its thumbnail is a real picture of the level
  const colours = await req.getByTestId('thumb').evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < d.length; i += 4) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return seen.size;
  });
  expect(colours).toBeGreaterThan(4);

  // play test: finish it, nothing goes on a leaderboard, back to the queue
  await req.getByTestId('playtest').click();
  await runToFinish(page);
  await expect(page.getByTestId('submit-status')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('requests-title')).toHaveText('Requests (2)');

  await req.getByTestId('approve').click();
  await page.getByTestId('request-row').filter({ hasText: 'Dropper' }).getByTestId('reject').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByTestId('requests-title')).toHaveText('Requests (0)');
  await expect(page.getByTestId('global-row')).toHaveCount(1);
  const g = globalRow(page, 'Keeper level');
  await expect(g.getByTestId('global-author')).toHaveText('by TESTER');
  await expect(g.getByTestId('global-record')).toHaveText('No times yet');
  // global rows get thumbnails too, once their level has loaded
  await expect(g.getByTestId('thumb')).not.toHaveAttribute('data-loading', '1');
});

test('US-024 US-029 US-030 US-049: a finish goes on the leaderboard under my name; ghosts with eyes', async ({ page }) => {
  await makeGlobalLevel(page, 'Race me');
  await page.getByTestId('admin-button').click(); // lock: play as a normal visitor

  // first run, as TESTER: no typing at the finish
  await page.getByTestId('play-global').click();
  await runToFinish(page);
  const time = (await page.getByTestId('final-time').textContent())!;
  await expect(page.getByTestId('submit-status')).toHaveText(`TESTER: rank 1 with ${time}`);
  await expect(page.getByTestId('ghost-row')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // change the name, then a slower run
  await page.getByTestId('player-name').click();
  await page.getByTestId('modal-input').fill('slowpoke');
  await page.getByTestId('modal-input').press('Enter');
  await expect(page.getByTestId('player-name')).toHaveText('Playing as SLOWPOKE');
  await page.getByTestId('play-global').click();
  await runToFinish(page, 600);
  await expect(page.getByTestId('submit-status')).toContainText('SLOWPOKE: rank 2');
  await page.keyboard.press('Escape');

  await expect(page.getByTestId('global-record')).toHaveText(`Record ${time} TESTER`);
  await page.getByTestId('toggle-top').click();
  await expect(page.getByTestId('leaderboard-row')).toHaveCount(2);
  await expect(page.getByTestId('leaderboard-row').first()).toContainText('TESTER');

  // ghosts: eyes start closed; open both, each its own colour, waiting with the world
  await page.getByTestId('play-global').click();
  await page.waitForFunction(() => window.__holes.screen === 'play');
  await expect(page.getByTestId('ghost-row')).toHaveCount(2);
  expect(await page.evaluate(() => window.__holes.ghosts.length)).toBe(0);
  await page.getByTestId('eye').nth(0).click();
  await page.getByTestId('eye').nth(1).click();
  await page.waitForFunction(() => window.__holes.ghosts.length === 2);
  const colours = await page.evaluate(() => window.__holes.ghosts.map((g) => g.colour));
  expect(new Set(colours).size).toBe(2);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__holes.ghosts.every((g) => g.tick === 0))).toBe(true);
  await startClock(page);
  await page.waitForFunction(() => window.__holes.ghosts.some((g) => g.x > 5 * 32 * 256));

  // the name tag above a ghost is drawn in its colour
  const tagPixels = await page.evaluate(() => {
    const g = window.__holes.ghosts.find((x) => x.name === 'TESTER')!;
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
  expect(await page.evaluate(() => window.__holes.ghosts[0].name)).toBe('TESTER');
});

test('US-049: the first visit asks for a name and remembers it', async ({ page }) => {
  await freshApp(page, null);
  await expect(page.getByRole('dialog')).toContainText("What's your name?");
  // nothing usable is not accepted
  await page.getByTestId('modal-input').fill('!!');
  await page.getByTestId('modal-input').press('Enter');
  await expect(page.getByRole('dialog')).toContainText('Please enter a name');
  await page.getByTestId('modal-input').fill('zac 1');
  await page.getByTestId('modal-input').press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('player-name')).toHaveText('Playing as ZAC 1');
  await page.reload();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('player-name')).toHaveText('Playing as ZAC 1');
});

test('US-024 US-023 US-048: watch a replay; the admin renames (leaderboard kept), removes an entry, then the level', async ({ page }) => {
  await makeGlobalLevel(page, 'Doomed');
  await page.getByTestId('play-global').click();
  await runToFinish(page);
  const time = (await page.getByTestId('final-time').textContent())!;
  await expect(page.getByTestId('submit-status')).toContainText('TESTER: rank 1');
  await page.keyboard.press('Escape');

  await page.getByTestId('toggle-top').click();
  await page.getByTestId('watch-run').click();
  await expect(page.getByTestId('finish-overlay')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('final-time')).toHaveText(time);
  await page.keyboard.press('Escape');

  // rename keeps the leaderboard; there is no way to change the level itself
  await globalRow(page, 'Doomed').getByTestId('rename-global').click();
  await page.getByTestId('modal-input').fill('Renamed');
  await page.getByTestId('modal-input').press('Enter');
  await expect(globalRow(page, 'Renamed').getByTestId('global-record')).toHaveText(`Record ${time} TESTER`);
  await expect(page.getByTestId('update-global')).toHaveCount(0);

  await page.getByTestId('toggle-top').click();
  await page.getByTestId('delete-run').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByTestId('global-record')).toHaveText('No times yet');

  await page.getByTestId('delete-global').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('global-row')).toHaveCount(0);
  // the local level is still there, and can be sent in again
  await page.getByTestId('back-to-menu').click();
  await expect(page.getByTestId('level-row').filter({ hasText: 'Doomed' }).getByTestId('submit-global')).toBeEnabled();
});

test('US-041: a finished global level shows Completed and my best, kept without a leaderboard place', async ({ page }) => {
  await makeGlobalLevel(page, 'Mine');
  const g = globalRow(page, 'Mine');
  await expect(g.getByTestId('global-completed')).toHaveCount(0);

  await page.getByTestId('play-global').click();
  await runToFinish(page);
  const time = (await page.getByTestId('final-time').textContent())!;
  await expect(page.getByTestId('best-line')).toHaveText('First clear, saved as your best');
  await page.keyboard.press('Escape');
  await expect(g.getByTestId('global-completed')).toHaveText('Completed');
  await expect(g.getByTestId('global-mine')).toHaveText(`Your best ${time}`);

  // even with that leaderboard entry removed, it is this browser's own record
  await page.getByTestId('toggle-top').click();
  await page.getByTestId('delete-run').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(g.getByTestId('global-record')).toHaveText('No times yet');
  await expect(g.getByTestId('global-mine')).toHaveText(`Your best ${time}`);

  // a slower run does not replace it, and it survives a reload
  await page.getByTestId('play-global').click();
  await runToFinish(page, 600);
  await expect(page.getByTestId('best-line')).toHaveText(`Best ${time}`);
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(g.getByTestId('global-mine')).toHaveText(`Your best ${time}`);
});
