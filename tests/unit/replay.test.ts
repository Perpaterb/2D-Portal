import { describe, it, expect } from 'vitest';
import { ascii } from './helpers';
import { Sim, IN_MASK, type TickInput } from '../../src/sim/sim';
import { Recorder, ReplayReader, runReplay, parseReplay, formatTicks } from '../../src/sim/replay';
import { levelHash, parseLevel, checkPlayable, BLUE, ORANGE, WHITE, type LevelObject } from '../../src/sim/level';

export function kitchenSink() {
  const rows = [
    'WWWWWWWWWWWWWWWWWWWWWWWW',
    'W......................W',
    'W......................W',
    'W......................W',
    'W......................W',
    'W......................W',
    'W.S...B.....B......DDF.W',
    'WWWWWWWWWWDDDDDWWWWWWWWW',
  ];
  const extra: LevelObject[] = [
    { id: 0, kind: 'dispenser', x: 5 * 32, y: 48, liquid: BLUE, channel: 1, defaultOn: true, dir: 1, cap: 60 },
    { id: 0, kind: 'dispenser', x: 12 * 32, y: 48, liquid: ORANGE, channel: 1, defaultOn: false, dir: 1, cap: 60 },
    { id: 0, kind: 'dispenser', x: 18 * 32, y: 48, liquid: WHITE, channel: 0, defaultOn: true, dir: 2, cap: 60 },
    { id: 0, kind: 'plate', x: 9 * 32 + 16, y: 224, channel: 1 },
    { id: 0, kind: 'door', cx: 17, cy: 6, channel: 1 },
  ];
  return ascii(rows, extra);
}

/** test-side PRNG so the input stream is reproducible */
function inputs(seed: number, n: number): TickInput[] {
  let s = seed >>> 0;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const out: TickInput[] = [];
  let bits = 0;
  let ax = 50;
  let ay = 0;
  for (let i = 0; i < n; i++) {
    if (r() < 0.08) bits = Math.floor(r() * (IN_MASK + 1));
    if (r() < 0.1) {
      ax = Math.round((r() - 0.5) * 800);
      ay = Math.round((r() - 0.5) * 800);
    }
    out.push({ bits, ax, ay });
  }
  return out;
}

function simulate(level: ReturnType<typeof kitchenSink>, inp: TickInput[]): Sim {
  const sim = new Sim(level);
  for (const i of inp) sim.step(i);
  return sim;
}

describe('US-019 deterministic physics', () => {
  it('US-019: the same level and inputs give the same state, every time', () => {
    const level = kitchenSink();
    const inp = inputs(1234, 3000);
    const a = simulate(level, inp);
    const b = simulate(JSON.parse(JSON.stringify(level)), inp);
    expect(a.stateHash()).toBe(b.stateHash());
    // the run actually exercised the interesting parts
    expect(a.particleSeq).toBeGreaterThan(500);
    expect(a.paint.size).toBeGreaterThan(5);
  });

  it('US-019: one different input changes the state (the hash can fail)', () => {
    const level = kitchenSink();
    const inp = inputs(1234, 3000);
    const changed = inp.map((x) => ({ ...x }));
    changed[200] = { ...changed[200], bits: changed[200].bits ^ 2 };
    // checked straight after the changed tick: later on the two runs can legitimately meet
    // again (here the player ends up against the same wall by tick 218)
    expect(simulate(level, inp.slice(0, 201)).stateHash()).not.toBe(simulate(level, changed.slice(0, 201)).stateHash());
    expect(simulate(level, inp.slice(0, 201)).stateHash()).toBe(simulate(level, inp.slice(0, 201)).stateHash());
  });

  it('US-019: state holds only integers (no floats creep in)', () => {
    const sim = simulate(kitchenSink(), inputs(99, 2000));
    const bodies = [sim.player, ...sim.boxes, ...sim.particles];
    for (const b of bodies) for (const v of [b.x, b.y, b.vx, b.vy]) expect(Number.isInteger(v)).toBe(true);
  });
});

describe('US-019 replay files', () => {
  it('US-019: recording then replaying reproduces the run exactly', () => {
    const level = kitchenSink();
    const inp = inputs(77, 2500);
    const rec = new Recorder();
    const live = new Sim(level);
    for (const i of inp) {
      rec.push(i);
      live.step(i);
    }
    const replay = rec.finish(levelHash(level));
    const file = JSON.parse(JSON.stringify(replay));
    const result = runReplay(level, parseReplay(file));
    expect(result.stateHash).toBe(live.stateHash());
  });

  it('US-019: the finish time comes from re-running the replay, not from the file', () => {
    const level = ascii(['WWWWWWWW', 'W......W', 'W.S..F.W', 'WWWWWWWW']);
    const rec = new Recorder();
    const sim = new Sim(level);
    for (let n = 0; n < 600 && !sim.finished; n++) {
      const i = { bits: 2, ax: 10, ay: 0 };
      rec.push(i);
      sim.step(i);
    }
    const replay = rec.finish(levelHash(level));
    replay.ticks = 1; // a lie in the file
    const result = runReplay(level, parseReplay(replay));
    expect(result.finished).toBe(true);
    expect(result.ticks).toBe(sim.finishTick);
  });

  it('US-019: a replay for another level version is rejected', () => {
    const level = kitchenSink();
    const rec = new Recorder();
    rec.push({ bits: 0, ax: 0, ay: 0 });
    const replay = rec.finish(levelHash(level));
    const edited = { ...level, tiles: [...level.tiles, [50, 50, 1] as [number, number, 1]] };
    expect(() => runReplay(edited, replay)).toThrow(/different version/);
  });

  it('US-019: run-length encoding round trips', () => {
    const inp = inputs(5, 1000);
    const rec = new Recorder();
    inp.forEach((i) => rec.push(i));
    const replay = rec.finish('x');
    expect(replay.runs.length).toBeLessThan(inp.length * 4);
    const reader = new ReplayReader(replay);
    const back = inp.map(() => reader.next());
    expect(back).toEqual(inp.map((i) => ({ bits: i.bits & IN_MASK, ax: i.ax, ay: i.ay })));
    expect(reader.done()).toBe(true);
  });

  it('US-019: damaged replay files are rejected', () => {
    expect(() => parseReplay({ hello: 1 })).toThrow();
    const rec = new Recorder();
    rec.push({ bits: 0, ax: 0, ay: 0 });
    const r = rec.finish('abc');
    expect(() => parseReplay({ ...r, runs: [1, 2, 3] })).toThrow(/damaged/);
    expect(() => parseReplay({ ...r, runs: [0, 0, 0, 0] })).toThrow(/damaged/);
    expect(() => parseReplay({ ...r, sim: 999 })).toThrow(/different version/);
  });

  it('US-018: times format as mm:ss.mmm', () => {
    expect(formatTicks(0)).toBe('00:00.000');
    expect(formatTicks(60)).toBe('00:01.000');
    expect(formatTicks(3661)).toBe('01:01.017');
  });
});

describe('level format', () => {
  it('US-019: the level hash ignores object and tile order', () => {
    const a = kitchenSink();
    const b = { ...a, tiles: [...a.tiles].reverse(), objects: [...a.objects].reverse() };
    expect(levelHash(a)).toBe(levelHash(b));
    expect(levelHash(parseLevel(JSON.parse(JSON.stringify(a))))).toBe(levelHash(a));
  });

  it('US-006: a level needs exactly one start and at least one finish', () => {
    expect(checkPlayable(ascii(['WSFW'])).ok).toBe(true);
    expect(checkPlayable(ascii(['W.FW'])).problems).toEqual(['Add a start']);
    expect(checkPlayable(ascii(['WS.W'])).problems).toEqual(['Add at least one finish']);
    expect(checkPlayable(ascii(['WSSFW'])).problems).toEqual(['Only one start is allowed']);
  });

  it('parseLevel rejects malformed levels', () => {
    expect(() => parseLevel({ v: 2 })).toThrow();
    expect(() => parseLevel({ v: 1, tiles: [[0, 0, 7]], objects: [] })).toThrow();
    expect(() => parseLevel({ v: 1, tiles: [], objects: [{ id: 1, kind: 'plate', x: 0, y: 0, channel: 99 }] })).toThrow();
  });
});
