'use strict';
/* sessions.js — Workstream B owner: real Hermes sessions as the chat spine.
 * Layer on Chat tab: "Sessions" button in the composer row opens a sheet with
 * the live session list (GET /api/session/list). Each row: title/preview,
 * message count, last-active. Actions per session: open (resume), rename,
 * archive (PATCH), delete, fork. /new creates a REAL upstream session
 * (POST /api/session) and switches chat to it; all sends then carry
 * session_id (POST /api/run/create {input, session_id}) so history persists.
 * Resuming a session loads its transcript from GET /api/session/:id/messages.
 * Persisted current session id in localStorage 'hm2.session'.
 * Contracts consumed: none required. Contracts emitted:
 *   bus 'session:switch' {conversation, session_id}  (chat.js spine, slash.js model key)
 *   bus 'session:history' {items}                    (chat.js renders saved history)
 *   bus 'session:new' handled here now (slash /new flows through)
 */
window.MODULES = window.MODULES || {};
MODULES.sessions = (() => {
  let sheet = null, rows = [];

  const cur = () => localStorage.getItem('hm2.session') || null;

  function setSession(id, title) {
    try { id ? localStorage.setItem('hm2.session', id) : localStorage.removeItem('hm2.session');
      if (title) localStorage.setItem('hm2.session.title.' + id, title);
    } catch {}
    bus.emit('session:switch', { conversation: id, session_id: id });
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const s = Date.now() / 1000 - ts;
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  async function resume(id) {
    closeSheet();
    if (!id) return;
    toast('loading session…');
    try {
      const j = await API.json(`/api/session/${encodeURIComponent(id)}/messages`);
      const items = (j.data || []).map(m => {
        if (m.role === 'tool' || m.role === 'tool_call') return { _tool: true, name: m.tool_name || 'tool', output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') };
        const text = typeof m.content === 'string' ? m.content : (m.content == null ? '' : JSON.stringify(m.content));
        if (!text.trim()) return null;
        return { role: m.role === 'assistant' ? 'assistant' : 'user', text };
      }).filter(Boolean);
      setSession(id);
      bus.emit('session:history', { items });
      setChatTitle(id, localStorage.getItem('hm2.session.title.' + id));
    } catch (e) { toast('resume failed: ' + e.message); }
  }

  function setChatTitle(id, title) { // DOM-touching helper kept free of innerHTML-by-string
    const tl = document.getElementById('chat-title'); if (tl && title) tl.textContent = title;
  }

  async function newSession() {
    try {
      const j = await API.json('/api/session', { method: 'POST', body: {} });
      const id = j.session && j.session.id;
      if (!id) throw new Error('no id returned');
      setSession(id);
      closeSheet(); toast('new session');
      bus.emit('session:history', { items: [] }); // resets timeline
    } catch (e) { toast('new session failed: ' + e.message); }
  }

  // -------------------------------------------------------------- actions
  async function rename(r) {
    const p = prompt('rename session', r.title || ''); if (p == null) return;
    try { await API.json(`/api/session/${encodeURIComponent(r.id)}`, { method: 'PATCH', body: { title: p } });
      toast('renamed'); openList(true);
    } catch (e) { toast('rename failed: ' + e.message); }
  }
  async function archive(r) {
    try { await API.json(`/api/session/${encodeURIComponent(r.id)}`, { method: 'PATCH', body: { archived: !r.archived } });
      toast(r.archived ? 'unarchived' : 'archived'); openList(true);
    } catch (e) { toast('archive failed: ' + e.message); }
  }
  async function del(r) {
    const yes = await confirmSheet('delete session?', '“' + (r.title || r.id) + '” and its history will be removed.',
      [{ label: 'cancel', value: false }, { label: 'delete', value: true, cls: 'danger' }]);
    if (!yes) return;
    try { await API.json(`/api/session/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
      if (cur() === r.id) { localStorage.removeItem('hm2.session'); bus.emit('session:switch', { conversation: null, session_id: null }); }
      toast('deleted'); openList(true);
    } catch (e) { toast('delete failed: ' + e.message); }
  }
  async function fork(r) {
    try {
      const j = await API.json(`/api/session/${encodeURIComponent(r.id)}/fork`, { method: 'POST', body: {} });
      const id = j.session && j.session.id; if (!id) throw new Error('no id');
      toast('forked'); setSession(id); openList(true);
      await resume(id);
    } catch (e) { toast('fork failed: ' + e.message); }
  }

  // --------------------------------------------------------------- list UI
  async function openList(force) {
    if (sheet && !force) return;
    closeSheet();
    sheet = document.createElement('div');
    sheet.className = 'sheet open sessions-sheet';
    sheet.style.cssText = 'max-height:78vh;z-index:70;padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px))';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px';
    const h3 = document.createElement('h3'); h3.style.cssText = 'margin:0'; h3.textContent = 'Sessions';
    const newBtn = document.createElement('button'); newBtn.className = 'btn primary'; newBtn.textContent = '+ new';
    newBtn.style.cssText = 'min-height:44px;padding:0 14px';
    newBtn.onclick = newSession;
    head.append(h3, newBtn);
    sheet.appendChild(head);
    const list = document.createElement('div'); list.className = 'sessions-list';
    sheet.appendChild(list);
    const x = document.createElement('button'); x.type = 'button'; x.className = 'btn sessions-close';
    x.textContent = '✕ close'; x.style.cssText = 'width:100%;margin-top:8px;min-height:44px'; x.onclick = closeSheet;
    sheet.appendChild(x);
    sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });
    document.body.appendChild(sheet);
    // rows
    {
      const ld = document.createElement('div'); ld.className = 'muted';
      ld.style.padding = '10px 2px'; ld.textContent = 'loading…'; list.appendChild(ld);
    }
    try {
      const j = await API.json('/api/session/list?limit=50');
      rows = j.sessions || [];
    } catch (e) { list.textContent = ''; const d = document.createElement('div'); d.className = 'muted'; d.textContent = 'list failed: ' + e.message; list.appendChild(d); return; }
    try { for (const r of rows) if (r.title) localStorage.setItem('hm2.session.title.' + r.id, r.title); } catch {}
    list.textContent = '';
    if (!rows.length) { const d = document.createElement('div'); d.className = 'muted'; d.textContent = 'no sessions yet'; list.appendChild(d); }
    for (const r of rows) {
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'btn sessions-item' + (r.id === cur() ? ' active' : '');
      row.style.cssText = 'display:block;width:100%;text-align:left;margin:3px 0;min-height:48px;padding:8px 12px';
      const t = document.createElement('div');
      t.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600';
      t.textContent = (r.pinned ? '📌 ' : '') + (r.title || '(untitled)') + (r.id === cur() ? '  ← current' : '');
      const meta = document.createElement('div'); meta.className = 'muted';
      meta.style.cssText = 'font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      meta.textContent = `${r.message_count || 0} msgs · ${timeAgo(r.last_active)}${r.model ? ' · ' + r.model : ''}`;
      row.append(t, meta);
      row.onclick = () => resume(r.id);
      row.oncontextmenu = e => { e.preventDefault(); rowMenu(r); };
      // long-press = menu (mobile)
      let lp = null;
      row.addEventListener('touchstart', () => { lp = setTimeout(() => { lp = null; rowMenu(r); }, 550); }, { passive: true });
      row.addEventListener('touchend', () => { if (lp) { clearTimeout(lp); lp = null; } });
      row.addEventListener('touchmove', () => { if (lp) { clearTimeout(lp); lp = null; } }, { passive: true });
      list.appendChild(row);
    }
  }

  function rowMenu(r) {
    const m = document.createElement('div');
    m.className = 'sheet open';
    m.style.cssText = 'z-index:80;padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px))';
    const mk = (label, fn) => { const b = document.createElement('button'); b.className = 'btn'; b.textContent = label; b.style.cssText = 'display:block;width:100%;min-height:44px;text-align:left;margin:3px 0'; b.onclick = () => { m.remove(); fn(); }; m.appendChild(b); };
    mk('✏️ rename', () => rename(r));
    mk('⑂ fork to new session', () => fork(r));
    mk(r.archived ? '📥 unarchive' : '📤 archive', () => archive(r));
    mk('🗑 delete', () => del(r));
    const c = document.createElement('button'); c.className = 'btn'; c.textContent = '✕ close'; c.style.cssText = 'display:block;width:100%;min-height:44px;margin-top:6px'; c.onclick = () => m.remove();
    m.appendChild(c);
    document.body.appendChild(m);
  }

  function closeSheet() {
    document.querySelectorAll('.sessions-sheet').forEach(s => s.remove());
    if (sheet) { sheet = null; }
  }

  // composer button: "≡" sessions
  let mountTries = 0;
  function mount() {
    const c = document.querySelector('.composer');
    if (!c) { if (++mountTries < 40) setTimeout(mount, 250); return; }
    if (c.querySelector('.sessions-btn')) return;
    // header-defined ≡ button (chat-head #sessions-open) is our primary trigger;
    // mark composer presence for tests and fall back to injecting if header wasn't rendered.
    let b = document.getElementById('sessions-open');
    if (!b) {
      b = document.createElement('button');
      b.textContent = '≡'; b.title = 'sessions'; b.className = 'btn sessions-btn';
      b.style.cssText = 'min-width:44px;min-height:44px;font-size:18px;padding:0 10px';
      const first = c.firstElementChild;
      c.insertBefore(b, first);
    }
    b.classList.add('sessions-btn');
    b.onclick = () => openList();
    const rb = document.getElementById('session-rename');
    if (rb && !rb.dataset.wired) { rb.dataset.wired = '1'; rb.onclick = () => { const id = cur(); const rowsById = rows.find(r => r.id === id) || {}; if (id) rename({ id, title: rowsById.title || localStorage.getItem('hm2.session.title.' + id) }); }; }
  }

  // boot: remember last session across reloads
  bus.on('module:loaded', n => { if (n === 'chat') setTimeout(mount, 60); });
  bus.on('tab:switch', n => { if (n === 'chat') { mountTries = 0; mount(); } });
  // slash /new flows here: create a real session and switch to it
  bus.on('session:new', () => { newSession(); });
  // chat header ≡ opens the sessions sheet
  bus.on('sessions:open', () => openList());
  // restore: emit the persisted session id once boot finished, so slash.js '/model' keys line up
  setTimeout(() => { const id = cur(); if (id) bus.emit('session:switch', { conversation: id, session_id: id }); }, 100);

  return {
    render(el) { el.innerHTML = ''; },
    _test: { setSession, cur, timeAgo, closeSheet, openList },
  };
})();
