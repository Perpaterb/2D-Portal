// Level data format. Pure data, shared by the editor, the game and (later) the server.
import { Hasher } from './fixed';

export const WHITE_WALL = 1;
export const DARK_WALL = 2;
/** Dark walls that start covered in paint on every face (liquid = kind - 2). */
export const BLUE_BLOCK = 3;
export const ORANGE_BLOCK = 4;
export const WHITE_BLOCK = 5;
export type TileKind = typeof WHITE_WALL | typeof DARK_WALL | typeof BLUE_BLOCK | typeof ORANGE_BLOCK | typeof WHITE_BLOCK;
export const TILE_KINDS: readonly TileKind[] = [WHITE_WALL, DARK_WALL, BLUE_BLOCK, ORANGE_BLOCK, WHITE_BLOCK];

/** The paint a tile kind starts with, or 0 for plain walls. */
export function blockPaint(kind: TileKind): number {
  return kind >= BLUE_BLOCK ? kind - 2 : 0;
}

// Liquid / paint colours
export const BLUE = 1;
export const ORANGE = 2;
export const WHITE = 3;
export type Liquid = typeof BLUE | typeof ORANGE | typeof WHITE;

export const CHANNEL_COUNT = 8;
export const DEFAULT_CAP = 150;
export const MIN_CAP = 10;
export const MAX_CAP = 400;

// Object anchors are integer pixels. For start/finish/box/plate the anchor is the
// bottom-centre (feet on the floor); for dispensers it is the centre.
export interface StartObj { id: number; kind: 'start'; x: number; y: number }
export interface FinishObj { id: number; kind: 'finish'; x: number; y: number }
export interface BoxObj { id: number; kind: 'box'; x: number; y: number }
export interface PlateObj { id: number; kind: 'plate'; x: number; y: number; channel: number }
export interface DoorObj { id: number; kind: 'door'; cx: number; cy: number; channel: number }
export interface DispenserObj {
  id: number;
  kind: 'dispenser';
  x: number;
  y: number;
  liquid: Liquid;
  channel: number;
  defaultOn: boolean;
  dir: number; // 0 right, 1 down, 2 left, 3 up
  cap: number;
}
export type LevelObject = StartObj | FinishObj | BoxObj | PlateObj | DoorObj | DispenserObj;
export type ObjectKind = LevelObject['kind'];

export interface LevelData {
  v: 1;
  /** [cx, cy, kind] */
  tiles: [number, number, TileKind][];
  objects: LevelObject[];
}

export function emptyLevel(): LevelData {
  return { v: 1, tiles: [], objects: [] };
}

export interface PlayableCheck {
  ok: boolean;
  problems: string[];
}

export function checkPlayable(level: LevelData): PlayableCheck {
  const problems: string[] = [];
  const starts = level.objects.filter((o) => o.kind === 'start').length;
  const finishes = level.objects.filter((o) => o.kind === 'finish').length;
  if (starts === 0) problems.push('Add a start');
  if (starts > 1) problems.push('Only one start is allowed');
  if (finishes === 0) problems.push('Add at least one finish');
  return { ok: problems.length === 0, problems };
}

/** Canonical form: tiles sorted, objects sorted by id, keys in a fixed order. */
export function canonicalLevel(level: LevelData): LevelData {
  const tiles = [...level.tiles]
    .map((t) => [t[0], t[1], t[2]] as [number, number, TileKind])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const objects = [...level.objects].sort((a, b) => a.id - b.id).map(canonicalObject);
  return { v: 1, tiles, objects };
}

function canonicalObject(o: LevelObject): LevelObject {
  switch (o.kind) {
    case 'start':
    case 'finish':
    case 'box':
      return { id: o.id, kind: o.kind, x: o.x, y: o.y } as LevelObject;
    case 'plate':
      return { id: o.id, kind: 'plate', x: o.x, y: o.y, channel: o.channel };
    case 'door':
      return { id: o.id, kind: 'door', cx: o.cx, cy: o.cy, channel: o.channel };
    case 'dispenser':
      return {
        id: o.id,
        kind: 'dispenser',
        x: o.x,
        y: o.y,
        liquid: o.liquid,
        channel: o.channel,
        defaultOn: o.defaultOn,
        dir: o.dir,
        cap: o.cap,
      };
  }
}

/** Identifies an exact level version. Replays are only valid for the hash they were recorded on. */
export function levelHash(level: LevelData): string {
  return new Hasher().str(JSON.stringify(canonicalLevel(level))).hex();
}

const KINDS: ObjectKind[] = ['start', 'finish', 'box', 'plate', 'door', 'dispenser'];

function isInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && Math.abs(n) < 2 ** 30;
}

/** Validates untrusted level JSON (files, server data). Throws on anything malformed. */
export function parseLevel(raw: unknown): LevelData {
  const r = raw as LevelData;
  if (!r || r.v !== 1 || !Array.isArray(r.tiles) || !Array.isArray(r.objects)) throw new Error('Not a 2dholes level');
  for (const t of r.tiles) {
    if (!Array.isArray(t) || !isInt(t[0]) || !isInt(t[1]) || !TILE_KINDS.includes(t[2])) {
      throw new Error('Bad tile');
    }
  }
  const ids = new Set<number>();
  for (const o of r.objects) {
    if (!o || !KINDS.includes(o.kind) || !isInt(o.id) || ids.has(o.id)) throw new Error('Bad object');
    ids.add(o.id);
    if (o.kind === 'door') {
      if (!isInt(o.cx) || !isInt(o.cy) || !isInt(o.channel)) throw new Error('Bad door');
    } else if (!isInt(o.x) || !isInt(o.y)) throw new Error('Bad object position');
    if ((o.kind === 'plate' || o.kind === 'door' || o.kind === 'dispenser') && (o.channel < 0 || o.channel >= CHANNEL_COUNT)) {
      throw new Error('Bad channel');
    }
    if (o.kind === 'dispenser') {
      if (![BLUE, ORANGE, WHITE].includes(o.liquid) || typeof o.defaultOn !== 'boolean' || !isInt(o.dir) || o.dir < 0 || o.dir > 3) {
        throw new Error('Bad dispenser');
      }
      if (!isInt(o.cap) || o.cap < MIN_CAP || o.cap > MAX_CAP) throw new Error('Bad dispenser cap');
    }
  }
  return canonicalLevel(r);
}
