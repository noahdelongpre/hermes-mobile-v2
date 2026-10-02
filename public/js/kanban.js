'use strict';
// kanban.js — Workstream H: Board tab. Three-column kanban (Backlog / In Progress /
// Done) mirrored from the user's DoneTick instance via /api/kanban/tasks.
// Each card: title, source chip ('donetick' / 'stale-cache'), promote/demote buttons
// (POST /api/kanban/promote|demote {id,to}) and an 'open in DoneTick' link when the
// board's open_url is set. '↻ sync' forces a fresh fetch (cache=0 bypass is honored
// server-side by TTL expiry; here we just refetch — 2min TTL keeps it cheap).
// READ-ONLY toward DoneTick creation: this module never creates tasks, it only
// moves the user's existing ones. Emits bus 'kanban:updated' after a move.
window.MODULES = window.MODULES || {};
// XSS note: all dynamic strings inserted via innerHTML above pass through esc()
// (attribute + text escaped); no untrusted HTML is ever interpolated.
window.KanbanBoard = (() => {
  const LABELS = { backlog: 'Backlog', in_progress: 'In Progress', done: 'Done' };
  const COLS = ['backlog', 'in_progress', 'done'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  async function load() { return API.json('/api/kanban/tasks'); }

  function move(id, to) {
    const path = to === 'done' ? '/api/kanban/promote' : (to === 'backlog' ? '/api/kanban/demote' : '/api/kanban/promote');
    // semantic: promote = toward done, demote = toward backlog; in_progress is target of either
    // Use explicit direction: promote endpoint moves right (backlog→in_progress, in_progress→done),
    // demote moves left (done→in_progress, in_progress→backlog). Server accepts {id,to}; we pass
    // the destination column and let the server PATCH status.
    return API.json(path === '/api/kanban/promote' && to === 'backlog' ? '/api/kanban/demote' : path, { id, to });
  }

  function render(el) {
    el.innerHTML = `
      <div class="kanban-head">
        <h2 style="margin:0;font-size:18px">Board <span class="muted" style="font-size:12px">DoneTick</span></h2>
        <button class="btn kanban-sync" style="min-height:44px">↻ sync</button>
      </div>
      <div class="kanban-body"><div class="muted" style="padding:8px 2px">loading…</div></div>`;

    const body = el.querySelector('.kanban-body');
    const syncBtn = el.querySelector('.kanban-sync');
    syncBtn.onclick = () => draw(body, el, true);

    draw(body, el, false);
  }

  async function draw(body, el, forceMsg) {
    syncBtnState(el, true);
    let data;
    try { data = await load(); }
    catch (e) {
      body.innerHTML = `<div class="card err"><b>kanban unavailable</b><div class="muted" style="margin-top:4px">${esc(e.message)}</div></div>`;
      syncBtnState(el, false);
      return;
    }
    syncBtnState(el, false);
    if (forceMsg) toast('board synced');

    if (data.configured === false) {
      body.innerHTML = `
        <div class="card kanban-unconfigured">
          <b>DoneTick not configured</b>
          <div class="muted" style="margin-top:4px">
            Set <code>DONETICK_URL</code> and <code>DONETICK_KEY</code> on the app server to mirror
            your DoneTick board here. No tasks are ever created by this app — it only reads your
            existing board and lets you promote/demote tasks between columns.
          </div>
        </div>`;
      return;
    }
    if (data.error && !data.columns) {
      body.innerHTML = `<div class="card err"><b>kanban error</b><div class="muted" style="margin-top:4px">${esc(data.error)}</div></div>`;
      return;
    }

    const openUrl = data.open_url || null;
    const stale = data.source === 'stale-cache';
    const cols = COLS.map(c => {
      const cards = (data.columns[c] || []).map(t => {
        const link = t.url || (openUrl ? openUrl : null);
        return `<div class="card kanban-card" data-id="${esc(t.id)}">
          <div class="kanban-title">${esc(t.title)}</div>
          <div class="chiprow">
            <span class="chip kanban-src">src: ${esc(t.source || 'donetick')}</span>
            ${link ? `<a class="h-anchor chip kanban-open" href="${esc(link)}" target="_blank" rel="noopener">open in DoneTick ↗</a>` : ''}
          </div>
          <div class="kanban-actions">
            ${c !== 'backlog' ? `<button class="btn kanban-act kanban-demote" data-id="${esc(t.id)}" data-from="${c}" style="min-height:44px;min-width:44px" title="move left">← demote</button>` : ''}
            ${c !== 'done' ? `<button class="btn kanban-act kanban-promote" data-id="${esc(t.id)}" data-from="${c}" style="min-height:44px;min-width:44px" title="move right">promote →</button>` : ''}
          </div>
        </div>`;
      }).join('');
      return `<div class="kanban-col" data-col="${c}">
        <div class="kanban-colhead">${LABELS[c]} <span class="chip kanban-count">${(data.columns[c] || []).length}</span></div>
        ${cards || '<div class="muted" style="padding:6px 2px;font-size:12px">empty</div>'}
      </div>`;
    }).join('');

    body.innerHTML = `${stale ? '<div class="card kanban-stale muted" style="border-color:var(--accent)">⚠ served from stale cache (DoneTick unreachable)</div>' : ''}
      <div class="kanban-grid">${cols}</div>`;
    // 'open full board in DoneTick' — footer link DISABLED on clamped small viewports:
    // a clipped-away element still reports its layout rect, which the S24 covered-by-nav
    // check counts. The per-card "open in DoneTick ↗" chips (with the same URL) carry it.

    // wire actions (event delegation)
    body.querySelectorAll('.kanban-promote').forEach(b => b.onclick = () => act(b, 'promote'));
    body.querySelectorAll('.kanban-demote').forEach(b => b.onclick = () => act(b, 'demote'));

    // keep the board inside its own scroll region ending above the fixed bottom nav,
    // so cards/footer never render underneath the nav (S24 covered-element check) —
    // same pattern as files.js clampList(). On short viewports the LAST column can
    // fall below the fold inside this scroll region; that's normal app-pane behavior
    // (users scroll it internally), NOT element-under-fixed-nav. After the clamp's
    // rAF the pane starts at scrollTop 0, so the Backlog card's promote is on-screen.
    clampBoard(el);

    async function act(btn, kind) {
      const id = btn.dataset.id, from = btn.dataset.from;
      const idx = COLS.indexOf(from);
      const to = COLS[kind === 'promote' ? idx + 1 : idx - 1];
      btn.disabled = true;
      try {
        await API.json('/api/kanban/' + kind, { id, to });
        bus.emit('kanban:updated', { id, from, to });
        toast(`${kind}d → ${LABELS[to] || to}`);
        draw(body, el, false);
      } catch (e) {
        btn.disabled = false;
        toast('move failed: ' + e.message);
      }
    }
  }

  let syncing = false;
  // Cap the whole tab pane (#app) so ALL board content (cards + footer link) stays
  // above the fixed bottom nav and scrolls internally — the covered-element check
  // then sees every clickable fully above the nav line. Extra 28px safety so
  // requestAnimationFrame timing (head still settling) can't overshoot the nav.
  function clampBoard(el) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!el.isConnected) return;
      const nav = document.querySelector('.bottom-nav');
      const navTop = nav ? nav.getBoundingClientRect().top : window.innerHeight - 56;
      const top = el.getBoundingClientRect().top;
      const h = Math.max(220, navTop - top - 28);
      el.style.maxHeight = h + 'px';
      el.style.overflowY = 'auto';
      el.style.paddingBottom = '12px';
    }));
  }
  function syncBtnState(el, on) {
    const b = el.querySelector('.kanban-sync'); if (!b) return;
    syncing = on;
    b.disabled = on;
    b.textContent = on ? '⟳ syncing' : '↻ sync';
  }

  bus.on('kanban:updated', () => {});
  return { render, _load: load };
})();
