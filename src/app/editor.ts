import { mount, navigate } from './router';
import { el, promptBox, toast, pickJsonFile } from './ui';
import {
  beginFrame, drawBackdrop, drawTiles, drawLevelObject, objectBounds, screenToWorld, visibleRect,
  CHANNEL_COLOURS, CHANNEL_NAMES, LIQUID_NAMES, type Camera,
} from './render';
import { getLevel, saveLevel, getBest, type LocalLevel } from './storage';
import { startPlay } from './play';
import { TILE_PX, cellKey, keyCx, keyCy, CELL_LIMIT } from '../sim/fixed';
import {
  WHITE_WALL, DARK_WALL, BLUE, ORANGE, WHITE, DEFAULT_CAP, MIN_CAP, MAX_CAP, checkPlayable, parseLevel, levelHash,
  type LevelData, type LevelObject, type TileKind, type Liquid,
} from '../sim/level';
import { parseReplay } from '../sim/replay';

type Tool =
  | 'select' | 'white' | 'dark' | 'erase'
  | 'start' | 'finish' | 'box' | 'plate' | 'door'
  | 'disp-blue' | 'disp-orange' | 'disp-white';

const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: 'select', label: 'Select', key: 'V' },
  { id: 'white', label: 'White wall', key: '1' },
  { id: 'dark', label: 'Dark wall', key: '2' },
  { id: 'erase', label: 'Erase', key: 'X' },
  { id: 'start', label: 'Start', key: '3' },
  { id: 'finish', label: 'Finish', key: '4' },
  { id: 'box', label: 'Box', key: '5' },
  { id: 'plate', label: 'Plate', key: '6' },
  { id: 'door', label: 'Door', key: '7' },
  { id: 'disp-blue', label: 'Blue gel', key: '8' },
  { id: 'disp-orange', label: 'Orange bounce', key: '9' },
  { id: 'disp-white', label: 'White paint', key: '0' },
];

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

/** Remembered camera per level, so coming back from play keeps your view. */
const camMemory = new Map<string, Camera>();

export function showEditor(id: string): boolean {
  const stored = getLevel(id);
  if (!stored) return false;
  let level: LocalLevel = stored;

  mount((root) => {
    // ------------------------------------------------------------- model
    const tiles = new Map<number, TileKind>();
    let objects: LevelObject[] = [];
    const load = (d: LevelData) => {
      tiles.clear();
      for (const [cx, cy, k] of d.tiles) tiles.set(cellKey(cx, cy), k);
      objects = d.objects.map((o) => ({ ...o }));
    };
    load(level.data);
    const toData = (): LevelData => ({
      v: 1,
      tiles: [...tiles].map(([k, kind]) => [keyCx(k), keyCy(k), kind] as [number, number, TileKind]),
      objects: objects.map((o) => ({ ...o })),
    });
    const nextId = () => objects.reduce((m, o) => Math.max(m, o.id), 0) + 1;

    let tool: Tool = 'white';
    let snap = loadSnap();
    let channel = 0;
    let selected: number | null = null;
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
    const status = el('div', { class: 'editor-status' }, 'Middle mouse drag: move · Wheel: zoom · Left: place · Right: erase · Ctrl+Z / Ctrl+Y');

    const toolButtons = new Map<Tool, HTMLButtonElement>();
    for (const t of TOOLS) {
      const b = el('button', { class: 'tool', 'data-tool': t.id, title: `${t.label} (${t.key})`, onclick: () => setTool(t.id) },
        el('span', { class: `tool-icon icon-${t.id}` }), el('span', { class: 'tool-label' }, t.label));
      toolButtons.set(t.id, b);
      toolbar.append(b);
    }

    root.append(
      el('div', { class: 'editor' },
        el('div', { class: 'topbar' },
          el('div', { class: 'topbar-left' },
            el('button', { class: 'btn', 'data-testid': 'back-to-menu', onclick: () => { saveNow(); navigate('#/'); } }, '← Menu'),
            nameBtn,
            el('span', { class: 'mode-chip' }, 'Creator')),
          el('div', { class: 'topbar-right' }, snapBtn, undoBtn, redoBtn, loadReplayBtn, bestBtn, playWrap)),
        el('div', { class: 'editor-body' }, toolbar, el('div', { class: 'canvas-wrap' }, canvas, status, props))));

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
      window.__holes.editor = { tiles: tiles.size, objects: objects.length, cam, snap };
      renderProps();
    }

    function setTool(t: Tool) {
      tool = t;
      if (t !== 'select') selected = null;
      refreshChrome();
    }

    // ------------------------------------------------------------- properties
    function renderProps() {
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
      drawTiles(ctx, rect, cam.zoom, tiles, null);
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
      if (hover && tool !== 'select') {
        const [wx, wy] = hover;
        ctx.strokeStyle = 'rgba(54, 227, 210, 0.7)';
        ctx.lineWidth = 1.5 / cam.zoom;
        if (tool === 'white' || tool === 'dark' || tool === 'erase' || tool === 'door' || snap) {
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

    const setTile = (cx: number, cy: number, kind: TileKind | null): boolean => {
      const k = cellKey(cx, cy);
      if (kind === null) return tiles.delete(k);
      if (tiles.get(k) === kind) return false;
      tiles.set(k, kind);
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

    const placeObject = (wx: number, wy: number) => {
      const id2 = nextId();
      let o: LevelObject;
      switch (tool) {
        case 'start': {
          const [x, y] = anchor('start', wx, wy);
          objects = objects.filter((q) => q.kind !== 'start');
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
          if (objects.some((q) => q.kind === 'door' && q.cx === cx && q.cy === cy)) return;
          tiles.delete(cellKey(cx, cy));
          o = { id: id2, kind: 'door', cx, cy, channel };
          break;
        }
        default: {
          const liquid = tool === 'disp-blue' ? BLUE : tool === 'disp-orange' ? ORANGE : WHITE;
          const [x, y] = anchor('dispenser', wx, wy);
          o = { id: id2, kind: 'dispenser', x, y, liquid, channel, defaultOn: true, dir: 1, cap: DEFAULT_CAP };
        }
      }
      objects.push(o);
      selected = o.id;
    };

    // stroke state
    let panning: { sx: number; sy: number; cx: number; cy: number } | null = null;
    let stroke: { mode: 'paint' | 'erase'; last: [number, number] | null; changed: boolean; snap: string } | null = null;
    let drag: { id: number; dx: number; dy: number; moved: boolean; snap: string } | null = null;

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
          stroke.changed = setTile(x, y, tool === 'white' ? WHITE_WALL : DARK_WALL) || stroke.changed;
        }
      }
      stroke.last = [cx, cy];
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        panning = { sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y };
        canvas.classList.add('panning');
        return;
      }
      const [wx, wy] = world(e);
      if (e.button === 2 || (e.button === 0 && tool === 'erase')) {
        stroke = { mode: 'erase', last: null, changed: false, snap: snapshot() };
        strokeTo(wx, wy);
        refreshChrome();
        return;
      }
      if (e.button !== 0) return;
      if (tool === 'white' || tool === 'dark') {
        stroke = { mode: 'paint', last: null, changed: false, snap: snapshot() };
        strokeTo(wx, wy);
        refreshChrome();
        return;
      }
      if (tool === 'select') {
        const o = objectAt(wx, wy);
        selected = o ? o.id : null;
        if (o) {
          const [ax, ay] = o.kind === 'door' ? [o.cx * T, o.cy * T] : [o.x, o.y];
          drag = { id: o.id, dx: wx - ax, dy: wy - ay, moved: false, snap: snapshot() };
        }
        refreshChrome();
        return;
      }
      pushUndo();
      placeObject(wx, wy);
      changed();
    };

    const onMouseMove = (e: MouseEvent) => {
      if (panning) {
        cam.x = panning.cx - (e.clientX - panning.sx) / cam.zoom;
        cam.y = panning.cy - (e.clientY - panning.sy) / cam.zoom;
        return;
      }
      const [wx, wy] = world(e);
      hover = [wx, wy];
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
          if ((cx !== o.cx || cy !== o.cy) && !objects.some((q) => q.kind === 'door' && q.cx === cx && q.cy === cy)) {
            o.cx = cx;
            o.cy = cy;
            tiles.delete(cellKey(cx, cy));
            drag.moved = true;
          }
        } else {
          const [x, y] = snap ? anchor(o.kind, wx, wy) : [Math.round(wx - drag.dx), Math.round(wy - drag.dy)];
          if (x !== o.x || y !== o.y) {
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
        window.__holes.editor = { tiles: tiles.size, objects: objects.length, cam, snap };
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
      window.__holes.editor = { tiles: tiles.size, objects: objects.length, cam, snap };
    };

    const doUndo = () => {
      const s = undo.pop();
      if (!s) return;
      redo.push(snapshot());
      load(JSON.parse(s));
      selected = null;
      changed();
    };
    const doRedo = () => {
      const s = redo.pop();
      if (!s) return;
      undo.push(snapshot());
      load(JSON.parse(s));
      selected = null;
      changed();
    };

    const play = () => {
      const data = toData();
      if (!checkPlayable(data).ok) return;
      saveNow();
      startPlay({ levelId: id, name: level.name, data: parseLevel(data), mode: 'live', onExit: () => showEditor(id) });
    };

    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.modal-overlay')) return;
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
      if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if ((k === 'delete' || k === 'backspace') && selected !== null) {
        pushUndo();
        objects = objects.filter((o) => o.id !== selected);
        selected = null;
        changed();
        return;
      }
      if (k === 'escape') { selected = null; refreshChrome(); return; }
      if (k === 'p') { play(); return; }
      if (k === 'g') { snap = !snap; storeSnap(snap); refreshChrome(); return; }
      const t = TOOLS.find((x) => x.key.toLowerCase() === k);
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
        const replay = parseReplay(raw);
        const data = parseLevel(toData());
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
