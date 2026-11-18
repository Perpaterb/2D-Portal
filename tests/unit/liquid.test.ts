import { describe, it, expect } from 'vitest';
import { ascii, run, live } from './helpers';
import { LEVEL_LIQUID_CAP } from '../../src/sim/sim';
import { BLUE, ORANGE, WHITE, MAX_CAP, parseLevel, type LevelObject } from '../../src/sim/level';

const ROOM = ['WWWWWWWWWWWWWWWWWWWWWWWWWWWWWW', ...Array.from({ length: 8 }, () => 'W............................W'), 'W.S..........................W', 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWW'];
const dispenser = (x: number, liquid: number, cap = 200): LevelObject =>
  ({ id: 0, kind: 'dispenser', x, y: 48, liquid, channel: 0, defaultOn: true, dir: 1, cap }) as LevelObject;

describe('US-013 level liquid limit', () => {
  it('US-013: however many dispensers, the level never holds more than 200 drops; the oldest anywhere goes', () => {
    const sim = live(ascii(ROOM, [BLUE, ORANGE, WHITE, BLUE, ORANGE, WHITE].map((c, i) => dispenser(100 + i * 120, c))));
    let max = 0;
    let firstSeq = -1;
    for (let i = 0; i < 1200; i++) {
      sim.step({ bits: 0, ax: 1, ay: 0 });
      max = Math.max(max, sim.liquidAlive);
      expect(sim.liquidAlive).toBe(sim.particles.filter((p) => !p.dead).length);
      if (sim.liquidAlive === LEVEL_LIQUID_CAP && firstSeq < 0) firstSeq = Math.min(...sim.particles.filter((p) => !p.dead).map((p) => p.seq));
    }
    expect(LEVEL_LIQUID_CAP).toBe(200);
    expect(max).toBe(200);
    // the earliest drops have gone (oldest first), even though each dispenser's own cap was never reached
    const oldestLeft = Math.min(...sim.particles.filter((p) => !p.dead).map((p) => p.seq));
    expect(oldestLeft).toBeGreaterThan(firstSeq);
    expect(sim.dispensers.every((d) => d.alive < d.cap)).toBe(true);
  });

  it('US-013: a dispenser cap above 200 from an older level still loads, as 200', () => {
    const l = parseLevel(ascii(ROOM, [dispenser(100, BLUE, 400)]));
    expect(l.objects.find((o) => o.kind === 'dispenser')).toMatchObject({ cap: MAX_CAP });
    expect(MAX_CAP).toBe(200);
  });
});

describe('US-013 resting liquid', () => {
  it('US-013: a settled pool goes quiet, and wakes when its floor is painted another colour', () => {
    const level = ascii(ROOM, [{ ...dispenser(300, BLUE, 40), channel: 1 } as LevelObject]);
    const sim = live(level);
    // the dispenser keeps pouring but is capped at 40, so its newest drops replace the oldest
    run(sim, 500);
    const alive = sim.particles.filter((p) => !p.dead);
    const asleep = alive.filter((p) => p.asleep);
    expect(alive.length).toBe(40);
    expect(asleep.length).toBeGreaterThan(20);
    // a sleeping drop is exactly where an awake one would rest: on the floor, not in it
    for (const p of asleep) {
      expect(sim.overlapsSolid(p)).toBe(false);
      expect(p.y + p.hh).toBe(10 * 32 * 256);
    }
    // the floor under them turns orange (as when an orange drop lands and paints it, which calls
    // the same wake hook): the blue drops resting there wake and paint it back blue
    // stop the pour (so no new drop can repaint the floor), and let the last drops settle
    sim.dispensers[0].defaultOn = false;
    run(sim, 120);
    const face = sim.particles.find((p) => !p.dead && p.asleep)!.restKey;
    expect(asleep.filter((p) => p.restKey === face).length).toBeGreaterThan(0);
    sim.paint.set(face, ORANGE);
    (sim as unknown as { wakeFace(fk: number): void }).wakeFace(face);
    sim.step({ bits: 0, ax: 1, ay: 0 });
    expect(sim.paint.get(face)).toBe(BLUE);
  });
});
