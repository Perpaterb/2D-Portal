// Integer-only maths helpers. The simulation never uses floating point results
// directly: every value is an integer well inside 2^53, so every operation is exact
// and identical on every JS engine. That is what makes replays deterministic.

/** Sub-units per pixel. Positions and velocities are stored in sub-units. */
export const SUB = 256;
/** Tile size in pixels. */
export const TILE_PX = 32;
/** Tile size in sub-units. */
export const T = TILE_PX * SUB;
export const TICK_HZ = 60;

/** Integer division truncating towards zero. Exact for |a|, |b| < 2^53. */
export function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/** Integer division rounding towards negative infinity. */
export function fdiv(a: number, b: number): number {
  return Math.floor(a / b);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Integer square root (floor), exact for 0 <= n < 2^53. */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  // Math.sqrt is correctly rounded by IEEE 754, then corrected to be exact.
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

/** Move v towards 0 by amount (amount >= 0). */
export function towardsZero(v: number, amount: number): number {
  if (v > 0) return v > amount ? v - amount : 0;
  if (v < 0) return -v > amount ? v + amount : 0;
  return 0;
}

// Directions: 0 right, 1 down, 2 left, 3 up (screen coordinates, y grows downward).
export const DX = [1, 0, -1, 0] as const;
export const DY = [0, 1, 0, -1] as const;

const OFF = 1 << 20;
const SPAN = 1 << 21;
/** Cell coordinate limit; levels can extend about a million tiles in each direction. */
export const CELL_LIMIT = OFF - 1;

export function cellKey(cx: number, cy: number): number {
  return (cx + OFF) * SPAN + (cy + OFF);
}

export function keyCx(key: number): number {
  return Math.floor(key / SPAN) - OFF;
}

export function keyCy(key: number): number {
  return (key % SPAN) - OFF;
}

/** Deterministic 32-bit PRNG (mulberry32). Returns uint32. */
export function nextRandom(state: { rng: number }): number {
  state.rng = (state.rng + 0x6d2b79f5) | 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/** FNV-1a style 32-bit hash accumulator over integers. */
export class Hasher {
  h = 0x811c9dc5;
  int(n: number): this {
    // fold a possibly >32-bit integer in two halves
    const lo = n | 0;
    const hi = Math.floor(n / 4294967296) | 0;
    this.h = Math.imul(this.h ^ lo, 0x01000193);
    this.h = Math.imul(this.h ^ hi, 0x01000193);
    return this;
  }
  str(s: string): this {
    for (let i = 0; i < s.length; i++) this.h = Math.imul(this.h ^ s.charCodeAt(i), 0x01000193);
    return this;
  }
  hex(): string {
    return (this.h >>> 0).toString(16).padStart(8, '0');
  }
}
