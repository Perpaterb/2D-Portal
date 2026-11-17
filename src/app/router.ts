import type { Sim } from '../sim/sim';

export type Screen = 'menu' | 'editor' | 'play';

/** Read-only window into the running app, used by end-to-end tests to observe state. */
export interface DebugHook {
  screen: Screen;
  sim: Sim | null;
  ghost: Sim | null;
  editor: { tiles: number; objects: number; cam: { x: number; y: number; zoom: number }; snap: boolean } | null;
}

declare global {
  interface Window {
    __holes: DebugHook;
  }
}

window.__holes = { screen: 'menu', sim: null, ghost: null, editor: null };

let cleanup: (() => void) | null = null;

export function mount(render: (root: HTMLElement) => () => void, screen: Screen): void {
  const root = document.getElementById('app')!;
  cleanup?.();
  cleanup = null;
  root.replaceChildren();
  window.__holes.screen = screen;
  window.__holes.sim = null;
  window.__holes.ghost = null;
  window.__holes.editor = null;
  cleanup = render(root);
}

export function navigate(hash: string): void {
  if (location.hash === hash || (hash === '#/' && location.hash === '')) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else location.hash = hash;
}
