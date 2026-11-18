// Local (this browser) storage for levels and personal best replays.
import { emptyLevel, parseLevel, levelHash, type LevelData } from '../sim/level';
import { parseReplay, type Replay } from '../sim/replay';

export interface LocalLevel {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  data: LevelData;
}

export interface BestRun {
  levelHash: string;
  ticks: number;
  replay: Replay;
}

const INDEX_KEY = '2dholes.levels';
const levelKey = (id: string) => `2dholes.level.${id}`;
const bestKey = (id: string) => `2dholes.best.${id}`;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function ids(): string[] {
  return read<string[]>(INDEX_KEY) ?? [];
}

export function listLevels(): LocalLevel[] {
  const out: LocalLevel[] = [];
  for (const id of ids()) {
    const l = getLevel(id);
    if (l) out.push(l);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getLevel(id: string): LocalLevel | null {
  const l = read<LocalLevel>(levelKey(id));
  if (!l) return null;
  try {
    return { ...l, data: parseLevel(l.data) };
  } catch {
    return null;
  }
}

export function saveLevel(level: LocalLevel): boolean {
  const list = ids();
  if (!list.includes(level.id)) {
    list.push(level.id);
    write(INDEX_KEY, list);
  }
  return write(levelKey(level.id), level);
}

export function createLevel(name: string, data: LevelData = emptyLevel()): LocalLevel {
  const now = new Date().toISOString();
  const level: LocalLevel = { id: newId(), name, createdAt: now, updatedAt: now, data };
  saveLevel(level);
  return level;
}

export function duplicateLevel(id: string): LocalLevel | null {
  const l = getLevel(id);
  if (!l) return null;
  return createLevel(`${l.name} (copy)`, JSON.parse(JSON.stringify(l.data)));
}

export function deleteLevel(id: string): void {
  write(INDEX_KEY, ids().filter((x) => x !== id));
  remove(levelKey(id));
  remove(bestKey(id));
}

/** Best run for the level's current version, or null (old versions don't count). */
export function getBest(id: string, data: LevelData): BestRun | null {
  const b = read<BestRun>(bestKey(id));
  if (!b || b.levelHash !== levelHash(data)) return null;
  try {
    return { ...b, replay: parseReplay(b.replay) };
  } catch {
    return null;
  }
}

/** This browser's best on a global level is kept under its own key, apart from local levels. */
export const globalBestId = (globalId: string) => `global.${globalId}`;

/** The stored best time for a level version, known only by its hash (as the global list gives it). */
export function bestTicksForHash(id: string, hash: string): number | null {
  const b = read<BestRun>(bestKey(id));
  return b && b.levelHash === hash ? b.ticks : null;
}

/** Saves the run if it beats the stored best. Returns true when it is a new best. */
export function offerBest(id: string, data: LevelData, ticks: number, replay: Replay): boolean {
  const cur = getBest(id, data);
  if (cur && cur.ticks <= ticks) return false;
  write(bestKey(id), { levelHash: levelHash(data), ticks, replay } satisfies BestRun);
  return true;
}
