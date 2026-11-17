import { mount } from './router';
import { el, downloadJson, toast } from './ui';
import { beginFrame, drawSim, type Camera } from './render';
import { offerBest, getBest } from './storage';
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
  ghost?: Replay | null;
  ghostLabel?: string;
  onExit: () => void;
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
    const ghostInfo = el('div', { class: 'hud-ghost', 'data-testid': 'ghost-info' });
    const stop = el('button', { class: 'btn hud-stop', 'data-testid': 'stop', onclick: () => exit() }, '■ Stop (Esc)');
    const hint = el(
      'div',
      { class: 'hud-hint' },
      opts.mode === 'live'
        ? 'A/D move · Space jump · Left/right click portals · E pick up · R restart · G ghost · Esc back'
        : 'Replay · Space pause · R restart · Esc back',
    );
    const overlay = el('div', { class: 'overlay hidden', 'data-testid': 'finish-overlay' });
    root.append(
      el('div', { class: 'play-screen' },
        canvas,
        el('div', { class: 'hud-top' },
          el('div', { class: 'hud-left' }, el('div', { class: 'hud-name' }, opts.mode === 'watch' ? `Replay: ${opts.name}` : opts.name), ghostInfo),
          timer,
          el('div', { class: 'hud-right' }, stop)),
        hint,
        overlay));

    const cam: Camera = { x: 0, y: 0, zoom: 1.4 };
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
    let ghost: Sim | null = null;
    let ghostReader: ReplayReader | null = null;
    let showGhost = true;
    let done = false;
    let paused = false;
    const ghostReplay = opts.mode === 'live' && opts.ghost && opts.ghost.level === hash ? opts.ghost : null;

    const reset = () => {
      sim = new Sim(opts.data);
      recorder = new Recorder();
      reader = opts.mode === 'watch' && opts.replay ? new ReplayReader(opts.replay) : null;
      ghost = ghostReplay ? new Sim(opts.data) : null;
      ghostReader = ghostReplay ? new ReplayReader(ghostReplay) : null;
      done = false;
      paused = false;
      overlay.classList.add('hidden');
      window.__holes.sim = sim;
      window.__holes.ghost = ghost;
      ghostInfo.textContent = ghostReplay
        ? `Ghost: ${opts.ghostLabel ?? 'your best'} ${formatTicks(ghostReplay.ticks)}${showGhost ? '' : ' (hidden)'}`
        : '';
    };
    reset();

    // ---------------------------------------------------------------- input
    const held = new Set<string>();
    let latched = 0;
    let mouseX = -1;
    let mouseY = -1;
    /** clicks keep the aim they had at the moment of the click, one shot per tick */
    const clicks: { bit: number; ax: number; ay: number }[] = [];
    let lastFire = 0;
    const aimNow = (): [number, number] =>
      mouseX >= 0
        ? [Math.round((mouseX - w / 2) / cam.zoom), Math.round((mouseY - h / 2) / cam.zoom)]
        : [100 * sim.player.facing, 0];

    const keyBits = (code: string) => KEY_BITS[code] ?? 0;
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('.modal-overlay')) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        exit();
        return;
      }
      if (e.code === 'KeyR' && !e.repeat) {
        reset();
        return;
      }
      if (e.code === 'KeyG' && !e.repeat && opts.mode === 'live') {
        showGhost = !showGhost;
        if (ghostReplay) ghostInfo.textContent = `Ghost: ${opts.ghostLabel ?? 'your best'} ${formatTicks(ghostReplay.ticks)}${showGhost ? '' : ' (hidden)'}`;
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
      if (opts.levelId) {
        prevBest = getBest(opts.levelId, opts.data)?.ticks ?? null;
        isBest = verified.finished && offerBest(opts.levelId, opts.data, ticks, replay);
      }
      overlay.replaceChildren(
        el('div', { class: 'overlay-card' },
          el('h2', {}, 'Level complete'),
          el('div', { class: 'big-time', 'data-testid': 'final-time' }, formatTicks(ticks)),
          el('p', { class: isBest ? 'new-best' : '' }, isBest ? (prevBest === null ? 'First clear, saved as your best' : 'New best!') : `Best ${formatTicks(prevBest ?? ticks)}`),
          el('div', { class: 'overlay-buttons' },
            el('button', { class: 'btn primary', onclick: () => reset() }, 'Retry (R)'),
            el('button', { class: 'btn', 'data-testid': 'watch-replay', onclick: () => startPlay({ ...opts, mode: 'watch', replay, ghost: null }) }, 'Watch replay'),
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
      recorder.push(inp);
      sim.step(inp);
      if (ghost && ghostReader && !ghost.finished && !ghostReader.done()) ghost.step(ghostReader.next());
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
      cam.x = sim.player.x / SUB;
      cam.y = sim.player.y / SUB;
      beginFrame(ctx, cam, w, h, dpr);
      drawSim(ctx, cam, w, h, sim, { ghost: showGhost ? ghost : null, frame });
      const shown = sim.finished ? sim.finishTick : sim.tick;
      timer.textContent = formatTicks(shown);
      timer.classList.toggle('paused', paused);
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

function safeName(s: string): string {
  return s.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'level';
}
