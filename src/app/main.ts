import './router';
import { navigate } from './router';
import { showMenu } from './menu';
import { showEditor } from './editor';

function route(): void {
  const m = /^#\/edit\/([\w-]+)$/.exec(location.hash);
  if (m) {
    if (!showEditor(m[1])) navigate('#/');
    return;
  }
  showMenu();
}

window.addEventListener('hashchange', route);
route();
