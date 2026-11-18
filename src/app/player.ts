// The player's name: asked the first time the site opens, remembered in this browser, and used
// for every leaderboard run and level submission (as the author).
import { el, modal } from './ui';
import { lastName, rememberName } from './arcade';
import { NAME_LENGTH, normaliseName } from '../sim/names';

export function playerName(): string {
  return normaliseName(lastName()) ?? '';
}

/** Asks for a name until a usable one is given (or, when changing, until cancelled). */
export async function askName(changing = false): Promise<string> {
  let note = 'Up to 8 letters or numbers. It goes on the leaderboards and on levels you send in.';
  for (;;) {
    const r = await modal({
      title: changing ? 'Change your name' : "What's your name?",
      body: note,
      input: { value: playerName(), maxLength: NAME_LENGTH, placeholder: 'NAME' },
      buttons: changing
        ? [{ label: 'Cancel', value: 'no' }, { label: 'Save', value: 'yes', kind: 'primary' }]
        : [{ label: "Let's go", value: 'yes', kind: 'primary' }],
    });
    if (changing && (!r || r.button !== 'yes')) return playerName();
    const name = normaliseName(r?.text ?? '');
    if (name) {
      rememberName(name);
      return name;
    }
    note = 'Please enter a name: letters, numbers, space, dot, dash or underscore.';
  }
}

/** "Playing as NAME": click to change it. */
export function playerButton(onChange: () => void = () => undefined): HTMLButtonElement {
  const btn = el('button', { class: 'btn player', 'data-testid': 'player-name', title: 'Change your name' });
  const paint = () => {
    btn.textContent = `Playing as ${playerName() || '…'}`;
  };
  btn.addEventListener('click', async () => {
    await askName(true);
    paint();
    onChange();
  });
  paint();
  return btn;
}
