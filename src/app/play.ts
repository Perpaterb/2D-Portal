import { mount } from './router';
import { el, downloadJson, toast } from './ui';
import { beginFrame, drawSim, lastViewCount, lastViewEdges, type Camera } from './render';
import { orientationAfterTeleport, screenOffsetToWorld, type Orientation } from './portalview';
import { offerBest, getBest, globalBestId } from './storage';
import { getRunReplay, submitRun, topRuns, type RunRow } from './global';
import { askName, playerName } from './player';
import {
  Sim, IN_LEFT, IN_RIGHT, IN_JUMP, IN_USE, IN_FIRE_A, IN_FIRE_B, MAX_TICKS, type TickInput,
} from '../sim/sim';
import { SUB } from '../sim/fixed';
import { levelHash, type LevelData } from '../sim/level';
import { Recorder, ReplayReader, runReplay, formatTicks, type Replay } from '../sim/replay';

export interface PlayOptions {
  levelId: string | null;
  name: string;
  data: LevelData;
  /** live: you play and it records. watch: a replay plays back. */
  mode: 'live' | 'watch';
  replay?: Replay;
  /** set when playing a global level: its leaderboard drives the ghost panel and submission */
  global?: { id: string; runs: RunRow[] };
  onExit: () => void;
}

export const GHOST_COLOURS = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#c77dff', '#ff9f1c', '#2ec4b6', '#f15bb5', '#a3e635', '#94a3b8'];

interface GhostRun {
  run: RunRow;
  colour: string;
  replay: Replay;
  sim: Sim;
  reader: ReplayReader;
}

function loadEyes(levelId: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(`2dholes.eyes.${levelId}`) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function saveEyes(levelId: string, eyes: Set<string>): void {
  try {
    localStorage.setItem(`2dholes.eyes.${levelId}`, JSON.stringify([...eyes]));
  } catch {
    /* ignore */
  }
}

const TICK_MS = 1000 / 60;

const KEY_BITS: Record<string, number> = {
  KeyA: IN_LEFT, ArrowLeft: IN_LEFT,
  KeyD: IN_RIGHT, ArrowRight: IN_RIGHT,
  Space: IN_JUMP, KeyW: IN_JUMP, ArrowUp: IN_JUMP,
  KeyE: IN_USE,
};

export function startPlay(opts: PlayOptions): void {
  mount((root) => {
    const hash = levelHash(opts.data);
    const canvas = el('canvas', { class: 'game-canvas', 'data-testid': 'game-canvas' });
    const ctx = canvas.getContext('2d')!;
    const timer = el('div', { class: 'hud-timer', 'data-testid': 'timer' }, '00:00.000');
    const global = opts.mode === 'live' ? opts.global ?? null : null;
    const panel = el('div', { class: 'ghost-panel', 'data-testid': 'ghost-panel' });
    const stop = el('button', { class: 'btn hud-stop', 'data-testid': 'stop', onclick: () => exit() }, '■ Stop (Esc)');
    const hint = el(
      'div',
      { class: 'hud-hint' },
      opts.mode === 'live'
        ? 'A/D move · Space jump · Left/right click portals · E pick up · Q or R restart · Esc back'
        : 'Replay · Space pause · Q or R restart · Esc back',
    );
    const overlay = el('div', { class: 'overlay hidden', 'data-testid': 'finish-overlay' });
    const ready = el('div', { class: 'hud-ready hidden', 'data-testid': 'ready' }, 'Move, jump or shoot to start the clock');
    root.append(
      el('div', { class: 'play-screen' },
        canvas,
        el('div', { class: 'hud-top' },
          el('div', { class: 'hud-left' }, el('div', { class: 'hud-name' }, opts.mode === 'watch' ? `Replay: ${opts.name}` : opts.name), global ? panel : null),
          timer,
          el('div', { class: 'hud-right' }, stop)),
        hint,
        ready,
        overlay));

    const cam: Camera = { x: 0, y: 0, zoom: 1.4, angle: 0, sx: 1 };
    // after a portal, the view starts turned to match what you were seeing, then eases upright
    const EASE_MS = 350;
    let easeFrom: Orientation = { angle: 0, sx: 1 };
    let easeStart = -1e9;
    let seenTeleports = 0;
    const orientation = (now: number): Orientation => {
      const k = Math.min(1, (now - easeStart) / EASE_MS);
      const e = 1 - (1 - k) ** 3;
      return { angle: easeFrom.angle * (1 - e), sx: easeFrom.sx + (1 - easeFrom.sx) * e };
    };
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

    // ---------------------------------------------------------------- state
    let sim: Sim;
    let recorder: Recorder;
    let reader: ReplayReader | null = null;
    let done = false;
    let paused = false;
    let runs: RunRow[] = global?.runs ?? [];
    const eyes = global ? loadEyes(global.id) : new Set<string>();
    const ghosts = new Map<string, GhostRun>();
    const replays = new Map<string, Replay>();

    const publishGhosts = () => {
      window.__holes.ghosts = [...ghosts.values()].map((g) => ({ name: g.run.name, colour: g.colour, tick: g.sim.tick, x: g.sim.player.x, y: g.sim.player.y }));
    };

    /** Advances a ghost by one real tick, skipping any idle lead-in in its replay. */
    const stepGhost = (g: GhostRun) => {
      while (!g.sim.finished && !g.reader.done()) {
        const t = g.sim.tick;
        g.sim.step(g.reader.next());
        if (g.sim.tick !== t) return;
      }
    };

    /** Starts a ghost in step with the live run (fast-forwarded to the current tick). */
    const startGhost = (run: RunRow, replay: Replay) => {
      const g: GhostRun = { run, colour: colourOf(run), replay, sim: new Sim(opts.data), reader: new ReplayReader(replay) };
      while (g.sim.tick < sim.tick && !g.sim.finished && !g.reader.done()) g.sim.step(g.reader.next());
      ghosts.set(run.id, g);
      publishGhosts();
    };

    const colourOf = (run: RunRow) => GHOST_COLOURS[Math.max(0, runs.findIndex((r) => r.id === run.id)) % GHOST_COLOURS.length];

    const setEye = async (run: RunRow, on: boolean) => {
      if (!global) return;
      if (on) eyes.add(run.id);
      else eyes.delete(run.id);
      saveEyes(global.id, eyes);
      if (!on) {
        ghosts.delete(run.id);
        publishGhosts();
      } else if (!ghosts.has(run.id)) {
        try {
          const replay = replays.get(run.id) ?? (await getRunReplay(run.id, opts.data));
          replays.set(run.id, replay);
          if (replay.level !== hash) throw new Error('That run was for an older version of this level');
          if (eyes.has(run.id) && !ghosts.has(run.id)) startGhost(run, replay);
        } catch (e) {
          toast((e as Error).message);
        }
      }
      paintPanel();
    };

    const paintPanel = () => {
      if (!global) return;
      panel.replaceChildren(el('div', { class: 'ghost-title' }, 'Top 10 · ghosts'));
      if (!runs.length) panel.append(el('div', { class: 'ghost-empty' }, 'No times yet. Set the first one.'));
      runs.forEach((r, i) => {
        const on = eyes.has(r.id);
        panel.append(
          el('div', { class: `ghost-row ${on ? 'on' : ''}`, 'data-testid': 'ghost-row' },
            el('span', { class: 'ghost-dot', style: `background:${GHOST_COLOURS[i % GHOST_COLOURS.length]}` }),
            el('span', { class: 'ghost-rank' }, `${i + 1}`),
            el('span', { class: 'ghost-name' }, r.name),
            el('span', { class: 'ghost-time' }, formatTicks(r.ticks)),
            el('button', {
              class: 'eye', 'data-testid': 'eye', 'aria-pressed': on ? 'true' : 'false',
              title: on ? 'Hide this ghost' : 'Show this ghost', 'aria-label': `${on ? 'Hide' : 'Show'} ghost of ${r.name}`,
              onclick: (e: Event) => { (e.currentTarget as HTMLElement).blur(); void setEye(r, !on); },
            }, eyeIcon(on))));
      });
    };

    const reset = () => {
      sim = new Sim(opts.data);
      recorder = new Recorder();
      reader = opts.mode === 'watch' && opts.replay ? new ReplayReader(opts.replay) : null;
      for (const g of [...ghosts.values()]) startGhost(g.run, g.replay);
      done = false;
      paused = false;
      seenTeleports = 0;
      easeFrom = { angle: 0, sx: 1 };
      easeStart = -1e9;
      overlay.classList.add('hidden');
      window.__holes.sim = sim;
      publishGhosts();
    };
    reset();
    paintPanel();
    for (const r of runs) if (eyes.has(r.id)) void setEye(r, true);

    // ---------------------------------------------------------------- input
    const held = new Set<string>();
    let latched = 0;
    let mouseX = -1;
    let mouseY = -1;
    /** clicks keep the aim they had at the moment of the click, one shot per tick */
    const clicks: { bit: number; ax: number; ay: number }[] = [];
    let lastFire = 0;
    const aimNow = (): [number, number] => {
      if (mouseX < 0) return [100 * sim.player.facing, 0];
      // the camera is centred on the player, so undoing zoom and the view's turn gives the aim
      const [ax, ay] = screenOffsetToWorld(mouseX - w / 2, mouseY - h / 2, cam.zoom, { angle: cam.angle ?? 0, sx: cam.sx ?? 1 });
      return [Math.round(ax), Math.round(ay)];
    };

    const keyBits = (code: string) => KEY_BITS[code] ?? 0;
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('.modal-overlay')) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        exit();
        return;
      }
      if ((e.code === 'KeyR' || e.code === 'KeyQ') && !e.repeat) {
        reset();
        return;
      }
      if (opts.mode === 'watch' && e.code === 'Space') {
        e.preventDefault();
        paused = !paused;
        return;
      }
      const b = keyBits(e.code);
      if (b) {
        e.preventDefault();
        held.add(e.code);
        latched |= b;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      held.delete(e.code);
    };
    const onMouseMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      mouseX = e.clientX - r.left;
      mouseY = e.clientY - r.top;
    };
    const onMouseDown = (e: MouseEvent) => {
      onMouseMove(e);
      if (e.button === 1) e.preventDefault();
      const bit = e.button === 0 ? IN_FIRE_A : e.button === 2 ? IN_FIRE_B : 0;
      if (bit && clicks.length < 4) {
        const [ax, ay] = aimNow();
        clicks.push({ bit, ax, ay });
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cam.zoom = Math.min(3, Math.max(0.6, cam.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    };
    const noMenu = (e: Event) => e.preventDefault();
    const onBlur = () => {
      held.clear();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', noMenu);

    const sampleInput = (): TickInput => {
      let bits = latched;
      for (const code of held) bits |= keyBits(code);
      latched = 0;
      // aim: the camera is centred on the player, so the mouse offset from the
      // screen centre is the aim offset in world pixels
      let [ax, ay] = aimNow();
      // a queued click fires this tick with its own aim; a repeat of the same button
      // waits one tick so the simulation sees a fresh press
      const c = clicks[0];
      if (c && !(c.bit & lastFire)) {
        clicks.shift();
        bits |= c.bit;
        ax = c.ax;
        ay = c.ay;
        lastFire = c.bit;
      } else lastFire = 0;
      return { bits, ax, ay };
    };

    // ---------------------------------------------------------------- finish
    const finishLive = () => {
      done = true;
      const replay = recorder.finish(hash);
      // the time shown and saved is the one the replay itself produces
      const verified = runReplay(opts.data, replay);
      if (!verified.finished || verified.ticks !== sim.finishTick) {
        console.error('Replay did not reproduce the live run', verified, sim.finishTick);
      }
      const ticks = verified.ticks;
      replay.ticks = ticks;
      let isBest = false;
      let prevBest: number | null = null;
      // global levels keep this browser's best too, whether or not it goes on the leaderboard
      const bestId = opts.levelId ?? (global ? globalBestId(global.id) : null);
      if (bestId) {
        prevBest = getBest(bestId, opts.data)?.ticks ?? null;
        isBest = verified.finished && offerBest(bestId, opts.data, ticks, replay);
      }
      const bestLine = el('p', { class: isBest ? 'new-best' : '', 'data-testid': 'best-line' },
        isBest ? (prevBest === null ? 'First clear, saved as your best' : 'New best!') : `Best ${formatTicks(prevBest ?? ticks)}`);
      let submitArea: HTMLElement | null = null;
      if (global) {
        // the run goes on the leaderboard under this browser's name, no typing at the finish
        const status = el('p', { class: 'submit-status', 'data-testid': 'submit-status' }, 'Checking your run…');
        submitArea = el('div', { class: 'submit-area' }, status);
        void (async () => {
          const name = playerName() || (await askName());
          try {
            const r = await submitRun(global.id, name, replay);
            status.textContent = r.improved
              ? `${r.name}: rank ${r.rank} with ${formatTicks(r.best)}`
              : `${r.name}: your best is still ${formatTicks(r.best)} (rank ${r.rank})`;
            status.classList.add('ok');
            runs = await topRuns(global.id);
            paintPanel();
          } catch (e) {
            status.textContent = (e as Error).message;
            status.classList.add('error');
          }
        })();
      }
      overlay.replaceChildren(
        el('div', { class: 'overlay-card' },
          el('h2', {}, 'Level complete'),
          el('div', { class: 'big-time', 'data-testid': 'final-time' }, formatTicks(ticks)),
          bestLine,
          global ? submitArea : null,
          el('div', { class: 'overlay-buttons' },
            el('button', { class: 'btn primary', onclick: () => reset() }, 'Retry (R)'),
            el('button', { class: 'btn', 'data-testid': 'watch-replay', onclick: () => startPlay({ ...opts, mode: 'watch', replay }) }, 'Watch replay'),
            el('button', { class: 'btn', 'data-testid': 'save-replay', onclick: () => downloadJson(`${safeName(opts.name)}-${formatTicks(ticks).replace(/[:.]/g, '')}.2dhr.json`, replay) }, 'Save replay file'),
            el('button', { class: 'btn', onclick: () => exit() }, 'Back (Esc)'))));
      overlay.classList.remove('hidden');
    };

    const finishWatch = () => {
      done = true;
      overlay.replaceChildren(
        el('div', { class: 'overlay-card' },
          el('h2', {}, sim.finished ? 'Replay finished' : 'Replay ended'),
          el('div', { class: 'big-time', 'data-testid': 'final-time' }, sim.finished ? formatTicks(sim.finishTick) : 'Did not finish'),
          el('div', { class: 'overlay-buttons' },
            el('button', { class: 'btn primary', onclick: () => reset() }, 'Watch again (R)'),
            el('button', { class: 'btn', onclick: () => exit() }, 'Back (Esc)'))));
      overlay.classList.remove('hidden');
    };

    const tickOnce = () => {
      if (done || paused) return;
      if (reader) {
        if (reader.done()) return finishWatch();
        sim.step(reader.next());
        if (sim.finished) finishWatch();
        return;
      }
      const inp = sampleInput();
      sim.step(inp);
      // nothing happens before the first action, so the replay and the ghosts begin there too
      if (!sim.started) return;
      recorder.push(inp);
      for (const g of ghosts.values()) stepGhost(g);
      if (sim.finished) finishLive();
      else if (sim.tick >= MAX_TICKS) {
        done = true;
        toast('Time limit reached (one hour)');
      }
    };

    // ---------------------------------------------------------------- loop
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let frame = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      acc += Math.min(now - last, 250);
      last = now;
      let n = 0;
      while (acc >= TICK_MS && n < 8) {
        tickOnce();
        acc -= TICK_MS;
        n++;
      }
      if (n === 8) acc = 0;
      frame++;
      if (sim.player.teleports !== seenTeleports) {
        seenTeleports = sim.player.teleports;
        const t = sim.lastPlayerTeleport;
        if (t) {
          easeFrom = orientationAfterTeleport(orientation(now), t.angIn, t.angOut);
          // turn the shorter way round
          easeFrom.angle = Math.atan2(Math.sin(easeFrom.angle), Math.cos(easeFrom.angle));
          easeStart = now;
        }
      }
      const o = orientation(now);
      cam.angle = Math.abs(o.angle) < 1e-4 ? 0 : o.angle;
      cam.sx = o.sx;
      cam.x = sim.player.x / SUB;
      cam.y = sim.player.y / SUB;
      window.__holes.cam = { x: cam.x, y: cam.y, zoom: cam.zoom, angle: cam.angle, sx: cam.sx };
      beginFrame(ctx, cam, w, h, dpr);
      drawSim(ctx, cam, w, h, sim, { ghosts: [...ghosts.values()].map((g) => ({ sim: g.sim, colour: g.colour, name: g.run.name })), frame });
      if (frame % 15 === 0) publishGhosts();
      window.__holes.views = lastViewCount;
      window.__holes.viewEdges = lastViewEdges;
      const shown = sim.finished ? sim.finishTick : sim.tick;
      timer.textContent = formatTicks(shown);
      timer.classList.toggle('paused', paused);
      ready.classList.toggle('hidden', opts.mode !== 'live' || sim.started || done);
    };
    raf = requestAnimationFrame(loop);

    let exited = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      opts.onExit();
    };

    return () => {
      exited = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, 'play');
}

function eyeIcon(open: boolean): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  const path = (d: string) => {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2');
    p.setAttribute('stroke-linecap', 'round');
    svg.append(p);
  };
  if (open) {
    path('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z');
    path('M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z');
  } else {
    path('M2 12s3.5 5 10 5 10-5 10-5');
    path('M5 15.5 3.5 18M12 17v3M19 15.5l1.5 2.5');
  }
  return svg;
}

function safeName(s: string): string {
  return s.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'level';
}
