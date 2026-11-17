// The deterministic game simulation. No DOM, no floats in state, no time sources:
// the same level plus the same per-tick inputs always produces the same result.
// This file must stay runnable on the server (Deno) to verify replays.
import {
  SUB, T, DX, DY, idiv, fdiv, clamp, isqrt, towardsZero, cellKey, nextRandom, Hasher,
} from './fixed';
import {
  BLUE, ORANGE, WHITE, WHITE_WALL, DARK_WALL, CHANNEL_COUNT, levelHash, canonicalLevel, blockPaint,
  type LevelData, type Liquid, type TileKind, type DispenserObj,
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
export const PLAYER_HW = 9 * SUB;
export const PLAYER_HH = 21 * SUB;
export const BOX_H = 12 * SUB;
export const PARTICLE_H = 2 * SUB;
const GRAB_RANGE = 56 * SUB;
const HOLD_DIST = 44 * SUB;
const HOLD_DROP = 110 * SUB;
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
}

export interface Portal {
  cx: number;
  cy: number;
  /** outward normal direction 0..3 */
  n: number;
  /** face plane coordinate (x for horizontal normals, y for vertical) */
  plane: number;
  /** tangent span [t0, t1) and centre */
  t0: number;
  t1: number;
  tc: number;
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

/** Linear map applied to positions and velocities when passing from one portal to another. */
export function portalMatrix(nIn: number, nOut: number): [number, number, number, number] {
  if (nOut === nIn) {
    // same facing: reflect the normal, keep the tangent
    return nIn === 0 || nIn === 2 ? [-1, 0, 0, 1] : [1, 0, 0, -1];
  }
  if (nOut === (nIn + 2) % 4) return [1, 0, 0, 1];
  const k = (nOut - (nIn + 2) + 8) % 4;
  // k=1: (x,y)->(-y,x); k=3: (x,y)->(y,-x)
  return k === 1 ? [0, -1, 1, 0] : [0, 1, -1, 0];
}

export class Sim {
  readonly levelHash: string;
  tick = 0;
  /** the world waits, untimed, until the first input with any action in it */
  started = false;
  finished = false;
  finishTick = -1;
  tiles = new Map<number, TileKind>();
  /** paint per face: key = cellKey * 4 + dir */
  paint = new Map<number, number>();
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
  /** cosmetic only, never hashed */
  lastShot: ShotTrace | null = null;
  /** cosmetic only: facings of the last portal pair the player went through */
  lastPlayerTeleport: { nIn: number; nOut: number; inP: Portal; outP: Portal } | null = null;

  // scratch results from moveAxis, reused to avoid allocations
  private hitBlocked = false;
  private hitPaint = 0;
  private hitKey = -1;
  private hitFace = 0;
  private hitTile = false;

  constructor(level: LevelData) {
    this.levelHash = levelHash(level);
    this.rng = parseInt(this.levelHash, 16) | 0;
    for (const [cx, cy, kind] of canonicalLevel(level).tiles) {
      const k = cellKey(cx, cy);
      const pre = blockPaint(kind);
      // painted blocks are dark walls with paint already on every face
      this.tiles.set(k, pre ? DARK_WALL : kind);
      if (pre) for (let f = 0; f < 4; f++) this.paint.set(k * 4 + f, pre);
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
    this.player = this.makeBody(0, px, py, PLAYER_HW, PLAYER_HH, {
      coyote: 0, jumpBuf: 0, jumping: false, holding: null, facing: 1, aimX: 1, aimY: 0,
    }) as Player;
    for (const d of this.dispensers) d.on = d.defaultOn;
  }

  private makeBody<E extends object>(id: number, x: number, y: number, hw: number, hh: number, extra: E): Body & E {
    return { id, x, y, vx: 0, vy: 0, hw, hh, ground: false, groundPaint: 0, teleports: 0, ...extra };
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
      if (want) d.open = true;
      else if (d.open) {
        const x0 = d.cx * T;
        const y0 = d.cy * T;
        let blocked = overlaps(this.player, x0, y0, x0 + T, y0 + T);
        if (!blocked) for (const b of this.boxes) if (overlaps(b, x0, y0, x0 + T, y0 + T)) { blocked = true; break; }
        if (!blocked) {
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
        b.vx = clamp(idiv(tx - b.x, 2), -MAX_SPEED, MAX_SPEED);
        b.vy = clamp(idiv(ty - b.y, 2), -MAX_SPEED, MAX_SPEED);
        this.moveBody(b, others, false);
        b.ground = false;
        if (Math.abs(b.x - p.x) > HOLD_DROP || Math.abs(b.y - p.y) > HOLD_DROP) {
          b.held = false;
          p.holding = null;
        }
      } else {
        if (b.ground) b.vx = towardsZero(b.vx, b.groundPaint === BLUE ? SLIP_FRICTION : BOX_FRICTION);
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
        ground: false, groundPaint: 0, teleports: 0, color: d.liquid, dead: false, seq: this.particleSeq++, owner: di,
      };
      if (this.overlapsSolid(pt)) continue;
      const spread = (nextRandom(this) % 193) - 96;
      if (d.dir === 0 || d.dir === 2) pt.vy += spread;
      else pt.vx += spread;
      d.fifo.push(pt);
      d.alive++;
      d.poured++;
      this.particles.push(pt);
      while (d.alive > d.cap) {
        const oldest = d.fifo.shift()!;
        if (!oldest.dead) this.killParticle(oldest);
      }
      if (d.fifo.length > d.cap * 2) d.fifo = d.fifo.filter((q) => !q.dead);
    }
  }

  private killParticle(pt: Particle): void {
    if (pt.dead) return;
    pt.dead = true;
    this.dispensers[pt.owner].alive--;
  }

  // ----------------------------------------------------------- particles

  private stepParticles(): void {
    for (const pt of this.particles) {
      if (pt.dead) continue;
      pt.vy = clamp(pt.vy + PARTICLE_GRAVITY, -MAX_SPEED, MAX_SPEED);
      this.moveParticle(pt);
    }
    // liquid spreading: resting particles sharing a 4px cell nudge sideways
    const taken = new Set<number>();
    const cell = 4 * SUB;
    for (const pt of this.particles) {
      if (pt.dead) continue;
      const k = cellKey(fdiv(pt.x, cell), fdiv(pt.y, cell));
      if (taken.has(k) && pt.ground) {
        this.moveAxis(pt, pt.seq & 1 ? cell : -cell, 0, NO_OBSTACLES);
      }
      taken.add(cellKey(fdiv(pt.x, cell), fdiv(pt.y, cell)));
    }
    if (this.particles.length > 64 && this.tick % 30 === 0) this.particles = this.particles.filter((q) => !q.dead);
  }

  private moveParticle(pt: Particle): void {
    pt.ground = false;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(pt.vx), Math.abs(pt.vy)) / SUBSTEP));
    for (let i = 0; i < steps && !pt.dead; i++) {
      const sx = idiv(pt.vx, steps);
      const sy = idiv(pt.vy, steps);
      const d0 = this.portalDepths(pt);
      this.moveAxis(pt, sx, 0, NO_OBSTACLES);
      if (this.hitBlocked && this.particleHit(pt, 0)) return;
      this.moveAxis(pt, sy, 1, NO_OBSTACLES);
      if (this.hitBlocked && this.particleHit(pt, 1)) return;
      this.checkTeleport(pt, d0);
    }
  }

  /** Returns true if the particle was consumed by painting. */
  private particleHit(pt: Particle, axis: number): boolean {
    if (this.hitTile) {
      const fk = this.hitKey * 4 + this.hitFace;
      const base = this.tiles.get(this.hitKey) === WHITE_WALL ? WHITE : DARK;
      const colour = this.paint.get(fk) ?? base;
      if (colour !== pt.color) {
        if (pt.color === WHITE && base === WHITE) this.paint.delete(fk);
        else this.paint.set(fk, pt.color);
        this.killParticle(pt);
        return true;
      }
    }
    if (axis === 0) pt.vx = 0;
    else {
      if (pt.vy > 0) {
        pt.ground = true;
        pt.vx = towardsZero(pt.vx, pt.color === BLUE ? 4 : 40);
      }
      pt.vy = 0;
    }
    return false;
  }

  // ------------------------------------------------------------- portals

  private shotSolid(cx: number, cy: number): boolean {
    const k = cellKey(cx, cy);
    if (this.tiles.has(k)) return true;
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

  isPortalable(cx: number, cy: number, face: number): boolean {
    const k = cellKey(cx, cy);
    const kind = this.tiles.get(k);
    if (kind === undefined) return false;
    return kind === WHITE_WALL || this.paint.get(k * 4 + face) === WHITE;
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
      if (other && other.n === n && portalCovers(other, cx, cy)) return false;
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
      if (old && hadBoth) this.unstickAll(old.n);
      return true;
    }
    return false;
  }

  private unstickAll(n: number): void {
    const bodies: Body[] = [this.player, ...this.boxes];
    for (const b of bodies) {
      if (!this.overlapsSolid(b)) continue;
      const ox = b.x;
      const oy = b.y;
      let freed = false;
      for (let px = 1; px <= 80 && !freed; px++) {
        b.x = ox + DX[n] * px * SUB;
        b.y = oy + DY[n] * px * SUB;
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
      const into = -(DX[p.n] * b.vx + DY[p.n] * b.vy);
      if (into < MAG_MIN_INTO) continue;
      const d = depth(b, p);
      if (d < 0 || d > MAG_RANGE) continue;
      const u = (p.n === 0 || p.n === 2 ? b.y : b.x) - p.tc;
      if (u > MAG_WIDTH || u < -MAG_WIDTH) continue;
      if (!best || d < bestD) {
        best = p;
        bestD = d;
        bestInto = into;
      }
    }
    if (!best) return;
    const axis = best.n === 0 || best.n === 2 ? 1 : 0;
    const halfAlong = axis === 1 ? b.hw : b.hh; // extent towards the portal face
    const pos = axis === 1 ? b.y : b.x;
    const half = axis === 1 ? b.hh : b.hw;
    const margin = 2 * SUB;
    let need = 0;
    if (pos - half < best.t0 + margin) need = Math.min(best.t0 + margin - (pos - half), best.tc - pos);
    else if (pos + half > best.t1 - margin) need = Math.max(best.t1 - margin - (pos + half), best.tc - pos);
    if (need === 0) return;
    // slide fast enough to fit the mouth before the leading edge reaches the face
    const ticksLeft = Math.max(1, idiv(bestD - halfAlong, bestInto));
    const step = clamp(idiv(Math.abs(need) + ticksLeft - 1, ticksLeft), MAG_STEP, MAG_MAX_STEP);
    this.moveAxis(b, clamp(need, -step, step), axis, obstacles);
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
    const [m00, m01, m10, m11] = portalMatrix(pin.n, pout.n);
    const [ix, iy] = portalCentre(pin);
    const [ox, oy] = portalCentre(pout);
    const rx = b.x - ix;
    const ry = b.y - iy;
    b.x = ox + m00 * rx + m01 * ry;
    b.y = oy + m10 * rx + m11 * ry;
    const vx = b.vx;
    const vy = b.vy;
    b.vx = clamp(m00 * vx + m01 * vy, -MAX_SPEED, MAX_SPEED);
    b.vy = clamp(m10 * vx + m11 * vy, -MAX_SPEED, MAX_SPEED);
    if (pout.n === 0 || pout.n === 2) b.y = clamp(b.y, pout.t0 + b.hh, pout.t1 - b.hh);
    else b.x = clamp(b.x, pout.t0 + b.hw, pout.t1 - b.hw);
    if (depth(b, pout) < 0) {
      if (pout.n === 0 || pout.n === 2) b.x = pout.plane;
      else b.y = pout.plane;
    }
    b.teleports++;
    if (b === this.player) this.lastPlayerTeleport = { nIn: pin.n, nOut: pout.n, inP: pin, outP: pout };
  }

  // ------------------------------------------------------------ collision

  isSolid(cx: number, cy: number, b: Body): boolean {
    const k = cellKey(cx, cy);
    if (this.tiles.has(k)) return !this.holeFor(cx, cy, b);
    const d = this.doorAt.get(k);
    return !!d && !d.open;
  }

  overlapsSolid(b: Body): boolean {
    const cx0 = fdiv(b.x - b.hw, T);
    const cx1 = fdiv(b.x + b.hw - 1, T);
    const cy0 = fdiv(b.y - b.hh, T);
    const cy1 = fdiv(b.y + b.hh - 1, T);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) if (this.isSolid(cx, cy, b)) return true;
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
        const isTile = this.tiles.has(k);
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
      }
    }

    const np = limit - sign * half;
    if (axis === 0) b.x = np;
    else b.y = np;
  }

  private moveBody(b: Body, obstacles: Body[], bounce: boolean): void {
    b.ground = false;
    b.groundPaint = 0;
    b.vx = clamp(b.vx, -MAX_SPEED, MAX_SPEED);
    b.vy = clamp(b.vy, -MAX_SPEED, MAX_SPEED);
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.vx), Math.abs(b.vy)) / SUBSTEP));
    for (let i = 0; i < steps; i++) {
      const sx = idiv(b.vx, steps);
      const sy = idiv(b.vy, steps);
      const d0 = this.portalDepths(b);
      this.moveAxis(b, sx, 0, obstacles);
      if (this.hitBlocked) {
        if (bounce && this.hitPaint === ORANGE && Math.abs(b.vx) > BOUNCE_MIN) b.vx = -b.vx; // orange keeps all its speed
        else b.vx = 0;
      }
      this.moveAxis(b, sy, 1, obstacles);
      if (this.hitBlocked) {
        if (bounce && this.hitPaint === ORANGE && Math.abs(b.vy) > BOUNCE_MIN) {
          b.vy = -b.vy;
        } else {
          if (b.vy > 0) {
            b.ground = true;
            b.groundPaint = this.hitPaint;
          }
          b.vy = 0;
        }
      }
      this.checkTeleport(b, d0);
    }
  }

  // ---------------------------------------------------------------- hash

  stateHash(): string {
    const h = new Hasher();
    h.int(this.started ? 1 : 0).int(this.tick).int(this.finished ? 1 : 0).int(this.finishTick).int(this.rng).int(this.prevBits);
    const p = this.player;
    for (const b of [p as Body, ...this.boxes]) h.int(b.x).int(b.y).int(b.vx).int(b.vy).int(b.ground ? 1 : 0);
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

export function overlaps(b: Body, x0: number, y0: number, x1: number, y1: number): boolean {
  return b.x - b.hw < x1 && b.x + b.hw > x0 && b.y - b.hh < y1 && b.y + b.hh > y0;
}

export function makePortal(cx: number, cy: number, n: number): Portal {
  const horizontalNormal = n === 0 || n === 2;
  let plane: number;
  if (n === 0) plane = (cx + 1) * T;
  else if (n === 2) plane = cx * T;
  else if (n === 1) plane = (cy + 1) * T;
  else plane = cy * T;
  const t0 = horizontalNormal ? cy * T : cx * T;
  return { cx, cy, n, plane, t0, t1: t0 + 2 * T, tc: t0 + T };
}

export function portalCovers(p: Portal, cx: number, cy: number): boolean {
  if (p.n === 0 || p.n === 2) return cx === p.cx && (cy === p.cy || cy === p.cy + 1);
  return cy === p.cy && (cx === p.cx || cx === p.cx + 1);
}

export function portalCentre(p: Portal): [number, number] {
  return p.n === 0 || p.n === 2 ? [p.plane, p.tc] : [p.tc, p.plane];
}

/** Signed distance of the body centre in front of the portal plane. */
function depth(b: Body, p: Portal): number {
  switch (p.n) {
    case 0: return b.x - p.plane;
    case 2: return p.plane - b.x;
    case 1: return b.y - p.plane;
    default: return p.plane - b.y;
  }
}

function aligned(b: Body, p: Portal): boolean {
  if (p.n === 0 || p.n === 2) return b.y - b.hh >= p.t0 && b.y + b.hh <= p.t1;
  return b.x - b.hw >= p.t0 && b.x + b.hw <= p.t1;
}

function inMouth(b: Body, p: Portal): boolean {
  return aligned(b, p) && depth(b, p) >= 0;
}
