import type { Sim } from '../sim/sim';

export type Screen = 'menu' | 'global' | 'editor' | 'play';

/** Read-only window into the running app, used by end-to-end tests to observe state. */
export interface DebugHook {
  screen: Screen;
  sim: Sim | null;
  /** ghosts running in the current play, with their tick and position */
  ghosts: { name: string; colour: string; tick: number; x: number; y: number }[];
  editor: { tiles: number; objects: number; cam: { x: number; y: number; zoom: number }; snap: boolean; area?: { x0: number; y0: number; x1: number; y1: number } | null; floating?: boolean } | null;
  /** play camera, including the eased turn after passing through a portal */
  cam?: { x: number; y: number; zoom: number; angle: number; sx: number };
  /** portal view wedges drawn in the last frame */
  views?: number;
}

declare global {
  interface Window {
    __holes: DebugHook;
  }
}

window.__holes = { screen: 'menu', sim: null, ghosts: [], editor: null };

let cleanup: (() => void) | null = null;

export function mount(render: (root: HTMLElement) => () => void, screen: Screen): void {
  const root = document.getElementById('app')!;
  cleanup?.();
  cleanup = null;
  root.replaceChildren();
  window.__holes.screen = screen;
  window.__holes.sim = null;
  window.__holes.ghosts = [];
  window.__holes.editor = null;
  cleanup = render(root);
}

export function navigate(hash: string): void {
  if (location.hash === hash || (hash === '#/' && location.hash === '')) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else location.hash = hash;
}
