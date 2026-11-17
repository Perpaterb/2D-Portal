import { describe, it, expect } from 'vitest';
import {
  teleportAffine, viewAffine, applyAffine, visibleSpans, crossings, orientationAfterTeleport, orientationMatrix,
  screenOffsetToWorld, type SolidFn,
} from '../../src/app/portalview';
import { Sim, makePortal } from '../../src/sim/sim';
import { DX, DY, SUB } from '../../src/sim/fixed';
import { ascii } from './helpers';

const cellsFor = (n: number): [number, number] => [5 + DX[n] * 3, 7 + DY[n] * 3];

describe('US-026 portal view geometry', () => {
  it('US-026: the view transform is the exact inverse of passing through, for every facing pair', () => {
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) {
        const pin = makePortal(...cellsFor(a), a);
        const pout = makePortal(40, -12, b);
        for (const q of [[3, 4], [-50, 77], [210, -33]] as [number, number][]) {
          const back = applyAffine(viewAffine(pin, pout), applyAffine(teleportAffine(pin, pout), q));
          expect(back[0]).toBeCloseTo(q[0], 9);
          expect(back[1]).toBeCloseTo(q[1], 9);
        }
      }
    }
  });

  it('US-026: a point just behind the entry face appears just in front of the exit face', () => {
    const pin = makePortal(0, 0, 0); // faces right, plane x = 32, span y 0..64
    const pout = makePortal(20, 5, 3); // floor facing up, plane y = 160, span x 640..704
    const [x, y] = applyAffine(teleportAffine(pin, pout), [30, 32]); // 2 px behind, centred
    expect(x).toBeCloseTo(672);
    expect(y).toBeCloseTo(160 - 2);
  });

  const open: SolidFn = () => false;

  it('US-026: an open line of sight sees the whole mouth; an eye behind the face sees nothing', () => {
    const p = makePortal(0, 0, 0); // plane x = 32, mouth y 0..64; spans run -32..32 from its centre
    const spans = visibleSpans(open, [200, 32], p);
    expect(spans).toHaveLength(1);
    expect(spans[0][0]).toBeCloseTo(-32);
    expect(spans[0][1]).toBeCloseTo(32);
    expect(visibleSpans(open, [10, 32], p)).toEqual([]);
  });

  it('US-026: walls between the head and the portal block part of the view', () => {
    const p = makePortal(0, 0, 0); // plane x = 32, mouth y 0..64
    // a wall block at cell (3, 0): covers y 0..32 between the eye and the upper half
    const solid: SolidFn = (cx, cy) => cx === 3 && cy === 0;
    const spans = visibleSpans(solid, [200, 40], p);
    expect(spans).toHaveLength(1);
    expect(spans[0][0]).toBeGreaterThan(20 - 32);
    expect(spans[0][1]).toBeCloseTo(32);
    // fully blocked
    expect(visibleSpans((cx) => cx === 3, [200, 40], p)).toEqual([]);
  });
});

describe('US-027 seamless passing through', () => {
  it('US-027: a body part-way into a portal is reported as crossing; one in the open is not', () => {
    const sim = new Sim(ascii(['WWWWWWWW', 'W......W', 'W......W', 'W.S....W', 'WWWWWWWW']));
    sim.portals[0] = makePortal(0, 2, 0); // left wall, plane x = 32, span y 64..128
    sim.portals[1] = makePortal(7, 2, 2);
    sim.player.x = 36 * SUB; // centre 4 px in front, 5 px of the body behind the face
    expect(crossings(sim, [sim.player]).map((c) => c.pin)).toEqual([sim.portals[0]]);
    sim.player.x = 100 * SUB;
    expect(crossings(sim, [sim.player])).toEqual([]);
  });

  it('US-027: after passing through, the turned view keeps the motion going the same way on screen', () => {
    const mul = (m: number[], v: number[]) => [m[0] * v[0] + m[1] * v[1], m[2] * v[0] + m[3] * v[1]];
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) {
        const o = orientationAfterTeleport({ angle: 0, sx: 1 }, 2 * a, 2 * b); // flat facings are even 45° steps
        const before = [-DX[a], -DY[a]]; // moving into the entry, upright camera
        const after = mul(orientationMatrix(o), [DX[b], DY[b]]); // moving out of the exit
        expect(after[0]).toBeCloseTo(before[0], 9);
        expect(after[1]).toBeCloseTo(before[1], 9);
      }
    }
  });

  it('US-027: aim maps screen offsets back to world offsets under a turned or flipped view', () => {
    for (const o of [{ angle: 0, sx: 1 }, { angle: Math.PI / 2, sx: 1 }, { angle: 1.1, sx: -1 }, { angle: Math.PI, sx: -1 }]) {
      const world = [37, -21];
      const m = orientationMatrix(o);
      const zoom = 1.4;
      const screen = [zoom * (m[0] * world[0] + m[1] * world[1]), zoom * (m[2] * world[0] + m[3] * world[1])];
      const back = screenOffsetToWorld(screen[0], screen[1], zoom, o);
      expect(back[0]).toBeCloseTo(world[0], 9);
      expect(back[1]).toBeCloseTo(world[1], 9);
    }
  });
});
