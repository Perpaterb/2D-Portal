import { describe, it, expect, beforeEach } from 'vitest';
import { ascii } from '../unit/helpers';
import { Sim, IN_RIGHT } from '../../src/sim/sim';
import { Recorder, runReplay, type Replay } from '../../src/sim/replay';
import { levelHash, type LevelData } from '../../src/sim/level';

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

async function addLevel(sourceId = 'src-1', level = LEVEL, name = 'Test level'): Promise<string> {
  const r = await api({ action: 'upload', password: PASSWORD, sourceId, name, level });
  expect(r.status).toBe(200);
  return r.body.id as string;
}

beforeEach(async () => {
  await wipe('admin_attempts');
  await wipe('global_levels');
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

describe('US-021 admin unlock and upload', () => {
  it('US-021: the server checks the password', async () => {
    expect((await api({ action: 'unlock', password: 'wrong' })).status).toBe(401);
    expect((await api({ action: 'unlock', password: PASSWORD })).status).toBe(200);
    expect((await api({ action: 'upload', password: 'wrong', sourceId: 'a', name: 'n', level: LEVEL })).status).toBe(401);
  });

  it('US-021: five wrong tries lock unlocking out, even with the right password', async () => {
    for (let i = 0; i < 5; i++) expect((await api({ action: 'unlock', password: `bad${i}` })).status).toBe(401);
    const locked = await api({ action: 'unlock', password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(String(locked.body.error)).toMatch(/Too many/);
  });

  it('US-021: only playable levels can be added', async () => {
    const r = await api({ action: 'upload', password: PASSWORD, sourceId: 'a', name: 'n', level: ascii(['WWW', 'W.W', 'WWW']) });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/not playable/);
  });

  it('US-021: updating keeps the leaderboard if nothing changed, and resets it when the level changed', async () => {
    const id = await addLevel();
    expect((await api({ action: 'submit', levelId: id, name: 'ACE', replay: finishingReplay(LEVEL) })).status).toBe(200);
    const same = await api({ action: 'upload', password: PASSWORD, sourceId: 'src-1', name: 'Renamed', level: LEVEL });
    expect(same.body).toMatchObject({ id, created: false, reset: false });
    expect(await anonGet<unknown[]>(`runs?select=id&level_id=eq.${id}`)).toHaveLength(1);
    const changed = { ...LEVEL, tiles: [...LEVEL.tiles, [5, 0, 2] as [number, number, 2]] };
    const upd = await api({ action: 'upload', password: PASSWORD, sourceId: 'src-1', name: 'Renamed', level: changed });
    expect(upd.body).toMatchObject({ id, created: false, reset: true });
    expect(await anonGet<unknown[]>(`runs?select=id&level_id=eq.${id}`)).toHaveLength(0);
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
