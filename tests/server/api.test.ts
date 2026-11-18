import { describe, it, expect, beforeEach } from 'vitest';
import { ascii } from '../unit/helpers';
import { Sim, IN_RIGHT, IN_LEFT } from '../../src/sim/sim';
import { Recorder, runReplay, type Replay } from '../../src/sim/replay';
import { levelHash, parseLevel, BLUE, ORANGE, type LevelData, type LevelObject } from '../../src/sim/level';

const URL_ = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PASSWORD = process.env.ADMIN_PASSWORD;
if (!URL_ || !ANON || !SERVICE || !PASSWORD) {
  throw new Error('Server tests need SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY and ADMIN_PASSWORD (run scripts/test-server.sh)');
}

const anonHeaders = { apikey: ANON, 'Content-Type': 'application/json', ...(ANON.startsWith('eyJ') ? { Authorization: `Bearer ${ANON}` } : {}) };
const serviceHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

async function api(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${URL_}/functions/v1/api`, { method: 'POST', headers: anonHeaders, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

/** Test setup only: wipe tables with the service key so every test starts clean. */
async function wipe(table: string): Promise<void> {
  const r = await fetch(`${URL_}/rest/v1/${table}?id=not.is.null`, { method: 'DELETE', headers: serviceHeaders });
  if (!r.ok) throw new Error(`wipe ${table}: ${r.status}`);
}

async function anonGet<T>(path: string): Promise<T> {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { headers: anonHeaders });
  return (await r.json()) as T;
}

const LEVEL: LevelData = ascii(['WWWWWWWWWW', 'W........W', 'W.S....F.W', 'WWWWWWWWWW']);

/** A real run: hold right until the finish, recorded as the game records it. */
function finishingReplay(level: LevelData, extraIdle = 0): Replay {
  const sim = new Sim(level);
  const rec = new Recorder();
  for (let i = 0; i < extraIdle; i++) {
    rec.push({ bits: 0, ax: 1, ay: 0 });
    sim.step({ bits: 0, ax: 1, ay: 0 });
  }
  while (!sim.finished && sim.tick < 2000) {
    rec.push({ bits: IN_RIGHT, ax: 1, ay: 0 });
    sim.step({ bits: IN_RIGHT, ax: 1, ay: 0 });
  }
  return rec.finish(levelHash(level));
}

/** The real way a level becomes global: anyone submits it with a finishing run, the admin approves it. */
async function addLevel(level = LEVEL, name = 'Test level', author = 'MAKER'): Promise<string> {
  const sent = await api({ action: 'submit-level', name, author, level, replay: finishingReplay(level) });
  expect(sent.status).toBe(200);
  const ok = await api({ action: 'approve-request', password: PASSWORD, id: sent.body.id });
  expect(ok.status).toBe(200);
  return ok.body.id as string;
}

/** Test setup only: put a level straight in with the service key (for a level too heavy to verify on submit). */
async function seedLevel(level: LevelData, name: string): Promise<string> {
  const r = await fetch(`${URL_}/rest/v1/global_levels`, {
    method: 'POST', headers: { ...serviceHeaders, Prefer: 'return=representation' },
    body: JSON.stringify({ name, data: level, level_hash: levelHash(level) }),
  });
  if (!r.ok) throw new Error(`seed: ${r.status}`);
  return ((await r.json()) as { id: string }[])[0].id;
}

beforeEach(async () => {
  await wipe('admin_attempts');
  await wipe('level_requests');
  await wipe('global_levels');
  await wipe('global_folders');
});

describe('database access rules', () => {
  it('US-022: anyone can read global levels and runs, but nobody can write them directly', async () => {
    await addLevel();
    expect(await anonGet<unknown[]>('global_levels?select=id,name')).toHaveLength(1);
    const ins = await fetch(`${URL_}/rest/v1/global_levels`, {
      method: 'POST', headers: anonHeaders, body: JSON.stringify({ source_id: 'x', name: 'x', data: {}, level_hash: 'abcdef12' }),
    });
    expect(ins.status).toBeGreaterThanOrEqual(401);
    const del = await fetch(`${URL_}/rest/v1/global_levels?id=not.is.null`, { method: 'DELETE', headers: { ...anonHeaders, Prefer: 'return=representation' } });
    expect(del.status).toBeGreaterThanOrEqual(401); // permission denied, not just filtered
    expect(await anonGet<unknown[]>('global_levels?select=id')).toHaveLength(1);
    const attempts = await fetch(`${URL_}/rest/v1/admin_attempts?select=id`, { headers: anonHeaders });
    expect(attempts.status).toBeGreaterThanOrEqual(401);
  });
});

describe('US-021 admin unlock', () => {
  it('US-021: the server checks the password', async () => {
    expect((await api({ action: 'unlock', password: 'wrong' })).status).toBe(401);
    expect((await api({ action: 'unlock', password: PASSWORD })).status).toBe(200);
    expect((await api({ action: 'create-folder', password: 'wrong', name: 'n' })).status).toBe(401);
    expect((await api({ action: 'list-requests', password: 'wrong' })).status).toBe(401);
  });

  it('US-021: five wrong tries lock unlocking out, even with the right password', async () => {
    for (let i = 0; i < 5; i++) expect((await api({ action: 'unlock', password: `bad${i}` })).status).toBe(401);
    const locked = await api({ action: 'unlock', password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(String(locked.body.error)).toMatch(/Too many/);
  });
});

describe('US-046 US-047 submissions and the review queue', () => {
  it('US-046: anyone can submit a playable level with a run that finishes that exact version', async () => {
    const unplayable = ascii(['WWW', 'W.W', 'WWW']);
    const bad = await api({ action: 'submit-level', name: 'n', author: 'KID', level: unplayable, replay: finishingReplay(LEVEL) });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/not playable/);

    // a run of a different version of the level does not count
    const other = ascii(['WWWWWWWWWW', 'W........W', 'W.S...F..W', 'WWWWWWWWWW']);
    const wrong = await api({ action: 'submit-level', name: 'n', author: 'KID', level: LEVEL, replay: finishingReplay(other) });
    expect(wrong.status).toBe(400);
    expect(String(wrong.body.error)).toMatch(/Finish this version/);

    // nor does a run that never reaches the finish
    const rec = new Recorder();
    for (let i = 0; i < 30; i++) rec.push({ bits: IN_RIGHT, ax: 1, ay: 0 });
    const unfinished = await api({ action: 'submit-level', name: 'n', author: 'KID', level: LEVEL, replay: rec.finish(levelHash(LEVEL)) });
    expect(unfinished.status).toBe(400);

    // a name and an author are both needed
    expect((await api({ action: 'submit-level', name: '  ', author: 'KID', level: LEVEL, replay: finishingReplay(LEVEL) })).status).toBe(400);
    expect((await api({ action: 'submit-level', name: 'n', author: '!!', level: LEVEL, replay: finishingReplay(LEVEL) })).status).toBe(400);

    const ok = await api({ action: 'submit-level', name: 'My level', author: 'kid', level: LEVEL, replay: finishingReplay(LEVEL) });
    expect(ok.status).toBe(200);
    // it is waiting, not global yet, and the queue is private
    expect(await anonGet<unknown[]>('global_levels?select=id')).toHaveLength(0);
    const peek = await fetch(`${URL_}/rest/v1/level_requests?select=id`, { headers: anonHeaders });
    expect(peek.ok).toBe(false);
  });

  it('US-046: one address can have at most 10 levels waiting', async () => {
    const replay = finishingReplay(LEVEL);
    for (let i = 0; i < 10; i++) expect((await api({ action: 'submit-level', name: `L${i}`, author: 'KID', level: LEVEL, replay })).status).toBe(200);
    const eleventh = await api({ action: 'submit-level', name: 'L10', author: 'KID', level: LEVEL, replay });
    expect(eleventh.status).toBe(429);
    expect(String(eleventh.body.error)).toMatch(/10 levels waiting/);
  });

  it('US-047: the admin lists requests, approves one to the bottom of the top folder, and rejects another', async () => {
    const first = await addLevel(LEVEL, 'Already there');
    const a = await api({ action: 'submit-level', name: 'Keep me', author: 'kid', level: LEVEL, replay: finishingReplay(LEVEL) });
    const b = await api({ action: 'submit-level', name: 'Not this', author: 'kid', level: LEVEL, replay: finishingReplay(LEVEL) });
    const list = await api({ action: 'list-requests', password: PASSWORD });
    const reqs = list.body.requests as { id: string; name: string; author: string; data: unknown }[];
    expect(reqs.map((r) => [r.name, r.author])).toEqual([['Keep me', 'KID'], ['Not this', 'KID']]);
    // the very same level comes back, enough to draw it and play-test it
    expect(levelHash(parseLevel(reqs[0].data))).toBe(levelHash(LEVEL));

    const approved = await api({ action: 'approve-request', password: PASSWORD, id: a.body.id });
    expect(approved.status).toBe(200);
    expect((await api({ action: 'reject-request', password: PASSWORD, id: b.body.id })).status).toBe(200);
    expect(((await api({ action: 'list-requests', password: PASSWORD })).body.requests as unknown[])).toHaveLength(0);

    const rows = await anonGet<{ id: string; name: string; author: string | null; folder_id: string | null }[]>(
      'global_levels?select=id,name,author,folder_id&order=position.asc',
    );
    expect(rows.map((r) => r.name)).toEqual(['Already there', 'Keep me']);
    expect(rows[1]).toMatchObject({ author: 'KID', folder_id: null });
    expect(await anonGet<unknown[]>(`runs?select=id&level_id=eq.${approved.body.id}`)).toHaveLength(0);
    expect(first).toBe(rows[0].id);
    // approving twice finds nothing
    expect((await api({ action: 'approve-request', password: PASSWORD, id: a.body.id })).status).toBe(404);
  });
});

describe('US-048 global levels cannot be changed', () => {
  it('US-048: there is no upload or update; the admin can rename (leaderboard kept) or delete', async () => {
    const id = await addLevel();
    expect((await api({ action: 'submit', levelId: id, name: 'ACE', replay: finishingReplay(LEVEL) })).status).toBe(200);
    const upload = await api({ action: 'upload', password: PASSWORD, sourceId: 'x', name: 'n', level: LEVEL });
    expect(upload.status).toBe(400);
    expect(String(upload.body.error)).toMatch(/Unknown action/);
    expect((await api({ action: 'rename-level', password: 'wrong', id, name: 'New' })).status).toBe(401);
    expect((await api({ action: 'rename-level', password: PASSWORD, id, name: 'New name' })).status).toBe(200);
    expect(await anonGet<{ name: string }[]>(`global_levels?select=name&id=eq.${id}`)).toEqual([{ name: 'New name' }]);
    expect(await anonGet<unknown[]>(`runs?select=id&level_id=eq.${id}`)).toHaveLength(1);
  });
});

describe('US-024 replay-verified leaderboard', () => {
  it('US-024: the time is worked out by re-running the replay, not taken from the client', async () => {
    const id = await addLevel();
    const replay = finishingReplay(LEVEL);
    const local = runReplay(LEVEL, replay);
    const r = await api({ action: 'submit', levelId: id, name: 'speedy', replay: { ...replay, ticks: 1 } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: 'SPEEDY', ticks: local.ticks, best: local.ticks, rank: 1, improved: true });
    const rows = await anonGet<{ ticks: number }[]>(`runs?select=ticks&level_id=eq.${id}`);
    expect(rows).toEqual([{ ticks: local.ticks }]);
  });

  it('US-024: best run per name is kept; a slower run does not replace it', async () => {
    const id = await addLevel();
    const fast = finishingReplay(LEVEL);
    const slow = finishingReplay(LEVEL, 30);
    expect((await api({ action: 'submit', levelId: id, name: 'ACE', replay: fast })).body.improved).toBe(true);
    const r = await api({ action: 'submit', levelId: id, name: 'ace', replay: slow });
    expect(r.body).toMatchObject({ improved: false, best: runReplay(LEVEL, fast).ticks });
    await api({ action: 'submit', levelId: id, name: 'BOB', replay: slow });
    const rows = await anonGet<{ name: string }[]>(`runs?select=name&level_id=eq.${id}&order=ticks.asc`);
    expect(rows.map((x) => x.name)).toEqual(['ACE', 'BOB']);
  });

  it('US-024: replays that do not finish, are for another version, or are too long are refused', async () => {
    const id = await addLevel();
    const rec = new Recorder();
    for (let i = 0; i < 30; i++) rec.push({ bits: 0, ax: 1, ay: 0 });
    const idle = await api({ action: 'submit', levelId: id, name: 'X', replay: rec.finish(levelHash(LEVEL)) });
    expect(idle.status).toBe(400);
    expect(String(idle.body.error)).toMatch(/does not reach the finish/);

    const other = ascii(['WWWWWWWWWW', 'W........W', 'W.S...F..W', 'WWWWWWWWWW']);
    const wrong = await api({ action: 'submit', levelId: id, name: 'X', replay: finishingReplay(other) });
    expect(wrong.status).toBe(409);

    const long = new Recorder();
    long.push({ bits: 0, ax: 1, ay: 0 });
    const lr = long.finish(levelHash(LEVEL));
    lr.runs[0] = 5 * 60 * 60 + 1;
    const tooLong = await api({ action: 'submit', levelId: id, name: 'X', replay: lr });
    expect(tooLong.status).toBe(400);
    expect(String(tooLong.body.error)).toMatch(/5 minutes/);

    const noName = await api({ action: 'submit', levelId: id, name: '!!!', replay: finishingReplay(LEVEL) });
    expect(noName.status).toBe(400);
  });
});

describe('US-043 folders', () => {
  type Row = { id: string; name: string; folder_id: string | null };
  type F = { id: string; name: string; parent_id: string | null };
  const levelsIn = async (folder: string | null) =>
    (await anonGet<Row[]>(`global_levels?select=id,name,folder_id&order=position.asc&folder_id=${folder ? `eq.${folder}` : 'is.null'}`)).map((r) => r.name);
  const foldersIn = async (folder: string | null) =>
    (await anonGet<F[]>(`global_folders?select=id,name,parent_id&order=position.asc&parent_id=${folder ? `eq.${folder}` : 'is.null'}`)).map((r) => r.name);
  const admin = (body: Record<string, unknown>) => api({ ...body, password: PASSWORD });

  it('US-043: folders nest; levels and folders move in, out, and reorder; a folder cannot go inside itself', async () => {
    const a = await addLevel(LEVEL, 'A');
    const b = await addLevel(LEVEL, 'B');
    const c = await addLevel(LEVEL, 'C');
    const easy = (await admin({ action: 'create-folder', name: 'Easy' })).body.id as string;
    const hard = (await admin({ action: 'create-folder', name: 'Hard' })).body.id as string;
    const harder = (await admin({ action: 'create-folder', name: 'Harder', parent: hard })).body.id as string;
    expect(await foldersIn(null)).toEqual(['Easy', 'Hard']);
    expect(await foldersIn(hard)).toEqual(['Harder']);

    // into a folder, then reorder inside it
    expect((await admin({ action: 'move', kind: 'level', id: a, folder: easy })).status).toBe(200);
    expect((await admin({ action: 'move', kind: 'level', id: c, folder: easy })).status).toBe(200);
    expect(await levelsIn(easy)).toEqual(['A', 'C']);
    await admin({ action: 'move', kind: 'level', id: c, folder: easy, before: a });
    expect(await levelsIn(easy)).toEqual(['C', 'A']);
    expect(await levelsIn(null)).toEqual(['B']);
    // and back out to the top, before B
    await admin({ action: 'move', kind: 'level', id: a, folder: null, before: b });
    expect(await levelsIn(null)).toEqual(['A', 'B']);

    // folders reorder and move too, but never into themselves
    await admin({ action: 'move', kind: 'folder', id: hard, folder: null, before: easy });
    expect(await foldersIn(null)).toEqual(['Hard', 'Easy']);
    const loop = await admin({ action: 'move', kind: 'folder', id: hard, folder: harder });
    expect(loop.status).toBe(400);
    expect(String(loop.body.error)).toMatch(/inside itself/);
    expect((await admin({ action: 'move', kind: 'folder', id: hard, folder: hard })).status).toBe(400);
    expect(await foldersIn(hard)).toEqual(['Harder']);

    // renaming; deleting Hard moves Harder (and anything in Hard) up to the top
    await admin({ action: 'move', kind: 'level', id: b, folder: hard });
    expect((await admin({ action: 'rename-folder', id: easy, name: 'Starter' })).status).toBe(200);
    expect((await admin({ action: 'delete-folder', id: hard })).status).toBe(200);
    expect((await foldersIn(null)).sort()).toEqual(['Harder', 'Starter']);
    expect((await levelsIn(null)).sort()).toEqual(['A', 'B']);
    expect(await levelsIn(easy)).toEqual(['C']);
  });

  it('US-043: only the admin can change folders, through the server', async () => {
    const easy = (await admin({ action: 'create-folder', name: 'Easy' })).body.id as string;
    const id = await addLevel();
    expect((await api({ action: 'move', password: 'nope', kind: 'level', id, folder: easy })).status).toBe(401);
    expect((await api({ action: 'delete-folder', password: 'nope', id: easy })).status).toBe(401);
    for (const fn of ['place_global_item', 'delete_global_folder', 'approve_level_request']) {
      const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: 'POST', headers: anonHeaders, body: JSON.stringify({}) });
      expect(r.ok).toBe(false);
    }
    const ins = await fetch(`${URL_}/rest/v1/global_folders`, { method: 'POST', headers: anonHeaders, body: JSON.stringify({ name: 'x' }) });
    expect(ins.ok).toBe(false);
    const write = await fetch(`${URL_}/rest/v1/global_levels?id=eq.${id}`, { method: 'PATCH', headers: anonHeaders, body: JSON.stringify({ folder_id: easy }) });
    expect(write.ok).toBe(false);
    expect(await levelsIn(null)).toEqual(['Test level']);
  });
});

describe('US-013 verify time budget', () => {
  it('US-013: a run too heavy to re-run in time gets a clear refusal, not a crashed request', { timeout: 20000 }, async () => {
    // eight full dispensers pouring over ramps for four and a half minutes: about 1.5 s to re-run on a dev
    // machine, so far more than the 100 ms local budget however fast the test machine is
    const rows = ['WWWWWWWWWWWWWWWWWWWWWWWW', ...Array.from({ length: 5 }, () => 'W......................W'), 'W.....\\/..\\/..\\/..\\/...W', 'W.S.F..................W', 'WWWWWWWWWWWWWWWWWWWWWWWW'];
    const pours: LevelObject[] = [2, 5, 8, 11, 13, 16, 19, 21].map((cx, i) => ({ id: 0, kind: 'dispenser' as const, x: cx * 32 + 16, y: 48, liquid: i % 2 ? ORANGE : BLUE, channel: 0, defaultOn: true, dir: 1 as const, cap: 200 }));
    const heavy = ascii(rows, pours);
    const sim = new Sim(heavy);
    const rec = new Recorder();
    const push = (bits: number) => {
      rec.push({ bits, ax: 1, ay: 0 });
      sim.step({ bits, ax: 1, ay: 0 });
    };
    push(IN_LEFT);
    for (let i = 0; i < 270 * 60; i++) push(0);
    while (!sim.finished && sim.tick < 299 * 60) push(IN_RIGHT);
    expect(sim.finished).toBe(true);
    const id = await seedLevel(heavy, 'Heavy');
    const r = await api({ action: 'submit', levelId: id, name: 'X', replay: rec.finish(levelHash(heavy)) });
    expect(r.status).toBe(422);
    expect(String(r.body.error)).toMatch(/too long to verify/);
    // and a normal run on the same server is still verified
    expect((await api({ action: 'submit', levelId: await addLevel(), name: 'ACE', replay: finishingReplay(LEVEL) })).status).toBe(200);
  });
});

describe('US-023 admin delete', () => {
  it('US-023: the admin can remove a single entry and a whole level; nobody else can', async () => {
    const id = await addLevel();
    await api({ action: 'submit', levelId: id, name: 'RUDE', replay: finishingReplay(LEVEL) });
    const [run] = await anonGet<{ id: string }[]>(`runs?select=id&level_id=eq.${id}`);
    expect((await api({ action: 'delete-run', password: 'wrong', id: run.id })).status).toBe(401);
    expect((await api({ action: 'delete-run', password: PASSWORD, id: run.id })).status).toBe(200);
    expect(await anonGet<unknown[]>(`runs?select=id&level_id=eq.${id}`)).toHaveLength(0);
    expect((await api({ action: 'delete-level', password: 'wrong', id })).status).toBe(401);
    expect((await api({ action: 'delete-level', password: PASSWORD, id })).status).toBe(200);
    expect(await anonGet<unknown[]>('global_levels?select=id')).toHaveLength(0);
  });
});
