import './router';
import { navigate } from './router';
import { showMenu } from './menu';
import { showEditor } from './editor';
import { showGlobal } from './globalpage';

function route(): void {
  const m = /^#\/edit\/([\w-]+)$/.exec(location.hash);
  if (m) {
    if (!showEditor(m[1])) navigate('#/');
    return;
  }
  const g = /^#\/global(?:\/([\w-]+))?$/.exec(location.hash);
  if (g) {
    showGlobal(g[1] ?? null);
    return;
  }
  showMenu();
}

window.addEventListener('hashchange', route);
route();
