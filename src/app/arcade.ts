// Old-school arcade name entry: 8 slots, Up / Down cycle the letter, Left / Right move,
// or just type. Enter submits.
import { el } from './ui';
import { NAME_CHARS, NAME_LENGTH, normaliseName } from '../sim/names';

const LAST_NAME_KEY = '2dholes.name';

export function lastName(): string {
  try {
    return localStorage.getItem(LAST_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberName(name: string): void {
  try {
    localStorage.setItem(LAST_NAME_KEY, name);
  } catch {
    /* ignore */
  }
}

export function nameEntry(onSubmit: (name: string) => void): HTMLElement {
  const chars = [...lastName().toUpperCase().padEnd(NAME_LENGTH, ' ').slice(0, NAME_LENGTH)].map((c) =>
    NAME_CHARS.includes(c) ? c : ' ',
  );
  let pos = Math.min(chars.join('').trimEnd().length, NAME_LENGTH - 1);
  const slots = chars.map(() => el('span', { class: 'arcade-slot' }));
  const box = el('div', { class: 'arcade', tabindex: 0, 'data-testid': 'name-entry', role: 'textbox', 'aria-label': 'Leaderboard name, up to 8 characters' }, ...slots);

  const paint = () => {
    slots.forEach((s, i) => {
      s.textContent = chars[i] === ' ' ? '_' : chars[i];
      s.classList.toggle('blank', chars[i] === ' ');
      s.classList.toggle('cursor', i === pos);
    });
    box.dataset.value = chars.join('').trim();
  };

  const cycle = (d: number) => {
    const i = NAME_CHARS.indexOf(chars[pos]);
    chars[pos] = NAME_CHARS[(i + d + NAME_CHARS.length) % NAME_CHARS.length];
  };

  box.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'Escape') return; // let Esc leave the play screen as usual
    e.stopPropagation(); // keep typed letters away from the game controls
    if (k === 'Enter') {
      e.preventDefault();
      const name = normaliseName(chars.join(''));
      if (name) onSubmit(name);
      else box.classList.add('shake');
      return;
    }
    if (k === 'ArrowUp') cycle(1);
    else if (k === 'ArrowDown') cycle(-1);
    else if (k === 'ArrowLeft') pos = Math.max(0, pos - 1);
    else if (k === 'ArrowRight') pos = Math.min(NAME_LENGTH - 1, pos + 1);
    else if (k === 'Backspace') {
      if (chars[pos] === ' ' && pos > 0) pos--;
      chars[pos] = ' ';
    } else if (k === 'Delete') chars[pos] = ' ';
    else if (k.length === 1 && NAME_CHARS.includes(k.toUpperCase())) {
      chars[pos] = k.toUpperCase();
      pos = Math.min(NAME_LENGTH - 1, pos + 1);
    } else return;
    e.preventDefault();
    box.classList.remove('shake');
    paint();
  });
  paint();
  return box;
}
