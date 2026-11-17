// Replays are the per-tick inputs of a run, run-length encoded. The time of a run is
// never stored as trusted data: it is worked out by re-running the replay.
import { Sim, SIM_VERSION, MAX_TICKS, IN_MASK, type TickInput } from './sim';
import { levelHash, type LevelData } from './level';

export const REPLAY_FORMAT = '2dholes-replay';

export interface Replay {
  format: typeof REPLAY_FORMAT;
  v: 1;
  sim: number;
  /** hash of the exact level version this was recorded on */
  level: string;
  /** flat runs: [count, bits, ax, ay, count, bits, ax, ay, ...] */
  runs: number[];
  /** informational only, recomputed on verify */
  ticks: number;
}

export class Recorder {
  private runs: number[] = [];
  private ticks = 0;

  push(inp: TickInput): void {
    const r = this.runs;
    const n = r.length;
    const bits = inp.bits & IN_MASK;
    if (n >= 4 && r[n - 3] === bits && r[n - 2] === inp.ax && r[n - 1] === inp.ay) r[n - 4]++;
    else r.push(1, bits, inp.ax, inp.ay);
    this.ticks++;
  }

  finish(levelHashHex: string): Replay {
    return { format: REPLAY_FORMAT, v: 1, sim: SIM_VERSION, level: levelHashHex, runs: [...this.runs], ticks: this.ticks };
  }
}

/** Expands a replay into a per-tick input reader. */
export class ReplayReader {
  private i = 0;
  private left: number;
  constructor(private replay: Replay) {
    this.left = replay.runs.length ? replay.runs[0] : 0;
  }

  done(): boolean {
    return this.i >= this.replay.runs.length;
  }

  next(): TickInput {
    const r = this.replay.runs;
    while (this.i < r.length && this.left <= 0) {
      this.i += 4;
      this.left = this.i < r.length ? r[this.i] : 0;
    }
    if (this.i >= r.length) return { bits: 0, ax: 0, ay: 0 };
    this.left--;
    const inp = { bits: r[this.i + 1], ax: r[this.i + 2], ay: r[this.i + 3] };
    if (this.left <= 0) {
      this.i += 4;
      this.left = this.i < r.length ? r[this.i] : 0;
    }
    return inp;
  }
}

export function parseReplay(raw: unknown): Replay {
  const r = raw as Replay;
  if (!r || r.format !== REPLAY_FORMAT || r.v !== 1 || !Array.isArray(r.runs) || typeof r.level !== 'string') {
    throw new Error('Not a 2dholes replay file');
  }
  if (r.sim !== SIM_VERSION) throw new Error('This replay was made with a different version of the game physics');
  if (r.runs.length % 4 !== 0) throw new Error('Replay data is damaged');
  let total = 0;
  for (let i = 0; i < r.runs.length; i += 4) {
    const [c, b, ax, ay] = r.runs.slice(i, i + 4);
    if (![c, b, ax, ay].every((n) => Number.isInteger(n)) || c < 1 || b < 0 || b > IN_MASK) {
      throw new Error('Replay data is damaged');
    }
    if (Math.abs(ax) > 1e6 || Math.abs(ay) > 1e6) throw new Error('Replay data is damaged');
    total += c;
  }
  if (total > MAX_TICKS) throw new Error('Replay is too long');
  return { format: REPLAY_FORMAT, v: 1, sim: r.sim, level: r.level, runs: r.runs, ticks: total };
}

export interface ReplayResult {
  finished: boolean;
  /** ticks to finish (or ticks simulated if not finished) */
  ticks: number;
  stateHash: string;
}

/** Re-runs a replay against a level from scratch. This is the source of truth for a run's time. */
export function runReplay(level: LevelData, replay: Replay): ReplayResult {
  if (levelHash(level) !== replay.level) throw new Error('This replay is for a different version of the level');
  const sim = new Sim(level);
  const reader = new ReplayReader(replay);
  while (!reader.done() && !sim.finished && sim.tick < MAX_TICKS) sim.step(reader.next());
  return { finished: sim.finished, ticks: sim.finished ? sim.finishTick : sim.tick, stateHash: sim.stateHash() };
}

export function formatTicks(ticks: number): string {
  const ms = Math.round((ticks * 1000) / 60);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}
