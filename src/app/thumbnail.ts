// Small pictures of a level for the level lists. Drawn from the level data with the
// editor's own drawing code, so a thumbnail always shows exactly what the level is.
import { TILE_PX, cellKey } from '../sim/fixed';
import { tileInfo, type LevelData, type TileInfo } from '../sim/level';
import { beginFrame, drawTiles, levelFaceLook, drawLevelObject, objectBounds, type Rect } from './render';

export const THUMB_W = 120;
export const START_DOT = '#4fdc84';
export const FINISH_DOT = '#ffd54d';
export const THUMB_H = 68;

/** World-pixel box around every tile and object, with a little margin. */
export function levelBounds(data: LevelData): Rect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const t of data.tiles) {
    x0 = Math.min(x0, t[0] * TILE_PX);
    y0 = Math.min(y0, t[1] * TILE_PX);
    x1 = Math.max(x1, (t[0] + 1) * TILE_PX);
    y1 = Math.max(y1, (t[1] + 1) * TILE_PX);
  }
  for (const o of data.objects) {
    const b = objectBounds(o);
    x0 = Math.min(x0, b[0]);
    y0 = Math.min(y0, b[1]);
    x1 = Math.max(x1, b[2]);
    y1 = Math.max(y1, b[3]);
  }
  if (!Number.isFinite(x0)) return null;
  const m = TILE_PX / 2;
  return [x0 - m, y0 - m, x1 + m, y1 + m];
}

/** Draws the whole level, fitted and centred, into a canvas of the thumbnail size. */
export function drawThumbnail(canvas: HTMLCanvasElement, data: LevelData): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = THUMB_W * dpr;
  canvas.height = THUMB_H * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const b = levelBounds(data);
  if (!b) {
    beginFrame(ctx, { x: 0, y: 0, zoom: 1 }, THUMB_W, THUMB_H, dpr);
    return;
  }
  const zoom = Math.min(THUMB_W / (b[2] - b[0]), THUMB_H / (b[3] - b[1]));
  beginFrame(ctx, { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, zoom }, THUMB_W, THUMB_H, dpr);
  const tiles = new Map<number, TileInfo>();
  for (const t of data.tiles) tiles.set(cellKey(t[0], t[1]), tileInfo(t));
  drawTiles(ctx, b, zoom, tiles, levelFaceLook(tiles));
  for (const o of data.objects) drawLevelObject(ctx, o);
  // the start and finish markers are too thin to read this small: a dot for each that stays visible
  const r = 3.5 / zoom;
  for (const o of data.objects) {
    if (o.kind !== 'start' && o.kind !== 'finish') continue;
    ctx.fillStyle = o.kind === 'start' ? START_DOT : FINISH_DOT;
    ctx.beginPath();
    ctx.arc(o.x, o.y - 20, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** A thumbnail element for a level row. */
export function thumbnail(data: LevelData | null): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'thumb';
  canvas.dataset.testid = 'thumb';
  canvas.style.width = `${THUMB_W}px`;
  canvas.style.height = `${THUMB_H}px`;
  if (data) drawThumbnail(canvas, data);
  else canvas.dataset.loading = '1';
  return canvas;
}
