import { mount, navigate } from './router';
import { el, formatDateTime, confirmBox, promptBox, toast } from './ui';
import { thumbnail } from './thumbnail';
import { listLevels, createLevel, duplicateLevel, deleteLevel, getLevel, saveLevel, getBest } from './storage';
import { checkPlayable } from '../sim/level';
import { formatTicks } from '../sim/replay';
import { startPlay } from './play';
import { globalEnabled, submitLevel } from './global';
import { adminButton } from './adminui';
import { askName, playerButton, playerName } from './player';

export function showMenu(): void {
  mount((root) => {
    let alive = true;
    const list = el('div', { class: 'level-list', 'data-testid': 'my-levels' });

    // ------------------------------------------------------------ my levels
    const refresh = () => {
      const levels = listLevels();
      list.replaceChildren();
      if (levels.length === 0) list.append(el('p', { class: 'empty' }, 'No levels yet. Make one with "New level".'));
      for (const l of levels) {
        const check = checkPlayable(l.data);
        const best = getBest(l.id, l.data);
        list.append(
          el('div', { class: 'level-row', 'data-testid': 'level-row', 'data-level-id': l.id },
            thumbnail(l.data),
            el('div', { class: 'level-info' },
              el('div', { class: 'level-name', 'data-testid': 'level-name' }, l.name),
              el('div', { class: 'level-meta' },
                el('span', { 'data-testid': 'level-edited' }, `Edited ${formatDateTime(l.updatedAt)}`),
                el('span', { class: check.ok ? 'badge ok' : 'badge', 'data-testid': 'level-playable' }, check.ok ? 'Playable' : 'Not playable'),
                el('span', { class: 'best', 'data-testid': 'level-best' }, best ? `Best ${formatTicks(best.ticks)}` : 'No best time'))),
            el('div', { class: 'level-actions' },
              el('button', { class: 'btn primary', onclick: () => navigate(`#/edit/${l.id}`) }, 'Edit'),
              el('button', {
                class: 'btn', disabled: !check.ok, title: check.ok ? 'Play this level' : check.problems.join(', '),
                onclick: () => startPlay({ levelId: l.id, name: l.name, data: l.data, mode: 'live', onExit: () => showMenu() }),
              }, 'Play'),
              globalEnabled
                ? el('button', {
                    class: 'btn', 'data-testid': 'submit-global', disabled: !check.ok,
                    title: check.ok ? 'Send this level to the admin to add to the global levels' : check.problems.join(', '),
                    onclick: () => sendIn(l.id),
                  }, 'Submit to global')
                : null,
              el('button', {
                class: 'btn',
                onclick: async () => {
                  const name = await promptBox('Rename level', l.name);
                  const cur = getLevel(l.id);
                  if (name && cur) {
                    saveLevel({ ...cur, name, updatedAt: new Date().toISOString() });
                    refresh();
                  }
                },
              }, 'Rename'),
              el('button', { class: 'btn', onclick: () => { duplicateLevel(l.id); refresh(); } }, 'Duplicate'),
              el('button', {
                class: 'btn danger',
                onclick: async () => {
                  if (await confirmBox('Delete level?', `"${l.name}" will be gone for good.`, 'Delete', true)) {
                    deleteLevel(l.id);
                    refresh();
                  }
                },
              }, 'Delete'))));
      }
    };

    // ------------------------------------------------------------ submit to global
    const sendIn = async (id: string) => {
      const l = getLevel(id);
      if (!l) return;
      // the finish that proves it can be done: this browser's best run on this exact version
      const best = getBest(l.id, l.data);
      if (!best) {
        toast('Finish this level first (play it to the finish), then submit it');
        return;
      }
      const name = await promptBox('Submit to global', l.name, 'Submit');
      if (!name) return;
      const author = playerName() || (await askName());
      try {
        await submitLevel(name, author, l.data, best.replay);
        toast(`Sent "${name}" for review. The admin will check it soon.`);
      } catch (e) {
        toast((e as Error).message);
      }
    };

    const newLevel = async () => {
      const name = await promptBox('New level', `Level ${listLevels().length + 1}`, 'Create');
      if (!name) return;
      const l = createLevel(name);
      navigate(`#/edit/${l.id}`);
    };

    const rerender = () => {
      if (alive) refresh();
    };

    root.append(
      el('div', { class: 'menu' },
        el('header', { class: 'menu-header' },
          el('div', {}, el('h1', { class: 'logo' }, '2d', el('span', {}, 'holes')), el('p', {}, 'Build it. Portal it. Beat the clock.')),
          el('div', { class: 'header-buttons' }, playerButton(rerender), adminButton(rerender))),
        el('div', { class: 'menu-columns' },
          el('section', { class: 'panel' },
            el('div', { class: 'panel-head' }, el('h2', {}, 'My levels'), el('button', { class: 'btn primary', onclick: newLevel, 'data-testid': 'new-level' }, '+ New level')),
            list),
          el('section', { class: 'panel', 'data-testid': 'global-levels' },
            el('div', { class: 'panel-head' }, el('h2', {}, 'Global levels')),
            globalEnabled
              ? el('div', { class: 'global-intro' },
                  el('p', {}, 'Levels everyone can play, with leaderboards. Send yours in with "Submit to global".'),
                  el('button', { class: 'btn primary big', 'data-testid': 'open-global', onclick: () => navigate('#/global') }, 'Global levels'))
              : el('p', { class: 'empty' }, 'Global levels are not connected yet.')))));
    refresh();
    // first visit: ask for a name, then draw the menu again with it
    if (!playerName()) void askName().then(() => alive && showMenu());
    return () => {
      alive = false;
    };
  }, 'menu');
}
