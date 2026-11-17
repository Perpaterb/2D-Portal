// Canvas rendering for the editor and the game. Visual only: nothing here feeds back
// into the simulation, so it is free to use floating point.
import { SUB, TILE_PX, cellKey, keyCx, keyCy, DX, DY } from '../sim/fixed';
import { BLUE, ORANGE, WHITE, WHITE_WALL, type LevelObject, type TileKind } from '../sim/level';
import {
  Sim, PLAYER_HW, PLAYER_HH, BOX_H, PLATE_HW, FINISH_HW, FINISH_H, type Portal, type Box,
} from '../sim/sim';

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
}

export function screenToWorld(cam: Camera, w: number, h: number, sx: number, sy: number): [number, number] {
  return [(sx - w / 2) / cam.zoom + cam.x, (sy - h / 2) / cam.zoom + cam.y];
}

export function beginFrame(ctx: CanvasRenderingContext2D, cam: Camera, w: number, h: number, dpr: number): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0b1422';
  ctx.fillRect(0, 0, w, h);
  const z = cam.zoom;
  ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (w / 2 - cam.x * z), dpr * (h / 2 - cam.y * z));
}

function visibleCells(cam: Camera, w: number, h: number): [number, number, number, number] {
  const [x0, y0] = screenToWorld(cam, w, h, 0, 0);
  const [x1, y1] = screenToWorld(cam, w, h, w, h);
  return [Math.floor(x0 / T) - 1, Math.floor(y0 / T) - 1, Math.floor(x1 / T) + 1, Math.floor(y1 / T) + 1];
}

export function drawBackdrop(ctx: CanvasRenderingContext2D, cam: Camera, w: number, h: number, grid: boolean): void {
  const [cx0, cy0, cx1, cy1] = visibleCells(cam, w, h);
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

export function drawTiles(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  w: number,
  h: number,
  tiles: Map<number, TileKind>,
  paint: Map<number, number> | null,
): void {
  const [cx0, cy0, cx1, cy1] = visibleCells(cam, w, h);
  const visible = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
  const list: [number, number, TileKind][] = [];
  if (visible < tiles.size) {
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = tiles.get(cellKey(cx, cy));
        if (k !== undefined) list.push([cx, cy, k]);
      }
    }
  } else {
    for (const [key, k] of tiles) {
      const cx = keyCx(key);
      const cy = keyCy(key);
      if (cx >= cx0 && cx <= cx1 && cy >= cy0 && cy <= cy1) list.push([cx, cy, k]);
    }
  }
  // bodies
  for (const [cx, cy, k] of list) {
    const x = cx * T;
    const y = cy * T;
    if (k === WHITE_WALL) {
      ctx.fillStyle = '#c3ced9';
      ctx.fillRect(x, y, T, T);
      ctx.fillStyle = '#d3dce5';
      ctx.fillRect(x + 2, y + 2, T - 4, T - 4);
    } else {
      ctx.fillStyle = '#262c35';
      ctx.fillRect(x, y, T, T);
      ctx.fillStyle = '#2e3540';
      ctx.fillRect(x + 3, y + 3, T - 6, T - 6);
    }
  }
  // exposed edges
  const fine = cam.zoom >= 0.4;
  for (const [cx, cy, k] of list) {
    for (let f = 0; f < 4; f++) {
      if (tiles.has(cellKey(cx + DX[f], cy + DY[f]))) continue;
      const [ex, ey, ew, eh] = faceRect(cx, cy, f, 3);
      if (k === WHITE_WALL) {
        if (fine) {
          ctx.fillStyle = 'rgba(150, 225, 255, 0.22)';
          const [gx, gy, gw, gh] = faceRect(cx, cy, f, -5);
          ctx.fillRect(gx, gy, gw, gh);
        }
        ctx.fillStyle = '#ffffff';
      } else ctx.fillStyle = '#566173';
      ctx.fillRect(ex, ey, ew, eh);
      const pc = paint?.get(cellKey(cx, cy) * 4 + f);
      if (pc) {
        ctx.fillStyle = LIQUID_COLOURS[pc];
        const [px, py, pw, ph] = faceRect(cx, cy, f, 6);
        ctx.fillRect(px, py, pw, ph);
      }
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
  const plane = p.plane / SUB;
  const t0 = p.t0 / SUB;
  const len = (p.t1 - p.t0) / SUB;
  const horizontalNormal = p.n === 0 || p.n === 2;
  const out = p.n === 0 || p.n === 1 ? 1 : -1;
  const pulse = 0.5 + 0.5 * Math.sin(t / 6);
  ctx.save();
  ctx.fillStyle = col;
  // glow out into the room
  for (let k = 0; k < 3; k++) {
    ctx.globalAlpha = 0.12 + 0.06 * pulse - k * 0.03;
    const d = 6 + k * 4;
    if (horizontalNormal) ctx.fillRect(out > 0 ? plane : plane - d, t0 + 2, d, len - 4);
    else ctx.fillRect(t0 + 2, out > 0 ? plane : plane - d, len - 4, d);
  }
  ctx.globalAlpha = 1;
  // the mouth (sits over the wall face)
  if (horizontalNormal) ctx.fillRect(out > 0 ? plane - 5 : plane, t0, 5, len);
  else ctx.fillRect(t0, out > 0 ? plane - 5 : plane, len, 5);
  ctx.fillStyle = '#0b1422';
  if (horizontalNormal) ctx.fillRect(out > 0 ? plane - 9 : plane + 5, t0 + 4, 4, len - 8);
  else ctx.fillRect(t0 + 4, out > 0 ? plane - 9 : plane + 5, len - 8, 4);
  ctx.restore();
}

export function drawPlayer(
  ctx: CanvasRenderingContext2D, x: number, y: number, aimX: number, aimY: number, facing: number, ghost: boolean,
): void {
  const hw = PLAYER_HW / SUB;
  const hh = PLAYER_HH / SUB;
  ctx.save();
  if (ghost) ctx.globalAlpha = 0.38;
  const bodyCol = ghost ? '#b8c8ff' : '#e9eef4';
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
  ctx.fillStyle = ghost ? '#b8c8ff' : '#36e3d2';
  ctx.fillRect(gx + ux * 18 - 2, gy - 4 + uy * 18 - 2, 4, 4);
  ctx.restore();
}

export interface SimDrawOptions {
  ghost?: Sim | null;
  frame: number;
}

export function drawSim(ctx: CanvasRenderingContext2D, cam: Camera, w: number, h: number, sim: Sim, opt: SimDrawOptions): void {
  drawBackdrop(ctx, cam, w, h, false);
  for (const f of sim.finishes) drawFinish(ctx, f.x / SUB, f.y / SUB);
  for (const pl of sim.plates) drawPlate(ctx, pl.x / SUB, pl.y / SUB, pl.channel, pl.pressed);
  for (const d of sim.dispensers) drawDispenser(ctx, d.x / SUB, d.y / SUB, d.liquid, d.dir, d.channel, d.on);

  // entities first, walls over them, so anything half-way into a portal is hidden by the wall
  const g = opt.ghost;
  if (g) {
    const gp = g.player;
    drawPlayer(ctx, gp.x / SUB, gp.y / SUB, gp.aimX, gp.aimY, gp.facing, true);
  }
  for (const b of sim.boxes) if (!b.held) drawBox(ctx, b.x / SUB, b.y / SUB);
  const p = sim.player;
  drawPlayer(ctx, p.x / SUB, p.y / SUB, p.aimX, p.aimY, p.facing, false);
  const held: Box | null = p.holding;
  if (held) drawBox(ctx, held.x / SUB, held.y / SUB, true);

  for (const pt of sim.particles) {
    if (pt.dead) continue;
    ctx.fillStyle = LIQUID_COLOURS[pt.color];
    ctx.fillRect(pt.x / SUB - 2.5, pt.y / SUB - 2.5, 5, 5);
  }

  drawTiles(ctx, cam, w, h, sim.tiles, sim.paint);
  for (const d of sim.doors) drawDoor(ctx, d.cx, d.cy, d.channel, d.open);
  sim.portals.forEach((po, i) => po && drawPortal(ctx, po, i, opt.frame));

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
