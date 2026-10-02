'use strict';
// files.js — workstream C: lazy file tree, preview w/ line numbers, edit-in-place,
// create file/dir, delete (confirm sheet), rename/move, filename search, breadcrumb bar,
// [file: path] chip → bus.emit('fm:mention', path) for composer insert.
// Backend: server/modules/fs_routes.js (list/read/write/mkdir/delete/move/search)
window.MODULES = window.MODULES || {};
MODULES.files = (() => {
  const state = { ws: 'default', path: '', expanded: new Map(), preview: null, search: null, pageSize: 25, page: 0 };

  // ---- API helpers ----
  const q = (path) => `ws=${encodeURIComponent(state.ws)}&path=${encodeURIComponent(path || '')}`;
  async function list(p) { return API.json(`/api/fs/list?${q(p)}`); }
  async function read(p) { return API.json(`/api/fs/read?${q(p)}`); }
  async function write(p, content) { return API.post('/api/fs/write', { ws: state.ws, path: p, content }); }
  async function mkdir(p) { return API.post('/api/fs/mkdir', { ws: state.ws, path: p }); }
  async function del(p) { return API.post('/api/fs/delete', { ws: state.ws, path: p }); }
  async function move(from, to) { return API.post('/api/fs/move', { ws: state.ws, from, to }); }
  async function search(s) {
    const r = await API.fetch(`/api/fs/search?ws=${encodeURIComponent(state.ws)}&q=${encodeURIComponent(s)}`);
    const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j;
  }

  // ---- rendering ----
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function wsBarEl() {
    const bar = el('div', 'fs-ws');
    bar.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:2px 0 6px';
    const lbl = el('span', 'muted', 'ws:');
    lbl.style.cssText = 'font-size:12px';
    bar.appendChild(lbl);
    API.json('/api/fs/workspaces').then(j => {
      for (const w of (j.workspaces || [])) {
        const b = el('button', 'chip fs-ws-seg' + (w.id === state.ws ? ' active' : ''), w.id);
        b.style.cssText = 'min-height:36px;min-width:36px;font-size:12px;padding:2px 10px' + (w.id === state.ws ? ';border-color:var(--accent);color:var(--accent)' : '');
        b.title = w.root;
        b.onclick = () => { state.ws = w.id; state.path = ''; state.expanded.clear(); state.preview = null; state.page = 0; render(); };
        bar.appendChild(b);
      }
    }).catch(() => {});
    return bar;
  }
  function crumbEl() {
    const bar = el('div', 'fs-crumb');
    bar.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0 8px';
    const mk = (label, p) => {
      const b = el('button', 'chip fs-crumb-seg', label || '/');
      b.style.cssText = 'min-height:44px;min-width:44px;font-size:14px;cursor:pointer';
      b.onclick = () => { state.path = p; state.page = 0; render(); };
      return b;
    };
    bar.appendChild(mk('', ''));
    const parts = state.path ? state.path.split('/') : [];
    let acc = '';
    parts.forEach((seg, i) => {
      acc = acc ? acc + '/' + seg : seg;
      bar.appendChild(mk(seg, i === parts.length - 1 ? null : acc));
    });
    return bar;
  }

  function toolbarEl() {
    const bar = el('div', 'fs-toolbar');
    bar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px';
    const btn = (label, fn, cls) => { const b = el('button', cls || '', label); b.style.cssText = 'font-size:14px'; b.onclick = fn; return b; };
    bar.appendChild(btn('＋ File', () => createPrompt('file'), 'primary'));
    bar.appendChild(btn('＋ Dir', () => createPrompt('dir')));
    bar.appendChild(btn('🔍 Search', doSearch));
    return bar;
  }

  async function createPrompt(kind) {
    const name = prompt(kind === 'dir' ? 'New folder name:' : 'New file name:');
    if (!name) return;
    const p = state.path ? state.path + '/' + name : name;
    try {
      if (kind === 'dir') await mkdir(p); else await write(p, '');
      toast((kind === 'dir' ? 'Folder ' : 'File ') + 'created');
      render();
    } catch (e) { toast('create failed: ' + e.message); }
  }

  async function doSearch() {
    const s = prompt('Search filenames:');
    if (!s) return;
    try {
      const j = await search(s);
      state.search = { q: s, results: j.results };
      render();
    } catch (e) { toast('search failed: ' + e.message); }
  }

  function searchEl(container) {
    const s = state.search;
    const card = el('div', 'card fs-search');
    const head = el('div', '', `Search "${s.q}" — ${s.results.length} result(s)`);
    const close = el('button', '', '✕');
    close.style.cssText = 'min-width:44px;min-height:44px;font-size:14px';
    close.onclick = () => { state.search = null; render(); };
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px';
    head.appendChild(close);
    card.appendChild(head);
    const listWrap = el('div', 'fs-search-list');
    for (const r of s.results.slice(0, 100)) {
      const row = el('button', 'fs-search-hit');
      row.textContent = r || './';
      row.style.cssText = 'display:block;width:100%;text-align:left;font-size:14px;min-height:44px;margin:2px 0;font-family:var(--mono)';
      row.onclick = () => {
        if (!r) return;
        const i = r.lastIndexOf('/');
        state.path = i > 0 ? r.slice(0, i) : '';
        state.search = null;
        openFile(r);
      };
      listWrap.appendChild(row);
    }
    card.appendChild(listWrap);
    container.appendChild(card);
  }

  function rowEl(name, isDir, container) {
    const p = state.path ? state.path + '/' + name : name;
    const row = el('button', 'fs-row' + (isDir ? ' fs-dir' : ''));
    row.style.cssText = 'display:flex;width:100%;min-height:44px;align-items:center;gap:8px;text-align:left;font-size:14px;margin:2px 0;padding:8px 10px';
    const icon = el('span', isDir ? 'fs-ico-dir' : 'fs-ico-file', isDir ? '📁' : '📄');
    const label = el('span', 'fs-label', name);
    label.style.cssText = 'flex:1;overflow-wrap:anywhere;font-family:var(--mono);font-size:14px';
    row.appendChild(icon); row.appendChild(label);

    if (isDir) {
      if (state.expanded.get(p)) icon.textContent = '📂';
      row.onclick = async () => {
        const was = state.expanded.get(p);
        if (was) { state.expanded.delete(p); render(); return; }
        state.expanded.set(p, true);
        render();
      };
    } else {
      row.onclick = () => openFile(p);
    }

    // per-row actions: mention chip + delete (+ rename via move)
    const mention = el('button', 'fs-act', '@');
    mention.title = 'Insert [file: ' + p + '] chip';
    mention.style.cssText = 'min-width:44px;min-height:44px;font-size:16px;flex:none';
    mention.onclick = (e) => {
      e.stopPropagation();
      bus.emit('fm:mention', p);
      toast('chip inserted: ' + p);
    };
    row.appendChild(mention);

    const more = el('button', 'fs-act', '⋮');
    more.title = 'Actions: delete / rename';
    more.style.cssText = 'min-width:44px;min-height:44px;font-size:16px;flex:none';
    more.onclick = async (e) => {
      e.stopPropagation();
      const acts = [
        ['Delete', 'danger', 'delete'],
        ['Rename/Move', '', 'move'],
        ['Cancel', '', null],
      ];
      const v = await confirmSheet(name, isDir ? 'Directory actions' : 'File actions', acts);
      try {
        if (v === 'delete') {
          await del(p);
          toast('deleted: ' + name);
          state.expanded.delete(p);
          if (state.preview && state.preview.path === p) state.preview = null;
          render();
        } else if (v === 'move') {
          const to = prompt('Rename/move to (workspace-relative path):', p);
          if (to && to !== p) {
            await move(p, to);
            toast('moved');
            state.expanded.delete(p);
            state.expanded.set(to, state.expanded.get(to) === true);
            if (state.preview && state.preview.path === p) state.preview.path = to;
            render();
          }
        }
      } catch (err) { toast('action failed: ' + err.message); }
    };
    row.appendChild(more);
    container.appendChild(row);

    if (isDir && state.expanded.get(p)) {
      const kids = el('div', 'fs-kids');
      kids.style.cssText = 'margin-left:18px;border-left:2px solid var(--border);padding-left:6px';
      kids.dataset.lazyPath = p;
      container.appendChild(kids);
      list(p).then(j => {
        kids.innerHTML = '';
        const sub = { ...state, path: p };
        for (const d of j.dirs) kids.appendChild(rowFor(kids, d.name, true, sub));
        for (const f of j.files) kids.appendChild(rowFor(kids, f.name, false, sub));
        if (!j.dirs.length && !j.files.length) kids.appendChild(el('div', 'muted', '(empty)'));
      }).catch(e => { kids.innerHTML = ''; kids.appendChild(el('div', 'err', e.message)); });
    }
    return row;
  }

  // rowEl but for nested lazy containers: state.path override per subdir
  function rowFor(container, name, isDir, sub) {
    const p = sub.path ? sub.path + '/' + name : name;
    const row = el('button', 'fs-row' + (isDir ? ' fs-dir' : ''));
    row.style.cssText = 'display:flex;width:100%;min-height:44px;align-items:center;gap:8px;text-align:left;font-size:14px;margin:2px 0;padding:8px 10px';
    const icon = el('span', isDir ? 'fs-ico-dir' : 'fs-ico-file', isDir ? '📁' : '📄');
    const label = el('span', 'fs-label', name);
    label.style.cssText = 'flex:1;overflow-wrap:anywhere;font-family:var(--mono);font-size:14px';
    row.appendChild(icon); row.appendChild(label);
    if (isDir) {
      if (state.expanded.get(p)) icon.textContent = '📂';
      row.onclick = () => {
        if (state.expanded.get(p)) state.expanded.delete(p); else state.expanded.set(p, true);
        render();
      };
    } else row.onclick = () => openFile(p);
    const mention = el('button', 'fs-act', '@');
    mention.style.cssText = 'min-width:44px;min-height:44px;font-size:16px;flex:none';
    mention.onclick = (e) => { e.stopPropagation(); bus.emit('fm:mention', p); toast('chip inserted: ' + p); };
    row.appendChild(mention);
    const more = el('button', 'fs-act', '⋮');
    more.style.cssText = 'min-width:44px;min-height:44px;font-size:16px;flex:none';
    more.onclick = async (e) => {
      e.stopPropagation();
      const v = await confirmSheet(name, isDir ? 'Directory actions' : 'File actions', [
        ['Delete', 'danger', 'delete'], ['Rename/Move', '', 'move'], ['Cancel', '', null]]);
      try {
        if (v === 'delete') {
          await del(p); toast('deleted: ' + name); state.expanded.delete(p);
          if (state.preview && state.preview.path === p) state.preview = null;
          render();
        } else if (v === 'move') {
          const to = prompt('Rename/move to:', p);
          if (to && to !== p) {
            await move(p, to); toast('moved'); state.expanded.delete(p);
            if (state.preview && state.preview.path === p) state.preview.path = to;
            render();
          }
        }
      } catch (err) { toast('action failed: ' + err.message); }
    };
    row.appendChild(more);
    container.appendChild(row);
    if (isDir && state.expanded.get(p)) {
      const kids = el('div', 'fs-kids');
      kids.style.cssText = 'margin-left:18px;border-left:2px solid var(--border);padding-left:6px';
      container.appendChild(kids);
      list(p).then(j => {
        kids.innerHTML = '';
        const sub2 = { path: p };
        for (const d of j.dirs) kids.appendChild(rowFor(kids, d.name, true, sub2));
        for (const f of j.files) kids.appendChild(rowFor(kids, f.name, false, sub2));
        if (!j.dirs.length && !j.files.length) kids.appendChild(el('div', 'muted', '(empty)'));
      }).catch(e => { kids.innerHTML = ''; kids.appendChild(el('div', 'err', e.message)); });
    }
    return row;
  }

  function previewEl(container) {
    const pv = state.preview;
    if (!pv) return;
    const card = el('div', 'card fs-preview');
    const head = el('div', 'fs-preview-head');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px';
    const title = el('span', '', pv.path || 'preview');
    title.style.cssText = 'font-family:var(--mono);font-size:14px;overflow-wrap:anywhere;flex:1';
    const close = el('button', '', '✕');
    close.style.cssText = 'min-width:44px;min-height:44px;font-size:14px;flex:none';
    close.onclick = () => { state.preview = null; render(); };
    const edit = el('button', 'primary', pv.editing ? 'Cancel' : 'Edit');
    edit.style.cssText = 'font-size:14px;flex:none';
    edit.onclick = () => { state.preview.editing = !state.preview.editing; render(); };
    head.appendChild(title); head.appendChild(edit); head.appendChild(close);
    card.appendChild(head);

    // meta line (muted size/truncation notice — never wired into the append flow)
    const sizeLabel = pv.binary ? 'binary — preview unavailable' : `${pv.size} bytes${pv.truncated ? ' (truncated at 1MB)' : ''}`;
    const meta = el('div', 'muted', sizeLabel);
    meta.style.cssText = 'font-size:12px;margin-bottom:4px';
    card.appendChild(meta);

    if (pv.binary) { container.appendChild(card); return; }

    if (pv.editing) {
      const ta = el('textarea', 'fs-editor');
      ta.value = pv.content || '';
      ta.style.cssText = 'width:100%;min-height:45vh;font-family:var(--mono);font-size:14px;line-height:1.5;resize:vertical';
      ta.oninput = () => { pv.dirty = ta.value !== pv.orig; };
      card.appendChild(ta);
      const save = el('button', 'primary', 'Save');
      save.style.cssText = 'margin-top:8px;font-size:14px';
      save.onclick = async () => {
        try {
          const j = await write(pv.path, ta.value);
          toast(`saved ${j.size} bytes`);
          pv.content = ta.value; pv.orig = ta.value; pv.size = j.size; pv.editing = false; pv.dirty = false;
          render();
        } catch (e) { toast('save failed: ' + e.message); }
      };
      const wrap = el('div'); wrap.style.cssText = 'display:flex;gap:8px;margin-top:8px';
      wrap.appendChild(save);
      if (pv.dirty) wrap.appendChild(el('span', 'muted', 'unsaved changes'));
      card.appendChild(wrap);
    } else {
      const linesEl = el('pre', 'fs-code');
      linesEl.style.cssText = 'max-height:55vh;overflow:auto;margin:0;font-size:12px;line-height:1.5';
      const lines = (pv.content || '').split('\n');
      const g = document.createElement('div');
      g.style.cssText = 'display:flex';
      const gutter = el('div', 'fs-gutter');
      gutter.style.cssText = 'flex:none;text-align:right;color:var(--muted);user-select:none';
      const code = el('code', 'fs-code-body');
      const frag = document.createDocumentFragment();
      lines.forEach((ln, i) => {
        const r = document.createElement('div');
        r.style.cssText = 'display:flex';
        const gn = document.createElement('span');
        gn.textContent = i + 1;
        gn.style.cssText = 'display:inline-block;min-width:44px;padding-right:10px;color:var(--muted)';
        const cn = document.createElement('span');
        cn.textContent = ln.length ? ln : ' ';
        cn.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;flex:1';
        r.appendChild(gn); r.appendChild(cn);
        frag.appendChild(r);
      });
      code.appendChild(frag);
      g.appendChild(code);
      if (pv.truncated) g.appendChild(el('div', 'muted', '⚠ truncated at 1MB'));
      linesEl.appendChild(g);
      card.appendChild(linesEl);
    }
    container.appendChild(card);
  }

  async function openFile(p) {
    try {
      const j = await read(p);
      state.preview = { path: p, content: j.content, orig: j.content, size: j.size, truncated: j.truncated, binary: j.binary, editing: false, dirty: false };
      render();
    } catch (e) { toast('read failed: ' + e.message); }
  }

  async function render() {
    const root = document.getElementById('app');
    if (!root) return;
    root.innerHTML = '';
    root.appendChild(wsBarEl());
    root.appendChild(crumbEl());
    root.appendChild(toolbarEl());
    if (state.search) searchEl(root);
    previewEl(root);
    const listCard = el('div', 'card fs-list');
    listCard.style.cssText = 'padding:8px';
    const lw = el('div', 'muted'); lw.textContent = 'loading…';
    listCard.appendChild(lw);
    root.appendChild(listCard);
    try {
      const j = await list(state.path);
      listCard.innerHTML = '';
      // page to what fits, then size the scroll region ONCE rows are in the DOM —
      // clamping before rows exist freezes the box at its 180px floor (the
      // 'files tab feels broken / tiny' bug).
      const fit = fitPage(listCard, j).capacity;
      const cap = Math.max(fit, 8); // never shrink below 8 rows just because the box started small
      for (const d of j.dirs.slice(0, cap)) rowFor(listCard, d.name, true, { path: j.path || state.path });
      for (const f of j.files.slice(0, Math.max(0, cap - j.dirs.length))) rowFor(listCard, f.name, false, { path: j.path || state.path });
      if (!j.dirs.length && !j.files.length) listCard.appendChild(el('div', 'muted', '(empty directory)'));
      if (j.dirs.length + j.files.length > cap) listCard.appendChild(pagerEl(listCard, j.dirs, j.files, cap));
      clampList(listCard);
    } catch (e) {
      listCard.innerHTML = '';
      listCard.appendChild(el('div', 'err', 'load failed: ' + e.message));
    }
  }

  // pager: list is capped at a FIT count — rows are re-paged after the scroll
  // region is sized so nothing extends past it into the fixed bottom nav
  // (S24 layout check: clipped-but-not-scrolled rows still report viewport rects).
  function fitPage(listCard, j) {
    const navTop = document.querySelector('.bottom-nav')?.getBoundingClientRect().top || window.innerHeight - 56;
    const h = Math.max(180, window.innerHeight - navTop - listCard.getBoundingClientRect().top - 8);
    const rowH = 50; // 44px row + margin
    const max = Math.max(1, Math.floor((h - 16) / rowH));
    return { dirs: j.dirs, files: j.files, capacity: max };
  }
  function pagerEl(listCard, dirs, files, cap) {
    const combined = [...dirs, ...files];
    const total = combined.length;
    const row = el('div', 'fs-pager');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:center;margin-top:8px';
    const shown = Math.min(cap, total);
    const label = el('span', 'muted', `1-${shown} of ${total}`);
    label.style.cssText = 'font-size:12px';
    const next = el('button', '', '→');
    next.style.cssText = 'min-width:44px;min-height:44px;font-size:16px';
    next.onclick = () => {
      const start = cap; // page 2+: all entries starting there
      listCard.innerHTML = '';
      for (const e of combined.slice(start)) {
        const isDir = dirs.includes(e);
        rowFor(listCard, e, isDir, { path: state.path });
      }
      const back = el('button', '', '←');
      back.style.cssText = 'min-width:44px;min-height:44px;font-size:16px';
      back.onclick = () => render();
      const row2 = el('div', 'fs-pager');
      row2.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:center;margin-top:8px';
      row2.appendChild(back);
      const l2 = el('span', 'muted', `${start + 1}-${total} of ${total}`);
      l2.style.cssText = 'font-size:12px';
      row2.appendChild(l2);
      listCard.appendChild(row2);
      clampList(listCard);
    };
    row.appendChild(label); row.appendChild(next);
    return row;
  }

  // keep the list inside its own scroll region that ends above the fixed bottom
  // nav, so list rows never render underneath the nav (S24 touch-target check).
  function clampList(listCard) {
    requestAnimationFrame(() => {
      // the tab pane itself scrolls now (#app>div) — measure the card's position
      // INSIDE the scroll content (rect.top depends on scroll position, not layout)
      const pane = document.querySelector('#app > div');
      const paneTop = pane ? pane.getBoundingClientRect().top : 0;
      const top = listCard.getBoundingClientRect().top;
      const h = Math.max(300, window.innerHeight - paneTop - top - 8); // visible space from card top to pane bottom
      listCard.style.maxHeight = Math.max(300, h) + 'px';
      listCard.style.overflowY = 'auto';
      listCard.style.paddingBottom = '12px';
      if (top > window.innerHeight) { // card fully below the fold (user scrolled/clamped already?) — just size it generously
        listCard.style.maxHeight = '70vh';
      }
    });
  }

  // keep expanded dirs across re-renders; clear when switching workspaces
  bus.on('workspace:changed', ws => { state.ws = ws; state.expanded.clear(); state.path = ''; state.preview = null; render(); });

  // @-mention insert: [file: path] chip. Chat owns #composer; if we're on the files
  // tab (composer not in DOM), stash the pending path — chat picks it up on tab return
  // via 'module:loaded files' refire. No composer writes from outside chat.js.
  let pendingMention = null;
  bus.on('fm:mention', p => {
    const composer = document.getElementById('composer');
    if (composer) {
      composer.value = (composer.value ? composer.value.replace(/\s*$/, '') + ' ' : '') + `[file: ${p}]`;
      composer.focus();
    } else {
      pendingMention = p;
    }
  });
  // when chat remounts (tab switch), flush a pending mention into its fresh composer
  document.addEventListener('click', () => {
    if (pendingMention) {
      const composer = document.getElementById('composer');
      if (composer) {
        composer.value = (composer.value ? composer.value.replace(/\s*$/, '') + ' ' : '') + `[file: ${pendingMention}]`;
        pendingMention = null;
      }
    }
  });

  return { render, openFile, state };
})();
