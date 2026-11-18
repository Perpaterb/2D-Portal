// The "Unlock admin" button, shared by the menu and the global levels page.
import { el, modal, toast } from './ui';
import { globalEnabled, isAdmin, unlockAdmin, lockAdmin } from './global';

export function adminButton(onChange: () => void): HTMLButtonElement {
  const btn = el('button', { class: 'btn', 'data-testid': 'admin-button' });
  const paint = () => {
    btn.textContent = isAdmin() ? 'Admin unlocked · Lock' : 'Unlock admin';
    btn.classList.toggle('on', isAdmin());
    btn.hidden = !globalEnabled;
  };
  btn.addEventListener('click', async () => {
    if (isAdmin()) {
      lockAdmin();
    } else {
      const r = await modal({
        title: 'Unlock admin',
        body: 'Admins review submitted levels, organise the global levels into folders, and remove levels and leaderboard entries.',
        input: { value: '', type: 'password', placeholder: 'Admin password' },
        buttons: [{ label: 'Cancel', value: 'no' }, { label: 'Unlock', value: 'yes', kind: 'primary' }],
      });
      if (!r || r.button !== 'yes' || !r.text) return;
      try {
        await unlockAdmin(r.text);
        toast('Admin unlocked');
      } catch (e) {
        toast((e as Error).message);
      }
    }
    paint();
    onChange();
  });
  paint();
  return btn;
}
