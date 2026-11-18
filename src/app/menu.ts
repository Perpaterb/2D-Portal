import { mount, navigate } from './router';
import { el, formatDateTime, confirmBox, promptBox, modal, toast } from './ui';
import { listLevels, createLevel, duplicateLevel, deleteLevel, getLevel, saveLevel, getBest } from './storage';
import { checkPlayable, levelHash } from '../sim/level';
import { formatTicks } from '../sim/replay';
import { startPlay } from './play';
import {
  globalEnabled, listGlobalLevels, topRuns, getGlobalLevelData, getRunReplay, isAdmin, unlockAdmin, lockAdmin,
  uploadLevel, deleteGlobalLevel, deleteRun, type GlobalLevel, type RunRow,
} from './global';

export function showMenu(): void {
  mount((root) => {
    let alive = true;
    let globals: GlobalLevel[] = [];
    const list = el('div', { class: 'level-list', 'data-testid': 'my-levels' });
    const globalList = el('div', { class: 'level-list', 'data-testid': 'global-list' });
    const adminBtn = el('button', { class: 'btn', 'data-testid': 'admin-button' });

    // ------------------------------------------------------------ my levels
    const refresh = () => {
      const levels = listLevels();
      list.replaceChildren();
      if (levels.length === 0) list.append(el('p', { class: 'empty' }, 'No levels yet. Make one with "New level".'));
      for (const l of levels) {
        const check = checkPlayable(l.data);
        const best = getBest(l.id, l.data);
        const g = globals.find((x) => x.source_id === l.id);
        const upToDate = g && g.level_hash === levelHash(l.data) && g.name === l.name;
        list.append(
          el('div', { class: 'level-row', 'data-testid': 'level-row', 'data-level-id': l.id },
            el('div', { class: 'level-info' },
              el('div', { class: 'level-name', 'data-testid': 'level-name' }, l.name),
              el('div', { class: 'level-meta' },
                el('span', { 'data-testid': 'level-edited' }, `Edited ${formatDateTime(l.updatedAt)}`),
                el('span', { class: check.ok ? 'badge ok' : 'badge', 'data-testid': 'level-playable' }, check.ok ? 'Playable' : 'Not playable'),
                g ? el('span', { class: 'badge global', 'data-testid': 'level-global' }, upToDate ? 'Global' : 'Global (changed here)') : null,
                el('span', { class: 'best', 'data-testid': 'level-best' }, best ? `Best ${formatTicks(best.ticks)}` : 'No best time'))),
            el('div', { class: 'level-actions' },
              el('button', { class: 'btn primary', onclick: () => navigate(`#/edit/${l.id}`) }, 'Edit'),
              el('button', {
                class: 'btn', disabled: !check.ok, title: check.ok ? 'Play this level' : check.problems.join(', '),
                onclick: () => startPlay({ levelId: l.id, name: l.name, data: l.data, mode: 'live', onExit: () => showMenu() }),
              }, 'Play'),
              isAdmin() && check.ok
                ? el('button', {
                    class: 'btn admin', 'data-testid': g ? 'update-global' : 'add-global', disabled: !!upToDate,
                    title: upToDate ? 'The global copy is up to date' : '',
                    onclick: () => publish(l.id, !!g),
                  }, g ? 'Update global' : 'Add to global')
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

    const publish = async (id: string, exists: boolean) => {
      const l = getLevel(id);
      if (!l) return;
      if (exists && !(await confirmBox('Update global level?', `The global copy of "${l.name}" will be replaced. If the level itself changed, its leaderboard is cleared.`, 'Update'))) return;
      try {
        const r = await uploadLevel(l.id, l.name, l.data);
        toast(r.created ? 'Added to the global levels' : r.reset ? 'Global level updated; its leaderboard was reset' : 'Global level updated');
      } catch (e) {
        toast((e as Error).message);
      }
      await loadGlobals();
    };

    // ------------------------------------------------------------ admin
    const paintAdmin = () => {
      adminBtn.textContent = isAdmin() ? 'Admin unlocked · Lock' : 'Unlock admin';
      adminBtn.classList.toggle('on', isAdmin());
      adminBtn.hidden = !globalEnabled;
    };
    adminBtn.addEventListener('click', async () => {
      if (isAdmin()) {
        lockAdmin();
      } else {
        const r = await modal({
          title: 'Unlock admin',
          body: 'Admins can add levels to the global list and remove levels and leaderboard entries.',
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
      paintAdmin();
      refresh();
      paintGlobals();
    });

    // ------------------------------------------------------------ global levels
    const tops = new Map<string, RunRow[]>();
    let globalsState: 'loading' | 'ok' | { error: string } = 'loading';
    const open = new Set<string>();

    const playGlobal = async (g: GlobalLevel) => {
      try {
        const data = await getGlobalLevelData(g.id);
        const runs = await topRuns(g.id);
        startPlay({ levelId: null, name: g.name, data, mode: 'live', global: { id: g.id, runs }, onExit: () => showMenu() });
      } catch (e) {
        toast((e as Error).message);
      }
    };

    const watchRun = async (g: GlobalLevel, run: RunRow) => {
      try {
        const [data, replay] = await Promise.all([getGlobalLevelData(g.id), getRunReplay(run.id)]);
        startPlay({ levelId: null, name: `${g.name} · ${run.name}`, data, mode: 'watch', replay, onExit: () => showMenu() });
      } catch (e) {
        toast((e as Error).message);
      }
    };

    const paintGlobals = () => {
      globalList.replaceChildren();
      if (!globalEnabled) {
        globalList.append(el('p', { class: 'empty' }, 'Global levels are not connected yet.'));
        return;
      }
      if (globalsState === 'loading') {
        globalList.append(el('p', { class: 'empty', 'data-testid': 'global-loading' }, 'Loading global levels…'));
        return;
      }
      if (globalsState !== 'ok') {
        globalList.append(el('p', { class: 'empty error', 'data-testid': 'global-error' }, globalsState.error));
        return;
      }
      if (globals.length === 0) globalList.append(el('p', { class: 'empty' }, 'No global levels yet.'));
      for (const g of globals) {
        const runs = tops.get(g.id) ?? [];
        const wr = runs[0];
        const row = el('div', { class: 'level-row global-row', 'data-testid': 'global-row', 'data-global-id': g.id },
          el('div', { class: 'level-info' },
            el('div', { class: 'level-name', 'data-testid': 'global-name' }, g.name),
            el('div', { class: 'level-meta' },
              el('span', {}, `Updated ${formatDateTime(g.updated_at)}`),
              el('span', { class: 'best', 'data-testid': 'global-record' }, wr ? `Record ${formatTicks(wr.ticks)} ${wr.name}` : 'No times yet'))),
          el('div', { class: 'level-actions' },
            el('button', { class: 'btn primary', 'data-testid': 'play-global', onclick: () => playGlobal(g) }, 'Play'),
            el('button', {
              class: `btn ${open.has(g.id) ? 'on' : ''}`, 'data-testid': 'toggle-top',
              onclick: () => { if (open.has(g.id)) open.delete(g.id); else open.add(g.id); paintGlobals(); },
            }, 'Top 10'),
            isAdmin()
              ? el('button', {
                  class: 'btn danger', 'data-testid': 'delete-global',
                  onclick: async () => {
                    if (!(await confirmBox('Delete global level?', `"${g.name}" and its whole leaderboard will be removed for everyone.`, 'Delete', true))) return;
                    try {
                      await deleteGlobalLevel(g.id);
                      toast('Global level deleted');
                    } catch (e) {
                      toast((e as Error).message);
                    }
                    await loadGlobals();
                  },
                }, 'Delete')
              : null));
        globalList.append(row);
        if (open.has(g.id)) {
          const board = el('ol', { class: 'leaderboard', 'data-testid': 'leaderboard' });
          if (!runs.length) board.append(el('li', { class: 'empty' }, 'No times yet. Be the first.'));
          runs.forEach((r) => {
            board.append(el('li', { 'data-testid': 'leaderboard-row' },
              el('span', { class: 'lb-name' }, r.name),
              el('span', { class: 'lb-time' }, formatTicks(r.ticks)),
              el('button', { class: 'btn small', 'data-testid': 'watch-run', onclick: () => watchRun(g, r) }, 'Watch'),
              isAdmin()
                ? el('button', {
                    class: 'btn small danger', 'data-testid': 'delete-run', title: 'Remove this entry',
                    onclick: async () => {
                      if (!(await confirmBox('Remove entry?', `Remove ${r.name} ${formatTicks(r.ticks)} from the leaderboard?`, 'Remove', true))) return;
                      try {
                        await deleteRun(r.id);
                      } catch (e) {
                        toast((e as Error).message);
                      }
                      await loadGlobals();
                    },
                  }, '✕')
                : null));
          });
          globalList.append(board);
        }
      }
    };

    const loadGlobals = async () => {
      if (!globalEnabled) return paintGlobals();
      try {
        const g = await listGlobalLevels();
        const boards = await Promise.all(g.map((x) => topRuns(x.id).catch(() => [] as RunRow[])));
        if (!alive) return;
        globals = g;
        tops.clear();
        g.forEach((x, i) => tops.set(x.id, boards[i]));
        globalsState = 'ok';
      } catch (e) {
        if (!alive) return;
        // keep showing what loaded before; only a first failed load replaces the list
        if (globalsState !== 'ok') globalsState = { error: (e as Error).message };
        toast((e as Error).message);
      }
      if (!alive) return;
      paintGlobals();
      refresh();
    };

    const newLevel = async () => {
      const name = await promptBox('New level', `Level ${listLevels().length + 1}`, 'Create');
      if (!name) return;
      const l = createLevel(name);
      navigate(`#/edit/${l.id}`);
    };

    root.append(
      el('div', { class: 'menu' },
        el('header', { class: 'menu-header' },
          el('div', {}, el('h1', { class: 'logo' }, '2d', el('span', {}, 'holes')), el('p', {}, 'Build it. Portal it. Beat the clock.')),
          adminBtn),
        el('div', { class: 'menu-columns' },
          el('section', { class: 'panel' },
            el('div', { class: 'panel-head' }, el('h2', {}, 'My levels'), el('button', { class: 'btn primary', onclick: newLevel, 'data-testid': 'new-level' }, '+ New level')),
            list),
          el('section', { class: 'panel', 'data-testid': 'global-levels' },
            el('div', { class: 'panel-head' }, el('h2', {}, 'Global levels')),
            globalList))));
    paintAdmin();
    refresh();
    paintGlobals();
    void loadGlobals();
    return () => {
      alive = false;
    };
  }, 'menu');
}
