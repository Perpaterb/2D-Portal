import { describe, it, expect } from 'vitest';
import { ascii, run, idle, live } from './helpers';
import { IN_LEFT, IN_RIGHT, IN_JUMP, IN_FIRE_A, GRAVITY, type Sim } from '../../src/sim/sim';
import { SUB, T, cellKey } from '../../src/sim/fixed';
import {
  BLUE, ORANGE, WHITE_WALL, DARK_WALL, BLUE_BLOCK, hypFace, parseLevel, canonicalLevel, type LevelData, type Tile,
} from '../../src/sim/level';

const right = { bits: IN_RIGHT, ax: 100, ay: 0 };
const left = { bits: IN_LEFT, ax: -100, ay: 0 };

/** A floor with a three-cell 45° ramp up to a platform on the right. Start at the bottom left. */
const RAMP = [
  'WWWWWWWWWWWWWWWWWWWW',
  'W..................W',
  'W..................W',
  'W..................W',
  'W........../DDDDDDDW',
  'W........./DDDDDDDDW',
  'W.S....../DDDDDDDDDW',
  'WWWWWWWWWWWWWWWWWWWW',
];
const rampSlopes: [number, number][] = [[9, 6], [10, 5], [11, 4]];

function noOverlap(sim: Sim): void {
  expect(sim.overlapsSolid(sim.player)).toBe(false);
  for (const b of sim.boxes) expect(sim.overlapsSolid(b)).toBe(false);
}

describe('US-038 slopes', () => {
  it('US-038: the player walks up a ramp onto the platform, never sinking into it', () => {
    const sim = live(ascii(RAMP));
    for (let i = 0; i < 200; i++) {
      sim.step(right);
      noOverlap(sim);
    }
    expect(sim.player.y + sim.player.hh).toBe(4 * T);
    expect(sim.player.x).toBeGreaterThan(12 * T);
  });

  it('US-038: walking down a ramp keeps you on it rather than hopping off', () => {
    const level = ascii(RAMP.map((r, i) => (i === 6 ? r.replace('S', '.') : i === 3 ? 'W...............S..W' : r)));
    const sim = live(level);
    run(sim, 20);
    let onRamp = 0;
    let grounded = 0;
    for (let i = 0; i < 200; i++) {
      sim.step(left);
      noOverlap(sim);
      const x = sim.player.x;
      if (x > 9 * T && x < 12 * T) {
        onRamp++;
        if (sim.player.ground) grounded++;
      }
    }
    expect(onRamp).toBeGreaterThan(10);
    expect(grounded).toBe(onRamp);
    expect(sim.player.y + sim.player.hh).toBe(7 * T);
  });

  it('US-038: a box set on a ramp slides down it to the floor', () => {
    const level = ascii(RAMP, [{ id: 0, kind: 'box', x: 11 * 32 + 16, y: 4 * 32 - 2 }]);
    const sim = live(level);
    for (let i = 0; i < 300; i++) {
      sim.step(idle);
      noOverlap(sim);
    }
    const b = sim.boxes[0];
    expect(b.y + b.hh).toBe(7 * T);
    expect(b.x).toBeLessThan(9 * T);
  });

  it('US-038: the player stands still on a plain ramp, and slides down a blue one', () => {
    const settle = (blue: boolean) => {
      const level = ascii(RAMP.map((r, i) => (i === 6 ? r.replace('S', '.') : i === 3 ? 'W..........S.......W' : r)));
      const sim = live(level);
      if (blue) for (const [cx, cy] of rampSlopes) sim.paint.set(cellKey(cx, cy) * 4 + hypFace(1), BLUE);
      run(sim, 30);
      const x0 = sim.player.x;
      run(sim, 90);
      return sim.player.x - x0;
    };
    expect(settle(false)).toBe(0);
    expect(settle(true)).toBeLessThan(-8 * SUB);
  });

  it('US-038: liquid poured on a ramp runs down it', () => {
    const level = ascii(RAMP, [{ id: 0, kind: 'dispenser', x: 11 * 32 + 16, y: 2 * 32, liquid: BLUE, channel: 0, defaultOn: true, dir: 1, cap: 60 }]);
    const sim = live(level);
    // paint it blue first so the pour does not just paint and vanish
    for (const [cx, cy] of rampSlopes) sim.paint.set(cellKey(cx, cy) * 4 + hypFace(1), BLUE);
    run(sim, 400);
    const atFoot = sim.particles.filter((p) => !p.dead && p.x < 9 * T && p.y > 6 * T);
    expect(atFoot.length).toBeGreaterThan(5);
  });

  it('US-038: orange on a 45° floor throws a falling box sideways at full speed', () => {
    const level = ascii(RAMP, [{ id: 0, kind: 'box', x: 10 * 32 + 16, y: 1 * 32 + 24 }]);
    const sim = live(level);
    for (const [cx, cy] of rampSlopes) sim.paint.set(cellKey(cx, cy) * 4 + hypFace(1), ORANGE);
    let impact = 0;
    let thrown = 0;
    for (let i = 0; i < 120 && !thrown; i++) {
      const before = sim.boxes[0].vy;
      sim.step(idle);
      const b = sim.boxes[0];
      if (b.vx < 0) {
        impact = before + GRAVITY;
        thrown = -b.vx;
      }
    }
    expect(impact).toBeGreaterThan(4 * SUB);
    // the face points up-left, so straight down becomes straight left, same speed
    expect(thrown).toBe(impact);
  });

  it('US-038: a slope never lets bodies inside it, whatever the inputs', () => {
    const level = ascii(
      [
        'WWWWWWWWWWWWWWWWWWWW',
        'W..................W',
        'W....\\.......\\....W',
        'W.../D....../D\\...W',
        'W../DD\\..B./DDD\\..W',
        'W./DDDD\\.S/DDDDD\\.W',
        'WWWWWWWWWWWWWWWWWWWW',
      ].map((r) => r.padEnd(20, '.')),
    );
    const sim = live(level);
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    const moves = [IN_LEFT, IN_RIGHT, IN_LEFT | IN_JUMP, IN_RIGHT | IN_JUMP, 0, IN_JUMP];
    for (let i = 0; i < 3000; i++) {
      const bits = moves[rnd() % moves.length];
      for (let k = 0; k < 6; k++) {
        sim.step({ bits, ax: 50, ay: 0 });
        noOverlap(sim);
      }
    }
  });
});

describe('US-038 / US-039 portals and slopes', () => {
  it('US-038: a slope flat side takes a portal like any wall; the sloped face does not (yet)', () => {
    const level = ascii([
      'WWWWWWWWWWWWWW',
      'W............W',
      'W............W',
      'W............W',
      'W............W',
      'W.S..........W',
      'WWWWWWWWWWWWWW',
    ]);
    // a white floor slope rising left (flat side facing left) on a white wall, at x = 9,
    // and above it a white slope whose sloped face looks up-left
    level.tiles.push([9, 5, WHITE_WALL], [9, 4, WHITE_WALL, 2], [9, 3, WHITE_WALL, 1]);
    const sim = live(level);
    run(sim, 10);
    sim.step({ bits: IN_FIRE_A, ax: 300, ay: -40 });
    expect(sim.lastShot?.ok).toBe(true);
    expect(sim.portals[0]).toMatchObject({ cx: 9, cy: 4, n: 2 });
    const sim2 = live(level);
    run(sim2, 10);
    sim2.step({ bits: IN_FIRE_A, ax: 300, ay: -87 });
    expect(sim2.lastShot?.ok).toBe(false);
    expect(sim2.portals[0]).toBeNull();
    // and the shot stopped inside the slope cell, on its sloped face
    expect(Math.floor(sim2.lastShot!.x1 / T)).toBe(9);
    expect(Math.floor(sim2.lastShot!.y1 / T)).toBe(3);
  });
});

describe('US-037 per-side colours', () => {
  const block = (t: Tile): LevelData => {
    const l = ascii(['WWWWWWWWWW', 'W........W', 'W.S......W', 'WWWWWWWWWW']);
    l.tiles.push(t);
    return l;
  };

  it('US-037: a dark block with a white top takes portals on top only; a white wall with a dark side refuses there', () => {
    const sim = live(block([5, 1, DARK_WALL, 0, [0, 0, 0, WHITE_WALL]]));
    expect(sim.isPortalable(5, 1, 3)).toBe(true);
    for (const f of [0, 1, 2]) expect(sim.isPortalable(5, 1, f)).toBe(false);
    const sim2 = live(block([5, 1, WHITE_WALL, 0, [DARK_WALL, 0, 0, 0]]));
    expect(sim2.isPortalable(5, 1, 0)).toBe(false);
    expect(sim2.isPortalable(5, 1, 2)).toBe(true);
  });

  it('US-037: blue and orange sides start painted, and white paint can cover them', () => {
    const sim = live(block([5, 1, DARK_WALL, 0, [BLUE_BLOCK, 0, 0, 0]]));
    const k = cellKey(5, 1);
    expect(sim.paint.get(k * 4 + 0)).toBe(BLUE);
    expect(sim.paint.get(k * 4 + 2)).toBeUndefined();
  });

  it('US-037: sides matching the tile are dropped, so the same look always saves the same way', () => {
    const a = canonicalLevel({ v: 1, tiles: [[0, 0, DARK_WALL, 0, [DARK_WALL, 0, 0, 0]]], objects: [] });
    expect(a.tiles).toEqual([[0, 0, DARK_WALL]]);
    const b = canonicalLevel({ v: 1, tiles: [[0, 0, DARK_WALL, 1, [0, 0, BLUE_BLOCK, BLUE_BLOCK]]], objects: [] });
    // shape 1 looks left and up: only "up" stands for the sloped face, "left" is dropped
    expect(b.tiles).toEqual([[0, 0, DARK_WALL, 1, [0, 0, 0, BLUE_BLOCK]]]);
    expect(() => parseLevel({ v: 1, tiles: [[0, 0, 2, 7]], objects: [] })).toThrow(/shape/);
    expect(() => parseLevel({ v: 1, tiles: [[0, 0, 2, 0, [9, 0, 0, 0]]], objects: [] })).toThrow(/sides/);
  });
});
