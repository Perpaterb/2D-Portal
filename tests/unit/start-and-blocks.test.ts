import { describe, it, expect } from 'vitest';
import { ascii, run, idle, live } from './helpers';
import { Sim, SIM_VERSION, IN_RIGHT, IN_FIRE_A, IN_USE } from '../../src/sim/sim';
import { Recorder, runReplay, parseReplay } from '../../src/sim/replay';
import { SUB, cellKey } from '../../src/sim/fixed';
import {
  BLUE, ORANGE, WHITE, DARK_WALL, BLUE_BLOCK, ORANGE_BLOCK, WHITE_BLOCK, levelHash, parseLevel,
  type LevelData, type TileKind,
} from '../../src/sim/level';

const right = { bits: IN_RIGHT, ax: 100, ay: 0 };

/** A room with a dispenser pouring and the player in the air, so a running world is easy to spot. */
function busyRoom(): LevelData {
  return ascii(
    ['WWWWWWWWWWWW', 'W..........W', 'W.S........W', 'W..........W', 'W.......F..W', 'WWWWWWWWWWWW'],
    [{ id: 0, kind: 'dispenser', x: 200, y: 48, liquid: BLUE, channel: 0, defaultOn: true, dir: 1, cap: 50 }],
  );
}

describe('US-030 the world waits for the first action', () => {
  it('US-030: idle ticks change nothing: no time, no liquid, no falling', () => {
    const sim = new Sim(busyRoom());
    const before = sim.stateHash();
    run(sim, 300);
    expect(sim.started).toBe(false);
    expect(sim.tick).toBe(0);
    expect(sim.particles.length).toBe(0);
    expect(sim.stateHash()).toBe(before);
  });

  it('US-030: aiming alone does not start it, any action does', () => {
    for (const bits of [IN_RIGHT, IN_FIRE_A, IN_USE]) {
      const sim = new Sim(busyRoom());
      sim.step({ bits: 0, ax: -300, ay: 200 });
      expect(sim.started).toBe(false);
      sim.step({ bits, ax: 50, ay: 0 });
      expect(sim.started).toBe(true);
      expect(sim.tick).toBe(1);
      run(sim, 30);
      expect(sim.tick).toBe(31);
    }
  });

  it('US-030: waiting before starting gives the same run and the same time', () => {
    const play = (wait: number) => {
      const sim = new Sim(busyRoom());
      const rec = new Recorder();
      for (let i = 0; i < wait; i++) {
        rec.push(idle);
        sim.step(idle);
      }
      for (let n = 0; n < 900 && !sim.finished; n++) {
        rec.push(right);
        sim.step(right);
      }
      return { sim, replay: rec.finish(levelHash(busyRoom())) };
    };
    const quick = play(0);
    const slow = play(240);
    expect(quick.sim.finished).toBe(true);
    expect(slow.sim.finishTick).toBe(quick.sim.finishTick);
    expect(slow.sim.stateHash()).toBe(quick.sim.stateHash());
    // and the time worked out from the replay alone matches, idle lead-in or not
    expect(runReplay(busyRoom(), slow.replay).ticks).toBe(quick.sim.finishTick);
  });

  it('US-030: replays from the older physics are refused', () => {
    const rec = new Recorder();
    rec.push(right);
    const old = { ...rec.finish(levelHash(busyRoom())), sim: SIM_VERSION - 1 };
    expect(() => parseReplay(old)).toThrow(/different version of the game physics/);
  });
});

describe('US-033 painted blocks', () => {
  /** A wide room whose floor (row 4) is made of the given tile kind. */
  const floorOf = (kind: TileKind): LevelData => {
    const wall = 'W' + '.'.repeat(38) + 'W';
    const l = ascii(['W'.repeat(40), wall, 'W.S' + '.'.repeat(36) + 'W', wall]);
    for (let cx = 0; cx < 40; cx++) l.tiles.push([cx, 4, kind]);
    return l;
  };

  it('US-033: level files accept the block kinds and the sim turns them into painted dark walls', () => {
    for (const [kind, colour] of [[BLUE_BLOCK, BLUE], [ORANGE_BLOCK, ORANGE], [WHITE_BLOCK, WHITE]] as const) {
      const level = parseLevel(floorOf(kind));
      const sim = new Sim(level);
      const k = cellKey(5, 4);
      expect(sim.tiles.get(k)).toBe(DARK_WALL);
      for (let f = 0; f < 4; f++) expect(sim.paint.get(k * 4 + f)).toBe(colour);
    }
    expect(() => parseLevel({ v: 1, tiles: [[0, 0, 6]], objects: [] })).toThrow(/Bad tile/);
  });

  it('US-033: a blue block floor is slippery like blue paint', () => {
    const slide = (kind: TileKind) => {
      const sim = live(floorOf(kind));
      run(sim, 10);
      run(sim, kind === BLUE_BLOCK ? 120 : 20, right);
      const x0 = sim.player.x;
      run(sim, 30);
      return sim.player.x - x0;
    };
    expect(slide(BLUE_BLOCK)).toBeGreaterThan(slide(DARK_WALL) * 4);
  });

  it('US-033: a white block takes portals, a dark wall does not', () => {
    const shoot = (kind: TileKind) => {
      const sim = live(floorOf(kind));
      run(sim, 10);
      sim.step({ bits: IN_FIRE_A, ax: 0, ay: 100 });
      return sim.portals[0];
    };
    expect(shoot(WHITE_BLOCK)).not.toBeNull();
    expect(shoot(DARK_WALL)).toBeNull();
  });

  it('US-033: liquid paints over a block', () => {
    const level = floorOf(WHITE_BLOCK);
    level.objects.push({ id: 99, kind: 'dispenser', x: 300, y: 48, liquid: BLUE, channel: 0, defaultOn: true, dir: 1, cap: 50 });
    const sim = live(level);
    run(sim, 200);
    expect(sim.paint.get(cellKey(9, 4) * 4 + 3)).toBe(BLUE);
  });
});

describe('US-017 orange keeps all its speed', () => {
  it('US-017: a falling box leaves an orange floor as fast as it hit it', () => {
    const rows = ['WWWWWW', 'W....W', 'W.S..W', ...Array.from({ length: 8 }, () => 'W....W'), 'WWWWWW'];
    const level = ascii(rows, [{ id: 0, kind: 'box', x: 112, y: 3 * 32 }]);
    const sim = live(level);
    for (let cx = 0; cx < 6; cx++) sim.paint.set(cellKey(cx, 11) * 4 + 3, ORANGE);
    let hit = 0;
    let prev = 0;
    for (let i = 0; i < 200 && !hit; i++) {
      prev = sim.boxes[0].vy;
      sim.step(idle);
      if (prev > 0 && sim.boxes[0].vy < 0) hit = prev;
    }
    expect(hit).toBeGreaterThan(4 * SUB);
    // one tick of gravity is applied before the move, so the rebound is the impact speed reversed
    const peaks: number[] = [];
    let wasUp = true;
    let top = sim.boxes[0].y;
    for (let i = 0; i < 400; i++) {
      sim.step(idle);
      const b = sim.boxes[0];
      if (b.vy < 0) {
        wasUp = true;
        top = Math.min(top, b.y);
      } else if (wasUp && b.vy > 0) {
        peaks.push(top);
        wasUp = false;
        top = b.y;
      }
    }
    // it keeps bouncing back to (about) the same height instead of dying away
    expect(peaks.length).toBeGreaterThanOrEqual(3);
    const spread = Math.max(...peaks) - Math.min(...peaks);
    expect(spread).toBeLessThanOrEqual(2 * SUB);
  });
});
