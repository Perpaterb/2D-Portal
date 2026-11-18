// The global levels page: folders (with a breadcrumb path), levels, search across everything, and for
// the admin: folder tools, drag and drop, renaming, and the queue of levels people have sent in.
import { mount, navigate } from './router';
import { el, formatDateTime, confirmBox, promptBox, toast } from './ui';
import { thumbnail } from './thumbnail';
import { bestTicksForHash, globalBestId } from './storage';
import { formatTicks } from '../sim/replay';
import type { LevelData } from '../sim/level';
import { startPlay } from './play';
import { adminButton } from './adminui';
import { playerButton } from './player';
import {
  globalEnabled, isAdmin, listGlobalLevels, listGlobalFolders, getGlobalLevelsData, topRuns, getRunReplay,
  deleteGlobalLevel, deleteRun, renameGlobalLevel, createFolder, renameFolder, deleteFolder, moveItem,
  listRequests, approveRequest, rejectRequest,
  type GlobalLevel, type GlobalFolder, type RunRow, type LevelRequest,
} from './global';

type Drag = { kind: 'level' | 'folder'; id: string };

export function showGlobal(folderId: string | null): void {
  mount((root) => {
    let alive = true;
    let folders: GlobalFolder[] = [];
    let levels: GlobalLevel[] = [];
    let requests: LevelRequest[] = [];
    let state: 'loading' | 'ok' | { error: string } = 'loading';
    let query = '';
    let drag: Drag | null = null;
    const data = new Map<string, LevelData>();
    const tops = new Map<string, RunRow[]>();
    const openTop = new Set<string>();
    const wanted = new Set<string>();

    const body = el('div', { class: 'global-body', 'data-testid': 'global-list' });
    const search = el('input', {
      class: 'search', type: 'search', placeholder: 'Search all global levels and folders', 'data-testid': 'global-search',
      'aria-label': 'Search global levels',
    });
    search.addEventListener('input', () => {
      query = search.value.trim().toLowerCase();
      paint();
    });

    const folderById = (id: string | null) => (id ? folders.find((f) => f.id === id) ?? null : null);
    /** The folders from the top down to (and including) this one. */
    const pathOf = (id: string | null): GlobalFolder[] => {
      const out: GlobalFolder[] = [];
      let f = folderById(id);
      while (f && out.length < 100) {
        out.unshift(f);
        f = folderById(f.parent_id);
      }
      return out;
    };
    const pathText = (id: string | null) => ['Global', ...pathOf(id).map((f) => f.name)].join(' › ');
    const replay = () => showGlobal(folderId);

    // ---------------------------------------------------------------- loading
    const load = async () => {
      if (!globalEnabled) {
        state = { error: 'Global levels are not connected yet.' };
        return paint();
      }
      try {
        const [f, l, r] = await Promise.all([
          listGlobalFolders(),
          listGlobalLevels(),
          isAdmin() ? listRequests().catch((e: Error) => (toast(e.message), [] as LevelRequest[])) : Promise.resolve([]),
        ]);
        if (!alive) return;
        folders = f;
        levels = l;
        requests = r;
        state = 'ok';
        if (folderId && !folderById(folderId)) {
          toast('That folder is no longer there');
          folderId = null;
        }
      } catch (e) {
        if (!alive) return;
        if (state !== 'ok') state = { error: (e as Error).message };
        toast((e as Error).message);
      }
      paint();
    };

    /** Fetches the level data (for thumbnails) and top 10 of levels about to be shown. */
    const want = (ids: string[]) => {
      const missing = ids.filter((id) => !wanted.has(id));
      if (!missing.length) return;
      for (const id of missing) wanted.add(id);
      void (async () => {
        try {
          const [d, boards] = await Promise.all([
            getGlobalLevelsData(missing),
            Promise.all(missing.map((id) => topRuns(id).catch(() => [] as RunRow[]))),
          ]);
          if (!alive) return;
          for (const [id, lv] of d) data.set(id, lv);
          missing.forEach((id, i) => tops.set(id, boards[i]));
          paint();
        } catch (e) {
          for (const id of missing) wanted.delete(id);
          toast((e as Error).message);
        }
      })();
    };

    const act = async (job: () => Promise<unknown>, done?: string) => {
      try {
        await job();
        if (done) toast(done);
      } catch (e) {
        toast((e as Error).message);
      }
      await load();
    };

    // ---------------------------------------------------------------- drag and drop (admin)
    const draggable = (node: HTMLElement, item: Drag) => {
      if (!isAdmin()) return;
      node.draggable = true;
      node.addEventListener('dragstart', (e) => {
        drag = item;
        e.dataTransfer?.setData('text/plain', `${item.kind}:${item.id}`);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        node.classList.add('dragging');
      });
      node.addEventListener('dragend', () => {
        drag = null;
        node.classList.remove('dragging');
        root.querySelectorAll('.drop-into, .drop-before').forEach((n) => n.classList.remove('drop-into', 'drop-before'));
      });
    };

    /** where: what a drop at this point of the target means, or null if it means nothing */
    const dropTarget = (node: HTMLElement, where: (e: DragEvent, d: Drag) => { cls: string; run: () => Promise<void> } | null) => {
      if (!isAdmin()) return;
      node.addEventListener('dragover', (e) => {
        if (!drag) return;
        const w = where(e, drag);
        node.classList.remove('drop-into', 'drop-before');
        if (!w) return;
        e.preventDefault();
        node.classList.add(w.cls);
      });
      node.addEventListener('dragleave', () => node.classList.remove('drop-into', 'drop-before'));
      node.addEventListener('drop', (e) => {
        node.classList.remove('drop-into', 'drop-before');
        if (!drag) return;
        const w = where(e, drag);
        drag = null;
        if (!w) return;
        e.preventDefault();
        void act(w.run);
      });
    };

    /** Dropping on a folder (or breadcrumb, or "up a level") moves the item into it, at the end. */
    const intoFolder = (target: string | null) => (_e: DragEvent, d: Drag) =>
      d.id === target ? null : { cls: 'drop-into', run: () => moveItem(d.kind, d.id, target) };

    // ---------------------------------------------------------------- rows
    const levelRow = (g: GlobalLevel, withPath: boolean) => {
      const runs = tops.get(g.id) ?? [];
      const wr = runs[0];
      const mine = bestTicksForHash(globalBestId(g.id), g.level_hash);
      const lv = data.get(g.id) ?? null;
      const row = el('div', { class: 'level-row global-row', 'data-testid': 'global-row', 'data-global-id': g.id },
        thumbnail(lv),
        el('div', { class: 'level-info' },
          el('div', { class: 'level-name', 'data-testid': 'global-name' }, g.name),
          withPath ? el('div', { class: 'result-path', 'data-testid': 'result-path' }, pathText(g.folder_id)) : null,
          el('div', { class: 'level-meta' },
            g.author ? el('span', { 'data-testid': 'global-author' }, `by ${g.author}`) : null,
            mine !== null ? el('span', { class: 'badge ok', 'data-testid': 'global-completed' }, 'Completed') : null,
            mine !== null ? el('span', { class: 'best', 'data-testid': 'global-mine' }, `Your best ${formatTicks(mine)}`) : null,
            el('span', { class: 'best', 'data-testid': 'global-record' }, wr ? `Record ${formatTicks(wr.ticks)} ${wr.name}` : 'No times yet'))),
        el('div', { class: 'level-actions' },
          el('button', { class: 'btn primary', 'data-testid': 'play-global', onclick: () => playGlobal(g) }, 'Play'),
          el('button', {
            class: `btn ${openTop.has(g.id) ? 'on' : ''}`, 'data-testid': 'toggle-top',
            onclick: () => { if (openTop.has(g.id)) openTop.delete(g.id); else openTop.add(g.id); paint(); },
          }, 'Top 10'),
          isAdmin()
            ? el('button', {
                class: 'btn', 'data-testid': 'rename-global',
                onclick: async () => {
                  const name = await promptBox('Rename global level', g.name);
                  if (name && name !== g.name) await act(() => renameGlobalLevel(g.id, name));
                },
              }, 'Rename')
            : null,
          isAdmin()
            ? el('button', {
                class: 'btn danger', 'data-testid': 'delete-global',
                onclick: async () => {
                  if (!(await confirmBox('Delete global level?', `"${g.name}" and its whole leaderboard will be removed for everyone.`, 'Delete', true))) return;
                  await act(() => deleteGlobalLevel(g.id), 'Global level deleted');
                },
              }, 'Delete')
            : null));
      draggable(row, { kind: 'level', id: g.id });
      // a level dropped on a level goes just before it; a folder dropped here joins this folder
      dropTarget(row, (_e, d) =>
        d.id === g.id ? null
          : d.kind === 'level'
            ? { cls: 'drop-before', run: () => moveItem('level', d.id, g.folder_id, g.id) }
            : { cls: 'drop-into', run: () => moveItem('folder', d.id, g.folder_id) });
      const out: HTMLElement[] = [row];
      if (openTop.has(g.id)) out.push(board(g, runs));
      return out;
    };

    const board = (g: GlobalLevel, runs: RunRow[]) => {
      const list = el('ol', { class: 'leaderboard', 'data-testid': 'leaderboard' });
      if (!runs.length) list.append(el('li', { class: 'empty' }, 'No times yet. Be the first.'));
      for (const r of runs) {
        list.append(el('li', { 'data-testid': 'leaderboard-row' },
          el('span', { class: 'lb-name' }, r.name),
          el('span', { class: 'lb-time' }, formatTicks(r.ticks)),
          el('button', { class: 'btn small', 'data-testid': 'watch-run', onclick: () => watchRun(g, r) }, 'Watch'),
          isAdmin()
            ? el('button', {
                class: 'btn small danger', 'data-testid': 'delete-run', title: 'Remove this entry',
                onclick: async () => {
                  if (!(await confirmBox('Remove entry?', `Remove ${r.name} ${formatTicks(r.ticks)} from the leaderboard?`, 'Remove', true))) return;
                  tops.delete(g.id);
                  wanted.delete(g.id);
                  await act(() => deleteRun(r.id));
                },
              }, '✕')
            : null));
      }
      return list;
    };

    const folderRow = (f: GlobalFolder, withPath: boolean) => {
      const nLevels = levels.filter((l) => l.folder_id === f.id).length;
      const nFolders = folders.filter((x) => x.parent_id === f.id).length;
      const counts = [nFolders ? `${nFolders} folder${nFolders === 1 ? '' : 's'}` : '', `${nLevels} level${nLevels === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
      const row = el('div', { class: 'level-row folder-row', 'data-testid': 'folder-row', 'data-folder-id': f.id },
        el('div', { class: 'folder-icon', 'aria-hidden': 'true' }),
        el('div', { class: 'level-info' },
          el('div', { class: 'level-name', 'data-testid': 'folder-name' }, f.name),
          withPath ? el('div', { class: 'result-path', 'data-testid': 'result-path' }, pathText(f.parent_id)) : null,
          el('div', { class: 'level-meta' }, el('span', {}, counts))),
        el('div', { class: 'level-actions' },
          el('button', { class: 'btn', 'data-testid': 'open-folder', onclick: () => navigate(`#/global/${f.id}`) }, 'Open'),
          isAdmin()
            ? el('button', {
                class: 'btn', 'data-testid': 'rename-folder',
                onclick: async () => {
                  const name = await promptBox('Rename folder', f.name);
                  if (name && name !== f.name) await act(() => renameFolder(f.id, name));
                },
              }, 'Rename')
            : null,
          isAdmin()
            ? el('button', {
                class: 'btn danger', 'data-testid': 'delete-folder',
                onclick: async () => {
                  const up = f.parent_id ? folderById(f.parent_id)?.name ?? 'its parent' : 'Global';
                  if (!(await confirmBox('Delete folder?', `"${f.name}" will be removed. Everything in it moves up to ${up}.`, 'Delete', true))) return;
                  await act(() => deleteFolder(f.id), 'Folder deleted');
                },
              }, 'Delete')
            : null));
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        navigate(`#/global/${f.id}`);
      });
      draggable(row, { kind: 'folder', id: f.id });
      // the top edge of a folder means "put the dragged folder before this one"; anywhere else means "into it"
      dropTarget(row, (e, d) => {
        if (d.id === f.id) return null;
        const r = row.getBoundingClientRect();
        if (d.kind === 'folder' && e.clientY < r.top + r.height * 0.3) {
          return { cls: 'drop-before', run: () => moveItem('folder', d.id, f.parent_id, f.id) };
        }
        return { cls: 'drop-into', run: () => moveItem(d.kind, d.id, f.id) };
      });
      return row;
    };

    const requestRow = (q: LevelRequest) =>
      el('div', { class: 'level-row request-row', 'data-testid': 'request-row', 'data-request-id': q.id },
        thumbnail(q.data),
        el('div', { class: 'level-info' },
          el('div', { class: 'level-name', 'data-testid': 'request-name' }, q.name),
          el('div', { class: 'level-meta' },
            el('span', { 'data-testid': 'request-author' }, `by ${q.author}`),
            el('span', {}, `Sent ${formatDateTime(q.created_at)}`))),
        el('div', { class: 'level-actions' },
          el('button', {
            class: 'btn', 'data-testid': 'playtest',
            onclick: () => startPlay({ levelId: null, name: `Play test: ${q.name}`, data: q.data, mode: 'live', onExit: replay }),
          }, 'Play test'),
          el('button', { class: 'btn primary', 'data-testid': 'approve', onclick: () => act(() => approveRequest(q.id), `"${q.name}" added to Global`) }, 'Approve'),
          el('button', {
            class: 'btn danger', 'data-testid': 'reject',
            onclick: async () => {
              if (await confirmBox('Reject level?', `"${q.name}" by ${q.author} will be removed from the queue.`, 'Reject', true)) await act(() => rejectRequest(q.id));
            },
          }, 'Reject')));

    // ---------------------------------------------------------------- play
    const playGlobal = async (g: GlobalLevel) => {
      try {
        const lv = data.get(g.id) ?? (await getGlobalLevelsData([g.id])).get(g.id);
        if (!lv) throw new Error('That level is no longer on the global list');
        const runs = await topRuns(g.id);
        startPlay({ levelId: null, name: g.name, data: lv, mode: 'live', global: { id: g.id, runs }, onExit: replay });
      } catch (e) {
        toast((e as Error).message);
      }
    };

    const watchRun = async (g: GlobalLevel, run: RunRow) => {
      try {
        const [d, rp] = await Promise.all([getGlobalLevelsData([g.id]), getRunReplay(run.id)]);
        const lv = d.get(g.id);
        if (!lv) throw new Error('That level is no longer on the global list');
        startPlay({ levelId: null, name: `${g.name} · ${run.name}`, data: lv, mode: 'watch', replay: rp, onExit: replay });
      } catch (e) {
        toast((e as Error).message);
      }
    };

    // ---------------------------------------------------------------- paint
    const crumbs = el('nav', { class: 'crumbs', 'data-testid': 'crumbs', 'aria-label': 'Folder path' });
    const tools = el('div', { class: 'global-tools' });
    const queue = el('section', { class: 'panel requests', 'data-testid': 'requests' });

    const paintCrumbs = () => {
      crumbs.replaceChildren();
      const steps: (GlobalFolder | null)[] = [null, ...pathOf(folderId)];
      steps.forEach((f, i) => {
        if (i) crumbs.append(el('span', { class: 'crumb-sep' }, '›'));
        const here = i === steps.length - 1;
        const c = el('button', {
          class: `crumb ${here ? 'here' : ''}`, 'data-testid': 'crumb', 'data-folder-id': f?.id ?? '',
          onclick: () => navigate(f ? `#/global/${f.id}` : '#/global'),
        }, f ? f.name : 'Global');
        if (!here) dropTarget(c, intoFolder(f?.id ?? null));
        crumbs.append(c);
      });
    };

    const paintQueue = () => {
      queue.hidden = !isAdmin();
      if (!isAdmin()) return;
      queue.replaceChildren(
        el('div', { class: 'panel-head' }, el('h2', { 'data-testid': 'requests-title' }, `Requests (${requests.length})`)),
        requests.length
          ? el('div', { class: 'level-list' }, ...requests.map(requestRow))
          : el('p', { class: 'empty' }, 'No levels waiting for review.'),
      );
    };

    const paint = () => {
      if (!alive) return;
      paintCrumbs();
      paintQueue();
      tools.replaceChildren();
      if (isAdmin()) {
        tools.append(
          el('button', {
              class: 'btn', 'data-testid': 'new-folder',
              onclick: async () => {
                const name = await promptBox('New folder', 'New folder', 'Create');
                if (name) await act(() => createFolder(name, folderId));
              },
            }, '+ New folder'));
      }
      body.replaceChildren();
      if (state === 'loading') {
        body.append(el('p', { class: 'empty', 'data-testid': 'global-loading' }, 'Loading global levels…'));
        return;
      }
      if (state !== 'ok') {
        body.append(el('p', { class: 'empty error', 'data-testid': 'global-error' }, state.error));
        return;
      }
      if (query) {
        const fs = folders.filter((f) => f.name.toLowerCase().includes(query));
        const ls = levels.filter((l) => l.name.toLowerCase().includes(query));
        want(ls.map((l) => l.id));
        if (!fs.length && !ls.length) body.append(el('p', { class: 'empty', 'data-testid': 'no-results' }, `Nothing called "${search.value.trim()}".`));
        for (const f of fs) body.append(folderRow(f, true));
        for (const l of ls) body.append(...levelRow(l, true));
        return;
      }
      const here = folderById(folderId);
      if (here) {
        const up = el('div', { class: 'level-row up-row', 'data-testid': 'up-level' },
          el('div', { class: 'folder-icon up', 'aria-hidden': 'true' }),
          el('div', { class: 'level-info' }, el('div', { class: 'level-name' }, `Up to ${here.parent_id ? folderById(here.parent_id)?.name : 'Global'}`)));
        up.addEventListener('click', () => navigate(here.parent_id ? `#/global/${here.parent_id}` : '#/global'));
        dropTarget(up, intoFolder(here.parent_id));
        body.append(up);
      }
      const fs = folders.filter((f) => f.parent_id === folderId);
      const ls = levels.filter((l) => l.folder_id === folderId);
      want(ls.map((l) => l.id));
      if (!fs.length && !ls.length) body.append(el('p', { class: 'empty' }, here ? 'This folder is empty.' : 'No global levels yet.'));
      for (const f of fs) body.append(folderRow(f, false));
      for (const l of ls) body.append(...levelRow(l, false));
      if (isAdmin() && (fs.length || ls.length)) {
        const end = el('div', { class: 'drop-end', 'data-testid': 'drop-end' }, 'Drop here to move to the end');
        dropTarget(end, intoFolder(folderId));
        body.append(end);
      }
    };

    const rerender = () => {
      if (!alive) return;
      void load();
    };

    root.append(
      el('div', { class: 'menu global-page' },
        el('header', { class: 'menu-header' },
          el('div', { class: 'page-title' },
            el('button', { class: 'btn', 'data-testid': 'back-to-menu', onclick: () => navigate('#/') }, '← Menu'),
            el('h1', {}, 'Global levels')),
          el('div', { class: 'header-buttons' }, playerButton(), adminButton(rerender))),
        queue,
        el('section', { class: 'panel' },
          el('div', { class: 'panel-head global-head' }, crumbs, tools),
          search,
          body)));
    paint();
    void load();
    return () => {
      alive = false;
    };
  }, 'global');
}
