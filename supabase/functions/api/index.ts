// 2dholes server function. Every write to the global levels and leaderboard goes through here.
//   unlock / upload / delete-level / delete-run : need ADMIN_PASSWORD (checked here, never in the page)
//   submit : anyone; the replay is re-run with the game's own physics to work out the time
import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  parseLevel, checkPlayable, levelHash, parseReplay, runReplay, normaliseName, MAX_RUN_TICKS,
} from './_generated/sim.js';

const ADMIN_PASSWORD = Deno.env.get('ADMIN_PASSWORD') ?? '';
const LOCKOUT_MINUTES = 15;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_TOTAL = 50;
const MAX_BODY = 1_000_000;
// Edge functions get 2 s of CPU per request; stop re-running a replay well before that so the
// player gets a clear answer instead of a killed request.
const VERIFY_BUDGET_MS = Number(Deno.env.get('VERIFY_BUDGET_MS') ?? '') || 1500;

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

/** The caller's address as seen by our own proxies (the client cannot set these). */
function clientIp(req: Request): string {
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf;
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',').map((s) => s.trim()).filter(Boolean).pop() ?? 'unknown';
  return 'unknown';
}

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function requireAdmin(req: Request, password: unknown): Promise<void> {
  if (!ADMIN_PASSWORD) throw new HttpError(503, 'Admin is not set up on the server');
  const ip = clientIp(req);
  const since = new Date(Date.now() - LOCKOUT_MINUTES * 60_000).toISOString();
  const [mine, all] = await Promise.all([
    db.from('admin_attempts').select('id', { count: 'exact', head: true }).eq('ok', false).eq('ip', ip).gte('at', since),
    db.from('admin_attempts').select('id', { count: 'exact', head: true }).eq('ok', false).gte('at', since),
  ]);
  if ((mine.count ?? 0) >= MAX_FAILS_PER_IP || (all.count ?? 0) >= MAX_FAILS_TOTAL) {
    throw new HttpError(429, `Too many wrong passwords. Try again in ${LOCKOUT_MINUTES} minutes.`);
  }
  const ok = typeof password === 'string' && (await sameSecret(password, ADMIN_PASSWORD));
  await db.from('admin_attempts').insert({ ip, ok });
  if (!ok) throw new HttpError(401, 'Wrong password');
}

function must<T>(r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new HttpError(500, r.error.message);
  return r.data;
}

async function upload(body: Record<string, unknown>) {
  const sourceId = String(body.sourceId ?? '');
  const name = String(body.name ?? '').trim().slice(0, 60);
  if (!/^[\w-]{1,64}$/.test(sourceId) || !name) throw new HttpError(400, 'Bad level details');
  let level;
  try {
    level = parseLevel(body.level);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const check = checkPlayable(level);
  if (!check.ok) throw new HttpError(400, `Level is not playable: ${check.problems.join(', ')}`);
  const hash = levelHash(level);
  const existing = must(await db.from('global_levels').select('id, level_hash').eq('source_id', sourceId).maybeSingle());
  if (!existing) {
    const row = must(await db.from('global_levels').insert({ source_id: sourceId, name, data: level, level_hash: hash }).select('id').single());
    return { id: row.id, created: true, reset: false };
  }
  const changed = existing.level_hash !== hash;
  must(await db.from('global_levels').update({ name, data: level, level_hash: hash, updated_at: new Date().toISOString() }).eq('id', existing.id).select('id'));
  if (changed) must(await db.from('runs').delete().eq('level_id', existing.id).select('id'));
  return { id: existing.id, created: false, reset: changed };
}

async function submit(body: Record<string, unknown>) {
  const name = normaliseName(String(body.name ?? ''));
  if (!name) throw new HttpError(400, 'Enter a name');
  const levelId = String(body.levelId ?? '');
  const row = must(await db.from('global_levels').select('id, data, level_hash').eq('id', levelId).maybeSingle());
  if (!row) throw new HttpError(404, 'That level is no longer on the global list');
  let replay;
  try {
    replay = parseReplay(body.replay);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  if (replay.level !== row.level_hash) throw new HttpError(409, 'The level has changed since this run was played');
  if (replay.ticks > MAX_RUN_TICKS) throw new HttpError(400, 'Runs longer than 5 minutes are not accepted');
  const result = runReplay(parseLevel(row.data), replay, { ms: VERIFY_BUDGET_MS, now: () => performance.now() });
  if (result.outOfTime) throw new HttpError(422, 'This run is too long to verify on this level. Try a quicker run.');
  if (!result.finished) throw new HttpError(400, 'That replay does not reach the finish');
  const ticks = result.ticks;
  if (ticks > MAX_RUN_TICKS) throw new HttpError(400, 'Runs longer than 5 minutes are not accepted');

  const prev = must(await db.from('runs').select('id, ticks').eq('level_id', levelId).eq('name', name).maybeSingle());
  let improved = false;
  if (!prev) {
    must(await db.from('runs').insert({ level_id: levelId, name, ticks, replay: { ...replay, ticks } }).select('id'));
    improved = true;
  } else if (ticks < prev.ticks) {
    must(await db.from('runs').update({ ticks, replay: { ...replay, ticks }, created_at: new Date().toISOString() }).eq('id', prev.id).select('id'));
    improved = true;
  }
  const best = improved ? ticks : prev!.ticks;
  const ahead = await db.from('runs').select('id', { count: 'exact', head: true }).eq('level_id', levelId).lt('ticks', best);
  return { name, ticks, best, improved, rank: (ahead.count ?? 0) + 1 };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) throw new HttpError(413, 'Too large');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'Bad JSON');
    }
    switch (body.action) {
      case 'unlock':
        await requireAdmin(req, body.password);
        return json(200, { ok: true });
      case 'upload':
        await requireAdmin(req, body.password);
        return json(200, { ok: true, ...(await upload(body)) });
      case 'delete-level':
        await requireAdmin(req, body.password);
        must(await db.from('global_levels').delete().eq('id', String(body.id ?? '')).select('id'));
        return json(200, { ok: true });
      case 'delete-run':
        await requireAdmin(req, body.password);
        must(await db.from('runs').delete().eq('id', String(body.id ?? '')).select('id'));
        return json(200, { ok: true });
      case 'submit':
        return json(200, { ok: true, ...(await submit(body)) });
      default:
        throw new HttpError(400, 'Unknown action');
    }
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    console.error(e);
    return json(500, { error: 'Server error' });
  }
});
