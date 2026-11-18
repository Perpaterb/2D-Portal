import { describe, it, expect } from 'vitest';
import { ascii, run, idle, live } from './helpers';
import { IN_FIRE_A, makePortal, makeDiagonalPortal, isDiagonal, type Sim } from '../../src/sim/sim';
import { SUB, T } from '../../src/sim/fixed';
import { WHITE_WALL, DARK_WALL, type LevelData, type TileKind } from '../../src/sim/level';
import { teleportAffine, viewAffine, applyAffine, orientationAfterTeleport, orientationMatrix } from '../../src/app/portalview';

/**
 * A room with a white 45° ramp rising right at (9,6), (10,5), (11,4) on a dark fill.
 * The diagonal portal on (9,6) + (10,5) is centred on the grid corner (10T, 6T).
 */
function rampRoom(colour: TileKind = WHITE_WALL): LevelData {
  const l = ascii([
    'WWWWWWWWWWWWWWWWWWWW',
    'W..................W',
    'W..................W',
    'W..................W',
    'W...........DDDDDDDW',
    'W...........DDDDDDDW',
    'W.S.......DDDDDDDDDW',
    'WWWWWWWWWWWWWWWWWWWW',
  ]);
  l.tiles.push([9, 6, colour, 1], [10, 5, colour, 1], [11, 4, colour, 1]);
  return l;
}

const speed = (b: { vx: number; vy: number }) => Math.hypot(b.vx, b.vy);

function noOverlap(sim: Sim): void {
  expect(sim.overlapsSolid(sim.player)).toBe(false);
}

describe('US-039 diagonal portals', () => {
  it('US-039: a shot on the white sloped faces of two slopes in a line opens a diagonal portal there', () => {
    const sim = live(rampRoom());
    run(sim, 20);
    // nearly level, onto the middle of the first slope's face (x + y = 512 px there)
    sim.step({ bits: IN_FIRE_A, ax: 230, ay: -1 });
    expect(sim.lastShot?.ok).toBe(true);
    const p = sim.portals[0]!;
    expect(isDiagonal(p)).toBe(true);
    expect([p.px, p.py]).toEqual([10 * T, 6 * T]);
    // dark slopes refuse it
    const dark = live(rampRoom(DARK_WALL));
    run(dark, 20);
    dark.step({ bits: IN_FIRE_A, ax: 230, ay: -1 });
    expect(dark.lastShot?.ok).toBe(false);
    expect(dark.portals[0]).toBeNull();
  });

  it('US-039: one slope on its own is too short for a portal', () => {
    const l = rampRoom();
    l.tiles = l.tiles.filter((t) => !(t[0] === 10 && t[1] === 5) && !(t[0] === 11 && t[1] === 4));
    l.tiles.push([10, 5, DARK_WALL, 1], [11, 4, DARK_WALL, 1]);
    const sim = live(l);
    run(sim, 20);
    sim.step({ bits: IN_FIRE_A, ax: 230, ay: 2 });
    expect(sim.portals[0]).toBeNull();
  });

  it('US-039: falling onto a diagonal portal comes out of a wall portal, turned 45°, at the same speed', () => {
    const sim = live(rampRoom());
    sim.portals[0] = makeDiagonalPortal(9, 6, 1);
    sim.portals[1] = makePortal(0, 2, 0); // left wall, facing right
    sim.player.x = 10 * T;
    sim.player.y = 1 * T + sim.player.hh;
    let before = 0;
    for (let i = 0; i < 120 && sim.player.teleports === 0; i++) {
      before = speed(sim.player);
      sim.step(idle);
      noOverlap(sim);
    }
    expect(sim.player.teleports).toBe(1);
    const p = sim.player;
    // into the portal was down-right; straight down comes out turned 45°: right and down
    expect(p.vx).toBeGreaterThan(0);
    expect(p.vy).toBeGreaterThan(0);
    // speed kept to within rounding (and the gravity of the one tick)
    expect(Math.abs(speed(p) - before)).toBeLessThan(2 * 96 + 8);
    expect(p.x).toBeGreaterThanOrEqual(1 * T);
    for (let i = 0; i < 60; i++) {
      sim.step(idle);
      noOverlap(sim);
    }
  });

  it('US-039: falling into a floor portal shoots you out of the diagonal one, up and away from the ramp', () => {
    const sim = live(rampRoom());
    sim.portals[0] = makePortal(3, 7, 3); // in the floor (row 7) under x = 3..4, facing up
    sim.portals[1] = makeDiagonalPortal(9, 6, 1);
    sim.player.x = 4 * T;
    sim.player.y = 2 * T;
    let before = 0;
    for (let i = 0; i < 120 && sim.player.teleports === 0; i++) {
      before = speed(sim.player);
      sim.step(idle);
      noOverlap(sim);
    }
    expect(sim.player.teleports).toBe(1);
    const p = sim.player;
    // out of an up-left facing portal: up and to the left, equally
    expect(p.vx).toBeLessThan(0);
    expect(p.vy).toBeLessThan(0);
    expect(Math.abs(Math.abs(p.vx) - Math.abs(p.vy))).toBeLessThanOrEqual(2);
    expect(Math.abs(speed(p) - before)).toBeLessThan(2 * 96 + 8);
    // and it carries on out into the room without sticking in the ramp
    const x0 = p.x;
    for (let i = 0; i < 10; i++) {
      sim.step(idle);
      noOverlap(sim);
    }
    expect(p.x).toBeLessThan(x0);
  });

  it('US-039: a slightly off-centre fall is pulled into a diagonal portal by magnetism', () => {
    const fall = (magnetism: boolean) => {
      const sim = live(rampRoom());
      sim.portals[0] = makeDiagonalPortal(9, 6, 1);
      sim.portals[1] = makePortal(0, 2, 0);
      sim.player.x = 10 * T + 14 * SUB;
      sim.player.y = 1 * T;
      if (!magnetism) sim.magnetise = () => undefined;
      for (let i = 0; i < 120 && sim.player.teleports === 0; i++) sim.step(idle);
      return sim.player.teleports;
    };
    expect(fall(false)).toBe(0); // the test can fail: without the pull this fall misses the mouth
    expect(fall(true)).toBe(1);
  });

  it('US-039: seeing through is the exact inverse of passing through, for diagonal portals too', () => {
    const portals = [makePortal(5, 7, 0), makePortal(40, -12, 3), makeDiagonalPortal(9, 6, 1), makeDiagonalPortal(-4, 2, 3), makeDiagonalPortal(20, 20, 2)];
    for (const pin of portals) {
      for (const pout of portals) {
        if (pin === pout) continue;
        for (const q of [[3, 4], [-50, 77], [210, -33]] as [number, number][]) {
          const back = applyAffine(viewAffine(pin, pout), applyAffine(teleportAffine(pin, pout), q));
          expect(back[0]).toBeCloseTo(q[0], 2);
          expect(back[1]).toBeCloseTo(q[1], 2);
        }
      }
    }
  });

  it('US-039: after a 45° pass the turned view keeps the motion going the same way on screen', () => {
    const mul = (m: number[], v: number[]) => [m[0] * v[0] + m[1] * v[1], m[2] * v[0] + m[3] * v[1]];
    const dir = (a: number) => [Math.cos((a * Math.PI) / 4), Math.sin((a * Math.PI) / 4)];
    for (let a = 0; a < 8; a++) {
      for (let b = 0; b < 8; b++) {
        const o = orientationAfterTeleport({ angle: 0, sx: 1 }, a, b);
        const before = dir(a).map((v) => -v);
        const after = mul(orientationMatrix(o), dir(b));
        expect(after[0]).toBeCloseTo(before[0], 3);
        expect(after[1]).toBeCloseTo(before[1], 3);
      }
    }
  });
});
