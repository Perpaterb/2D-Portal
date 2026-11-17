import { mount, navigate } from './router';
import { el, formatDateTime, confirmBox, promptBox } from './ui';
import { listLevels, createLevel, duplicateLevel, deleteLevel, getLevel, saveLevel, getBest } from './storage';
import { checkPlayable } from '../sim/level';
import { formatTicks } from '../sim/replay';
import { startPlay } from './play';

export function showMenu(): void {
  mount((root) => {
    const list = el('div', { class: 'level-list', 'data-testid': 'my-levels' });

    const refresh = () => {
      const levels = listLevels();
      list.replaceChildren();
      if (levels.length === 0) {
        list.append(el('p', { class: 'empty' }, 'No levels yet. Make one with "New level".'));
      }
      for (const l of levels) {
        const playable = checkPlayable(l.data).ok;
        const best = getBest(l.id, l.data);
        list.append(
          el(
            'div',
            { class: 'level-row', 'data-testid': 'level-row', 'data-level-id': l.id },
            el(
              'div',
              { class: 'level-info' },
              el('div', { class: 'level-name', 'data-testid': 'level-name' }, l.name),
              el(
                'div',
                { class: 'level-meta' },
                el('span', { 'data-testid': 'level-edited' }, `Edited ${formatDateTime(l.updatedAt)}`),
                el('span', { class: playable ? 'badge ok' : 'badge', 'data-testid': 'level-playable' }, playable ? 'Playable' : 'Not playable'),
                el('span', { class: 'best', 'data-testid': 'level-best' }, best ? `Best ${formatTicks(best.ticks)}` : 'No best time'),
              ),
            ),
            el(
              'div',
              { class: 'level-actions' },
              el('button', { class: 'btn primary', onclick: () => navigate(`#/edit/${l.id}`) }, 'Edit'),
              el(
                'button',
                {
                  class: 'btn',
                  disabled: !playable,
                  title: playable ? 'Play this level' : checkPlayable(l.data).problems.join(', '),
                  onclick: () =>
                    startPlay({
                      levelId: l.id,
                      name: l.name,
                      data: l.data,
                      mode: 'live',
                      ghost: getBest(l.id, l.data)?.replay ?? null,
                      onExit: () => showMenu(),
                    }),
                },
                'Play',
              ),
              el(
                'button',
                {
                  class: 'btn',
                  onclick: async () => {
                    const name = await promptBox('Rename level', l.name);
                    const cur = getLevel(l.id);
                    if (name && cur) {
                      saveLevel({ ...cur, name, updatedAt: new Date().toISOString() });
                      refresh();
                    }
                  },
                },
                'Rename',
              ),
              el('button', { class: 'btn', onclick: () => { duplicateLevel(l.id); refresh(); } }, 'Duplicate'),
              el(
                'button',
                {
                  class: 'btn danger',
                  onclick: async () => {
                    if (await confirmBox('Delete level?', `"${l.name}" will be gone for good.`, 'Delete', true)) {
                      deleteLevel(l.id);
                      refresh();
                    }
                  },
                },
                'Delete',
              ),
            ),
          ),
        );
      }
    };

    const newLevel = async () => {
      const name = await promptBox('New level', `Level ${listLevels().length + 1}`, 'Create');
      if (!name) return;
      const l = createLevel(name);
      navigate(`#/edit/${l.id}`);
    };

    root.append(
      el(
        'div',
        { class: 'menu' },
        el('header', { class: 'menu-header' }, el('h1', { class: 'logo' }, '2d', el('span', {}, 'holes')), el('p', {}, 'Build it. Portal it. Beat the clock.')),
        el(
          'div',
          { class: 'menu-columns' },
          el(
            'section',
            { class: 'panel' },
            el('div', { class: 'panel-head' }, el('h2', {}, 'My levels'), el('button', { class: 'btn primary', onclick: newLevel, 'data-testid': 'new-level' }, '+ New level')),
            list,
          ),
          el(
            'section',
            { class: 'panel', 'data-testid': 'global-levels' },
            el('div', { class: 'panel-head' }, el('h2', {}, 'Global levels')),
            el('p', { class: 'empty' }, 'Global levels and leaderboards are not connected yet.'),
          ),
        ),
      ),
    );
    refresh();
    return () => {};
  }, 'menu');
}
