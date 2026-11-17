import { describe, it, expect } from 'vitest';
import { ascii, run, idle, px, live } from './helpers';
import {
  MAX_SPEED, RUN_SPEED, IN_LEFT, IN_RIGHT, IN_JUMP, IN_USE, IN_FIRE_A, IN_FIRE_B,
  portalMatrix, makePortal, PLAYER_HH, HOLD_REL_SPEED, GRAVITY,
} from '../../src/sim/sim';
import { SUB, T, DX, DY, cellKey } from '../../src/sim/fixed';
import { BLUE, ORANGE, WHITE, type LevelObject } from '../../src/sim/level';

const ROOM = [
  'WWWWWWWWWWWWWW',
  'W............W',
  'W............W',
  'W............W',
  'W.S........F.W',
  'WWWWWWWWWWWWWW',
];

const left = { bits: IN_LEFT, ax: -100, ay: 0 };
const right = { bits: IN_RIGHT, ax: 100, ay: 0 };

describe('US-007 movement', () => {
  it('US-007: stands on the floor', () => {
    const sim = live(ascii(ROOM));
    run(sim, 30);
    expect(sim.player.ground).toBe(true);
    expect(sim.player.y + PLAYER_HH).toBe(5 * T);
  });

  it('US-007: runs right up to run speed, stops at walls', () => {
    const sim = live(ascii(ROOM.map((r) => r.replace('F', '.'))));
    run(sim, 20, right);
    expect(sim.player.vx).toBe(RUN_SPEED);
    run(sim, 300, right);
    expect(sim.player.x + sim.player.hw).toBe(13 * T); // touching the right wall
    expect(sim.player.vx).toBe(0);
  });

  it('US-007: jumps and lands again', () => {
    const sim = live(ascii(ROOM));
    run(sim, 10);
    const floorY = sim.player.y;
    sim.step({ bits: IN_JUMP, ax: 1, ay: 0 });
    run(sim, 8, { bits: IN_JUMP, ax: 1, ay: 0 });
    expect(sim.player.y).toBeLessThan(floorY - 20 * SUB);
    run(sim, 80);
    expect(sim.player.y).toBe(floorY);
  });

  it('US-006: reaching a finish ends the run with a tick count', () => {
    const sim = live(ascii(ROOM));
    run(sim, 400, right);
    expect(sim.finished).toBe(true);
    expect(sim.finishTick).toBeGreaterThan(30);
    const t = sim.finishTick;
    run(sim, 10, right);
    expect(sim.finishTick).toBe(t);
  });
});

describe('US-008 portal gun', () => {
  it('US-008: left click places portal A on a white wall', () => {
    const sim = live(ascii(ROOM));
    run(sim, 10);
    sim.step({ bits: IN_FIRE_A, ax: -100, ay: 0 });
    expect(sim.portals[0]).toMatchObject({ cx: 0, n: 0 });
    expect(sim.portals[1]).toBeNull();
    sim.step({ bits: IN_FIRE_A, ax: 100, ay: 0 }); // still held: no new shot
    expect(sim.portals[0]!.cx).toBe(0);
    sim.step(idle);
    sim.step({ bits: IN_FIRE_B, ax: 100, ay: 0 });
    expect(sim.portals[1]).toMatchObject({ cx: 13, n: 2 });
  });

  it('US-008: dark grey walls do not take portals', () => {
    const rows = ROOM.map((r, i) => (i > 0 && i < 5 ? 'D' + r.slice(1) : r));
    const sim = live(ascii(rows));
    run(sim, 10);
    sim.step({ bits: IN_FIRE_A, ax: -100, ay: 0 });
    expect(sim.portals[0]).toBeNull();
    expect(sim.lastShot?.ok).toBe(false);
  });

  it('US-008: firing again moves the portal of that colour', () => {
    const sim = live(ascii(ROOM));
    run(sim, 10);
    sim.step({ bits: IN_FIRE_A, ax: -100, ay: 0 });
    sim.step(idle);
    sim.step({ bits: IN_FIRE_A, ax: 0, ay: -100 });
    expect(sim.portals[0]).toMatchObject({ cy: 0, n: 1 });
  });

  it('US-008: a portal needs open space in front of both tiles', () => {
    const rows = [...ROOM];
    rows[3] = 'WW...........W'; // a block in front of the upper left wall tile
    const sim = live(ascii(rows));
    run(sim, 10);
    sim.step({ bits: IN_FIRE_A, ax: -100, ay: 0 });
    // the only valid pair would be rows 4-5, but row 5 is floor, so no portal at all
    expect(sim.portals[0]).toBeNull();
  });
});

describe('US-009 portal physics', () => {
  it('US-009: walking into a wall portal comes out of the other', () => {
    const sim = live(ascii(ROOM.map((r) => r.replace('F', '.'))));
    run(sim, 10);
    sim.step({ bits: IN_FIRE_A, ax: -100, ay: 0 });
    sim.step(idle);
    sim.step({ bits: IN_FIRE_B, ax: 100, ay: 0 });
    expect(sim.portals[0] && sim.portals[1]).toBeTruthy();
    let teleported = false;
    for (let i = 0; i < 200 && !teleported; i++) {
      sim.step(left);
      teleported = sim.player.teleports > 0;
    }
    expect(teleported).toBe(true);
    expect(px(sim.player.x)).toBeGreaterThan(13 * 32 - 40);
    expect(sim.player.vx).toBeLessThan(0); // still moving left, out of the right wall
  });

  it('US-009: falling into a floor portal flings you up out of another floor portal at the same speed', () => {
    const rows = [
      'WWWWWWWWWWWWWWWWWWWW',
      ...Array.from({ length: 16 }, () => 'W..................W'),
      'WWWWWWWWWWWWWWWWWWWW',
    ];
    rows[2] = 'W.S................W';
    const level = ascii(rows);
    const sim = live(level);
    sim.portals[0] = makePortal(2, 17, 3); // floor below start, facing up
    sim.portals[1] = makePortal(14, 17, 3);
    let vyIn = 0;
    for (let i = 0; i < 300 && sim.player.teleports === 0; i++) {
      vyIn = sim.player.vy;
      sim.step(idle);
    }
    expect(sim.player.teleports).toBe(1);
    expect(sim.player.vy).toBeLessThan(0);
    expect(Math.abs(sim.player.vy)).toBeGreaterThanOrEqual(vyIn - 200);
    expect(px(sim.player.x)).toBeGreaterThan(14 * 32);
  });

  it('US-009: speed never exceeds the cap, even looping through portals', () => {
    const rows = [
      'WWWWWW',
      ...Array.from({ length: 30 }, () => 'W....W'),
      'WWWWWW',
    ];
    rows[1] = 'W.S..W';
    const sim = live(ascii(rows));
    sim.portals[0] = makePortal(2, 31, 3); // floor
    sim.portals[1] = makePortal(2, 0, 1); // ceiling, facing down: endless fall
    let maxV = 0;
    for (let i = 0; i < 1000; i++) {
      sim.step(idle);
      maxV = Math.max(maxV, Math.abs(sim.player.vy), Math.abs(sim.player.vx));
    }
    expect(sim.player.teleports).toBeGreaterThan(3);
    expect(maxV).toBe(MAX_SPEED);
  });

  it('US-009: the portal transform maps "into" the entry onto "out of" the exit for every pair', () => {
    for (let nIn = 0; nIn < 4; nIn++) {
      for (let nOut = 0; nOut < 4; nOut++) {
        const [a, b, c, d] = portalMatrix(nIn, nOut);
        const ix = -DX[nIn];
        const iy = -DY[nIn];
        expect([a * ix + b * iy + 0, c * ix + d * iy + 0]).toEqual([DX[nOut], DY[nOut]]);
        expect(Math.abs(a * d - b * c)).toBe(1);
      }
    }
  });
});

describe('US-010 boxes', () => {
  const rows = ROOM.map((r, i) => (i === 4 ? 'W.SB.......F.W' : r));

  it('US-010: E picks up and drops a box, and you cannot fire while holding', () => {
    const sim = live(ascii(rows));
    run(sim, 10);
    sim.step({ bits: IN_USE, ax: 100, ay: 0 });
    expect(sim.player.holding).not.toBeNull();
    run(sim, 10, { bits: 0, ax: 100, ay: 0 });
    const box = sim.boxes[0];
    expect(box.x).toBeGreaterThan(sim.player.x + 30 * SUB);
    sim.step({ bits: IN_FIRE_A, ax: -100, ay: 0 });
    expect(sim.portals[0]).toBeNull();
    sim.step({ bits: IN_USE, ax: 100, ay: 0 });
    expect(sim.player.holding).toBeNull();
    run(sim, 60);
    expect(box.ground).toBe(true);
  });

  it('US-010: a held box cannot be flung: it never moves faster than the player plus their run speed', () => {
    const sim = live(ascii(rows));
    run(sim, 10);
    sim.step({ bits: IN_USE, ax: 100, ay: 0 });
    run(sim, 20, { bits: 0, ax: 100, ay: 0 });
    const box = sim.boxes[0];
    let fastest = 0;
    // whip the aim from right to straight up and back, releasing mid-swing
    for (let i = 0; i < 12; i++) {
      sim.step({ bits: 0, ax: i % 2 ? 100 : -10, ay: i % 2 ? 0 : -100 });
      fastest = Math.max(fastest, Math.abs(box.vx - sim.player.vx), Math.abs(box.vy - sim.player.vy));
    }
    sim.step({ bits: IN_USE, ax: 0, ay: -100 });
    expect(sim.player.holding).toBeNull();
    expect(fastest).toBeGreaterThan(0);
    expect(fastest).toBeLessThanOrEqual(HOLD_REL_SPEED);
    expect(Math.abs(box.vx)).toBeLessThanOrEqual(Math.abs(sim.player.vx) + HOLD_REL_SPEED);
    // the release tick already lets the box fall, so one tick of gravity is on top
    expect(Math.abs(box.vy)).toBeLessThanOrEqual(Math.abs(sim.player.vy) + HOLD_REL_SPEED + GRAVITY);
  });

  it('US-010: a held box is stopped by walls', () => {
    const sim = live(ascii(rows));
    run(sim, 10);
    sim.step({ bits: IN_USE, ax: 0, ay: -100 });
    run(sim, 30, { bits: 0, ax: 0, ay: -2000 });
    expect(sim.boxes[0].y - sim.boxes[0].hh).toBeGreaterThanOrEqual(1 * T);
  });

  it('US-010: a held box is carried through a portal with the player', () => {
    const sim = live(ascii(rows));
    run(sim, 10);
    sim.step({ bits: IN_FIRE_A, ax: -100, ay: 0 });
    sim.step(idle);
    sim.step({ bits: IN_FIRE_B, ax: 100, ay: 0 });
    sim.step(idle);
    sim.step({ bits: IN_USE, ax: 100, ay: 0 });
    expect(sim.player.holding).not.toBeNull();
    for (let i = 0; i < 300 && sim.player.teleports === 0; i++) sim.step({ bits: IN_LEFT, ax: -100, ay: 0 });
    expect(sim.player.teleports).toBe(1);
    run(sim, 5, { bits: 0, ax: -100, ay: 0 });
    expect(sim.player.holding).not.toBeNull();
    expect(Math.abs(sim.boxes[0].x - sim.player.x)).toBeLessThan(60 * SUB);
    expect(px(sim.boxes[0].x)).toBeGreaterThan(9 * 32);
  });

  it('US-010: the player can stand on a box', () => {
    const stack = ROOM.map((r, i) => (i === 1 ? 'W..S.........W' : i === 4 ? 'W..B.......F.W' : r));
    const sim = live(ascii(stack));
    run(sim, 60);
    expect(sim.player.ground).toBe(true);
    expect(sim.player.y + sim.player.hh).toBe(5 * T - 24 * SUB);
  });
});

describe('US-011 / US-012 plates and multi-lock doors', () => {
  function level() {
    const rows = ROOM.map((r, i) => (i === 4 ? 'W.S.B.......FW' : r));
    const extra: LevelObject[] = [
      { id: 0, kind: 'plate', x: 4 * 32 + 16, y: 160, channel: 2 },
      { id: 0, kind: 'plate', x: 1 * 32 + 16, y: 160, channel: 2 },
      { id: 0, kind: 'door', cx: 10, cy: 4, channel: 2 },
      { id: 0, kind: 'door', cx: 10, cy: 3, channel: 2 },
    ];
    return ascii(rows, extra);
  }

  it('US-011: a box on a plate presses it', () => {
    const sim = live(level());
    run(sim, 5);
    expect(sim.plates[0].pressed).toBe(true);
    expect(sim.plates[1].pressed).toBe(false);
  });

  it('US-012: the door opens only while every plate on the channel is pressed', () => {
    const sim = live(level());
    run(sim, 5);
    expect(sim.doors.every((d) => !d.open)).toBe(true);
    // walk left onto the second plate
    for (let i = 0; i < 200 && !sim.plates[1].pressed; i++) sim.step(left);
    expect(sim.plates[1].pressed).toBe(true);
    sim.step(idle);
    expect(sim.doors.every((d) => d.open)).toBe(true);
    run(sim, 100, right); // off the plate (the box stops us at cell 3)
    expect(sim.plates[1].pressed).toBe(false);
    expect(sim.doors.every((d) => !d.open)).toBe(true);
  });

  it('US-012: a door never closes onto something standing in it', () => {
    const rows = ROOM.map((r, i) => (i === 4 ? 'W.S......B..FW' : r));
    const lvl = ascii(rows, [
      { id: 0, kind: 'plate', x: 2 * 32 + 16, y: 160, channel: 5 },
      { id: 0, kind: 'door', cx: 9, cy: 4, channel: 5 },
    ]);
    const sim = live(lvl);
    run(sim, 3);
    expect(sim.doors[0].open).toBe(true); // player is on the plate
    run(sim, 60, right); // walk off the plate: the box is still inside the door cell
    expect(sim.plates[0].pressed).toBe(false);
    expect(sim.doors[0].open).toBe(true);
    // move the box and the player clear of the doorway, then the door shuts
    sim.boxes[0].x = 11 * T;
    sim.player.x = 4 * T;
    run(sim, 2);
    expect(sim.doors[0].open).toBe(false);
  });

  it('US-012: a closed door blocks the player', () => {
    const lvl = level();
    lvl.objects = lvl.objects.filter((o) => o.kind !== 'box');
    const sim = live(lvl);
    run(sim, 400, right);
    expect(sim.finished).toBe(false);
    expect(sim.player.x + sim.player.hw).toBeLessThanOrEqual(10 * T);
  });
});

describe('US-013 / US-014 dispensers and liquid', () => {
  const BIG = [
    'WWWWWWWWWWWWWWWWWWWW',
    ...Array.from({ length: 10 }, () => 'W..................W'),
    'W.S..............F.W',
    'WWWWWWWWWWWWWWWWWWWW',
  ];
  function disp(liquid: 1 | 2 | 3, extra: Partial<LevelObject> = {}): LevelObject {
    return { id: 0, kind: 'dispenser', x: 10 * 32 + 16, y: 2 * 32 + 16, liquid, channel: 0, defaultOn: true, dir: 1, cap: 30, ...extra } as LevelObject;
  }

  it('US-014: blue liquid paints white floor blue and disappears', () => {
    const sim = live(ascii(BIG, [disp(BLUE)]));
    const fk = cellKey(10, 12) * 4 + 3; // top face of the floor under the dispenser
    for (let i = 0; i < 200 && !sim.paint.has(fk); i++) sim.step(idle);
    expect(sim.paint.get(fk)).toBe(BLUE);
    // the particle that painted is gone: one fewer alive than were poured
    expect(sim.dispensers[0].alive).toBe(sim.particleSeq - 1);
  });

  it('US-014: white liquid on a white floor does not paint; it pools', () => {
    const sim = live(ascii(BIG, [disp(WHITE)]));
    run(sim, 300);
    expect(sim.paint.size).toBe(0);
    expect(sim.aliveParticles()).toBe(30);
  });

  it('US-013: at the cap the dispenser keeps pouring and the oldest liquid goes', () => {
    const sim = live(ascii(BIG, [disp(WHITE)]));
    run(sim, 400);
    expect(sim.aliveParticles()).toBe(30);
    expect(sim.particleSeq).toBeGreaterThan(150);
    const oldestAlive = Math.min(...sim.particles.filter((p) => !p.dead).map((p) => p.seq));
    expect(oldestAlive).toBe(sim.particleSeq - 30);
  });

  it('US-014: white paints dark grey, and orange paints over blue', () => {
    const dark = BIG.map((r, i) => (i === 12 ? 'D'.repeat(20) : r));
    const sim = live(ascii(dark, [disp(WHITE)]));
    run(sim, 200);
    expect(sim.paint.get(cellKey(10, 12) * 4 + 3)).toBe(WHITE);

    const sim2 = live(ascii(BIG, [disp(ORANGE)]));
    sim2.paint.set(cellKey(10, 12) * 4 + 3, BLUE);
    run(sim2, 200);
    expect(sim2.paint.get(cellKey(10, 12) * 4 + 3)).toBe(ORANGE);
  });

  it('US-014: white paint over blue on a white wall cleans it back to white', () => {
    const sim = live(ascii(BIG, [disp(WHITE)]));
    sim.paint.set(cellKey(10, 12) * 4 + 3, BLUE);
    run(sim, 100);
    expect(sim.paint.has(cellKey(10, 12) * 4 + 3)).toBe(false);
  });

  it('US-013: a plate on the channel flips the dispenser; its liquid stays', () => {
    const plate: LevelObject = { id: 0, kind: 'plate', x: 2 * 32 + 16, y: 12 * 32, channel: 3 };
    const sim = live(ascii(BIG, [disp(WHITE, { channel: 3, defaultOn: false }), plate]));
    run(sim, 100);
    expect(sim.dispensers[0].on).toBe(true); // player standing on the plate flips it on
    const seq = sim.particleSeq;
    expect(seq).toBeGreaterThan(10);
    run(sim, 100, right); // step off the plate
    expect(sim.dispensers[0].on).toBe(false);
    const stopped = sim.particleSeq;
    const alive = sim.aliveParticles();
    run(sim, 300);
    expect(sim.particleSeq).toBe(stopped);
    expect(sim.aliveParticles()).toBe(alive);
  });

  it('US-009: liquid passes through portals', () => {
    const sim = live(ascii(BIG, [disp(WHITE)]));
    sim.portals[0] = makePortal(10, 12, 3); // under the dispenser
    sim.portals[1] = makePortal(3, 0, 1); // ceiling at the left
    run(sim, 200);
    expect(sim.particles.some((p) => p.teleports > 0)).toBe(true);
  });
});

describe('US-015 / US-016 / US-017 paint effects', () => {
  it('US-015: blue floor is slippery', () => {
    const slide = (blue: boolean) => {
      const sim = live(ascii(ROOM.map((r) => r.replace('F', '.'))));
      if (blue) for (let cx = 0; cx < 14; cx++) sim.paint.set(cellKey(cx, 5) * 4 + 3, BLUE);
      run(sim, 5);
      run(sim, blue ? 120 : 20, right);
      const x0 = sim.player.x;
      run(sim, 30);
      return sim.player.x - x0;
    };
    expect(slide(true)).toBeGreaterThan(slide(false) * 4);
  });

  it('US-016: white paint makes a dark wall take portals', () => {
    const rows = ROOM.map((r, i) => (i > 0 && i < 5 ? 'D' + r.slice(1) : r));
    const sim = live(ascii(rows));
    sim.paint.set(cellKey(0, 3) * 4 + 0, WHITE);
    sim.paint.set(cellKey(0, 4) * 4 + 0, WHITE);
    run(sim, 10);
    sim.step({ bits: IN_FIRE_A, ax: -100, ay: 0 });
    expect(sim.portals[0]).toMatchObject({ cx: 0, cy: 3, n: 0 });
  });

  it('US-016: blue on a white wall stays portal-able', () => {
    const sim = live(ascii(ROOM));
    sim.paint.set(cellKey(0, 3) * 4 + 0, BLUE);
    sim.paint.set(cellKey(0, 4) * 4 + 0, BLUE);
    run(sim, 10);
    sim.step({ bits: IN_FIRE_A, ax: -100, ay: 0 });
    expect(sim.portals[0]).not.toBeNull();
  });

  it('US-017: orange floor bounces a falling box', () => {
    const rows = [
      'WWWWWW',
      'W....W',
      'W.SB.W',
      ...Array.from({ length: 8 }, () => 'W....W'),
      'WWWWWW',
    ];
    const level = ascii(rows);
    // lift the box up high
    const box = level.objects.find((o) => o.kind === 'box')!;
    (box as { y: number }).y = 3 * 32;
    const sim = live(level);
    for (let cx = 0; cx < 6; cx++) sim.paint.set(cellKey(cx, 11) * 4 + 3, ORANGE);
    let bounced = false;
    let prevVy = 0;
    for (let i = 0; i < 200; i++) {
      sim.step(idle);
      if (prevVy > 0 && sim.boxes[0].vy < 0) bounced = true;
      prevVy = sim.boxes[0].vy;
    }
    expect(bounced).toBe(true);
  });
});

describe('US-028 portal magnetism', () => {
  // player starts high above the floor, 48 px left of a floor portal's centre
  const SHAFT = [
    'WWWWWWWWWWWW',
    ...Array.from({ length: 8 }, () => 'W..........W'),
    'WWWWWWWWWWWW',
  ];
  function setup(magnet: boolean) {
    const rows = [...SHAFT];
    rows[2] = 'W.S........W';
    const sim = live(ascii(rows));
    sim.portals[0] = makePortal(2, 9, 3); // floor, span x 64..128, centre 96
    sim.portals[1] = makePortal(11, 3, 2); // right wall
    if (!magnet) sim.magnetise = () => {};
    // start 48 px left of the centre: the player (18 px wide) would miss the mouth
    sim.player.x = 48 * SUB;
    return sim;
  }

  it('US-028: a falling player off to the side is pulled into a floor portal', () => {
    const sim = setup(true);
    run(sim, 200);
    expect(sim.player.teleports).toBeGreaterThan(0);
  });

  it('US-028: without the pull the same fall misses (the test can fail)', () => {
    const sim = setup(false);
    run(sim, 200);
    expect(sim.player.teleports).toBe(0);
  });

  it('US-028: no pull when rising away or beyond its reach; momentum is never changed', () => {
    const sim = setup(true);
    const near = 9 * T - 2 * T; // two tiles above the floor portal
    const at = (x: number, vx: number, vy: number) => {
      sim.player.x = x;
      sim.player.y = near;
      sim.player.vx = vx;
      sim.player.vy = vy;
      sim.magnetise(sim.player);
      return sim.player.x;
    };
    expect(at(48 * SUB, 0, -3 * SUB)).toBe(48 * SUB); // moving away
    expect(at(96 * SUB - 2 * T, 0, 3 * SUB)).toBe(96 * SUB - 2 * T); // two tiles off the centre line
    expect(at(80 * SUB, 0, 3 * SUB)).toBe(80 * SUB); // already fits the mouth
    expect(at(48 * SUB, 100, 3 * SUB)).toBeGreaterThan(48 * SUB); // off to the side: slid in
    expect([sim.player.vx, sim.player.vy]).toEqual([100, 3 * SUB]);
  });

  it('US-028: liquid is never magnetised', () => {
    const sim = live(ascii(SHAFT.map((r, i) => (i === 2 ? 'W.S........W' : r)), [
      { id: 0, kind: 'dispenser', x: 48, y: 48, liquid: BLUE, channel: 0, defaultOn: true, dir: 1, cap: 50 } as LevelObject,
    ]));
    sim.portals[0] = makePortal(2, 9, 3);
    sim.portals[1] = makePortal(11, 3, 2);
    const seen: unknown[] = [];
    const real = sim.magnetise.bind(sim);
    sim.magnetise = (b, o) => {
      seen.push(b);
      real(b, o);
    };
    run(sim, 120);
    expect(sim.particleSeq).toBeGreaterThan(20);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((b) => sim.particles.includes(b as never))).toBe(false);
  });
});
