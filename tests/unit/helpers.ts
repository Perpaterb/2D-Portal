import { WHITE_WALL, DARK_WALL, type LevelData, type LevelObject, type TileKind } from '../../src/sim/level';
import { Sim, type TickInput } from '../../src/sim/sim';
import { SUB, TILE_PX } from '../../src/sim/fixed';

/** Builds a level from ASCII art. One char per cell:
 *  W white wall, D dark wall, S start, F finish, B box, . empty.
 *  The row/column of each char is its cell coordinate. */
export function ascii(rows: string[], extra: LevelObject[] = []): LevelData {
  const tiles: [number, number, TileKind][] = [];
  const objects: LevelObject[] = [];
  let id = 1;
  rows.forEach((row, cy) => {
    [...row].forEach((ch, cx) => {
      const bx = cx * TILE_PX + TILE_PX / 2;
      const by = (cy + 1) * TILE_PX;
      if (ch === 'W') tiles.push([cx, cy, WHITE_WALL]);
      else if (ch === 'D') tiles.push([cx, cy, DARK_WALL]);
      else if (ch === 'S') objects.push({ id: id++, kind: 'start', x: bx, y: by });
      else if (ch === 'F') objects.push({ id: id++, kind: 'finish', x: bx, y: by });
      else if (ch === 'B') objects.push({ id: id++, kind: 'box', x: bx, y: by });
    });
  });
  for (const o of extra) objects.push({ ...o, id: id++ } as LevelObject);
  return { v: 1, tiles, objects };
}

export const idle: TickInput = { bits: 0, ax: 1, ay: 0 };

export function run(sim: Sim, ticks: number, inp: TickInput = idle): void {
  for (let i = 0; i < ticks; i++) sim.step(inp);
}

export function px(sub: number): number {
  return sub / SUB;
}

/** cell coordinate of the body centre */
export function cellOf(sim: Sim): [number, number] {
  return [Math.floor(sim.player.x / SUB / TILE_PX), Math.floor(sim.player.y / SUB / TILE_PX)];
}
