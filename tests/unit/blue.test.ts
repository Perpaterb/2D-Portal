import { describe, it, expect } from 'vitest';
import { ascii, run, live } from './helpers';
import { Sim, IN_RIGHT, RUN_SPEED, MAX_SPEED, SIM_VERSION } from '../../src/sim/sim';
import { Recorder, runReplay, parseReplay } from '../../src/sim/replay';
import { BLUE, BLUE_BLOCK, DARK_WALL, ORANGE, levelHash, levelUsesBlue, type LevelData, type TileKind } from '../../src/sim/level';

const right = { bits: IN_RIGHT, ax: 100, ay: 0 };

/** A very long room whose floor (row 4) is the given kind from x = 0 to `upTo`, dark after. */
function track(kind: TileKind, upTo = 600): LevelData {
  const w = 700;
  const l = ascii(['W'.repeat(w), 'W' + '.'.repeat(w - 2) + 'W', 'W.S' + '.'.repeat(w - 4) + 'W', 'W' + '.'.repeat(w - 2) + 'W']);
  for (let cx = 0; cx < w; cx++) l.tiles.push([cx, 4, cx < upTo ? kind : DARK_WALL]);
  return l;
}

describe('US-050 blue builds speed', () => {
  it('US-050: holding a direction on blue keeps speeding up past run speed, to the cap and no further', () => {
    const sim = live(track(BLUE_BLOCK));
    run(sim, 10);
    let top = 0;
    let atRun = -1;
    for (let i = 0; i < 500; i++) {
      sim.step(right);
      top = Math.max(top, sim.player.vx);
      if (atRun < 0 && sim.player.vx >= RUN_SPEED) atRun = i;
      expect(sim.player.vx).toBeLessThanOrEqual(MAX_SPEED);
    }
    expect(atRun).toBeGreaterThan(0);
    expect(top).toBe(MAX_SPEED);
    // the same on a dark floor stops at run speed
    const dark = live(track(DARK_WALL));
    run(dark, 10);
    let darkTop = 0;
    for (let i = 0; i < 500; i++) {
      dark.step(right);
      darkTop = Math.max(darkTop, dark.player.vx);
    }
    expect(darkTop).toBe(RUN_SPEED);
  });

  it('US-050: off the end of the blue, normal ground bleeds the extra speed off gently', () => {
    const sim = live(track(BLUE_BLOCK, 330));
    run(sim, 10);
    let fast = 0;
    while (sim.player.x < 330 * 32 * 256) {
      sim.step(right);
      fast = sim.player.vx;
    }
    expect(fast).toBeGreaterThan(3 * RUN_SPEED);
    sim.step(right);
    const next = sim.player.vx;
    expect(next).toBeLessThan(fast);
    expect(fast - next).toBeLessThanOrEqual(24 + 1); // gently, not a stop
    run(sim, 400, right);
    expect(sim.player.vx).toBe(RUN_SPEED);
  });

  it('US-050: what can make blue: a blue block, a blue side, or a blue dispenser', () => {
    const base = ascii(['WWWW', 'W.SW', 'WWWW']);
    expect(levelUsesBlue(base)).toBe(false);
    expect(levelUsesBlue({ ...base, tiles: [...base.tiles, [9, 9, BLUE_BLOCK]] })).toBe(true);
    expect(levelUsesBlue({ ...base, tiles: [...base.tiles, [9, 9, DARK_WALL, 0, [0, BLUE_BLOCK, 0, 0]]] })).toBe(true);
    const pour = (liquid: number) => ({ ...base, objects: [...base.objects, { id: 9, kind: 'dispenser' as const, x: 50, y: 40, liquid, channel: 0, defaultOn: true, dir: 1, cap: 10 }] }) as LevelData;
    expect(levelUsesBlue(pour(BLUE))).toBe(true);
    expect(levelUsesBlue(pour(ORANGE))).toBe(false);
  });

  it('US-050: older-physics runs still play on levels without blue, and are refused on levels with it', () => {
    const record = (level: LevelData) => {
      const sim = new Sim(level);
      const rec = new Recorder();
      for (let i = 0; i < 400 && !sim.finished; i++) {
        rec.push(right);
        sim.step(right);
      }
      return { replay: rec.finish(levelHash(level)), ticks: sim.finishTick };
    };
    const plain = ascii(['WWWWWWWWWW', 'W........W', 'W.S....F.W', 'WWWWWWWWWW']);
    const { replay, ticks } = record(plain);
    const old = { ...replay, sim: SIM_VERSION - 1 };
    expect(parseReplay(old, plain).sim).toBe(SIM_VERSION - 1);
    expect(runReplay(plain, old).ticks).toBe(ticks);
    expect(runReplay(plain, old)).toEqual(runReplay(plain, replay));
    // without the level to check against, only the current version is accepted
    expect(() => parseReplay(old)).toThrow(/different version of the game physics/);

    const blue = ascii(['WWWWWWWWWW', 'W........W', 'W.S....F.W', 'WWWWWWWWWW']);
    blue.tiles.push([4, 0, BLUE_BLOCK]);
    const b = record(blue);
    const oldBlue = { ...b.replay, sim: SIM_VERSION - 1 };
    expect(() => parseReplay(oldBlue, blue)).toThrow(/different version of the game physics/);
    expect(() => runReplay(blue, oldBlue)).toThrow(/different version of the game physics/);
    // and versions that never existed are refused everywhere
    expect(() => parseReplay({ ...replay, sim: 1 }, plain)).toThrow(/different version/);
  });
});
