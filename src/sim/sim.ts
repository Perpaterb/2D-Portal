// The deterministic game simulation. No DOM, no floats in state, no time sources:
// the same level plus the same per-tick inputs always produces the same result.
// This file must stay runnable on the server (Deno) to verify replays.
import {
  SUB, T, DX, DY, idiv, fdiv, clamp, isqrt, towardsZero, cellKey, keyCx, keyCy, nextRandom, Hasher,
} from './fixed';
import {
  BLUE, ORANGE, WHITE, WHITE_WALL, DARK_WALL, CHANNEL_COUNT, levelHash, canonicalLevel, tileInfo, sideColour,
  colourPaint, isOpenFace, hypFace, SLOPE_NORMALS,
  type LevelData, type Liquid, type TileKind, type DispenserObj, type TileInfo,
} from './level';

/** Bump whenever a change would alter the outcome of an existing replay. */
export const SIM_VERSION = 3;

// ---- tuning, all in sub-units (1 px = 256) per tick (60 Hz) ----
export const GRAVITY = 96;
export const MAX_SPEED = 20 * SUB;
const SUBSTEP = 8 * SUB;
export const RUN_SPEED = 896;
const GROUND_ACCEL = 128;
const AIR_ACCEL = 64;
const SLIP_ACCEL = 12;
const GROUND_FRICTION = 160;
const SLIP_FRICTION = 2;
const OVERSPEED_FRICTION = 24;
export const JUMP_V = -7 * SUB;
const COYOTE_TICKS = 6;
const JUMP_BUFFER_TICKS = 6;
const BOUNCE_MIN = 2 * SUB;
/** most liquid drops a whole level may hold at once */
export const LEVEL_LIQUID_CAP = 200;
/** downhill push per tick for bodies resting on a slope (boxes, liquid, and the player on blue) */
const SLOPE_ACCEL = 48;
export const PLAYER_HW = 9 * SUB;
export const PLAYER_HH = 21 * SUB;
export const BOX_H = 12 * SUB;
export const PARTICLE_H = 2 * SUB;
const GRAB_RANGE = 56 * SUB;
const HOLD_DIST = 44 * SUB;
const HOLD_DROP = 110 * SUB;
/** most a held box may move relative to the player, per axis (the player's run speed) */
export const HOLD_REL_SPEED = RUN_SPEED;
const BOX_FRICTION = 96;
const PARTICLE_GRAVITY = 80;
export const EMIT_EVERY = 2;
const EMIT_SPEED = 4 * SUB;
const EMIT_OFFSET = 14 * SUB;
export const PLATE_HW = 14 * SUB;
const PLATE_SENSE_H = 6 * SUB;
export const FINISH_HW = 14 * SUB;
export const FINISH_H = 48 * SUB;
const AIM_LIMIT = 4096;
const SHOT_STEPS = 2400;
export const MAX_TICKS = 60 * 60 * 60; // one hour
// portal magnetism: airborne bodies heading into a portal are steered to its centre
export const MAG_RANGE = 4 * T; // how far in front of the portal it reaches
export const MAG_WIDTH = T + T / 2; // how far off the centre line it reaches
const MAG_MIN_INTO = SUB; // must be moving into the portal at least 1 px/tick
const MAG_STEP = SUB; // minimum sideways slide per tick
const MAG_MAX_STEP = 8 * SUB; // maximum sideways slide per tick

// ---- inputs ----
export const IN_LEFT = 1;
export const IN_RIGHT = 2;
export const IN_JUMP = 4;
export const IN_USE = 8;
export const IN_FIRE_A = 16;
export const IN_FIRE_B = 32;
export const IN_MASK = 63;

export interface TickInput {
  bits: number;
  /** Aim offset from the player's centre, in whole pixels. */
  ax: number;
  ay: number;
}

// ---- state types ----
export interface Body {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hw: number;
  hh: number;
  ground: boolean;
  groundPaint: number;
  /** when resting on a slope: the downhill x direction (-1 or 1), else 0 */
  groundSlope: number;
  teleports: number;
}

export interface Player extends Body {
  coyote: number;
  jumpBuf: number;
  jumping: boolean;
  holding: Box | null;
  facing: number;
  aimX: number;
  aimY: number;
}

export interface Box extends Body {
  held: boolean;
}

export interface Particle extends Body {
  color: Liquid;
  dead: boolean;
  seq: number;
  /** index into Sim.dispensers */
  owner: number;
  /**
   * Resting drops sleep: stepping them would change nothing until the world under them does,
   * so they are skipped until the face they rest on is repainted, a door or portal changes, or
   * the spreading pass moves them. Never hashed: it only saves work.
   */
  asleep: boolean;
  /** the face key this drop last landed on, or -1 (a door) */
  restKey: number;
  /** while asleep: the 4px spot it holds (see Sim.spotKey) */
  spot: number;
}

/**
 * A portal: two cells long, on a flat face (n 0..3, as DX / DY) or on the sloped faces of two
 * slopes in a line (n 4..7 = 4 + slope shape - 1). Geometry is kept in vector form so both
 * kinds share the same maths: positions relative to the centre (px, py), the integer normal
 * (nx, ny) and tangent (-ny, nx). For a diagonal portal these vectors have length sqrt 2, so
 * "depth" and "along" values are scaled by sqrt 2 there; `half` is the mouth's half length in
 * the same scaled units (T for flat portals, 2T for diagonal ones).
 */
export interface Portal {
  cx: number;
  cy: number;
  n: number;
  /** direction of the normal in 45° steps, 0 = right, 2 = down (screen y points down) */
  ang: number;
  nx: number;
  ny: number;
  px: number;
  py: number;
  half: number;
  /** flat portals: face plane coordinate and tangent span [t0, t1) with centre tc */
  plane: number;
  t0: number;
  t1: number;
  tc: number;
  /** cells this portal opens up while a body is in its mouth */
  cells: number[];
}

export interface DoorState {
  id: number;
  cx: number;
  cy: number;
  channel: number;
  open: boolean;
}

export interface PlateState {
  id: number;
  x: number;
  y: number;
  channel: number;
  pressed: boolean;
}

export interface DispenserState {
  id: number;
  x: number;
  y: number;
  liquid: Liquid;
  channel: number;
  defaultOn: boolean;
  dir: number;
  cap: number;
  on: boolean;
  alive: number;
  /** total particles ever poured (informational) */
  poured: number;
  fifo: Particle[];
}

export interface ShotTrace {
  portal: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  ok: boolean;
  tick: number;
}

const DARK = 4;

/** Fixed-point scale for portal matrices, and sqrt(1/2) in it. */
export const MAT_ONE = 65536;
const MAT_HALF_ROOT2 = 46341;
const COS45 = [MAT_ONE, MAT_HALF_ROOT2, 0, -MAT_HALF_ROOT2, -MAT_ONE, -MAT_HALF_ROOT2, 0, MAT_HALF_ROOT2];

/**
 * Linear map applied to positions and velocities when passing from one portal to another,
 * in fixed point (MAT_ONE = 1). Into the entry portal becomes out of the exit portal. Two
 * portals facing the same way mirror the normal and keep the tangent; otherwise it is the
 * rotation by (exit angle - entry angle + 180°). 90° steps give exact integers.
 */
export function portalMatrix(angIn: number, angOut: number): [number, number, number, number] {
  if (angIn === angOut) {
    // mirror in the portal face: I - 2 n n^T / |n|^2
    const [nx, ny] = ANG_VEC[angIn];
    const n2 = nx * nx + ny * ny;
    return [MAT_ONE - idiv(2 * MAT_ONE * nx * nx, n2), -idiv(2 * MAT_ONE * nx * ny, n2), -idiv(2 * MAT_ONE * nx * ny, n2), MAT_ONE - idiv(2 * MAT_ONE * ny * ny, n2)];
  }
  const k = (angOut - angIn + 4 + 16) % 8;
  const c = COS45[k];
  const sn = COS45[(k + 6) % 8]; // sin(a) = cos(a - 90°)
  return [c, -sn, sn, c];
}

/** Integer direction vector for each 45° angle step (screen axes, y down). */
export const ANG_VEC: readonly (readonly [number, number])[] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** Applies a fixed-point portal matrix to an integer vector. */
export function applyMatrix(m: [number, number, number, number], x: number, y: number): [number, number] {
  return [idiv(m[0] * x + m[1] * y, MAT_ONE), idiv(m[2] * x + m[3] * y, MAT_ONE)];
}

export class Sim {
  readonly levelHash: string;
  tick = 0;
  /** the world waits, untimed, until the first input with any action in it */
  started = false;
  finished = false;
  finishTick = -1;
  /** solid cells: WHITE_WALL or DARK_WALL (the cell's own base) */
  tiles = new Map<number, TileKind>();
  /** slope cells: shape 1..4 (see SLOPE_NORMALS); everything else in `tiles` is a full block */
  slopes = new Map<number, number>();
  /** per-face base (WHITE or DARK) where a side differs from its cell; key = cellKey * 4 + dir */
  faceBase = new Map<number, number>();
  /** paint per face: key = cellKey * 4 + dir (a slope's sloped face uses hypFace) */
  paint = new Map<number, number>();
  /** the level's tiles as placed, for drawing; never changes during play */
  tileInfo = new Map<number, TileInfo>();
  doors: DoorState[] = [];
  doorAt = new Map<number, DoorState>();
  plates: PlateState[] = [];
  dispensers: DispenserState[] = [];
  boxes: Box[] = [];
  particles: Particle[] = [];
  portals: [Portal | null, Portal | null] = [null, null];
  channelActive: boolean[] = new Array(CHANNEL_COUNT).fill(false);
  player: Player;
  finishes: { x: number; y: number }[] = [];
  rng: number;
  prevBits = 0;
  particleSeq = 0;
  /** live drops in the whole level, and where the oldest might be in `particles` */
  liquidAlive = 0;
  private oldestIndex = 0;
  /** sleeping drops by the face they rest on */
  private sleepers = new Map<number, Particle[]>();
  private spreadTaken = new Set<number>();
  /** how many sleeping drops hold each 4px spot */
  private restingSpots = new Map<number, number>();
  private settling: (Particle | null)[] = [];
  /**
   * A flat copy of the level's cells over its bounding box, for fast collision checks:
   * 0 empty, 1 block, 2..5 slope (shape + 1), 6 door. Cells outside the box are empty.
   * Tiles never change during play (doors keep their open state in `doors`).
   */
  private grid: Uint8Array | null = null;
  private gx0 = 0;
  private gy0 = 0;
  private gw = 0;
  private gh = 0;
  /** cosmetic only, never hashed */
  lastShot: ShotTrace | null = null;
  /** cosmetic only: facings of the last portal pair the player went through */
  lastPlayerTeleport: { angIn: number; angOut: number; inP: Portal; outP: Portal } | null = null;

  // scratch results from moveAxis, reused to avoid allocations
  private hitBlocked = false;
  private hitPaint = 0;
  private hitKey = -1;
  private hitFace = 0;
  private hitTile = false;
  /** shape of the slope whose sloped face was hit, else 0 */
  private hitSlope = 0;

  constructor(level: LevelData) {
    this.levelHash = levelHash(level);
    this.rng = parseInt(this.levelHash, 16) | 0;
    for (const t of canonicalLevel(level).tiles) {
      const k = cellKey(t[0], t[1]);
      const info = tileInfo(t);
      this.tileInfo.set(k, info);
      // blue and orange are dark walls with paint already on; each side can have its own colour
      const cellBase = info.kind === WHITE_WALL ? WHITE_WALL : DARK_WALL;
      this.tiles.set(k, cellBase);
      if (info.shape) this.slopes.set(k, info.shape);
      for (let f = 0; f < 4; f++) {
        if (info.shape && isOpenFace(info.shape, f) && f !== hypFace(info.shape)) continue;
        const c = sideColour(info, f);
        const base = c === WHITE_WALL ? WHITE : DARK;
        if (base !== (cellBase === WHITE_WALL ? WHITE : DARK)) this.faceBase.set(k * 4 + f, base);
        const pre = colourPaint(c);
        if (pre) this.paint.set(k * 4 + f, pre);
      }
    }
    const objects = [...level.objects].sort((a, b) => a.id - b.id);
    let px = 0;
    let py = 0;
    for (const o of objects) {
      switch (o.kind) {
        case 'start':
          px = o.x * SUB;
          py = o.y * SUB - PLAYER_HH;
          break;
        case 'finish':
          this.finishes.push({ x: o.x * SUB, y: o.y * SUB });
          break;
        case 'box':
          this.boxes.push(this.makeBody(o.id, o.x * SUB, o.y * SUB - BOX_H, BOX_H, BOX_H, { held: false }) as Box);
          break;
        case 'plate':
          this.plates.push({ id: o.id, x: o.x * SUB, y: o.y * SUB, channel: o.channel, pressed: false });
          break;
        case 'door': {
          const d: DoorState = { id: o.id, cx: o.cx, cy: o.cy, channel: o.channel, open: false };
          this.doors.push(d);
          this.doorAt.set(cellKey(o.cx, o.cy), d);
          break;
        }
        case 'dispenser':
          this.dispensers.push(this.makeDispenser(o));
          break;
      }
    }
    this.buildGrid();
    this.player = this.makeBody(0, px, py, PLAYER_HW, PLAYER_HH, {
      coyote: 0, jumpBuf: 0, jumping: false, holding: null, facing: 1, aimX: 1, aimY: 0,
    }) as Player;
    for (const d of this.dispensers) d.on = d.defaultOn;
  }

  private buildGrid(): void {
    const keys = [...this.tiles.keys(), ...this.doorAt.keys()];
    if (!keys.length) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const k of keys) {
      const cx = keyCx(k);
      const cy = keyCy(k);
      if (cx < x0) x0 = cx;
      if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy;
      if (cy > y1) y1 = cy;
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    // a sprawling level keeps using the maps rather than a huge array
    if (w * h > 4_000_000) return;
    const grid = new Uint8Array(w * h);
    for (const [k] of this.tiles) grid[(keyCy(k) - y0) * w + keyCx(k) - x0] = this.slopes.get(k) ? this.slopes.get(k)! + 1 : 1;
    for (const [k] of this.doorAt) grid[(keyCy(k) - y0) * w + keyCx(k) - x0] = 6;
    this.grid = grid;
    this.gx0 = x0;
    this.gy0 = y0;
    this.gw = w;
    this.gh = h;
  }

  /**
   * Key of the 4px spot a drop sits in, for spreading. Small integers inside the level's box
   * (fast to hash); anything outside falls back to a cell-style key, which never collides with them.
   */
  private spotKey(pt: Particle): number {
    const sx = fdiv(pt.x, 4 * SUB);
    const sy = fdiv(pt.y, 4 * SUB);
    if (this.grid) {
      const x = sx - this.gx0 * 8;
      const y = sy - this.gy0 * 8;
      const w = this.gw * 8;
      if (x >= 0 && y >= 0 && x < w && y < this.gh * 8) return y * w + x;
    }
    return -1 - cellKey(sx, sy);
  }

  /** What is in a cell: 0 empty, 1 block, 2..5 slope (shape + 1), 6 door. */
  private cellCode(cx: number, cy: number): number {
    const g = this.grid;
    if (g) {
      const x = cx - this.gx0;
      const y = cy - this.gy0;
      return x < 0 || y < 0 || x >= this.gw || y >= this.gh ? 0 : g[y * this.gw + x];
    }
    const k = cellKey(cx, cy);
    const t = this.tiles.get(k);
    if (t !== undefined) return this.slopes.has(k) ? this.slopes.get(k)! + 1 : 1;
    return this.doorAt.has(k) ? 6 : 0;
  }

  private makeBody<E extends object>(id: number, x: number, y: number, hw: number, hh: number, extra: E): Body & E {
    return { id, x, y, vx: 0, vy: 0, hw, hh, ground: false, groundPaint: 0, groundSlope: 0, teleports: 0, ...extra };
  }

  private makeDispenser(o: DispenserObj): DispenserState {
    return {
      id: o.id, x: o.x * SUB, y: o.y * SUB, liquid: o.liquid, channel: o.channel,
      defaultOn: o.defaultOn, dir: o.dir, cap: o.cap, on: o.defaultOn, alive: 0, poured: 0, fifo: [],
    };
  }

  // ------------------------------------------------------------------ step

  step(input: TickInput): void {
    if (this.finished) return;
    const bits = input.bits & IN_MASK;
    if (!this.started) {
      // nothing moves and the clock does not run until the player acts
      if (!bits) return;
      this.started = true;
    }
    this.updateSwitches();

    const pressed = bits & ~this.prevBits;
    this.prevBits = bits;
    const p = this.player;
    p.aimX = clamp(input.ax | 0, -AIM_LIMIT, AIM_LIMIT);
    p.aimY = clamp(input.ay | 0, -AIM_LIMIT, AIM_LIMIT);

    if (pressed & IN_USE) this.toggleHold();
    if (!p.holding) {
      if (pressed & IN_FIRE_A) this.firePortal(0);
      if (pressed & IN_FIRE_B) this.firePortal(1);
    }

    this.stepPlayer(bits, pressed);
    this.stepBoxes();
    this.stepDispensers();
    this.stepParticles();

    this.tick++;
    for (const f of this.finishes) {
      if (overlaps(p, f.x - FINISH_HW, f.y - FINISH_H, f.x + FINISH_HW, f.y)) {
        this.finished = true;
        this.finishTick = this.tick;
        break;
      }
    }
  }

  // ------------------------------------------------------- plates, doors

  private updateSwitches(): void {
    const total = new Array(CHANNEL_COUNT).fill(0);
    const down = new Array(CHANNEL_COUNT).fill(0);
    for (const pl of this.plates) {
      const x0 = pl.x - PLATE_HW;
      const x1 = pl.x + PLATE_HW;
      const y0 = pl.y - PLATE_SENSE_H;
      const y1 = pl.y;
      let pressed = overlaps(this.player, x0, y0, x1, y1);
      if (!pressed) for (const b of this.boxes) if (overlaps(b, x0, y0, x1, y1)) { pressed = true; break; }
      pl.pressed = pressed;
      total[pl.channel]++;
      if (pressed) down[pl.channel]++;
    }
    for (let c = 0; c < CHANNEL_COUNT; c++) this.channelActive[c] = total[c] > 0 && down[c] === total[c];

    for (const d of this.doors) {
      const want = this.channelActive[d.channel];
      if (want && !d.open) this.wakeAll();
      if (want) d.open = true;
      else if (d.open) {
        const x0 = d.cx * T;
        const y0 = d.cy * T;
        let blocked = overlaps(this.player, x0, y0, x0 + T, y0 + T);
        if (!blocked) for (const b of this.boxes) if (overlaps(b, x0, y0, x0 + T, y0 + T)) { blocked = true; break; }
        if (!blocked) {
          if (d.open) this.wakeAll();
          d.open = false;
          for (const pt of this.particles) {
            if (!pt.dead && overlaps(pt, x0, y0, x0 + T, y0 + T)) this.killParticle(pt);
          }
        }
      }
    }
    for (const ds of this.dispensers) ds.on = ds.defaultOn !== this.channelActive[ds.channel];
  }

  // -------------------------------------------------------------- player

  private stepPlayer(bits: number, pressed: number): void {
    const p = this.player;
    const dir = (bits & IN_RIGHT ? 1 : 0) - (bits & IN_LEFT ? 1 : 0);
    const slippery = p.ground && p.groundPaint === BLUE;
    if (p.ground) p.coyote = COYOTE_TICKS;
    else if (p.coyote > 0) p.coyote--;
    if (dir !== 0) p.facing = dir;

    if (dir !== 0) {
      const accel = p.ground ? (slippery ? SLIP_ACCEL : GROUND_ACCEL) : AIR_ACCEL;
      if (dir * p.vx < RUN_SPEED) {
        p.vx += dir * accel;
        if (dir * p.vx > RUN_SPEED) p.vx = dir * RUN_SPEED;
      } else if (p.ground && !slippery) {
        // above run speed on normal ground: bleed off gently
        p.vx -= dir * Math.min(OVERSPEED_FRICTION, dir * p.vx - RUN_SPEED);
      }
    } else if (p.ground) {
      p.vx = towardsZero(p.vx, slippery ? SLIP_FRICTION : GROUND_FRICTION);
    }
    // on a blue slope there is no grip: you slide down it
    if (slippery && p.groundSlope) p.vx += p.groundSlope * SLOPE_ACCEL;

    if (pressed & IN_JUMP) p.jumpBuf = JUMP_BUFFER_TICKS;
    else if (p.jumpBuf > 0) p.jumpBuf--;
    if (p.jumpBuf > 0 && p.coyote > 0) {
      p.vy = Math.min(p.vy, JUMP_V);
      p.jumping = true;
      p.coyote = 0;
      p.jumpBuf = 0;
    }
    if (p.jumping && p.vy >= 0) p.jumping = false;
    p.vy += GRAVITY;
    // short hop: letting go of jump while rising from a jump falls sooner
    if (p.jumping && !(bits & IN_JUMP)) p.vy += GRAVITY;

    const obstacles = this.boxes.filter((b) => !b.held);
    if (!p.ground) this.magnetise(p, obstacles);
    const before = p.teleports;
    this.moveBody(p, obstacles, true);
    if (p.teleports !== before) {
      p.jumping = false;
      const held = p.holding;
      if (held) {
        held.x = p.x;
        held.y = p.y;
        held.vx = p.vx;
        held.vy = p.vy;
      }
    }
  }

  private aimUnit(dist: number): [number, number] {
    const p = this.player;
    let ax = p.aimX;
    let ay = p.aimY;
    if (ax === 0 && ay === 0) ax = p.facing;
    const len = isqrt(ax * ax + ay * ay);
    return [idiv(ax * dist, len), idiv(ay * dist, len)];
  }

  private toggleHold(): void {
    const p = this.player;
    if (p.holding) {
      p.holding.held = false;
      p.holding = null;
      return;
    }
    let best: Box | null = null;
    let bestD = 0;
    for (const b of this.boxes) {
      const dx = b.x - p.x;
      const dy = b.y - p.y;
      if (Math.abs(dx) > GRAB_RANGE || Math.abs(dy) > GRAB_RANGE) continue;
      const qx = idiv(dx, SUB);
      const qy = idiv(dy, SUB);
      const di = qx * qx + qy * qy;
      if (!best || di < bestD) {
        best = b;
        bestD = di;
      }
    }
    if (best) {
      best.held = true;
      p.holding = best;
    }
  }

  // --------------------------------------------------------------- boxes

  private stepBoxes(): void {
    const p = this.player;
    for (const b of this.boxes) {
      const others = this.boxes.filter((o) => o !== b);
      if (b.held) {
        const [ox, oy] = this.aimUnit(HOLD_DIST);
        const tx = p.x + ox;
        const ty = p.y + oy;
        // a held box never moves much faster than the player carrying it, so it can't be flung
        b.vx = clamp(clamp(idiv(tx - b.x, 2), p.vx - HOLD_REL_SPEED, p.vx + HOLD_REL_SPEED), -MAX_SPEED, MAX_SPEED);
        b.vy = clamp(clamp(idiv(ty - b.y, 2), p.vy - HOLD_REL_SPEED, p.vy + HOLD_REL_SPEED), -MAX_SPEED, MAX_SPEED);
        this.moveBody(b, others, false);
        b.ground = false;
        if (Math.abs(b.x - p.x) > HOLD_DROP || Math.abs(b.y - p.y) > HOLD_DROP) {
          b.held = false;
          p.holding = null;
        }
      } else {
        if (b.ground && b.groundSlope) b.vx += b.groundSlope * SLOPE_ACCEL; // boxes slide down slopes
        else if (b.ground) b.vx = towardsZero(b.vx, b.groundPaint === BLUE ? SLIP_FRICTION : BOX_FRICTION);
        b.vy += GRAVITY;
        if (!b.ground) this.magnetise(b, others);
        this.moveBody(b, others, true);
      }
    }
  }

  // ---------------------------------------------------------- dispensers

  private stepDispensers(): void {
    if (this.tick % EMIT_EVERY !== 0) return;
    for (let di = 0; di < this.dispensers.length; di++) {
      const d = this.dispensers[di];
      if (!d.on) continue;
      const x = d.x + DX[d.dir] * EMIT_OFFSET;
      const y = d.y + DY[d.dir] * EMIT_OFFSET;
      const pt: Particle = {
        id: 0, x, y, vx: DX[d.dir] * EMIT_SPEED, vy: DY[d.dir] * EMIT_SPEED, hw: PARTICLE_H, hh: PARTICLE_H,
        ground: false, groundPaint: 0, groundSlope: 0, teleports: 0, color: d.liquid, dead: false, seq: this.particleSeq++, owner: di,
        asleep: false, restKey: -1, spot: 0,
      };
      if (this.overlapsSolid(pt)) continue;
      const spread = (nextRandom(this) % 193) - 96;
      if (d.dir === 0 || d.dir === 2) pt.vy += spread;
      else pt.vx += spread;
      d.fifo.push(pt);
      d.alive++;
      d.poured++;
      this.particles.push(pt);
      this.liquidAlive++;
      while (d.alive > d.cap) {
        const oldest = d.fifo.shift()!;
        if (!oldest.dead) this.killParticle(oldest);
      }
      // the whole level holds a limited amount of liquid: the oldest drop anywhere goes
      while (this.liquidAlive > LEVEL_LIQUID_CAP) {
        while (this.particles[this.oldestIndex].dead) this.oldestIndex++;
        this.killParticle(this.particles[this.oldestIndex]);
      }
      if (d.fifo.length > d.cap * 2) d.fifo = d.fifo.filter((q) => !q.dead);
    }
  }

  private killParticle(pt: Particle): void {
    if (pt.dead) return;
    if (pt.asleep) this.unrest(pt);
    pt.dead = true;
    this.dispensers[pt.owner].alive--;
    this.liquidAlive--;
  }

  /** Wakes every drop resting on a face whose paint just changed. */
  private wakeFace(fk: number): void {
    const list = this.sleepers.get(fk);
    if (!list) return;
    for (const pt of list) if (pt.asleep) this.unrest(pt);
    this.sleepers.delete(fk);
  }

  /** Wakes every drop: something that could support or swallow them changed (a door, a portal). */
  private wakeAll(): void {
    if (!this.sleepers.size) return;
    for (const pt of this.particles) pt.asleep = false;
    this.sleepers.clear();
    this.restingSpots.clear();
  }

  /** A sleeping drop wakes: it no longer holds its spot. */
  private unrest(pt: Particle): void {
    pt.asleep = false;
    const n = this.restingSpots.get(pt.spot)! - 1;
    if (n) this.restingSpots.set(pt.spot, n);
    else this.restingSpots.delete(pt.spot);
  }

  // ----------------------------------------------------------- particles

  private stepParticles(): void {
    const settling = this.settling;
    settling.length = 0;
    for (const pt of this.particles) {
      if (pt.dead || pt.asleep) {
        settling.push(null);
        continue;
      }
      // liquid runs down slopes
      if (pt.ground && pt.groundSlope) pt.vx = clamp(pt.vx + pt.groundSlope * SLOPE_ACCEL, -MAX_SPEED, MAX_SPEED);
      pt.vy = clamp(pt.vy + PARTICLE_GRAVITY, -MAX_SPEED, MAX_SPEED);
      pt.restKey = -1;
      const tele = pt.teleports;
      this.moveParticle(pt);
      // came to rest on a flat face: it may sleep, unless it has to step aside below
      settling.push(!pt.dead && pt.ground && !pt.groundSlope && pt.vx === 0 && pt.vy === 0 && pt.teleports === tele && pt.restKey >= 0 ? pt : null);
    }
    // liquid spreading: a drop that lands on a 4px spot already taken steps sideways.
    // Settled (sleeping) drops hold their spots and never move; only drops still awake step aside.
    // spots held by sleeping drops are kept up to date as they sleep and wake
    const resting = this.restingSpots;
    const taken = this.spreadTaken;
    taken.clear();
    const cell = 4 * SUB;
    for (let i = 0; i < this.particles.length; i++) {
      const pt = this.particles[i];
      if (pt.dead || pt.asleep) continue;
      const k = this.spotKey(pt);
      if ((taken.has(k) || resting.has(k)) && pt.ground) {
        // step aside onto a free spot (its preferred side first); with both taken it stays put
        const first = pt.seq & 1 ? cell : -cell;
        for (const d of [first, -first]) {
          pt.x += d;
          const sk = this.spotKey(pt);
          const free = !taken.has(sk) && !resting.has(sk);
          pt.x -= d;
          if (!free) continue;
          this.moveAxis(pt, d, 0, NO_OBSTACLES);
          // it may be over an edge now: let it fall next tick rather than sleep in the air
          settling[i] = null;
          break;
        }
      }
      taken.add(this.spotKey(pt));
      const rest = settling[i];
      if (rest) {
        rest.asleep = true;
        rest.spot = this.spotKey(rest);
        resting.set(rest.spot, (resting.get(rest.spot) ?? 0) + 1);
        const list = this.sleepers.get(rest.restKey);
        if (list) list.push(rest);
        else this.sleepers.set(rest.restKey, [rest]);
      }
    }
    if (this.particles.length > 64 && this.tick % 30 === 0) {
      this.particles = this.particles.filter((q) => !q.dead);
      this.oldestIndex = 0;
      // rebuild the sleeper index so it does not hold on to dead or woken drops
      this.sleepers.clear();
      for (const pt of this.particles) {
        if (!pt.asleep) continue;
        const list = this.sleepers.get(pt.restKey);
        if (list) list.push(pt);
        else this.sleepers.set(pt.restKey, [pt]);
      }
    }
  }

  /**
   * Drops move in one sweep per tick (the sweep checks every cell on the way, so nothing is
   * skipped through); bodies use sub-steps for magnetism and portal mouths, drops need not.
   */
  private moveParticle(pt: Particle): void {
    pt.ground = false;
    pt.groundSlope = 0;
    const portals = !!(this.portals[0] && this.portals[1]);
    if (!portals) {
      // open air: if every cell the move could touch is empty, nothing can stop it
      const nx = pt.x + pt.vx;
      const ny = pt.y + pt.vy;
      const cx0 = fdiv(Math.min(pt.x, nx) - pt.hw, T);
      const cx1 = fdiv(Math.max(pt.x, nx) + pt.hw, T);
      const cy0 = fdiv(Math.min(pt.y, ny) - pt.hh, T);
      const cy1 = fdiv(Math.max(pt.y, ny) + pt.hh, T);
      let clear = true;
      for (let cy = cy0; cy <= cy1 && clear; cy++) for (let cx = cx0; cx <= cx1; cx++) if (this.cellCode(cx, cy) !== 0) { clear = false; break; }
      if (clear) {
        pt.x = nx;
        pt.y = ny;
        return;
      }
    }
    const d0 = portals ? this.portalDepths(pt) : NO_DEPTHS;
    this.moveAxis(pt, pt.vx, 0, NO_OBSTACLES);
    if (this.hitBlocked && this.particleHit(pt, 0)) return;
    this.moveAxis(pt, pt.vy, 1, NO_OBSTACLES);
    if (this.hitBlocked && this.particleHit(pt, 1)) return;
    if (portals) this.checkTeleport(pt, d0);
  }

  /** Returns true if the particle was consumed by painting. */
  private particleHit(pt: Particle, axis: number): boolean {
    if (this.hitTile) {
      const fk = this.hitKey * 4 + this.hitFace;
      const base = this.baseOf(fk);
      const colour = this.paint.get(fk) ?? base;
      if (colour !== pt.color) {
        if (pt.color === WHITE && base === WHITE) this.paint.delete(fk);
        else this.paint.set(fk, pt.color);
        this.wakeFace(fk);
        this.killParticle(pt);
        return true;
      }
    }
    if (axis === 0) pt.vx = 0;
    else {
      if (pt.vy > 0) {
        pt.ground = true;
        pt.restKey = this.hitTile ? this.hitKey * 4 + this.hitFace : -1;
        const shape = this.hitSlope;
        pt.groundSlope = shape && SLOPE_NORMALS[shape - 1][1] < 0 ? SLOPE_NORMALS[shape - 1][0] : 0;
        if (!pt.groundSlope) pt.vx = towardsZero(pt.vx, pt.color === BLUE ? 12 : 40);
      }
      pt.vy = 0;
    }
    return false;
  }

  // ------------------------------------------------------------- portals

  private shotSolid(cx: number, cy: number): boolean {
    const k = cellKey(cx, cy);
    if (this.tiles.has(k)) return !this.slopes.has(k); // slopes are checked point by point
    const d = this.doorAt.get(k);
    return !!d && !d.open;
  }

  firePortal(i: number): void {
    const p = this.player;
    const ax = p.aimX;
    const ay = p.aimY;
    const len = isqrt(ax * ax + ay * ay);
    if (len === 0) return;
    const sx = idiv(ax * SUB, len);
    const sy = idiv(ay * SUB, len);
    if (sx === 0 && sy === 0) return;
    let x = p.x;
    let y = p.y;
    let pcx = fdiv(x, T);
    let pcy = fdiv(y, T);
    const x0 = x;
    const y0 = y;
    for (let s = 0; s < SHOT_STEPS; s++) {
      x += sx;
      y += sy;
      const cx = fdiv(x, T);
      const cy = fdiv(y, T);
      const shape = this.slopes.get(cellKey(cx, cy));
      if (shape && insideSlope(x, y, cx, cy, shape)) {
        const entered = cx !== pcx || cy !== pcy;
        // straight in through a flat side, or onto the sloped face from inside the cell
        const sface = !entered ? -1 : cx !== pcx ? (cx > pcx ? 2 : 0) : cy > pcy ? 3 : 1;
        const ok = sface >= 0
          ? this.placePortal(i, cx, cy, sface, sface === 0 || sface === 2 ? y : x)
          : this.placeDiagonal(i, cx, cy, shape, x, y);
        this.lastShot = { portal: i, x0, y0, x1: x, y1: y, ok, tick: this.tick };
        return;
      }
      if (cx === pcx && cy === pcy) continue;
      let hx = cx;
      let hy = cy;
      let face: number;
      if (cx !== pcx && cy !== pcy) {
        if (this.shotSolid(cx, pcy)) { hy = pcy; face = cx > pcx ? 2 : 0; }
        else if (this.shotSolid(pcx, cy)) { hx = pcx; face = cy > pcy ? 3 : 1; }
        else if (this.shotSolid(cx, cy)) face = cx > pcx ? 2 : 0;
        else { pcx = cx; pcy = cy; continue; }
      } else if (cx !== pcx) {
        if (!this.shotSolid(cx, cy)) { pcx = cx; continue; }
        face = cx > pcx ? 2 : 0;
      } else {
        if (!this.shotSolid(cx, cy)) { pcy = cy; continue; }
        face = cy > pcy ? 3 : 1;
      }
      const hitT = face === 0 || face === 2 ? y : x;
      const ok = this.placePortal(i, hx, hy, face, hitT);
      this.lastShot = { portal: i, x0, y0, x1: x, y1: y, ok, tick: this.tick };
      return;
    }
    this.lastShot = { portal: i, x0, y0, x1: x, y1: y, ok: false, tick: this.tick };
  }

  /** A face's bare colour, WHITE or DARK, before any paint. */
  baseOf(fk: number): number {
    return this.faceBase.get(fk) ?? (this.tiles.get(Math.floor(fk / 4)) === WHITE_WALL ? WHITE : DARK);
  }

  isPortalable(cx: number, cy: number, face: number): boolean {
    const k = cellKey(cx, cy);
    if (!this.tiles.has(k)) return false;
    const shape = this.slopes.get(k);
    // a slope's flat sides work like any wall; its sloped face takes no flat portal
    if (shape && isOpenFace(shape, face)) return false;
    const fk = k * 4 + face;
    return this.baseOf(fk) === WHITE || this.paint.get(fk) === WHITE;
  }

  private validPair(i: number, sx: number, sy: number, n: number, tx: number, ty: number): boolean {
    const other = this.portals[1 - i];
    for (let j = 0; j < 2; j++) {
      const cx = sx + j * tx;
      const cy = sy + j * ty;
      if (this.doorAt.has(cellKey(cx, cy))) return false;
      if (!this.isPortalable(cx, cy, n)) return false;
      const fk = cellKey(cx + DX[n], cy + DY[n]);
      if (this.tiles.has(fk) || this.doorAt.has(fk)) return false;
      if (other && (other.n === n || isDiagonal(other)) && portalCovers(other, cx, cy)) return false;
    }
    return true;
  }

  private placePortal(i: number, cx: number, cy: number, n: number, hitT: number): boolean {
    if (this.doorAt.has(cellKey(cx, cy))) return false;
    const horizontalNormal = n === 0 || n === 2;
    const tx = horizontalNormal ? 0 : 1;
    const ty = horizontalNormal ? 1 : 0;
    const cellStart = horizontalNormal ? cy * T : cx * T;
    const lowFirst = hitT - cellStart < T / 2;
    const candidates: [number, number][] = lowFirst
      ? [[cx - tx, cy - ty], [cx, cy]]
      : [[cx, cy], [cx - tx, cy - ty]];
    for (const [sx, sy] of candidates) {
      if (!this.validPair(i, sx, sy, n, tx, ty)) continue;
      const old = this.portals[i];
      const hadBoth = !!(this.portals[0] && this.portals[1]);
      this.portals[i] = makePortal(sx, sy, n);
      this.wakeAll();
      if (old && hadBoth) this.unstickAll(old);
      return true;
    }
    return false;
  }

  /**
   * A shot on a slope's sloped face: the portal needs this slope and the next one along the
   * line (same shape, white), with open space in front of both.
   */
  private placeDiagonal(i: number, cx: number, cy: number, shape: number, hx: number, hy: number): boolean {
    const [nx, ny] = SLOPE_NORMALS[shape - 1];
    // which neighbour along the face first: the one on the side of the cell the shot hit
    const u = -ny * (hx - (cx * T + T / 2)) + nx * (hy - (cy * T + T / 2));
    const starts: [number, number][] = u >= 0 ? [[cx, cy], [cx + ny, cy - nx]] : [[cx + ny, cy - nx], [cx, cy]];
    const other = this.portals[1 - i];
    for (const [sx, sy] of starts) {
      const pair: [number, number][] = [[sx, sy], [sx - ny, sy + nx]];
      const ok = pair.every(([x, y]) => {
        const k = cellKey(x, y);
        if (this.slopes.get(k) !== shape || this.doorAt.has(k)) return false;
        const fk = k * 4 + hypFace(shape);
        if (this.baseOf(fk) !== WHITE && this.paint.get(fk) !== WHITE) return false;
        // the space in front of the sloped face must be open
        for (const [fx, fy] of [[x + nx, y], [x, y + ny]]) {
          const f = cellKey(fx, fy);
          if (this.tiles.has(f) || this.doorAt.has(f)) return false;
        }
        return !(other && portalCovers(other, x, y));
      });
      if (!ok) continue;
      const old = this.portals[i];
      const hadBoth = !!(this.portals[0] && this.portals[1]);
      this.portals[i] = makeDiagonalPortal(sx, sy, shape);
      this.wakeAll();
      if (old && hadBoth) this.unstickAll(old);
      return true;
    }
    return false;
  }

  private unstickAll(old: Portal): void {
    const bodies: Body[] = [this.player, ...this.boxes];
    for (const b of bodies) {
      if (!this.overlapsSolid(b)) continue;
      const ox = b.x;
      const oy = b.y;
      let freed = false;
      for (let px = 1; px <= 80 && !freed; px++) {
        b.x = ox + old.nx * px * SUB;
        b.y = oy + old.ny * px * SUB;
        freed = !this.overlapsSolid(b);
      }
      if (!freed) {
        b.x = ox;
        b.y = oy;
      }
    }
    for (const pt of this.particles) if (!pt.dead && this.overlapsSolid(pt)) this.killParticle(pt);
  }

  /**
   * Portal magnetism. An airborne body heading into a portal, but off to one side so it
   * would clip the edge, is slid sideways towards the centre until it fits the mouth.
   * Only position is nudged (through normal collision), never velocity, so momentum and
   * flings are untouched and already-aligned bodies are not affected at all.
   */
  magnetise(b: Body, obstacles: Body[] = NO_OBSTACLES): void {
    const a = this.portals[0];
    const c = this.portals[1];
    if (!a || !c) return;
    let best: Portal | null = null;
    let bestD = 0;
    let bestInto = 0;
    for (const p of [a, c]) {
      const into = -(p.nx * b.vx + p.ny * b.vy);
      if (into < MAG_MIN_INTO) continue;
      const d = depth(b, p);
      // diagonal portals measure in sqrt 2 units, so their reach is scaled to match
      const scale = Math.abs(p.nx) + Math.abs(p.ny);
      if (d < 0 || d > MAG_RANGE * scale) continue;
      const u = portalAlong(p, b.x, b.y);
      if (u > MAG_WIDTH * scale || u < -MAG_WIDTH * scale) continue;
      if (!best || d < bestD) {
        best = p;
        bestD = d;
        bestInto = into;
      }
    }
    if (!best) return;
    const u = portalAlong(best, b.x, b.y);
    const ext = alongExtent(best, b);
    const margin = 2 * SUB * (Math.abs(best.nx) + Math.abs(best.ny));
    let need = 0;
    if (u - ext < -best.half + margin) need = Math.min(-best.half + margin - (u - ext), -u);
    else if (u + ext > best.half - margin) need = Math.max(best.half - margin - (u + ext), -u);
    if (need === 0) return;
    // slide fast enough to fit the mouth before the leading edge reaches the face
    const ticksLeft = Math.max(1, idiv(bestD - acrossExtent(best, b), bestInto));
    const step = clamp(idiv(Math.abs(need) + ticksLeft - 1, ticksLeft), MAG_STEP, MAG_MAX_STEP);
    const k = clamp(need, -step, step);
    // move along the face: the tangent is (-ny, nx); a diagonal one moves on both axes
    if (best.ny) this.moveAxis(b, -best.ny * (best.nx ? idiv(k, 2) : k), 0, obstacles);
    if (best.nx) this.moveAxis(b, best.nx * (best.ny ? idiv(k, 2) : k), 1, obstacles);
  }

  private holeFor(cx: number, cy: number, b: Body): boolean {
    const a = this.portals[0];
    const c = this.portals[1];
    if (!a || !c) return false;
    // a held box never goes through on its own: it is carried across with the player
    if ((b as Box).held) return false;
    return (portalCovers(a, cx, cy) && inMouth(b, a)) || (portalCovers(c, cx, cy) && inMouth(b, c));
  }

  private portalDepths(b: Body): [number, number] {
    const a = this.portals[0];
    const c = this.portals[1];
    if (!a || !c) return [0, 0];
    return [depth(b, a), depth(b, c)];
  }

  private checkTeleport(b: Body, before: [number, number]): void {
    const a = this.portals[0];
    const c = this.portals[1];
    if (!a || !c || (b as Box).held) return;
    for (let i = 0; i < 2; i++) {
      const pin = i === 0 ? a : c;
      const pout = i === 0 ? c : a;
      if (before[i] < 0) continue;
      const d = depth(b, pin);
      if (d >= 0 || d <= -T || !aligned(b, pin)) continue;
      this.teleport(b, pin, pout);
      return;
    }
  }

  private teleport(b: Body, pin: Portal, pout: Portal): void {
    const m = portalMatrix(pin.ang, pout.ang);
    const [rx, ry] = applyMatrix(m, b.x - pin.px, b.y - pin.py);
    b.x = pout.px + rx;
    b.y = pout.py + ry;
    const [vx, vy] = applyMatrix(m, b.vx, b.vy);
    b.vx = clamp(vx, -MAX_SPEED, MAX_SPEED);
    b.vy = clamp(vy, -MAX_SPEED, MAX_SPEED);
    // fit the mouth, then make sure the centre is not behind the exit face
    const n2 = pout.nx * pout.nx + pout.ny * pout.ny;
    const room = pout.half - alongExtent(pout, b);
    const u = portalAlong(pout, b.x, b.y);
    const want = clamp(u, -room, room);
    if (want !== u) {
      const k = idiv(want - u, n2);
      b.x += -pout.ny * k;
      b.y += pout.nx * k;
    }
    const d = depth(b, pout);
    if (d < 0) {
      const k = idiv(-d + n2 - 1, n2);
      b.x += pout.nx * k;
      b.y += pout.ny * k;
    }
    b.teleports++;
    if (b === this.player) this.lastPlayerTeleport = { angIn: pin.ang, angOut: pout.ang, inP: pin, outP: pout };
  }

  // ------------------------------------------------------------ collision

  /** Full-cell solidity. Slope cells are not solid here: their triangle is handled separately. */
  isSolid(cx: number, cy: number, b: Body): boolean {
    const code = this.cellCode(cx, cy);
    if (code === 0) return false;
    if (code === 1) return !this.holeFor(cx, cy, b);
    if (code === 6) return !this.doorAt.get(cellKey(cx, cy))!.open;
    return false;
  }

  overlapsSolid(b: Body): boolean {
    const cx0 = fdiv(b.x - b.hw, T);
    const cx1 = fdiv(b.x + b.hw - 1, T);
    const cy0 = fdiv(b.y - b.hh, T);
    const cy1 = fdiv(b.y + b.hh - 1, T);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        if (this.isSolid(cx, cy, b)) return true;
        const code = this.cellCode(cx, cy);
        const shape = code >= 2 && code <= 5 ? code - 1 : 0;
        if (shape && !this.holeFor(cx, cy, b) && slopeOverlap(b.x - b.hw, b.y - b.hh, b.x + b.hw, b.y + b.hh, cx, cy, shape) < 0) return true;
      }
    }
    return false;
  }

  /**
   * Moves a body along one axis, stopping at the first solid cell or obstacle ahead.
   * Only things fully ahead of the leading edge can block, so a body that is already
   * overlapping something (for example after a portal closes) never gets snapped.
   */
  private moveAxis(b: Body, delta: number, axis: number, obstacles: Body[]): void {
    this.hitBlocked = false;
    this.hitPaint = 0;
    this.hitKey = -1;
    this.hitTile = false;
    this.hitSlope = 0;
    if (delta === 0) return;
    const pos = axis === 0 ? b.x : b.y;
    const half = axis === 0 ? b.hw : b.hh;
    const ohalf = axis === 0 ? b.hh : b.hw;
    const opos = axis === 0 ? b.y : b.x;
    const o0 = opos - ohalf;
    const o1 = opos + ohalf;
    const oc0 = fdiv(o0, T);
    const oc1 = fdiv(o1 - 1, T);
    const sign = delta > 0 ? 1 : -1;
    const oldEdge = pos + sign * half;
    const newEdge = oldEdge + delta;
    let limit = newEdge;
    const face = axis === 0 ? (sign > 0 ? 2 : 0) : sign > 0 ? 3 : 1;

    // cells strictly ahead of the old leading edge
    let c = sign > 0 ? -fdiv(-oldEdge, T) : fdiv(oldEdge, T) - 1;
    const cEnd = sign > 0 ? fdiv(newEdge - 1, T) : fdiv(newEdge, T);
    for (; sign > 0 ? c <= cEnd : c >= cEnd; c += sign) {
      let found = false;
      for (let oc = oc0; oc <= oc1; oc++) {
        const cx = axis === 0 ? c : oc;
        const cy = axis === 0 ? oc : c;
        if (!this.isSolid(cx, cy, b)) continue;
        const k = cellKey(cx, cy);
        const isTile = this.cellCode(cx, cy) === 1;
        const pnt = isTile ? this.paint.get(k * 4 + face) ?? 0 : 0;
        if (!found) {
          found = true;
          this.hitKey = isTile ? k : -1;
          this.hitTile = isTile;
          this.hitPaint = pnt;
        } else if (pnt === ORANGE || (pnt === BLUE && this.hitPaint !== ORANGE)) {
          this.hitPaint = pnt;
        }
      }
      if (found) {
        limit = sign > 0 ? c * T : (c + 1) * T;
        this.hitBlocked = true;
        this.hitFace = face;
        break;
      }
    }

    // slope cells: first contact with the triangle, worked out exactly along this axis
    if (this.slopes.size) {
      const cFrom = sign > 0 ? fdiv(oldEdge - 1, T) : fdiv(oldEdge, T);
      const cTo = sign > 0 ? fdiv(limit - 1, T) : fdiv(limit, T);
      for (let ca = cFrom; sign > 0 ? ca <= cTo : ca >= cTo; ca += sign) {
        for (let oc = oc0; oc <= oc1; oc++) {
          const cx = axis === 0 ? ca : oc;
          const cy = axis === 0 ? oc : ca;
          const code = this.cellCode(cx, cy);
          if (code < 2 || code > 5 || this.holeFor(cx, cy, b)) continue;
          const shape = code - 1;
          const k = cellKey(cx, cy);
          const hit = slopeContact(pos, half, o0, o1, axis, sign, delta, ca, oc, shape);
          if (hit === null) continue;
          const edge = oldEdge + sign * hit.t;
          if (sign > 0 ? edge >= limit : edge <= limit) continue;
          limit = edge;
          this.hitBlocked = true;
          this.hitTile = true;
          this.hitKey = k;
          this.hitFace = hit.leg ? face : hypFace(shape);
          this.hitSlope = hit.leg ? 0 : shape;
          this.hitPaint = this.paint.get(k * 4 + this.hitFace) ?? 0;
        }
      }
    }

    for (const o of obstacles) {
      const op = axis === 0 ? o.y : o.x;
      const oh = axis === 0 ? o.hh : o.hw;
      if (op - oh >= o1 || op + oh <= o0) continue;
      const opos2 = axis === 0 ? o.x : o.y;
      const ohalf2 = axis === 0 ? o.hw : o.hh;
      const edge = opos2 - sign * ohalf2;
      if (sign > 0 ? edge >= oldEdge && edge < limit : edge <= oldEdge && edge > limit) {
        limit = edge;
        this.hitBlocked = true;
        this.hitTile = false;
        this.hitKey = -1;
        this.hitPaint = 0;
        this.hitSlope = 0;
      }
    }

    const np = limit - sign * half;
    if (axis === 0) b.x = np;
    else b.y = np;
  }

  private moveBody(b: Body, obstacles: Body[], bounce: boolean): void {
    const wasGround = b.ground && b.vy >= 0;
    const tele0 = b.teleports;
    b.ground = false;
    b.groundPaint = 0;
    b.groundSlope = 0;
    b.vx = clamp(b.vx, -MAX_SPEED, MAX_SPEED);
    b.vy = clamp(b.vy, -MAX_SPEED, MAX_SPEED);
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.vx), Math.abs(b.vy)) / SUBSTEP));
    for (let i = 0; i < steps; i++) {
      const sx = idiv(b.vx, steps);
      const sy = idiv(b.vy, steps);
      const d0 = this.portalDepths(b);
      const x0 = b.x;
      this.moveAxis(b, sx, 0, obstacles);
      if (this.hitBlocked) {
        const shape = this.hitSlope;
        if (shape && bounce && this.hitPaint === ORANGE && reflectOff(b, shape)) {
          // bounced off the sloped face
        } else if (shape) {
          // run up (or along) the sloped face with the distance left over
          const left = Math.abs(sx) - Math.abs(b.x - x0);
          const ny = SLOPE_NORMALS[shape - 1][1];
          this.moveAxis(b, ny * left, 1, obstacles);
          if (!this.hitBlocked) this.moveAxis(b, Math.sign(sx) * left, 0, obstacles);
          if (this.hitBlocked && b.x === x0) b.vx = 0;
        } else if (bounce && this.hitPaint === ORANGE && Math.abs(b.vx) > BOUNCE_MIN) b.vx = -b.vx; // orange keeps all its speed
        else b.vx = 0;
      }
      this.moveAxis(b, sy, 1, obstacles);
      if (this.hitBlocked) {
        const shape = this.hitSlope;
        if (shape && bounce && this.hitPaint === ORANGE && reflectOff(b, shape)) {
          // bounced off the sloped face
        } else if (!shape && bounce && this.hitPaint === ORANGE && Math.abs(b.vy) > BOUNCE_MIN) {
          b.vy = -b.vy;
        } else {
          if (b.vy > 0) this.land(b, shape);
          b.vy = 0;
        }
      } else if (wasGround && sx !== 0 && b.vy >= 0 && b.teleports === tele0) {
        // keep walking down a slope instead of hopping off it
        const y0 = b.y;
        this.moveAxis(b, Math.abs(sx) + SUB, 1, obstacles);
        if (this.hitBlocked) {
          this.land(b, this.hitSlope);
          b.vy = 0;
        } else b.y = y0;
      }
      this.checkTeleport(b, d0);
    }
  }

  private land(b: Body, shape: number): void {
    b.ground = true;
    b.groundPaint = this.hitPaint;
    // only a floor slope (sloped face pointing up) has a downhill
    b.groundSlope = shape && SLOPE_NORMALS[shape - 1][1] < 0 ? SLOPE_NORMALS[shape - 1][0] : 0;
  }

  // ---------------------------------------------------------------- hash

  stateHash(): string {
    const h = new Hasher();
    h.int(this.started ? 1 : 0).int(this.tick).int(this.finished ? 1 : 0).int(this.finishTick).int(this.rng).int(this.prevBits);
    const p = this.player;
    for (const b of [p as Body, ...this.boxes]) h.int(b.x).int(b.y).int(b.vx).int(b.vy).int(b.ground ? 1 : 0).int(b.groundSlope);
    h.int(p.holding ? p.holding.id : -1).int(p.coyote).int(p.jumpBuf);
    for (const pt of this.particles) if (!pt.dead) h.int(pt.seq).int(pt.x).int(pt.y).int(pt.vx).int(pt.vy);
    for (const po of this.portals) if (po) h.int(po.cx).int(po.cy).int(po.n);
    else h.int(-99);
    for (const [k, v] of this.paint) h.int(k).int(v);
    for (const d of this.doors) h.int(d.open ? 1 : 0);
    return h.hex();
  }

  aliveParticles(): number {
    let n = 0;
    for (const pt of this.particles) if (!pt.dead) n++;
    return n;
  }
}

const NO_OBSTACLES: Body[] = [];
const NO_DEPTHS: [number, number] = [0, 0];

export function overlaps(b: Body, x0: number, y0: number, x1: number, y1: number): boolean {
  return b.x - b.hw < x1 && b.x + b.hw > x0 && b.y - b.hh < y1 && b.y + b.hh > y0;
}

const AXIS_ANG = [0, 2, 4, 6];

export function makePortal(cx: number, cy: number, n: number): Portal {
  if (n >= 4) return makeDiagonalPortal(cx, cy, n - 3);
  const horizontalNormal = n === 0 || n === 2;
  let plane: number;
  if (n === 0) plane = (cx + 1) * T;
  else if (n === 2) plane = cx * T;
  else if (n === 1) plane = (cy + 1) * T;
  else plane = cy * T;
  const t0 = horizontalNormal ? cy * T : cx * T;
  const tc = t0 + T;
  const cells = horizontalNormal ? [cellKey(cx, cy), cellKey(cx, cy + 1)] : [cellKey(cx, cy), cellKey(cx + 1, cy)];
  return {
    cx, cy, n, ang: AXIS_ANG[n], nx: DX[n], ny: DY[n],
    px: horizontalNormal ? plane : tc, py: horizontalNormal ? tc : plane, half: T,
    plane, t0, t1: t0 + 2 * T, tc, cells,
  };
}

/**
 * A portal on the sloped faces of slope (cx, cy) and the next slope along the line, at
 * (cx - ny, cy + nx). Its centre is the grid corner between them. It opens both slope cells
 * and the wall cells right behind them.
 */
export function makeDiagonalPortal(cx: number, cy: number, shape: number): Portal {
  const [nx, ny] = SLOPE_NORMALS[shape - 1];
  const bx = cx - ny;
  const by = cy + nx;
  const keys = new Set<number>();
  for (const [x, y] of [[cx, cy], [bx, by]]) {
    keys.add(cellKey(x, y));
    keys.add(cellKey(x - nx, y));
    keys.add(cellKey(x, y - ny));
  }
  return {
    cx, cy, n: 3 + shape, ang: [5, 7, 1, 3][shape - 1], nx, ny,
    px: ((cx + bx + 1) * T) / 2, py: ((cy + by + 1) * T) / 2, half: 2 * T,
    plane: 0, t0: 0, t1: 0, tc: 0, cells: [...keys],
  };
}

export function isDiagonal(p: Portal): boolean {
  return p.n >= 4;
}

export function portalCovers(p: Portal, cx: number, cy: number): boolean {
  return p.cells.includes(cellKey(cx, cy));
}

export function portalCentre(p: Portal): [number, number] {
  return [p.px, p.py];
}

/** Signed distance of a point in front of the portal face (times sqrt 2 for diagonal portals). */
export function portalDepth(p: Portal, x: number, y: number): number {
  return p.nx * (x - p.px) + p.ny * (y - p.py);
}

/** Position of a point along the portal face from its centre (times sqrt 2 for diagonal portals). */
export function portalAlong(p: Portal, x: number, y: number): number {
  return -p.ny * (x - p.px) + p.nx * (y - p.py);
}

/** Half the size of a body measured along the face, in the portal's units. */
function alongExtent(p: Portal, b: Body): number {
  return b.hw * Math.abs(p.ny) + b.hh * Math.abs(p.nx);
}

/** Half the size of a body measured across the face, in the portal's units. */
export function acrossExtent(p: Portal, b: Body): number {
  return b.hw * Math.abs(p.nx) + b.hh * Math.abs(p.ny);
}

/** Signed distance of the body centre in front of the portal plane. */
function depth(b: Body, p: Portal): number {
  return portalDepth(p, b.x, b.y);
}

function aligned(b: Body, p: Portal): boolean {
  return Math.abs(portalAlong(p, b.x, b.y)) + alongExtent(p, b) <= p.half;
}

function inMouth(b: Body, p: Portal): boolean {
  return aligned(b, p) && depth(b, p) >= 0;
}

// ------------------------------------------------------------- slopes
//
// A slope cell is the half of the cell behind its sloped face, which runs corner to corner
// through the cell centre. With n = SLOPE_NORMALS[shape - 1], a point p is inside when
// n . (p - centre) < 0. A box overlaps the triangle when it overlaps the cell and its corner
// furthest against n (clipped to the cell) is inside. All of it is exact integer maths.

/** n . (corner - centre) for a box against a slope cell: negative means overlapping; 1 if not touching the cell. */
export function slopeOverlap(x0: number, y0: number, x1: number, y1: number, cx: number, cy: number, shape: number): number {
  const X = cx * T;
  const Y = cy * T;
  if (x1 <= X || x0 >= X + T || y1 <= Y || y0 >= Y + T) return 1;
  const [nx, ny] = SLOPE_NORMALS[shape - 1];
  const px = clamp(nx < 0 ? x1 : x0, X, X + T);
  const py = clamp(ny < 0 ? y1 : y0, Y, Y + T);
  return nx * (px - X - T / 2) + ny * (py - Y - T / 2);
}

/** True if a point is strictly inside a slope cell's solid half. */
export function insideSlope(x: number, y: number, cx: number, cy: number, shape: number): boolean {
  const [nx, ny] = SLOPE_NORMALS[shape - 1];
  return nx * (x - cx * T - T / 2) + ny * (y - cy * T - T / 2) < 0;
}

/**
 * First contact of a box moving along one axis with a slope cell, as travel (>= 0) before it
 * would overlap, and whether that is on a flat side (leg) or the sloped face. Null if the
 * move never overlaps it. A box already overlapping is left alone (never snapped).
 */
function slopeContact(
  pos: number, half: number, o0: number, o1: number, axis: number, sign: number, delta: number,
  ca: number, cb: number, shape: number,
): { t: number; leg: boolean } | null {
  const A0 = ca * T;
  const B0 = cb * T;
  const h = T / 2;
  if (o1 <= B0 || o0 >= B0 + T) return null;
  const [nx, ny] = SLOPE_NORMALS[shape - 1];
  const sa = axis === 0 ? nx : ny;
  const sb = axis === 0 ? ny : nx;
  const fb = sb * (clamp(sb < 0 ? o1 : o0, B0, B0 + T) - B0 - h);
  const lo = pos - half;
  const hi = pos + half;
  const dist = Math.abs(delta);
  const tEnter = hi > A0 && lo < A0 + T ? 0 : sign > 0 ? A0 - hi : lo - (A0 + T);
  if (tEnter < 0 || tEnter >= dist) return null;
  const corner0 = sa < 0 ? hi : lo;
  const fEnter = sa * (clamp(corner0 + sign * tEnter, A0, A0 + T) - A0 - h) + fb;
  if (fEnter < 0) return tEnter === 0 ? null : { t: tEnter, leg: true };
  // moving away from the solid side never meets the sloped face
  if (sign !== -sa) return null;
  // moving towards it, the gap closes one for one with travel
  const tHit = tEnter + fEnter;
  return tHit < dist ? { t: tHit, leg: false } : null;
}

/** Orange on a sloped face: mirror the velocity in the 45° face, losing no speed. */
function reflectOff(b: Body, shape: number): boolean {
  const [nx, ny] = SLOPE_NORMALS[shape - 1];
  const d = b.vx * nx + b.vy * ny;
  if (-d <= BOUNCE_MIN) return false;
  // with n = (+-1, +-1), |n|^2 = 2, so v - 2 (v.n) n / |n|^2 = v - (v.n) n: exact in integers
  b.vx -= d * nx;
  b.vy -= d * ny;
  return true;
}
