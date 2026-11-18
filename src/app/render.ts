// Canvas rendering for the editor and the game. Visual only: nothing here feeds back
// into the simulation, so it is free to use floating point.
import { SUB, TILE_PX, cellKey, keyCx, keyCy, DX, DY } from '../sim/fixed';
import {
  BLUE, ORANGE, WHITE, WHITE_WALL, BLUE_BLOCK, ORANGE_BLOCK, SLOPE_NORMALS, sideColour, colourPaint, isOpenFace, hypFace,
  type LevelObject, type TileInfo,
} from '../sim/level';
import {
  Sim, PLAYER_HW, PLAYER_HH, BOX_H, PLATE_HW, FINISH_HW, FINISH_H, type Portal, type Body,
} from '../sim/sim';
import {
  crossings, visibleSpans, viewWedge, viewAffine, teleportAffine, applyAffine, simSolid, frontDistance, faceAxes, centrePx,
  type Pt,
} from './portalview';

export const CHANNEL_COLOURS = ['#ff5a5a', '#ffb020', '#ffe14d', '#4fdc84', '#3ed0ff', '#7a86ff', '#c870ff', '#ff70c8'];
export const CHANNEL_NAMES = ['Red', 'Amber', 'Yellow', 'Green', 'Cyan', 'Indigo', 'Violet', 'Pink'];
export const LIQUID_COLOURS: Record<number, string> = { [BLUE]: '#2f7bff', [ORANGE]: '#ff8a1f', [WHITE]: '#f3f6fa' };
export const LIQUID_NAMES: Record<number, string> = { [BLUE]: 'Blue gel', [ORANGE]: 'Orange bounce', [WHITE]: 'White paint' };
export const PORTAL_COLOURS = ['#36e3d2', '#ff5fa2'];

const T = TILE_PX;

export interface Camera {
  x: number;
  y: number;
  zoom: number;
  /** play only: view rotation (radians) and horizontal flip factor, eased after passing through portals */
  angle?: number;
  sx?: number;
}

/** World rectangle [x0, y0, x1, y1] in pixels. */
export type Rect = [number, number, number, number];

const BACKGROUND = '#0b1422';

export function screenToWorld(cam: Camera, w: number, h: number, sx: number, sy: number): [number, number] {
  const a = cam.angle ?? 0;
  const f = cam.sx ?? 1;
  const x = (sx - w / 2) / cam.zoom;
  const y = (sy - h / 2) / cam.zoom;
  const cs = Math.cos(-a);
  const sn = Math.sin(-a);
  const flip = Math.abs(f) < 0.05 ? (f < 0 ? -0.05 : 0.05) : f;
  return [(cs * x - sn * y) / flip + cam.x, sn * x + cs * y + cam.y];
}

export function beginFrame(ctx: CanvasRenderingContext2D, cam: Camera, w: number, h: number, dpr: number): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.scale(cam.zoom, cam.zoom);
  if (cam.angle) ctx.rotate(cam.angle);
  if (cam.sx !== undefined && cam.sx !== 1) ctx.scale(cam.sx, 1);
  ctx.translate(-cam.x, -cam.y);
}

/** Bounding box of everything on screen, in world pixels (accounts for rotation). */
export function visibleRect(cam: Camera, w: number, h: number): Rect {
  const corners = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => screenToWorld(cam, w, h, x, y));
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  // during a flip ease the view squashes; cap the area so drawing stays cheap
  const cap = 4000 / cam.zoom;
  return [Math.max(Math.min(...xs), cam.x - cap), Math.max(Math.min(...ys), cam.y - cap), Math.min(Math.max(...xs), cam.x + cap), Math.min(Math.max(...ys), cam.y + cap)];
}

function rectCells(r: Rect): [number, number, number, number] {
  return [Math.floor(r[0] / T) - 1, Math.floor(r[1] / T) - 1, Math.floor(r[2] / T) + 1, Math.floor(r[3] / T) + 1];
}

export function drawBackdrop(ctx: CanvasRenderingContext2D, rect: Rect, zoom: number, grid: boolean): void {
  const [cx0, cy0, cx1, cy1] = rectCells(rect);
  const cam = { zoom };
  if ((cx1 - cx0) * (cy1 - cy0) > 40000) return;
  if (cam.zoom >= 0.45) {
    ctx.fillStyle = '#0f1b2e';
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0 + ((((cx0 + cy) % 2) + 2) % 2); cx <= cx1; cx += 2) ctx.fillRect(cx * T, cy * T, T, T);
    }
  }
  if (grid && cam.zoom >= 0.35) {
    ctx.strokeStyle = 'rgba(160, 200, 255, 0.10)';
    ctx.lineWidth = 1 / cam.zoom;
    ctx.beginPath();
    for (let cx = cx0; cx <= cx1; cx++) {
      ctx.moveTo(cx * T, cy0 * T);
      ctx.lineTo(cx * T, (cy1 + 1) * T);
    }
    for (let cy = cy0; cy <= cy1; cy++) {
      ctx.moveTo(cx0 * T, cy * T);
      ctx.lineTo((cx1 + 1) * T, cy * T);
    }
    ctx.stroke();
    // origin marker so an endless canvas still has a reference point
    ctx.strokeStyle = 'rgba(160, 200, 255, 0.25)';
    ctx.beginPath();
    ctx.moveTo(-8, 0);
    ctx.lineTo(8, 0);
    ctx.moveTo(0, -8);
    ctx.lineTo(0, 8);
    ctx.stroke();
  }
}

/** How one face of a tile looks: bare white (takes portals) or dark, and any paint on it. */
export type FaceLook = (key: number, f: number) => { white: boolean; paint: number };

/** Face looks straight from the level's tile colours (the editor). */
export function levelFaceLook(tiles: Map<number, TileInfo>): FaceLook {
  return (key, f) => {
    const c = sideColour(tiles.get(key)!, f);
    return { white: c === WHITE_WALL, paint: colourPaint(c) };
  };
}

/** Face looks from a running sim: its bare sides plus whatever liquid has painted since. */
export function simFaceLook(sim: Sim): FaceLook {
  return (key, f) => {
    const fk = key * 4 + f;
    return { white: sim.baseOf(fk) === WHITE, paint: sim.paint.get(fk) ?? 0 };
  };
}

/** Corners of a slope's solid triangle, the two ends of its sloped face first. */
function slopeCorners(cx: number, cy: number, shape: number): [number, number][] {
  const [nx, ny] = SLOPE_NORMALS[shape - 1];
  const x0 = cx * T;
  const y0 = cy * T;
  const ox = nx > 0 ? x0 + T : x0; // the open corner the sloped face looks towards
  const oy = ny > 0 ? y0 + T : y0;
  const fx = nx > 0 ? x0 : x0 + T; // the solid corner opposite it
  const fy = ny > 0 ? y0 : y0 + T;
  return [[ox, fy], [fx, oy], [fx, fy]];
}

export function drawTiles(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  zoom: number,
  tiles: Map<number, TileInfo>,
  look: FaceLook,
): void {
  const cam = { zoom };
  const [cx0, cy0, cx1, cy1] = rectCells(rect);
  const visible = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
  const list: [number, number, TileInfo][] = [];
  if (visible < tiles.size) {
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const t = tiles.get(cellKey(cx, cy));
        if (t !== undefined) list.push([cx, cy, t]);
      }
    }
  } else {
    for (const [key, t] of tiles) {
      const cx = keyCx(key);
      const cy = keyCy(key);
      if (cx >= cx0 && cx <= cx1 && cy >= cy0 && cy <= cy1) list.push([cx, cy, t]);
    }
  }
  const outline = (cx: number, cy: number, t: TileInfo) => {
    ctx.beginPath();
    if (!t.shape) ctx.rect(cx * T, cy * T, T, T);
    else {
      const c = slopeCorners(cx, cy, t.shape);
      ctx.moveTo(c[0][0], c[0][1]);
      ctx.lineTo(c[1][0], c[1][1]);
      ctx.lineTo(c[2][0], c[2][1]);
      ctx.closePath();
    }
  };
  // bodies
  for (const [cx, cy, t] of list) {
    const white = t.kind === WHITE_WALL;
    ctx.save();
    outline(cx, cy, t);
    ctx.clip();
    ctx.fillStyle = white ? '#c3ced9' : '#262c35';
    ctx.fillRect(cx * T, cy * T, T, T);
    ctx.fillStyle = white ? '#d3dce5' : '#2e3540';
    const inset = white ? 2 : 3;
    if (!t.shape) ctx.fillRect(cx * T + inset, cy * T + inset, T - 2 * inset, T - 2 * inset);
    // a hint of the tile's own colour for blue and orange blocks, so the body reads at a glance
    if (t.kind === BLUE_BLOCK || t.kind === ORANGE_BLOCK) {
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = LIQUID_COLOURS[colourPaint(t.kind)];
      ctx.fillRect(cx * T, cy * T, T, T);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
  // exposed edges
  const fine = cam.zoom >= 0.4;
  const hidden = (cx: number, cy: number, f: number) => {
    const n = tiles.get(cellKey(cx + DX[f], cy + DY[f]));
    // covered by a full block, or by a slope's flat side facing back at this one
    return !!n && (!n.shape || !isOpenFace(n.shape, (f + 2) % 4));
  };
  for (const [cx, cy, t] of list) {
    const key = cellKey(cx, cy);
    for (let f = 0; f < 4; f++) {
      if (t.shape && isOpenFace(t.shape, f)) continue;
      if (hidden(cx, cy, f)) continue;
      const fl = look(key, f);
      if (fl.white && fine) {
        ctx.fillStyle = 'rgba(150, 225, 255, 0.22)';
        const [gx, gy, gw, gh] = faceRect(cx, cy, f, -5);
        ctx.fillRect(gx, gy, gw, gh);
      }
      ctx.fillStyle = fl.white ? '#ffffff' : '#566173';
      const [ex, ey, ew, eh] = faceRect(cx, cy, f, 3);
      ctx.fillRect(ex, ey, ew, eh);
      if (fl.paint) {
        ctx.fillStyle = LIQUID_COLOURS[fl.paint];
        const [px, py, pw, ph] = faceRect(cx, cy, f, 6);
        ctx.fillRect(px, py, pw, ph);
      }
    }
    if (t.shape) {
      // the sloped face: drawn as a thick line clipped to the triangle, so it sits just inside
      const fl = look(key, hypFace(t.shape));
      const c = slopeCorners(cx, cy, t.shape);
      const line = (width: number, style: string) => {
        ctx.strokeStyle = style;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(c[0][0], c[0][1]);
        ctx.lineTo(c[1][0], c[1][1]);
        ctx.stroke();
      };
      if (fl.white && fine) line(10, 'rgba(150, 225, 255, 0.22)');
      ctx.save();
      outline(cx, cy, t);
      ctx.clip();
      line(6, fl.white ? '#ffffff' : '#566173');
      if (fl.paint) line(12, LIQUID_COLOURS[fl.paint]);
      ctx.restore();
    }
  }
}

/** Rectangle hugging face f of a cell, `thick` px deep (negative = outside the tile). */
function faceRect(cx: number, cy: number, f: number, thick: number): [number, number, number, number] {
  const x = cx * T;
  const y = cy * T;
  const out = thick < 0;
  const t = Math.abs(thick);
  switch (f) {
    case 0: return out ? [x + T, y, t, T] : [x + T - t, y, t, T];
    case 2: return out ? [x - t, y, t, T] : [x, y, t, T];
    case 1: return out ? [x, y + T, T, t] : [x, y + T - t, T, t];
    default: return out ? [x, y - t, T, t] : [x, y, T, t];
  }
}

// ------------------------------------------------------------------ objects

export function drawStart(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = 'rgba(79, 220, 132, 0.18)';
  ctx.fillRect(x - 14, y - 44, 28, 44);
  ctx.fillStyle = '#4fdc84';
  ctx.fillRect(x - 15, y - 4, 30, 4);
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('START', x, y - 48);
}

export function drawFinish(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const hw = FINISH_HW / SUB;
  const hgt = FINISH_H / SUB;
  ctx.fillStyle = '#16263d';
  ctx.fillRect(x - hw, y - hgt, hw * 2, hgt);
  ctx.strokeStyle = '#ffd54d';
  ctx.lineWidth = 2;
  ctx.strokeRect(x - hw + 1, y - hgt + 1, hw * 2 - 2, hgt - 2);
  // chequered panel
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      ctx.fillStyle = (r + c) % 2 ? '#ffd54d' : '#16263d';
      ctx.fillRect(x - 9 + c * 6, y - hgt + 8 + r * 6, 6, 6);
    }
  }
  ctx.fillStyle = '#ffd54d';
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('EXIT', x, y - hgt - 4);
}

export function drawBox(ctx: CanvasRenderingContext2D, cx: number, cy: number, held = false): void {
  const s = BOX_H / SUB;
  ctx.fillStyle = '#7f8b99';
  ctx.fillRect(cx - s, cy - s, s * 2, s * 2);
  ctx.fillStyle = '#d8dfe7';
  ctx.fillRect(cx - s + 3, cy - s + 3, s * 2 - 6, s * 2 - 6);
  ctx.fillStyle = held ? '#36e3d2' : '#8995a3';
  ctx.fillRect(cx - 4, cy - 4, 8, 8);
}

export function drawPlate(ctx: CanvasRenderingContext2D, x: number, y: number, channel: number, pressed: boolean): void {
  const hw = PLATE_HW / SUB;
  ctx.fillStyle = '#3a4350';
  ctx.fillRect(x - hw - 2, y - 4, hw * 2 + 4, 4);
  ctx.fillStyle = CHANNEL_COLOURS[channel];
  ctx.globalAlpha = pressed ? 1 : 0.55;
  ctx.fillRect(x - hw, y - (pressed ? 5 : 8), hw * 2, pressed ? 2 : 4);
  ctx.globalAlpha = 1;
}

export function drawDoor(ctx: CanvasRenderingContext2D, cx: number, cy: number, channel: number, open: boolean): void {
  const x = cx * T;
  const y = cy * T;
  const col = CHANNEL_COLOURS[channel];
  ctx.strokeStyle = col;
  ctx.lineWidth = 2;
  if (open) {
    ctx.globalAlpha = 0.35;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x + 2, y + 2, T - 4, T - 4);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    return;
  }
  ctx.fillStyle = 'rgba(20, 28, 40, 0.75)';
  ctx.fillRect(x, y, T, T);
  ctx.fillStyle = col;
  for (let i = 0; i < 4; i++) ctx.fillRect(x + 4 + i * 7, y + 1, 2, T - 2);
  ctx.strokeRect(x + 1, y + 1, T - 2, T - 2);
}

export function drawDispenser(
  ctx: CanvasRenderingContext2D, x: number, y: number, liquid: number, dir: number, channel: number, on: boolean,
): void {
  ctx.fillStyle = '#4a5463';
  ctx.fillRect(x - 12, y - 12, 24, 24);
  ctx.fillStyle = '#5e6a7b';
  ctx.fillRect(x - 10, y - 10, 20, 20);
  ctx.fillStyle = LIQUID_COLOURS[liquid];
  const nx = DX[dir];
  const ny = DY[dir];
  // nozzle
  if (nx !== 0) ctx.fillRect(x + nx * 10 - (nx < 0 ? 6 : 0), y - 5, 6, 10);
  else ctx.fillRect(x - 5, y + ny * 10 - (ny < 0 ? 6 : 0), 10, 6);
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fill();
  // channel tag and on/off light
  ctx.fillStyle = CHANNEL_COLOURS[channel];
  ctx.fillRect(x - 11, y - 11, 5, 5);
  ctx.fillStyle = on ? '#7dff9a' : '#59202a';
  ctx.fillRect(x + 6, y - 11, 5, 5);
}

export function drawLevelObject(ctx: CanvasRenderingContext2D, o: LevelObject): void {
  switch (o.kind) {
    case 'start': return drawStart(ctx, o.x, o.y);
    case 'finish': return drawFinish(ctx, o.x, o.y);
    case 'box': return drawBox(ctx, o.x, o.y - BOX_H / SUB);
    case 'plate': return drawPlate(ctx, o.x, o.y, o.channel, false);
    case 'door': return drawDoor(ctx, o.cx, o.cy, o.channel, false);
    case 'dispenser': return drawDispenser(ctx, o.x, o.y, o.liquid, o.dir, o.channel, o.defaultOn);
  }
}

/** Editor hit box of an object, in world pixels. */
export function objectBounds(o: LevelObject): [number, number, number, number] {
  switch (o.kind) {
    case 'start': return [o.x - 14, o.y - 44, o.x + 14, o.y];
    case 'finish': return [o.x - 14, o.y - 48, o.x + 14, o.y];
    case 'box': return [o.x - 12, o.y - 24, o.x + 12, o.y];
    case 'plate': return [o.x - 16, o.y - 10, o.x + 16, o.y];
    case 'door': return [o.cx * T, o.cy * T, o.cx * T + T, o.cy * T + T];
    case 'dispenser': return [o.x - 13, o.y - 13, o.x + 13, o.y + 13];
  }
}

// ------------------------------------------------------------------- game

function drawPortal(ctx: CanvasRenderingContext2D, p: Portal, i: number, t: number): void {
  const col = PORTAL_COLOURS[i];
  const { n, t: tan, len } = faceAxes(p);
  const [cx, cy] = centrePx(p);
  const pulse = 0.5 + 0.5 * Math.sin(t / 6);
  ctx.save();
  // local frame: x out of the face, y along it, origin at the centre (works at any angle)
  ctx.transform(n[0], n[1], tan[0], tan[1], cx, cy);
  ctx.fillStyle = col;
  // glow out into the room
  for (let k = 0; k < 3; k++) {
    ctx.globalAlpha = 0.12 + 0.06 * pulse - k * 0.03;
    ctx.fillRect(0, -len + 2, 6 + k * 4, 2 * len - 4);
  }
  ctx.globalAlpha = 1;
  // the mouth (sits over the wall face)
  ctx.fillRect(-5, -len, 5, 2 * len);
  ctx.fillStyle = '#0b1422';
  ctx.fillRect(-9, -len + 4, 4, 2 * len - 8);
  ctx.restore();
}

function drawNameTag(ctx: CanvasRenderingContext2D, x: number, y: number, name: string, colour: string): void {
  ctx.save();
  ctx.font = 'bold 10px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const w = ctx.measureText(name).width + 8;
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = '#0b1422';
  ctx.fillRect(x - w / 2, y - 13, w, 13);
  ctx.globalAlpha = 1;
  ctx.fillStyle = colour;
  ctx.fillText(name, x, y - 1);
  ctx.restore();
}

export function drawPlayer(
  ctx: CanvasRenderingContext2D, x: number, y: number, aimX: number, aimY: number, facing: number, ghost: boolean,
  ghostColour = '#b8c8ff',
): void {
  const hw = PLAYER_HW / SUB;
  const hh = PLAYER_HH / SUB;
  ctx.save();
  if (ghost) ctx.globalAlpha = 0.45;
  const bodyCol = ghost ? ghostColour : '#e9eef4';
  const top = y - hh;
  // legs
  ctx.fillStyle = ghost ? '#8090c0' : '#4a5568';
  ctx.fillRect(x - hw + 2, y + hh - 12, 6, 12);
  ctx.fillRect(x + hw - 8, y + hh - 12, 6, 12);
  // torso
  ctx.fillStyle = bodyCol;
  ctx.fillRect(x - hw, top + 13, hw * 2, hh * 2 - 25);
  // head and visor
  ctx.fillRect(x - 7, top, 14, 13);
  ctx.fillStyle = ghost ? '#6070a0' : '#25303f';
  ctx.fillRect(facing > 0 ? x - 1 : x - 7, top + 4, 8, 4);
  // gun arm
  const len = Math.hypot(aimX, aimY) || 1;
  const ux = aimX / len;
  const uy = aimY / len;
  const gx = x;
  const gy = y;
  ctx.strokeStyle = ghost ? '#8090c0' : '#9aa6b5';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(gx, gy - 4);
  ctx.lineTo(gx + ux * 18, gy - 4 + uy * 18);
  ctx.stroke();
  ctx.fillStyle = ghost ? ghostColour : '#36e3d2';
  ctx.fillRect(gx + ux * 18 - 2, gy - 4 + uy * 18 - 2, 4, 4);
  ctx.restore();
}

export interface GhostDraw {
  sim: Sim;
  colour: string;
  name: string;
}

export interface SimDrawOptions {
  ghosts?: GhostDraw[];
  frame: number;
}

/** Number of portal view wedges drawn in the last frame (observability for tests). */
export let lastViewCount = 0;
/** The view edge lines drawn in the last frame, in world pixels: [x0, y0, x1, y1, portal]. */
export let lastViewEdges: [number, number, number, number, number][] = [];

function drawBody(ctx: CanvasRenderingContext2D, sim: Sim, b: Body): void {
  const p = sim.player;
  if (b === p) drawPlayer(ctx, p.x / SUB, p.y / SUB, p.aimX, p.aimY, p.facing, false);
  else drawBox(ctx, b.x / SUB, b.y / SUB, p.holding === b);
}

/** One copy of the world: everything except views through portals. */
function drawScene(ctx: CanvasRenderingContext2D, sim: Sim, rect: Rect, zoom: number, opt: SimDrawOptions): void {
  drawBackdrop(ctx, rect, zoom, false);
  for (const f of sim.finishes) drawFinish(ctx, f.x / SUB, f.y / SUB);
  for (const pl of sim.plates) drawPlate(ctx, pl.x / SUB, pl.y / SUB, pl.channel, pl.pressed);
  for (const d of sim.dispensers) drawDispenser(ctx, d.x / SUB, d.y / SUB, d.liquid, d.dir, d.channel, d.on);

  // entities first, walls over them, so the part of a body inside a portal mouth is hidden by
  // the wall here and drawn coming out of the other portal instead
  for (const g of opt.ghosts ?? []) {
    const gp = g.sim.player;
    drawPlayer(ctx, gp.x / SUB, gp.y / SUB, gp.aimX, gp.aimY, gp.facing, true, g.colour);
    drawNameTag(ctx, gp.x / SUB, (gp.y - PLAYER_HH) / SUB - 8, g.name, g.colour);
  }
  const p = sim.player;
  const bodies: Body[] = [...sim.boxes.filter((b) => b !== p.holding), p, ...(p.holding ? [p.holding] : [])];
  for (const b of bodies) drawBody(ctx, sim, b);
  for (const c of crossings(sim, bodies)) {
    ctx.save();
    // only the part in front of the exit portal, within its mouth
    const { n, t: tan, len } = faceAxes(c.pout);
    const [ox, oy] = centrePx(c.pout);
    const at = (a: number, b: number) => [ox + n[0] * a + tan[0] * b, oy + n[1] * a + tan[1] * b] as const;
    ctx.beginPath();
    for (const [k, [a, b]] of [[0, -len], [200, -len], [200, len], [0, len]].entries()) {
      const [x, y] = at(a, b);
      if (k) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.clip();
    ctx.transform(...teleportAffine(c.pin, c.pout));
    drawBody(ctx, sim, c.body);
    ctx.restore();
  }

  for (const pt of sim.particles) {
    if (pt.dead) continue;
    ctx.fillStyle = LIQUID_COLOURS[pt.color];
    ctx.fillRect(pt.x / SUB - 2.5, pt.y / SUB - 2.5, 5, 5);
  }

  drawTiles(ctx, rect, zoom, sim.tileInfo, simFaceLook(sim));
  for (const d of sim.doors) drawDoor(ctx, d.cx, d.cy, d.channel, d.open);
  sim.portals.forEach((po, i) => po && drawPortal(ctx, po, i, opt.frame));
}

/** Where the player looks from: their head. */
export function eyeOf(sim: Sim): Pt {
  return [sim.player.x / SUB, (sim.player.y - 14 * SUB) / SUB];
}

function drawPortalViews(ctx: CanvasRenderingContext2D, sim: Sim, rect: Rect, zoom: number, opt: SimDrawOptions): number {
  const [a, c] = sim.portals;
  lastViewEdges = [];
  if (!a || !c) return 0;
  const eye = eyeOf(sim);
  const solid = simSolid(sim);
  const far = Math.hypot(rect[2] - rect[0], rect[3] - rect[1]) + 200;
  const edges: [number, number, number, number, number][] = [];
  lastViewEdges = edges;
  let n = 0;
  for (const [i, pin, pout] of [[0, a, c], [1, c, a]] as [number, Portal, Portal][]) {
    if (frontDistance(pin, eye) <= 0) continue;
    const toOut = teleportAffine(pin, pout);
    for (const span of visibleSpans(solid, eye, pin)) {
      const wedge = viewWedge(eye, pin, span, far);
      ctx.save();
      ctx.beginPath();
      wedge.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.clip();
      ctx.fillStyle = BACKGROUND;
      ctx.fill();
      // the world beyond the other portal, in this portal's frame
      const mapped = wedge.map((q) => applyAffine(toOut, q));
      const inner: Rect = [
        Math.min(...mapped.map((q) => q[0])), Math.min(...mapped.map((q) => q[1])),
        Math.max(...mapped.map((q) => q[0])), Math.max(...mapped.map((q) => q[1])),
      ];
      ctx.save();
      ctx.transform(...viewAffine(pin, pout));
      drawScene(ctx, sim, inner, zoom, opt);
      ctx.restore();
      // a faint tint so it reads as "through the portal"
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = PORTAL_COLOURS[i];
      ctx.fill();
      ctx.restore();
      // the edges of what is seen through it, from the portal outward, so the cut-off is easy to see
      ctx.save();
      ctx.strokeStyle = PORTAL_COLOURS[i];
      ctx.lineWidth = 2 / zoom;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      for (const [from, to] of [[wedge[0], wedge[3]], [wedge[1], wedge[2]]]) {
        ctx.moveTo(from[0], from[1]);
        ctx.lineTo(to[0], to[1]);
        edges.push([from[0], from[1], to[0], to[1], i]);
      }
      ctx.stroke();
      ctx.restore();
      n++;
    }
    // the mouth itself stays on top
    drawPortal(ctx, pin, i, opt.frame);
  }
  return n;
}

export function drawSim(ctx: CanvasRenderingContext2D, cam: Camera, w: number, h: number, sim: Sim, opt: SimDrawOptions): void {
  const rect = visibleRect(cam, w, h);
  drawScene(ctx, sim, rect, cam.zoom, opt);
  lastViewCount = drawPortalViews(ctx, sim, rect, cam.zoom, opt);

  const shot = sim.lastShot;
  if (shot && sim.tick - shot.tick < 8) {
    ctx.save();
    ctx.globalAlpha = 1 - (sim.tick - shot.tick) / 8;
    ctx.strokeStyle = shot.ok ? PORTAL_COLOURS[shot.portal] : '#8a93a0';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(shot.x0 / SUB, shot.y0 / SUB);
    ctx.lineTo(shot.x1 / SUB, shot.y1 / SUB);
    ctx.stroke();
    ctx.restore();
  }
}
