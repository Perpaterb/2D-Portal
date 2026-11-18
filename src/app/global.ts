// Talks to the Supabase backend: public reads straight from the database (read-only by
// row-level security), and every write through the `api` server function.
import { parseLevel, type LevelData } from '../sim/level';
import { parseReplay, type Replay } from '../sim/replay';
import { TOP_COUNT } from '../sim/names';

// the project URL, accepted with or without a trailing /rest/v1 (as the dashboard sometimes shows it)
const BASE = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '') ?? '';
const KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '';

export const globalEnabled = !!(BASE && KEY);

export interface GlobalLevel {
  id: string;
  source_id: string;
  name: string;
  level_hash: string;
  updated_at: string;
}

export interface RunRow {
  id: string;
  name: string;
  ticks: number;
  created_at: string;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { apikey: KEY, 'Content-Type': 'application/json' };
  // legacy anon keys are JWTs and also go in Authorization; new publishable keys do not
  if (KEY.startsWith('eyJ')) h.Authorization = `Bearer ${KEY}`;
  return h;
}

async function rest<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}/rest/v1/${path}`, { headers: headers() });
  if (!r.ok) throw new Error(`Could not reach the global levels server (${r.status})`);
  return (await r.json()) as T;
}

async function api<T>(body: Record<string, unknown>): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${BASE}/functions/v1/api`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  } catch {
    throw new Error('Could not reach the global levels server');
  }
  const out = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(out.error ?? `Server error (${r.status})`);
  return out as T;
}

export function listGlobalLevels(): Promise<GlobalLevel[]> {
  return rest('global_levels?select=id,source_id,name,level_hash,updated_at&order=position.asc');
}

export async function getGlobalLevelData(id: string): Promise<LevelData> {
  const rows = await rest<{ data: unknown }[]>(`global_levels?select=data&id=eq.${encodeURIComponent(id)}`);
  if (!rows.length) throw new Error('That level is no longer on the global list');
  return parseLevel(rows[0].data);
}

export function topRuns(levelId: string, limit = TOP_COUNT): Promise<RunRow[]> {
  return rest(`runs?select=id,name,ticks,created_at&level_id=eq.${encodeURIComponent(levelId)}&order=ticks.asc,created_at.asc&limit=${limit}`);
}

export async function getRunReplay(runId: string): Promise<Replay> {
  const rows = await rest<{ replay: unknown }[]>(`runs?select=replay&id=eq.${encodeURIComponent(runId)}`);
  if (!rows.length) throw new Error('That run is no longer on the leaderboard');
  return parseReplay(rows[0].replay);
}

export interface SubmitResult {
  name: string;
  ticks: number;
  best: number;
  improved: boolean;
  rank: number;
}

export function submitRun(levelId: string, name: string, replay: Replay): Promise<SubmitResult> {
  return api({ action: 'submit', levelId, name, replay });
}

// ---------------------------------------------------------------- admin

const ADMIN_KEY = '2dholes.admin';

export function adminPassword(): string | null {
  try {
    return sessionStorage.getItem(ADMIN_KEY);
  } catch {
    return null;
  }
}

export function isAdmin(): boolean {
  return !!adminPassword();
}

/** Asks the server to check the password; remembered for this tab only. */
export async function unlockAdmin(password: string): Promise<void> {
  await api({ action: 'unlock', password });
  try {
    sessionStorage.setItem(ADMIN_KEY, password);
  } catch {
    /* storage blocked: admin stays locked */
  }
}

export function lockAdmin(): void {
  try {
    sessionStorage.removeItem(ADMIN_KEY);
  } catch {
    /* ignore */
  }
}

async function adminCall<T>(body: Record<string, unknown>): Promise<T> {
  const password = adminPassword();
  if (!password) throw new Error('Unlock admin first');
  try {
    return await api<T>({ ...body, password });
  } catch (e) {
    if ((e as Error).message === 'Wrong password') lockAdmin();
    throw e;
  }
}

export function uploadLevel(sourceId: string, name: string, level: LevelData): Promise<{ id: string; created: boolean; reset: boolean }> {
  return adminCall({ action: 'upload', sourceId, name, level });
}

export function deleteGlobalLevel(id: string): Promise<void> {
  return adminCall({ action: 'delete-level', id });
}

/** Moves a global level one place up (-1) or down (+1) the list everyone sees. */
export function moveGlobalLevel(id: string, step: -1 | 1): Promise<{ moved: boolean }> {
  return adminCall({ action: 'move-level', id, step });
}

export function deleteRun(id: string): Promise<void> {
  return adminCall({ action: 'delete-run', id });
}
