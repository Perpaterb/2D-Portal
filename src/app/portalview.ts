// Geometry for drawing through portals. Visual only (floats are fine here), but kept free
// of the DOM so it can be unit tested.
import { SUB, TILE_PX, cellKey } from '../sim/fixed';
import {
  portalMatrix, portalCovers, portalDepth, portalAlong, acrossExtent, MAT_ONE, type Portal, type Body, type Sim,
} from '../sim/sim';

export type Affine = [number, number, number, number, number, number]; // canvas order a b c d e f
export type Pt = [number, number];

export function centrePx(p: Portal): Pt {
  return [p.px / SUB, p.py / SUB];
}

/** The portal matrix as floats (the sim's fixed point, divided out). */
export function matrixF(angIn: number, angOut: number): [number, number, number, number] {
  return portalMatrix(angIn, angOut).map((v) => v / MAT_ONE) as [number, number, number, number];
}

/** Unit normal and unit tangent of a portal face (pixels). */
export function faceAxes(p: Portal): { n: Pt; t: Pt; len: number } {
  const l = Math.hypot(p.nx, p.ny);
  // half length of the mouth in pixels: one tile for flat portals, one tile diagonal for 45° ones
  return { n: [p.nx / l, p.ny / l], t: [-p.ny / l, p.nx / l], len: TILE_PX * l };
}

/** Maps a point near the entry portal to where it comes out of the exit (pixels). Same maths as the sim teleport. */
export function teleportAffine(pin: Portal, pout: Portal): Affine {
  const [m00, m01, m10, m11] = matrixF(pin.ang, pout.ang);
  const [ix, iy] = centrePx(pin);
  const [ox, oy] = centrePx(pout);
  return [m00, m10, m01, m11, ox - (m00 * ix + m01 * iy), oy - (m10 * ix + m11 * iy)];
}

/** Inverse of teleportAffine: where the world beyond `pout` appears when looking into `pin`. */
export function viewAffine(pin: Portal, pout: Portal): Affine {
  // the matrices are orthogonal, so the inverse is the transpose
  const [m00, m01, m10, m11] = matrixF(pin.ang, pout.ang);
  const [i00, i01, i10, i11] = [m00, m10, m01, m11];
  const [ix, iy] = centrePx(pin);
  const [ox, oy] = centrePx(pout);
  return [i00, i10, i01, i11, ix - (i00 * ox + i01 * oy), iy - (i10 * ox + i11 * oy)];
}

export function applyAffine(t: Affine, [x, y]: Pt): Pt {
  return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
}

/** Signed distance of a pixel point in front of the portal face. */
export function frontDistance(p: Portal, [x, y]: Pt): number {
  const { n } = faceAxes(p);
  const [cx, cy] = centrePx(p);
  return n[0] * (x - cx) + n[1] * (y - cy);
}

/** A point on the portal face, `s` pixels along it from the centre (-len..len). */
export function facePoint(p: Portal, s: number): Pt {
  const { t } = faceAxes(p);
  const [cx, cy] = centrePx(p);
  return [cx + t[0] * s, cy + t[1] * s];
}

export type SolidFn = (cx: number, cy: number) => boolean;

export function simSolid(sim: Sim): SolidFn {
  return (cx, cy) => {
    const k = cellKey(cx, cy);
    if (sim.tiles.has(k)) return true;
    const d = sim.doorAt.get(k);
    return !!d && !d.open;
  };
}

/**
 * Parts of the portal mouth the eye can see, as [tStart, tEnd] pixel spans along the face.
 * Rays from the eye to sample points on the face are blocked by solid cells on the way
 * (the portal's own wall cells don't count).
 */
export function visibleSpans(solid: SolidFn, eye: Pt, p: Portal, samples = 24): [number, number][] {
  if (frontDistance(p, eye) <= 0) return [];
  const { len } = faceAxes(p);
  const t0 = -len;
  const t1 = len;
  const step = (t1 - t0) / samples;
  const vis: boolean[] = [];
  for (let k = 0; k < samples; k++) {
    const t = t0 + step * (k + 0.5);
    vis.push(clearLine(solid, eye, facePoint(p, t), p));
  }
  const spans: [number, number][] = [];
  let start = -1;
  for (let k = 0; k <= samples; k++) {
    if (k < samples && vis[k]) {
      if (start < 0) start = k;
    } else if (start >= 0) {
      spans.push([t0 + step * start, t0 + step * k]);
      start = -1;
    }
  }
  return spans;
}

function clearLine(solid: SolidFn, [ex, ey]: Pt, [sx, sy]: Pt, p: Portal): boolean {
  const dx = sx - ex;
  const dy = sy - ey;
  const len = Math.hypot(dx, dy);
  const n = Math.max(1, Math.ceil(len / 3));
  for (let i = 1; i < n; i++) {
    const x = ex + (dx * i) / n;
    const y = ey + (dy * i) / n;
    const cx = Math.floor(x / TILE_PX);
    const cy = Math.floor(y / TILE_PX);
    if (portalCovers(p, cx, cy)) continue;
    if (solid(cx, cy)) return false;
  }
  return true;
}

/** The region seen through one visible span: from the face out to `far` pixels beyond, away from the eye. */
export function viewWedge(eye: Pt, p: Portal, span: [number, number], far: number): Pt[] {
  const a = facePoint(p, span[0]);
  const b = facePoint(p, span[1]);
  const out = (q: Pt): Pt => {
    const dx = q[0] - eye[0];
    const dy = q[1] - eye[1];
    const l = Math.hypot(dx, dy) || 1;
    return [q[0] + (dx / l) * far, q[1] + (dy / l) * far];
  };
  return [a, b, out(b), out(a)];
}

export interface Crossing {
  body: Body;
  pin: Portal;
  pout: Portal;
}

/** Bodies partly through a portal mouth: their far part must also be drawn coming out of the other portal. */
export function crossings(sim: Sim, bodies: Body[]): Crossing[] {
  const [a, c] = sim.portals;
  if (!a || !c) return [];
  const out: Crossing[] = [];
  for (const b of bodies) {
    for (const [pin, pout] of [[a, c], [c, a]] as [Portal, Portal][]) {
      // in the portal's own units (sqrt 2 scaled for diagonal ones), like the sim
      const ext = b.hw * Math.abs(pin.ny) + b.hh * Math.abs(pin.nx);
      const u = portalAlong(pin, b.x, b.y);
      if (u + ext <= -pin.half || u - ext >= pin.half) continue;
      const d = portalDepth(pin, b.x, b.y);
      if (d >= 0 && d < acrossExtent(pin, b)) out.push({ body: b, pin, pout });
    }
  }
  return out;
}

/** Camera orientation as rotation angle plus a horizontal flip factor (1 or -1, eased through 0). */
export interface Orientation {
  angle: number;
  sx: number;
}

/** Orientation matrix [a b c d] (x' = a x + b y, y' = c x + d y) for R(angle) * diag(sx, 1). */
export function orientationMatrix(o: Orientation): [number, number, number, number] {
  const cs = Math.cos(o.angle);
  const sn = Math.sin(o.angle);
  return [cs * o.sx, -sn, sn * o.sx, cs];
}

/**
 * After passing from `nIn` to `nOut`, the camera orientation that keeps the screen looking
 * exactly as it did: current orientation composed with the inverse portal matrix.
 */
export function orientationAfterTeleport(current: Orientation, angIn: number, angOut: number): Orientation {
  const [c00, c01, c10, c11] = orientationMatrix({ angle: current.angle, sx: current.sx < 0 ? -1 : 1 });
  const [m00, m01, m10, m11] = matrixF(angIn, angOut);
  const [i00, i01, i10, i11] = [m00, m10, m01, m11]; // inverse = transpose
  const o00 = c00 * i00 + c01 * i10;
  const o10 = c10 * i00 + c11 * i10;
  const o01 = c00 * i01 + c01 * i11;
  const o11 = c10 * i01 + c11 * i11;
  const det = o00 * o11 - o01 * o10;
  if (det < 0) return { angle: Math.atan2(-o10, -o00), sx: -1 };
  return { angle: Math.atan2(o10, o00), sx: 1 };
}

/** Screen offset (from the screen centre, in CSS px) to a world offset, undoing zoom and orientation. */
export function screenOffsetToWorld(dx: number, dy: number, zoom: number, o: Orientation): Pt {
  const x = dx / zoom;
  const y = dy / zoom;
  const cs = Math.cos(-o.angle);
  const sn = Math.sin(-o.angle);
  const rx = cs * x - sn * y;
  const ry = sn * x + cs * y;
  const sx = Math.abs(o.sx) < 0.3 ? (o.sx < 0 ? -0.3 : 0.3) : o.sx;
  return [rx / sx, ry];
}
