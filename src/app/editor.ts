import { mount, navigate } from './router';
import { el, promptBox, toast, pickJsonFile } from './ui';
import {
  beginFrame, drawBackdrop, drawTiles, levelFaceLook, drawLevelObject, objectBounds, screenToWorld, visibleRect,
  CHANNEL_COLOURS, CHANNEL_NAMES, LIQUID_NAMES, type Camera,
} from './render';
import { getLevel, saveLevel, getBest, type LocalLevel } from './storage';
import { startPlay } from './play';
import { TILE_PX, cellKey, keyCx, keyCy, CELL_LIMIT } from '../sim/fixed';
import {
  WHITE_WALL, DARK_WALL, BLUE_BLOCK, ORANGE_BLOCK, BLUE, ORANGE, WHITE, DEFAULT_CAP, MIN_CAP, MAX_CAP, checkPlayable, parseLevel, levelHash,
  SLOPE_NORMALS, tileInfo, tileTuple, sameTile, normaliseTile, isOpenFace, hypFace,
  type LevelData, type LevelObject, type TileKind, type TileInfo, type Liquid,
} from '../sim/level';
import { parseReplay } from '../sim/replay';

type Tool =
  | 'select' | 'erase' | 'wall'
  | 'start' | 'finish' | 'box' | 'plate' | 'door'
  | 'disp-blue' | 'disp-orange' | 'disp-white';

const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: 'select', label: 'Select', key: 'V' },
  { id: 'erase', label: 'Erase', key: 'X' },
  { id: 'wall', label: 'Wall', key: '' },
  { id: 'start', label: 'Start', key: '3' },
  { id: 'finish', label: 'Finish', key: '4' },
  { id: 'box', label: 'Box', key: '5' },
  { id: 'plate', label: 'Plate', key: '6' },
  { id: 'door', label: 'Door', key: '7' },
  { id: 'disp-blue', label: 'Blue gel', key: '8' },
  { id: 'disp-orange', label: 'Orange bounce', key: '9' },
  { id: 'disp-white', label: 'White paint', key: '0' },
];

/** What the Wall tool places: a full block, one coloured side, or a slope. */
type WallMode = 'full' | 'side' | 'slope';
interface WallCfg { mode: WallMode; side: number; shape: number; colour: TileKind }

/** Shortcut keys that pick a full block of one colour. */
const WALL_KEYS: Record<string, TileKind> = { '1': WHITE_WALL, '2': DARK_WALL, b: BLUE_BLOCK, o: ORANGE_BLOCK };

const COLOURS: { c: TileKind; name: string; hex: string }[] = [
  { c: WHITE_WALL, name: 'White', hex: '#e8eef4' },
  { c: DARK_WALL, name: 'Dark grey', hex: '#3a4250' },
  { c: BLUE_BLOCK, name: 'Blue', hex: '#2f7bff' },
  { c: ORANGE_BLOCK, name: 'Orange', hex: '#ff8a1f' },
];
const hexOf = (c: TileKind) => COLOURS.find((x) => x.c === c)!.hex;
const SIDE_NAMES = ['Right', 'Bottom', 'Left', 'Top'];
const SLOPE_NAMES = ['Floor rising right', 'Floor rising left', 'Ceiling, left', 'Ceiling, right'];

/** A 16 px picture of a wall setting, for the toolbar button and the pop-out. */
function wallIcon(cfg: WallCfg, size = 16): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  const add = (tag: string, attrs: Record<string, string>) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.append(e);
  };
  const fill = hexOf(cfg.colour);
  if (cfg.mode === 'full') add('rect', { x: '1', y: '1', width: '14', height: '14', rx: '2', fill });
  else if (cfg.mode === 'side') {
    add('rect', { x: '1', y: '1', width: '14', height: '14', rx: '2', fill: '#2e3540', stroke: '#566173' });
    const r = [['11', '1', '4', '14'], ['1', '11', '14', '4'], ['1', '1', '4', '14'], ['1', '1', '14', '4']][cfg.side];
    add('rect', { x: r[0], y: r[1], width: r[2], height: r[3], fill });
  } else {
    const [nx, ny] = SLOPE_NORMALS[cfg.shape - 1];
    const ox = nx > 0 ? 15 : 1;
    const oy = ny > 0 ? 15 : 1;
    const fx = nx > 0 ? 1 : 15;
    const fy = ny > 0 ? 1 : 15;
    add('polygon', { points: `${ox},${fy} ${fx},${oy} ${fx},${fy}`, fill });
  }
  return svg;
}

type Area = { x0: number; y0: number; x1: number; y1: number };
type Float = { base: string; baseObjects: LevelObject[]; tiles: [number, number, TileInfo][]; objects: LevelObject[]; ox: number; oy: number };

const SNAP_KEY = '2dholes.snap';
const T = TILE_PX;

function loadSnap(): boolean {
  try {
    return localStorage.getItem(SNAP_KEY) !== 'off';
  } catch {
    return true;
  }
}

function storeSnap(on: boolean): void {
  try {
    localStorage.setItem(SNAP_KEY, on ? 'on' : 'off');
  } catch {
    /* ignore */
  }
}

const WALL_KEY = '2dholes.wall';

function loadWall(): WallCfg {
  const fallback: WallCfg = { mode: 'full', side: 3, shape: 1, colour: WHITE_WALL };
  try {
    const w = JSON.parse(localStorage.getItem(WALL_KEY) ?? 'null') as WallCfg | null;
    if (w && ['full', 'side', 'slope'].includes(w.mode) && w.side >= 0 && w.side <= 3 && w.shape >= 1 && w.shape <= 4 && COLOURS.some((c) => c.c === w.colour)) return w;
  } catch {
    /* ignore */
  }
  return fallback;
}

function storeWall(w: WallCfg): void {
  try {
    localStorage.setItem(WALL_KEY, JSON.stringify(w));
  } catch {
    /* ignore */
  }
}

/** Remembered camera per level, so coming back from play keeps your view. */
const camMemory = new Map<string, Camera>();

export function showEditor(id: string): boolean {
  const stored = getLevel(id);
  if (!stored) return false;
  let level: LocalLevel = stored;

  mount((root) => {
    // ------------------------------------------------------------- model
    const tiles = new Map<number, TileInfo>();
    let objects: LevelObject[] = [];
    const load = (d: LevelData) => {
      tiles.clear();
      for (const t of d.tiles) tiles.set(cellKey(t[0], t[1]), tileInfo(t));
      objects = d.objects.map((o) => ({ ...o }));
    };
    load(level.data);
    const toData = (): LevelData => ({
      v: 1,
      tiles: [...tiles].map(([k, info]) => tileTuple(keyCx(k), keyCy(k), info)),
      objects: objects.map((o) => ({ ...o })),
    });
    const nextId = () => objects.reduce((m, o) => Math.max(m, o.id), 0) + 1;

    let tool: Tool = 'wall';
    let wall: WallCfg = loadWall();
    let snap = loadSnap();
    let channel = 0;
    let selected: number | null = null;
    /** grid-aligned selection rectangle in cells; x1 / y1 are exclusive */
    let area: Area | null = null;
    /**
     * Content lifted out of the level while it is being moved or duplicated. The level is always
     * `base` with the floating content stamped on at (ox, oy), so whatever it passes over comes
     * back untouched until the selection is let go.
     */
    let float: Float | null = null;
    const cam: Camera = camMemory.get(id) ?? { x: 0, y: 0, zoom: 1 };
    camMemory.set(id, cam);
    const undo: string[] = [];
    const redo: string[] = [];

    const snapshot = () => JSON.stringify(toData());
    const pushUndo = () => {
      undo.push(snapshot());
      if (undo.length > 200) undo.shift();
      redo.length = 0;
    };
    let saveTimer = 0;
    const saveNow = () => {
      clearTimeout(saveTimer);
      level = { ...level, data: parseLevel(toData()), updatedAt: new Date().toISOString() };
      if (!saveLevel(level)) toast('Could not save: browser storage is full or blocked');
    };
    const changed = () => {
      clearTimeout(saveTimer);
      saveTimer = window.setTimeout(saveNow, 250);
      refreshChrome();
    };

    // ------------------------------------------------------------- DOM
    const canvas = el('canvas', { class: 'editor-canvas', 'data-testid': 'editor-canvas' });
    const ctx = canvas.getContext('2d')!;
    const nameBtn = el('button', { class: 'level-title', title: 'Rename', 'data-testid': 'level-title' }, level.name);
    const snapBtn = el('button', { class: 'btn toggle', 'data-testid': 'snap-toggle' });
    const undoBtn = el('button', { class: 'btn', title: 'Undo (Ctrl+Z)', 'data-testid': 'undo' }, 'Undo');
    const redoBtn = el('button', { class: 'btn', title: 'Redo (Ctrl+Y)', 'data-testid': 'redo' }, 'Redo');
    const bestBtn = el('button', { class: 'btn', 'data-testid': 'watch-best' }, 'Watch best');
    const loadReplayBtn = el('button', { class: 'btn', 'data-testid': 'load-replay' }, 'Load replay');
    const playBtn = el('button', { class: 'btn play', 'data-testid': 'play' }, '▶ Play');
    const playWrap = el('span', { class: 'play-wrap' }, playBtn);
    const toolbar = el('div', { class: 'toolbar', 'data-testid': 'toolbar' });
    const props = el('div', { class: 'props hidden', 'data-testid': 'props' });
    const status = el('div', { class: 'editor-status' }, 'Middle mouse drag: move · Wheel: zoom · Left: place · Right: erase · Select: drag a box, Ctrl+D duplicates · Ctrl+Z / Ctrl+Y');

    const toolButtons = new Map<Tool, HTMLButtonElement>();
    const wallIconSlot = el('span', { class: 'tool-icon icon-wall' });
    const wallLabel = el('span', { class: 'tool-label' }, 'Wall');
    const flyout = el('div', { class: 'flyout hidden', 'data-testid': 'wall-flyout' });
    for (const t of TOOLS) {
      const isWall = t.id === 'wall';
      const b = el('button', {
        class: 'tool', 'data-tool': t.id,
        title: isWall ? 'Wall: click for full, one side or slope, then a colour (1, 2, B, O)' : `${t.label} (${t.key})`,
        onclick: () => {
          setTool(t.id);
          if (isWall) toggleFlyout();
        },
      }, isWall ? wallIconSlot : el('span', { class: `tool-icon icon-${t.id}` }), isWall ? wallLabel : el('span', { class: 'tool-label' }, t.label));
      toolButtons.set(t.id, b);
      toolbar.append(b);
      if (t.id === 'erase') toolbar.append(el('div', { class: 'tool-sep' }));
    }

    // ------------------------------------------------------------- wall pop-out
    let flyMode: WallMode = wall.mode;
    const paintWallButton = () => {
      wallIconSlot.replaceChildren(wallIcon(wall));
      const colour = COLOURS.find((c) => c.c === wall.colour)!.name;
      wallLabel.textContent = wall.mode === 'full' ? `${colour} wall` : wall.mode === 'side' ? `${colour} ${SIDE_NAMES[wall.side].toLowerCase()} side` : `${colour} slope`;
    };
    const closeFlyout = () => flyout.classList.add('hidden');
    const renderFlyout = () => {
      const step = (label: string, ...kids: HTMLElement[]) => el('div', { class: 'fly-step' }, el('div', { class: 'fly-label' }, label), el('div', { class: 'fly-row' }, ...kids));
      const pick = (icon: WallCfg, title: string, on: boolean, testid: string, after: () => void) =>
        el('button', { class: `fly-btn ${on ? 'on' : ''}`, title, 'aria-label': title, 'data-testid': testid, onclick: after }, wallIcon(icon, 22));
      const rows: HTMLElement[] = [
        step('Shape',
          pick({ ...wall, mode: 'full' }, 'Full block', flyMode === 'full', 'fly-full', () => { flyMode = 'full'; renderFlyout(); }),
          pick({ ...wall, mode: 'side' }, 'One side', flyMode === 'side', 'fly-side', () => { flyMode = 'side'; renderFlyout(); }),
          pick({ ...wall, mode: 'slope' }, 'Slope', flyMode === 'slope', 'fly-slope', () => { flyMode = 'slope'; renderFlyout(); })),
      ];
      if (flyMode === 'side') {
        rows.push(step('Which side', ...[3, 0, 1, 2].map((f) =>
          pick({ ...wall, mode: 'side', side: f }, SIDE_NAMES[f], wall.side === f, `fly-side-${f}`, () => { wall = { ...wall, side: f }; renderFlyout(); }))));
      }
      if (flyMode === 'slope') {
        rows.push(step('Which way', ...[1, 2, 3, 4].map((sh) =>
          pick({ ...wall, mode: 'slope', shape: sh }, SLOPE_NAMES[sh - 1], wall.shape === sh, `fly-shape-${sh}`, () => { wall = { ...wall, shape: sh }; renderFlyout(); }))));
      }
      rows.push(step('Colour', ...COLOURS.map(({ c, name }) =>
        pick({ ...wall, mode: flyMode, colour: c }, name, wall.colour === c && wall.mode === flyMode, `fly-colour-${c}`, () => {
          setWall({ ...wall, mode: flyMode, colour: c });
          closeFlyout();
        }))));
      flyout.replaceChildren(...rows);
    };
    function toggleFlyout() {
      if (!flyout.classList.contains('hidden')) return closeFlyout();
      flyMode = wall.mode;
      renderFlyout();
      const b = toolButtons.get('wall')!;
      flyout.style.top = `${b.offsetTop - toolbar.scrollTop}px`;
      flyout.classList.remove('hidden');
    }
    function setWall(cfg: WallCfg) {
      wall = cfg;
      storeWall(wall);
      paintWallButton();
      setTool('wall');
    }
    paintWallButton();

    root.append(
      el('div', { class: 'editor' },
        el('div', { class: 'topbar' },
          el('div', { class: 'topbar-left' },
            el('button', { class: 'btn', 'data-testid': 'back-to-menu', onclick: () => { saveNow(); navigate('#/'); } }, '← Menu'),
            nameBtn,
            el('span', { class: 'mode-chip' }, 'Creator')),
          el('div', { class: 'topbar-right' }, snapBtn, undoBtn, redoBtn, loadReplayBtn, bestBtn, playWrap)),
        el('div', { class: 'editor-body' }, toolbar, flyout, el('div', { class: 'canvas-wrap' }, canvas, status, props))));

    function refreshChrome() {
      snapBtn.textContent = `Snap to grid: ${snap ? 'On' : 'Off'}`;
      snapBtn.classList.toggle('on', snap);
      undoBtn.disabled = undo.length === 0;
      redoBtn.disabled = redo.length === 0;
      const check = checkPlayable(toData());
      playBtn.disabled = !check.ok;
      playWrap.title = check.ok ? 'Play this level (P)' : `Not playable yet: ${check.problems.join(', ')}`;
      playBtn.setAttribute('aria-label', playWrap.title);
      bestBtn.disabled = !getBest(id, toData());
      for (const [t, b] of toolButtons) b.classList.toggle('active', t === tool);
      publishHook();
      renderProps();
    }

    function publishHook() {
      window.__holes.editor = { tiles: tiles.size, objects: objects.length, cam, snap, area: area && { ...area }, floating: !!float };
    }

    function setTool(t: Tool) {
      tool = t;
      if (t !== 'select') {
        selected = null;
        letGo();
      }
      refreshChrome();
    }

    // ------------------------------------------------------------- overlap
    /** Things that stand on the floor may stand on a plate; that is how plates get pressed. */
    const STANDS = new Set(['start', 'finish', 'box']);
    const boundsOverlap = (a: LevelObject, b: LevelObject) => {
      if ((a.kind === 'plate' && STANDS.has(b.kind)) || (b.kind === 'plate' && STANDS.has(a.kind))) return false;
      const [ax0, ay0, ax1, ay1] = objectBounds(a);
      const [bx0, by0, bx1, by1] = objectBounds(b);
      return ax0 < bx1 && bx0 < ax1 && ay0 < by1 && by0 < ay1;
    };
    /** Objects never sit on top of each other (touching edges is fine). */
    const blockedBy = (o: LevelObject, others: LevelObject[], ignore?: (q: LevelObject) => boolean) =>
      others.some((q) => q.id !== o.id && !(ignore && ignore(q)) && boundsOverlap(o, q));
    const fits = (f: Float, ox: number, oy: number) =>
      !f.objects.some((o) => blockedBy(shifted(o, ox, oy), f.baseObjects));

    // ------------------------------------------------------------- area selection
    const shifted = (o: LevelObject, dcx: number, dcy: number): LevelObject =>
      o.kind === 'door' ? { ...o, cx: o.cx + dcx, cy: o.cy + dcy } : { ...o, x: o.x + dcx * T, y: o.y + dcy * T };

    /** An object belongs to the area when the middle of its outline is inside. */
    const inArea = (a: Area, o: LevelObject) => {
      const [x0, y0, x1, y1] = objectBounds(o);
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      return mx >= a.x0 * T && mx < a.x1 * T && my >= a.y0 * T && my < a.y1 * T;
    };

    const tilesIn = (a: Area): [number, number, TileInfo][] => {
      const out: [number, number, TileInfo][] = [];
      for (const [k, kind] of tiles) {
        const cx = keyCx(k);
        const cy = keyCy(k);
        if (cx >= a.x0 && cx < a.x1 && cy >= a.y0 && cy < a.y1) out.push([cx, cy, kind]);
      }
      return out;
    };

    /** Lifts the area's content into the floating layer: moved, or copied (all but the start). */
    const lift = (copy: boolean) => {
      if (!area || float) return;
      pushUndo();
      const a = area;
      const ts = tilesIn(a);
      const inside = objects.filter((o) => inArea(a, o) && !(copy && o.kind === 'start'));
      let id = nextId();
      const fo = inside.map((o) => shifted({ ...o, id: copy ? id++ : o.id }, -a.x0, -a.y0));
      if (!copy) {
        for (const [cx, cy] of ts) tiles.delete(cellKey(cx, cy));
        const ids = new Set(inside.map((o) => o.id));
        objects = objects.filter((o) => !ids.has(o.id));
      }
      float = { base: snapshot(), baseObjects: objects.map((o) => ({ ...o })), tiles: ts.map(([cx, cy, k]) => [cx - a.x0, cy - a.y0, k]), objects: fo, ox: a.x0, oy: a.y0 };
    };

    /** Rebuilds the level as base + floating content at its current offset. */
    const stamp = () => {
      if (!float) return;
      const f = float;
      load(JSON.parse(f.base));
      for (const [rx, ry, kind] of f.tiles) setTile(rx + f.ox, ry + f.oy, kind);
      for (const o of f.objects) {
        const c = shifted(o, f.ox, f.oy);
        if (c.kind === 'door') {
          objects = objects.filter((q) => !(q.kind === 'door' && q.cx === c.cx && q.cy === c.cy));
          tiles.delete(cellKey(c.cx, c.cy));
        }
        if (c.kind === 'start') objects = objects.filter((q) => q.kind !== 'start');
        objects.push(c);
      }
    };

    /** Drops the floating content where it is; the level already shows it there. */
    const letGo = () => {
      float = null;
      area = null;
    };

    const duplicateArea = () => {
      if (!area) return;
      float = null; // the current floating content stays where it is
      lift(true);
      // lift() sets float; TypeScript cannot see that through the call
      const f = float as Float | null;
      if (!f) return;
      // put the copy somewhere visibly separate that does not land on other objects
      const aw = area.x1 - area.x0;
      const ah = area.y1 - area.y0;
      const spot = ([[1, 1], [aw, 0], [0, ah], [-aw, 0], [0, -ah], [aw + 1, 0], [0, ah + 1]] as const)
        .find(([dx, dy]) => fits(f, f.ox + dx, f.oy + dy));
      if (!spot) {
        float = null;
        undo.pop();
        toast('No free space next to the selection for a copy');
        refreshChrome();
        return;
      }
      f.ox += spot[0];
      f.oy += spot[1];
      area = { x0: area.x0 + spot[0], y0: area.y0 + spot[1], x1: area.x1 + spot[0], y1: area.y1 + spot[1] };
      stamp();
      changed();
    };

    const deleteArea = () => {
      if (!area) return;
      if (float) {
        // dropping floating content leaves the base; undo brings back what was showing
        pushUndo();
        load(JSON.parse(float.base));
      } else {
        pushUndo();
        const a = area;
        for (const [cx, cy] of tilesIn(a)) tiles.delete(cellKey(cx, cy));
        objects = objects.filter((o) => !inArea(a, o));
      }
      letGo();
      changed();
    };

    type Edges = { l: boolean; r: boolean; t: boolean; b: boolean };
    /** Which edges of the area the point is on (corners give two). */
    const handleAt = (wx: number, wy: number): Edges | null => {
      if (!area) return null;
      const tol = 7 / cam.zoom;
      const x0 = area.x0 * T;
      const x1 = area.x1 * T;
      const y0 = area.y0 * T;
      const y1 = area.y1 * T;
      if (wx < x0 - tol || wx > x1 + tol || wy < y0 - tol || wy > y1 + tol) return null;
      const e = { l: Math.abs(wx - x0) <= tol, r: Math.abs(wx - x1) <= tol, t: Math.abs(wy - y0) <= tol, b: Math.abs(wy - y1) <= tol };
      return e.l || e.r || e.t || e.b ? e : null;
    };
    const insideArea = (wx: number, wy: number) =>
      !!area && wx >= area.x0 * T && wx < area.x1 * T && wy >= area.y0 * T && wy < area.y1 * T;
    const cursorFor = (e: Edges) =>
      (e.l && e.t) || (e.r && e.b) ? 'nwse-resize' : (e.r && e.t) || (e.l && e.b) ? 'nesw-resize' : e.l || e.r ? 'ew-resize' : 'ns-resize';

    // ------------------------------------------------------------- properties
    function renderProps() {
      if (area) {
        const a = area;
        const count = float ? float.tiles.length + float.objects.length : tilesIn(a).length + objects.filter((o) => inArea(a, o)).length;
        props.classList.remove('hidden');
        props.replaceChildren(
          el('h3', {}, 'Selection'),
          el('p', { class: 'hint', 'data-testid': 'area-info' }, `${a.x1 - a.x0} × ${a.y1 - a.y0} cells · ${count} thing${count === 1 ? '' : 's'}`),
          el('button', { class: 'btn', 'data-testid': 'duplicate-area', onclick: duplicateArea }, 'Duplicate (Ctrl+D)'),
          el('button', { class: 'btn danger', 'data-testid': 'delete-area', onclick: deleteArea }, 'Delete (Del)'),
          el('p', { class: 'hint' }, 'Drag inside to move. Drag an edge or corner to resize. Esc to let go.'));
        return;
      }
      const o = objects.find((x) => x.id === selected);
      if (!o) {
        props.classList.add('hidden');
        props.replaceChildren();
        return;
      }
      props.classList.remove('hidden');
      const rows: HTMLElement[] = [el('h3', {}, titleOf(o))];
      const edit = (fn: () => void) => {
        pushUndo();
        fn();
        changed();
      };
      if (o.kind === 'plate' || o.kind === 'door' || o.kind === 'dispenser') {
        rows.push(el('label', {}, 'Channel'),
          el('div', { class: 'swatches', 'data-testid': 'channel-swatches' }, ...CHANNEL_COLOURS.map((c, i) =>
            el('button', {
              class: `swatch ${o.channel === i ? 'active' : ''}`, style: `background:${c}`, title: CHANNEL_NAMES[i],
              'data-channel': i, onclick: () => edit(() => { o.channel = i; channel = i; }),
            }))));
        rows.push(el('p', { class: 'hint' }, o.kind === 'door'
          ? 'Opens only while every plate on this channel is pressed.'
          : o.kind === 'plate' ? 'Pressed by the player or a box.' : 'Flips on/off while every plate on this channel is pressed.'));
      }
      if (o.kind === 'dispenser') {
        rows.push(el('label', {}, 'Liquid'),
          el('div', { class: 'seg' }, ...([BLUE, ORANGE, WHITE] as Liquid[]).map((l) =>
            el('button', { class: `btn ${o.liquid === l ? 'on' : ''}`, onclick: () => edit(() => { o.liquid = l; }) }, LIQUID_NAMES[l]))));
        rows.push(el('label', {}, 'By default'),
          el('div', { class: 'seg' },
            el('button', { class: `btn ${o.defaultOn ? 'on' : ''}`, 'data-testid': 'default-on', onclick: () => edit(() => { o.defaultOn = true; }) }, 'On'),
            el('button', { class: `btn ${!o.defaultOn ? 'on' : ''}`, 'data-testid': 'default-off', onclick: () => edit(() => { o.defaultOn = false; }) }, 'Off')));
        rows.push(el('label', {}, 'Pours'),
          el('div', { class: 'seg' }, ...['→', '↓', '←', '↑'].map((a, d) =>
            el('button', { class: `btn ${o.dir === d ? 'on' : ''}`, onclick: () => edit(() => { o.dir = d; }) }, a))));
        const capInput = el('input', { type: 'number', min: MIN_CAP, max: MAX_CAP, value: o.cap, 'data-testid': 'cap-input' });
        capInput.addEventListener('change', () => {
          const v = Math.max(MIN_CAP, Math.min(MAX_CAP, Math.round(Number(capInput.value) || DEFAULT_CAP)));
          edit(() => { o.cap = v; });
        });
        rows.push(el('label', {}, `Liquid cap (${MIN_CAP} to ${MAX_CAP})`), capInput,
          el('p', { class: 'hint' }, 'At the cap it keeps pouring and its oldest liquid disappears.'));
      }
      rows.push(el('button', { class: 'btn danger', onclick: () => edit(() => { objects = objects.filter((x) => x.id !== o.id); selected = null; }) }, 'Delete'));
      props.replaceChildren(...rows);
    }

    // ------------------------------------------------------------- canvas
    let w = 0;
    let h = 0;
    let dpr = 1;
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    let hover: [number, number] | null = null;
    const draw = () => {
      beginFrame(ctx, cam, w, h, dpr);
      const rect = visibleRect(cam, w, h);
      drawBackdrop(ctx, rect, cam.zoom, true);
      drawTiles(ctx, rect, cam.zoom, tiles, levelFaceLook(tiles));
      for (const o of objects) drawLevelObject(ctx, o);
      const sel = objects.find((o) => o.id === selected);
      if (sel) {
        const [x0, y0, x1, y1] = objectBounds(sel);
        ctx.strokeStyle = '#36e3d2';
        ctx.lineWidth = 2 / cam.zoom;
        ctx.setLineDash([5 / cam.zoom, 4 / cam.zoom]);
        ctx.strokeRect(x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6);
        ctx.setLineDash([]);
      }
      if (area) {
        const x = area.x0 * T;
        const y = area.y0 * T;
        const aw = (area.x1 - area.x0) * T;
        const ah = (area.y1 - area.y0) * T;
        ctx.fillStyle = 'rgba(54, 227, 210, 0.08)';
        ctx.fillRect(x, y, aw, ah);
        ctx.strokeStyle = '#36e3d2';
        ctx.lineWidth = 2 / cam.zoom;
        ctx.setLineDash([6 / cam.zoom, 4 / cam.zoom]);
        ctx.strokeRect(x, y, aw, ah);
        ctx.setLineDash([]);
        const hs = 8 / cam.zoom;
        ctx.fillStyle = '#36e3d2';
        for (const hx of [x, x + aw / 2, x + aw]) {
          for (const hy of [y, y + ah / 2, y + ah]) {
            if (hx === x + aw / 2 && hy === y + ah / 2) continue;
            ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
          }
        }
      }
      if (hover && tool !== 'select') {
        const [wx, wy] = hover;
        ctx.strokeStyle = 'rgba(54, 227, 210, 0.7)';
        ctx.lineWidth = 1.5 / cam.zoom;
        if (tool === 'wall' || tool === 'erase' || tool === 'door' || snap) {
          ctx.strokeRect(Math.floor(wx / T) * T, Math.floor(wy / T) * T, T, T);
        } else {
          ctx.beginPath();
          ctx.arc(wx, wy, 4, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    };
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (canvas.clientWidth !== w || canvas.clientHeight !== h) resize();
      draw();
    };
    raf = requestAnimationFrame(loop);

    const world = (e: MouseEvent): [number, number] => {
      // measure at event time: layout may have changed since the last resize callback
      const r = canvas.getBoundingClientRect();
      return screenToWorld(cam, r.width, r.height, e.clientX - r.left, e.clientY - r.top);
    };
    const cellAt = (wx: number, wy: number): [number, number] => [
      Math.max(-CELL_LIMIT, Math.min(CELL_LIMIT, Math.floor(wx / T))),
      Math.max(-CELL_LIMIT, Math.min(CELL_LIMIT, Math.floor(wy / T))),
    ];

    const objectAt = (wx: number, wy: number): LevelObject | null => {
      for (let i = objects.length - 1; i >= 0; i--) {
        const [x0, y0, x1, y1] = objectBounds(objects[i]);
        if (wx >= x0 && wx <= x1 && wy >= y0 && wy <= y1) return objects[i];
      }
      return null;
    };

    /** Anchor for a free or snapped object. Bottom-anchored kinds sit on the cell floor. */
    const anchor = (kind: LevelObject['kind'], wx: number, wy: number): [number, number] => {
      if (!snap) return [Math.round(wx), Math.round(wy)];
      const [cx, cy] = cellAt(wx, wy);
      if (kind === 'dispenser') return [cx * T + T / 2, cy * T + T / 2];
      return [cx * T + T / 2, (cy + 1) * T];
    };

    /** The tile the Wall tool makes at a cell (a one-side wall recolours what is already there). */
    const wallTile = (cx: number, cy: number): TileInfo => {
      if (wall.mode === 'full') return { kind: wall.colour, shape: 0, sides: null };
      if (wall.mode === 'slope') return { kind: wall.colour, shape: wall.shape, sides: null };
      const cur = tiles.get(cellKey(cx, cy)) ?? { kind: DARK_WALL as TileKind, shape: 0, sides: null };
      const sides = cur.sides ? [...cur.sides] : [0, 0, 0, 0];
      sides[cur.shape && isOpenFace(cur.shape, wall.side) ? hypFace(cur.shape) : wall.side] = wall.colour;
      return normaliseTile({ kind: cur.kind, shape: cur.shape, sides });
    };

    const setTile = (cx: number, cy: number, info: TileInfo | null): boolean => {
      const k = cellKey(cx, cy);
      if (info === null) return tiles.delete(k);
      const cur = tiles.get(k);
      if (cur && sameTile(cur, info)) return false;
      tiles.set(k, normaliseTile(info));
      objects = objects.filter((o) => !(o.kind === 'door' && o.cx === cx && o.cy === cy));
      return true;
    };

    const eraseAt = (wx: number, wy: number): boolean => {
      const o = objectAt(wx, wy);
      if (o) {
        objects = objects.filter((x) => x !== o);
        if (selected === o.id) selected = null;
        return true;
      }
      const [cx, cy] = cellAt(wx, wy);
      return setTile(cx, cy, null);
    };

    const placeObject = (wx: number, wy: number): boolean => {
      const id2 = nextId();
      let o: LevelObject;
      switch (tool) {
        case 'start': {
          const [x, y] = anchor('start', wx, wy);
          o = { id: id2, kind: 'start', x, y };
          break;
        }
        case 'finish': case 'box': {
          const [x, y] = anchor(tool, wx, wy);
          o = { id: id2, kind: tool, x, y };
          break;
        }
        case 'plate': {
          const [x, y] = anchor('plate', wx, wy);
          o = { id: id2, kind: 'plate', x, y, channel };
          break;
        }
        case 'door': {
          const [cx, cy] = cellAt(wx, wy);
          o = { id: id2, kind: 'door', cx, cy, channel };
          break;
        }
        default: {
          const liquid = tool === 'disp-blue' ? BLUE : tool === 'disp-orange' ? ORANGE : WHITE;
          const [x, y] = anchor('dispenser', wx, wy);
          o = { id: id2, kind: 'dispenser', x, y, liquid, channel, defaultOn: true, dir: 1, cap: DEFAULT_CAP };
        }
      }
      // a new start replaces the old one, so only that may be under it
      if (blockedBy(o, objects, (q) => o.kind === 'start' && q.kind === 'start')) {
        toast('Something is already there');
        return false;
      }
      if (o.kind === 'start') objects = objects.filter((q) => q.kind !== 'start');
      if (o.kind === 'door') tiles.delete(cellKey(o.cx, o.cy));
      objects.push(o);
      selected = o.id;
      return true;
    };

    // stroke state
    let panning: { sx: number; sy: number; cx: number; cy: number } | null = null;
    let stroke: { mode: 'paint' | 'erase'; last: [number, number] | null; changed: boolean; snap: string } | null = null;
    let drag: { id: number; dx: number; dy: number; moved: boolean; snap: string } | null = null;
    let areaDrag:
      | { mode: 'new'; cx: number; cy: number; moved: boolean }
      | { mode: 'move'; cx: number; cy: number; start: Area; moved: boolean }
      | { mode: 'resize'; edges: Edges; start: Area; moved: boolean }
      | null = null;

    const strokeTo = (wx: number, wy: number) => {
      if (!stroke) return;
      const [cx, cy] = cellAt(wx, wy);
      const from = stroke.last ?? [cx, cy];
      // walk the cells between mouse samples so fast drags leave no gaps
      const steps = Math.max(Math.abs(cx - from[0]), Math.abs(cy - from[1]));
      for (let i = stroke.last ? 1 : 0; i <= steps; i++) {
        const x = steps ? Math.round(from[0] + ((cx - from[0]) * i) / steps) : cx;
        const y = steps ? Math.round(from[1] + ((cy - from[1]) * i) / steps) : cy;
        if (stroke.mode === 'erase') {
          const last = i === steps;
          stroke.changed = eraseAt(last ? wx : x * T + T / 2, last ? wy : y * T + T / 2) || stroke.changed;
        } else {
          stroke.changed = setTile(x, y, wallTile(x, y)) || stroke.changed;
        }
      }
      stroke.last = [cx, cy];
    };

    const onMouseDown = (e: MouseEvent) => {
      closeFlyout();
      if (e.button === 1) {
        e.preventDefault();
        panning = { sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y };
        canvas.classList.add('panning');
        return;
      }
      const [wx, wy] = world(e);
      if (e.button === 2 && area) {
        letGo();
        refreshChrome();
      }
      if (e.button === 2 || (e.button === 0 && tool === 'erase')) {
        stroke = { mode: 'erase', last: null, changed: false, snap: snapshot() };
        strokeTo(wx, wy);
        refreshChrome();
        return;
      }
      if (e.button !== 0) return;
      if (tool === 'wall') {
        stroke = { mode: 'paint', last: null, changed: false, snap: snapshot() };
        strokeTo(wx, wy);
        refreshChrome();
        return;
      }
      if (tool === 'select') {
        if (area) {
          const edges = handleAt(wx, wy);
          if (edges) {
            // resizing changes what is selected, so floating content is put down first
            float = null;
            areaDrag = { mode: 'resize', edges, start: { ...area }, moved: false };
            return;
          }
          if (insideArea(wx, wy)) {
            const [cx, cy] = cellAt(wx, wy);
            areaDrag = { mode: 'move', cx, cy, start: { ...area }, moved: false };
            return;
          }
          letGo();
        }
        const o = objectAt(wx, wy);
        if (!o) {
          const [cx, cy] = cellAt(wx, wy);
          selected = null;
          area = { x0: cx, y0: cy, x1: cx + 1, y1: cy + 1 };
          areaDrag = { mode: 'new', cx, cy, moved: false };
          refreshChrome();
          return;
        }
        selected = o.id;
        if (o) {
          const [ax, ay] = o.kind === 'door' ? [o.cx * T, o.cy * T] : [o.x, o.y];
          drag = { id: o.id, dx: wx - ax, dy: wy - ay, moved: false, snap: snapshot() };
        }
        refreshChrome();
        return;
      }
      const before = snapshot();
      if (placeObject(wx, wy)) {
        undo.push(before);
        if (undo.length > 200) undo.shift();
        redo.length = 0;
        changed();
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      if (panning) {
        cam.x = panning.cx - (e.clientX - panning.sx) / cam.zoom;
        cam.y = panning.cy - (e.clientY - panning.sy) / cam.zoom;
        return;
      }
      const [wx, wy] = world(e);
      hover = [wx, wy];
      if (areaDrag && area) {
        const d = areaDrag;
        if (d.mode === 'new') {
          const [cx, cy] = cellAt(wx, wy);
          if (cx !== d.cx || cy !== d.cy) d.moved = true;
          area = { x0: Math.min(cx, d.cx), y0: Math.min(cy, d.cy), x1: Math.max(cx, d.cx) + 1, y1: Math.max(cy, d.cy) + 1 };
          refreshChrome();
        } else if (d.mode === 'resize') {
          const gx = Math.round(wx / T);
          const gy = Math.round(wy / T);
          const a = { ...d.start };
          if (d.edges.l) a.x0 = Math.min(gx, a.x1 - 1);
          if (d.edges.r) a.x1 = Math.max(gx, a.x0 + 1);
          if (d.edges.t) a.y0 = Math.min(gy, a.y1 - 1);
          if (d.edges.b) a.y1 = Math.max(gy, a.y0 + 1);
          if (a.x0 !== area.x0 || a.x1 !== area.x1 || a.y0 !== area.y0 || a.y1 !== area.y1) {
            area = a;
            d.moved = true;
            refreshChrome();
          }
        } else {
          const [cx, cy] = cellAt(wx, wy);
          const dx = cx - d.cx;
          const dy = cy - d.cy;
          const nx = d.start.x0 + dx;
          const ny = d.start.y0 + dy;
          if (nx !== area.x0 || ny !== area.y0) {
            if (!float) lift(false);
            if (float) {
              // stop short rather than land on objects outside the selection
              if (!fits(float, nx, ny)) return;
              float.ox = nx;
              float.oy = ny;
            }
            area = { x0: nx, y0: ny, x1: d.start.x1 + dx, y1: d.start.y1 + dy };
            d.moved = true;
            stamp();
            changed();
          }
        }
        return;
      }
      if (tool === 'select' && !drag && !stroke) {
        const edges = handleAt(wx, wy);
        canvas.style.cursor = edges ? cursorFor(edges) : insideArea(wx, wy) ? 'move' : '';
      }
      if (stroke) {
        strokeTo(wx, wy);
        if (stroke.changed) refreshChrome();
        return;
      }
      if (drag) {
        const o = objects.find((x) => x.id === drag!.id);
        if (!o) return;
        if (o.kind === 'door') {
          const [cx, cy] = cellAt(wx - drag.dx + T / 2, wy - drag.dy + T / 2);
          if ((cx !== o.cx || cy !== o.cy) && !blockedBy({ ...o, cx, cy }, objects)) {
            o.cx = cx;
            o.cy = cy;
            tiles.delete(cellKey(cx, cy));
            drag.moved = true;
          }
        } else {
          const [x, y] = snap ? anchor(o.kind, wx, wy) : [Math.round(wx - drag.dx), Math.round(wy - drag.dy)];
          if ((x !== o.x || y !== o.y) && !blockedBy({ ...o, x, y }, objects)) {
            o.x = x;
            o.y = y;
            drag.moved = true;
          }
        }
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 1 && panning) {
        panning = null;
        canvas.classList.remove('panning');
        publishHook();
        return;
      }
      if (stroke) {
        if (stroke.changed) {
          undo.push(stroke.snap);
          redo.length = 0;
          changed();
        }
        stroke = null;
      }
      if (areaDrag) {
        // a plain click on empty space just clears the selection
        if (areaDrag.mode === 'new' && !areaDrag.moved) area = null;
        areaDrag = null;
        refreshChrome();
      }
      if (drag) {
        if (drag.moved) {
          undo.push(drag.snap);
          redo.length = 0;
          changed();
        }
        drag = null;
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const [bx, by] = screenToWorld(cam, r.width, r.height, sx, sy);
      cam.zoom = Math.min(4, Math.max(0.15, cam.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      const [ax, ay] = screenToWorld(cam, r.width, r.height, sx, sy);
      cam.x += bx - ax;
      cam.y += by - ay;
      publishHook();
    };

    const doUndo = () => {
      const s = undo.pop();
      if (!s) return;
      redo.push(snapshot());
      load(JSON.parse(s));
      selected = null;
      float = null;
      area = null;
      changed();
    };
    const doRedo = () => {
      const s = redo.pop();
      if (!s) return;
      undo.push(snapshot());
      load(JSON.parse(s));
      selected = null;
      float = null;
      area = null;
      changed();
    };

    const play = () => {
      const data = toData();
      if (!checkPlayable(data).ok) return;
      letGo();
      saveNow();
      startPlay({ levelId: id, name: level.name, data: parseLevel(data), mode: 'live', onExit: () => showEditor(id) });
    };

    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.modal-overlay')) return;
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
      if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); duplicateArea(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if ((k === 'delete' || k === 'backspace') && area) {
        deleteArea();
        return;
      }
      if ((k === 'delete' || k === 'backspace') && selected !== null) {
        pushUndo();
        objects = objects.filter((o) => o.id !== selected);
        selected = null;
        changed();
        return;
      }
      if (k === 'escape') { closeFlyout(); selected = null; letGo(); refreshChrome(); return; }
      if (WALL_KEYS[k]) { setWall({ ...wall, mode: 'full', colour: WALL_KEYS[k] }); return; }
      if (k === 'p') { play(); return; }
      if (k === 'g') { snap = !snap; storeSnap(snap); refreshChrome(); return; }
      const t = TOOLS.find((x) => x.key && x.key.toLowerCase() === k);
      if (t) setTool(t.id);
    };

    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mouseleave', () => { hover = null; });
    window.addEventListener('keydown', onKey);

    snapBtn.addEventListener('click', () => { snap = !snap; storeSnap(snap); refreshChrome(); });
    undoBtn.addEventListener('click', doUndo);
    redoBtn.addEventListener('click', doRedo);
    playBtn.addEventListener('click', play);
    nameBtn.addEventListener('click', async () => {
      const n = await promptBox('Rename level', level.name);
      if (n) {
        level = { ...level, name: n };
        nameBtn.textContent = n;
        saveNow();
      }
    });
    bestBtn.addEventListener('click', () => {
      const data = toData();
      const best = getBest(id, data);
      if (!best) return;
      saveNow();
      startPlay({ levelId: id, name: level.name, data: parseLevel(data), mode: 'watch', replay: best.replay, onExit: () => showEditor(id) });
    });
    loadReplayBtn.addEventListener('click', async () => {
      const raw = await pickJsonFile();
      if (!raw) return;
      try {
        const data = parseLevel(toData());
        const replay = parseReplay(raw, data);
        if (replay.level !== levelHash(data)) {
          toast('That replay is for a different level, or a different version of this one');
          return;
        }
        saveNow();
        startPlay({ levelId: id, name: level.name, data, mode: 'watch', replay, onExit: () => showEditor(id) });
      } catch (err) {
        toast((err as Error).message || 'Not a replay file');
      }
    });

    refreshChrome();

    return () => {
      saveNow();
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKey);
    };
  }, 'editor');
  return true;
}

function titleOf(o: LevelObject): string {
  switch (o.kind) {
    case 'start': return 'Start';
    case 'finish': return 'Finish';
    case 'box': return 'Box';
    case 'plate': return 'Pressure plate';
    case 'door': return 'Multi-lock door';
    case 'dispenser': return `${LIQUID_NAMES[o.liquid]} dispenser`;
  }
}
