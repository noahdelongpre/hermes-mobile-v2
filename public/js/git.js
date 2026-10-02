'use strict';
// git.js — workstream D: Git tab. Status list w/ stage checkboxes, diff viewer
// (reuses DiffView from diffview.js), log cards, commit box, branch dropdown.
// Backend: server/modules/git_routes.js. Vanilla JS only.
window.MODULES = window.MODULES || {};
MODULES.git = (() => {
  const s = { ws: localStorage.getItem('hm2.gitws') || '', status: null, log: [], branch: null, diff: null, sel: new Set(), err: null };

  // ---- API ----
  const qw = () => `ws=${encodeURIComponent(s.ws)}`;
  async function refresh() {
    s.err = null;
    if (!s.ws) {
      try {
        const j = await API.json('/api/fs/workspaces');
        let first = null;
        for (const w of (j.workspaces || [])) {
          try { await API.json(`/api/git/status?ws=${encodeURIComponent(w.id)}`); first = w; break; }
          catch (e) { if (!first) first = first; }
        }
        const gitws = first;
        s.ws = gitws ? gitws.id : 'default';
      } catch {}
    }
    let status, log, branch;
    try {
      [status, log, branch] = await Promise.all([
        API.json(`/api/git/status?${qw()}`),
        API.json(`/api/git/log?${qw()}&n=20`),
        API.json(`/api/git/branch?${qw()}`),
      ]);
      localStorage.setItem('hm2.gitws', s.ws);
    } catch (e) {
      s.err = e.message || 'git unavailable';
      return;
    }
    s.status = status; s.log = log; s.branch = branch;
    // prune selection to files that still exist in status
    const have = new Set(status.files.map(f => f.file));
    for (const f of [...s.sel]) if (!have.has(f)) s.sel.delete(f);
  }
  async function openDiff(file, staged) {
    const q = `${qw()}${file ? '&path=' + encodeURIComponent(file) : ''}${staged ? '&staged=1' : ''}`;
    s.diff = await API.json(`/api/git/diff?${q}`);
    s.diff.forFile = file || '(unstaged, all files)';
  }
  async function stage(files, unstage) { return API.post('/api/git/stage', { ws: s.ws, files, unstage: !!unstage }); }
  async function commit(msg, files) { return API.post('/api/git/commit', { ws: s.ws, message: msg, files: files && files.length ? files : undefined }); }
  async function switchBranch(name) { return API.post('/api/git/branch', { ws: s.ws, branch: name }); }

  // ---- helpers ----
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  async function refreshAndRender(root) {
    try { await refresh(); }
    catch (e) { renderError(root, e); return; }
    render(root);
  }

  function renderError(root, e) {
    root.innerHTML = '';
    root.appendChild(el('div', 'card err', `Git error: ${e.message || e}`));
    const b = el('button', '', 'Retry'); b.onclick = () => refreshAndRender(root);
    root.appendChild(b);
  }

  // ---- renderers ----
  function fileRow(f) {
    const row = el('div', 'git-file-row');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;min-height:44px;border-bottom:1px solid var(--border);font-size:13px';
    const stagedChange = f.staged && f.staged !== 'untracked';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = s.sel.has(f.file);
    cb.style.cssText = 'width:22px;height:22px;min-height:0;accent-color:var(--accent);flex:none;padding:0';
    cb.setAttribute('aria-label', `stage ${f.file}`);
    cb.onchange = () => { if (cb.checked) s.sel.add(f.file); else s.sel.delete(f.file); };
    row.appendChild(cb);
    const name = el('span', 'git-file', f.file);
    name.style.cssText = 'flex:1;font-family:var(--mono);font-size:12px;overflow-wrap:anywhere;cursor:pointer';
    name.onclick = () => openDiff(f.file, stagedChange).then(() => render(name.closest('#app') || document.body));
    row.appendChild(name);
    const chip = el('span', 'chip', f.unstaged || f.staged || '');
    if (f.unstaged === 'untracked') chip.style.color = 'var(--accent)';
    if (f.unstaged === 'modified') chip.style.color = 'var(--muted)';
    row.appendChild(chip);
    return row;
  }

  function statusCard(root) {
    const card = el('div', 'card');
    const st = s.status;
    const head = el('div'); head.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px';
    head.appendChild(el('b', '', `Branch: ${st.branch} ${st.ahead || st.behind ? `↑${st.ahead} ↓${st.behind}` : ''}`));
    const rbtn = el('button', '', '↻'); rbtn.title = 'refresh';
    rbtn.onclick = () => refreshAndRender(root);
    head.appendChild(rbtn);
    card.appendChild(head);

    if (!st.files.length) {
      const c = el('div', 'muted', 'Working tree clean — nothing to commit.');
      c.style.padding = '12px 0'; card.appendChild(c);
      return card;
    }
    // selection toolbar
    const bar = el('div'); bar.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px';
    const all = st.files.map(f => f.file);
    const bAll = el('button', '', all.length && all.every(f => s.sel.has(f)) ? 'Deselect all' : 'Select all');
    bAll.onclick = () => {
      const none = all.some(f => !s.sel.has(f));
      if (none) all.forEach(f => s.sel.add(f)); else s.sel.clear();
      render(root);
    };
    const nSel = all.filter(f => s.sel.has(f)).length;
    const bStage = el('button', 'primary', `Stage (${nSel})`);
    bStage.disabled = !nSel;
    if (!nSel) bStage.style.opacity = '.5';
    bStage.onclick = async () => {
      try { await stage([...s.sel]); s.sel.clear(); toast('staged'); await refreshAndRender(root); }
      catch (e) { toast('stage failed: ' + e.message); }
    };
    const bUnstage = el('button', '', `Unstage (${nSel})`);
    bUnstage.disabled = !nSel;
    if (!nSel) bUnstage.style.opacity = '.5';
    bUnstage.onclick = async () => {
      try { await stage([...s.sel], true); s.sel.clear(); toast('unstaged'); await refreshAndRender(root); }
      catch (e) { toast('unstage failed: ' + e.message); }
    };
    bar.appendChild(bAll); bar.appendChild(bStage); bar.appendChild(bUnstage);
    card.appendChild(bar);
    const list = el('div', 'git-files');
    for (const f of st.files) list.appendChild(fileRow(f));
    card.appendChild(list);
    return card;
  }

  function diffCard(root) {
    if (!s.diff) return null;
    const card = el('div', 'card');
    const head = el('div'); head.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap';
    head.appendChild(el('div', 'muted', `Diff: ${s.diff.forFile}${s.diff.staged ? ' (staged)' : ''}`));
    const x = el('button', '', '×');
    x.title = 'close diff'; x.onclick = () => { s.diff = null; render(root); };
    head.appendChild(x);
    card.appendChild(head);
    if (!s.diff.diff) {
      card.appendChild(el('div', 'muted', '(no diff — file unchanged or newly staged)'));
      return card;
    }
    const wrap = document.createElement('div');
    // innerHTML here is safe: DiffView.diffHTML escape()s every line it emits
    // (diffview.js esc) — no raw repo text reaches markup unescaped.
    wrap.innerHTML = DiffView.diffHTML(s.diff.diff.replace(/^\n+|\n+$/g, ''), {});
    DiffView.enhanceDiff(wrap);
    card.appendChild(wrap);
    return card;
  }

  function commitCard(root) {
    const card = el('div', 'card');
    card.appendChild(el('b', '', 'Commit'));
    const sel = [...s.sel];
    if (sel.length) card.appendChild(el('div', 'muted', `Will commit selected staged changes (${sel.length} file${sel.length > 1 ? 's' : ''} will be re-staged)`));
    const ta = document.createElement('textarea');
    ta.placeholder = 'Commit message…'; ta.rows = 2;
    ta.style.cssText = 'width:100%;margin:8px 0';
    const b = el('button', 'primary', 'Commit');
    b.onclick = async () => {
      const msg = ta.value.trim();
      if (!msg) return toast('enter a commit message');
      try {
        const r = await commit(msg, sel);
        s.sel.clear(); ta.value = ''; toast(`committed ${r.commit}`);
        await refreshAndRender(root);
      } catch (e) { toast('commit failed: ' + e.message); }
    };
    card.appendChild(ta); card.appendChild(b);
    return card;
  }

  function logCard(root) {
    if (!s.log.commits || !s.log.commits.length) return null;
    const card = el('div', 'card');
    card.appendChild(el('b', '', `Recent commits (${s.log.commits.length})`));
    for (const c of s.log.commits) {
      const row = el('div', 'card'); row.style.cssText = 'margin:6px 0;padding:8px 10px;background:var(--card2)';
      const top = el('div'); top.style.cssText = 'display:flex;gap:8px;align-items:baseline;justify-content:space-between;flex-wrap:wrap';
      top.appendChild(el('span', '', c.subject));
      const sha = el('span', 'chip', c.short); sha.style.fontFamily = 'var(--mono)';
      top.appendChild(sha);
      row.appendChild(top);
      const who = el('div', 'muted', `${c.author} · ${new Date(c.ts * 1000).toLocaleString()}`);
      who.style.fontSize = '12px'; row.appendChild(who);
      card.appendChild(row);
    }
    return card;
  }

  function branchCard(root) {
    const card = el('div', 'card');
    card.appendChild(el('b', '', 'Branches'));
    const sel = document.createElement('select');
    sel.style.cssText = 'width:100%;margin:8px 0';
    for (const b of s.branch.branches) {
      const o = document.createElement('option'); o.value = o.textContent = b;
      if (b === s.branch.current) o.selected = true;
      sel.appendChild(o);
    }
    const b = el('button', '', 'Switch');
    b.onclick = async () => {
      try { await switchBranch(sel.value); toast('now on ' + sel.value); await refreshAndRender(root); }
      catch (e) { toast('switch failed: ' + e.message); }
    };
    card.appendChild(sel); card.appendChild(b);
    return card;
  }

  function render(root) {
    root.innerHTML = '';
    if (s.status && !s.status.files.length && !s.log.commits.length) {
      /* clean tree still shows all cards */
    }
    const head = el('div'); head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap';
    head.appendChild(el('h2', '', 'Git')); head.querySelector('h2').style.cssText = 'margin:0;font-size:18px';
    if (s.ws) { const wchip = el('span', 'chip', '@ ' + s.ws); wchip.style.cssText = 'font-size:11px'; head.appendChild(wchip); }
    root.appendChild(head);

    if (s.err) {
      const ec = el('div', 'card');
      const msg = el('div', 'err', s.err);
      msg.style.marginBottom = '8px';
      ec.appendChild(msg);
      const hint = el('div', 'muted', 'Not a git repository in this workspace — pick one below.');
      hint.style.cssText = 'font-size:12px;margin-bottom:8px';
      ec.appendChild(hint);
      const bar = el('div'); bar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
      API.json('/api/fs/workspaces').then(j => {
        for (const w of (j.workspaces || [])) {
          const b = el('button', 'chip', w.id);
          b.style.cssText = 'min-height:40px;font-size:12px;padding:2px 10px';
          b.title = w.root;
          b.onclick = () => { s.ws = w.id; localStorage.setItem('hm2.gitws', w.id); refreshAndRender(); };
          bar.appendChild(b);
        }
      }).catch(() => {});
      ec.appendChild(bar);
      root.appendChild(ec);
      await_placeholder(root); return;
    }
    if (!s.status) { await_placeholder(root); return; } // refreshAndRender re-renders
    root.appendChild(statusCard(root));
    const d = diffCard(root); if (d) root.appendChild(d);
    root.appendChild(commitCard(root));
    if (s.branch && s.branch.branches.length) root.appendChild(branchCard(root));
    const lg = logCard(root); if (lg) root.appendChild(lg);
  }

  function await_placeholder(root) {
    const p = el('div', 'card muted', 'Loading git…');
    root.appendChild(p);
    refreshAndRender(root);
  }

  return {
    render(el) {
      s.sel.clear();
      render(el);
    },
  };
})();
