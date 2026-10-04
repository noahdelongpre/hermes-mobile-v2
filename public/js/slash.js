'use strict';
// slash.js — Workstream I: '/'-command overlay + model picker.
// Renders NOTHING into the app root itself; mounts on the chat composer:
// typing '/' as first char opens a fuzzy-search overlay (window.fuzzy from
// comm.js) as a .sheet listing registry commands; Enter = top hit, Esc/tap-out
// = close, tap = execute + clear the composer. '⌘' button next to '+' opens the
// provider/model bottom sheet from /api/models; selection emits bus
// 'model:selected' {provider, model} and persists per-conversation in
// localStorage ('hm2.model.<convo>').
// Contracts consumed: bus 'session:switch' {conversation} (chat.js spine);
// fallback convo = 'hm2-main'. Contracts emitted: 'session:new', 'run:stop',
// 'model:selected'. /files /git /term /board = location.hash (tab switch).
// Note: model selection only takes effect on the NEXT run create (chat.js
// reads localStorage at send time) — model_options per-run, never global.
window.MODULES = window.MODULES || {};
MODULES.slash = (() => {
  // Slash registry. fx = local action (nothing sent to Hermes verbatim).
  const MODEL_KEY = c => 'hm2.model.' + (c || 'hm2-main');
  const REGISTRY = [
    { cmd: '/new',    desc: 'new session',            fx: () => bus.emit('session:new', {}) },
    { cmd: '/stop',   desc: 'stop current run',       fx: () => bus.emit('run:stop', {}) },
    { cmd: '/model',  desc: 'pick provider / model',  fx: () => openPicker() },
    { cmd: '/files',  desc: 'open files tab',         fx: () => { location.hash = 'files'; } },
    { cmd: '/git',    desc: 'open git tab',           fx: () => { location.hash = 'git'; } },
    { cmd: '/term',   desc: 'open terminal tab',      fx: () => { location.hash = 'term'; } },
    { cmd: '/board',  desc: 'open board tab',         fx: () => { location.hash = 'board'; } },
    { cmd: '/memory', desc: 'open memory tab',        fx: () => { location.hash = 'memory'; } },
    { cmd: '/clear',  desc: 'clear composer draft',   fx: () => clearComposer() },
  ];
  let composer = null, composerInput = null, sheet = null, items = [], filtered = [];

  function currentConvo() { return window.__hm2_convo || 'hm2-main'; }

  function clearComposer() {
    if (composerInput) { composerInput.value = ''; composerInput.dispatchEvent(new Event('input', { bubbles: true })); }
    closeSheet();
  }

  function exec(entry) {
    closeSheet();
    if (composerInput) composerInput.value = ''; // always clear composer after a slash action
    if (entry && typeof entry.fx === 'function') { try { entry.fx(); } catch (e) { console.error('slash exec', e); } }
  }

  function renderList(needle) {
    if (!sheet) return;
    const q = needle.replace(/^\//, '');
    filtered = window.fuzzy ? fuzzy(q, items, it => it.cmd + ' ' + (it.desc || '')) : items.slice(0, 12);
    const list = sheet.querySelector('.slash-list');
    if (!list) return;
    list.innerHTML = '';
    filtered.slice(0, 12).forEach((it, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'slash-item btn' + (i === 0 ? ' primary' : '');
      row.style.cssText = 'display:flex;width:100%;justify-content:space-between;align-items:center;gap:10px;text-align:left;min-height:44px';
      const name = document.createElement('b'); name.textContent = it.cmd;
      const desc = document.createElement('span'); desc.className = 'muted'; desc.style.fontSize = '12px';
      desc.textContent = it.desc || '';
      row.append(name, desc);
      row.onclick = () => exec(it);
      list.appendChild(row);
    });
    if (!filtered.length) {
      const none = document.createElement('div'); none.className = 'muted'; none.style.padding = '8px 2px';
      none.textContent = 'no matching command';
      list.appendChild(none);
    }
  }

  function closeSheet() {
    if (sheet) { sheet.remove(); sheet = null; }
    if (composerInput) composerInput.focus();
  }

  function openSheet() {
    closeSheet();
    sheet = document.createElement('div');
    sheet.className = 'sheet open slash-sheet';
    sheet.style.cssText = 'max-height:44vh;z-index:70;padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px))';
    const h = document.createElement('div');
    h.className = 'muted'; h.style.fontSize = '12px'; h.style.marginBottom = '8px';
    h.textContent = 'slash commands — Enter runs the top hit';
    const list = document.createElement('div'); list.className = 'slash-list';
    sheet.append(h, list);
    sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });
    document.body.appendChild(sheet);
    // outside-tap catcher (next pointerdown outside the sheet closes it)
    setTimeout(() => document.addEventListener('pointerdown', function away(e) {
      if (sheet && !sheet.contains(e.target) && e.target !== composerInput) { sheet && closeSheet(); }
      document.removeEventListener('pointerdown', away, true);
    }, true), 0);
    items = REGISTRY;
    filtered = items;
    renderList(composerInput ? composerInput.value : '/');
  }

  // ---------------------------------------------------------- model picker
  function loadChoice(convo) {
    try { return JSON.parse(localStorage.getItem(MODEL_KEY(convo)) || 'null'); } catch { return null; }
  }
  function saveChoice(convo, pick) {
    try { localStorage.setItem(MODEL_KEY(convo), JSON.stringify(pick)); } catch {}
  }

  const EFFORTS = [['default', ''], ['minimal', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max'], ['ultra', 'ultra']];
  const effortOf = (convo) => localStorage.getItem('hm2.effort.' + (convo || currentConvo())) || '';

  // Effort-only sheet (shown right after a model pick, or from the current-model block)
  function openEffortSheet(convo, skipToast) {
    closeSheet();
    sheet = document.createElement('div');
    sheet.className = 'sheet open effort-sheet';
    sheet.style.cssText = 'max-height:60vh;z-index:71;padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px))';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px';
    const h3 = document.createElement('h3'); h3.style.cssText = 'margin:0'; h3.textContent = 'Reasoning effort';
    head.appendChild(h3);
    const cur = loadChoice(convo);
    const lbl = document.createElement('span'); lbl.className = 'chip';
    lbl.textContent = cur ? (cur.provider + ' / ' + cur.model) : 'no model picked';
    head.appendChild(lbl);
    sheet.appendChild(head);
    const list2 = document.createElement('div'); list2.className = 'effort-list';
    sheet.appendChild(list2);
    const active = effortOf(convo);
    for (const [label, value] of EFFORTS) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn effort-item';
      b.style.cssText = 'display:block;width:100%;text-align:left;margin:3px 0;min-height:44px;padding:6px 12px' + (value === active ? ';border-color:var(--accent);color:var(--accent)' : '');
      b.textContent = value === active ? label + '  ✓' : label;
      b.onclick = () => {
        try { if (value) localStorage.setItem('hm2.effort.' + convo, value); else localStorage.removeItem('hm2.effort.' + convo); } catch {}
        toast('reasoning → ' + label);
        closeSheet();
      };
      list2.appendChild(b);
    }
    const closeB = document.createElement('button');
    closeB.type = 'button'; closeB.className = 'btn'; closeB.textContent = '✕ close';
    closeB.style.cssText = 'width:100%;margin-top:8px;min-height:44px';
    closeB.onclick = closeSheet;
    sheet.appendChild(closeB);
    sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });
    document.body.appendChild(sheet);
    if (skipToast !== false) { /* toast handled by caller */ }
  }

  async function openPicker() {
    closeSheet();
    let data = null;
    try { data = await API.json('/api/models'); }
    catch (e) { toast('model options unavailable: ' + e.message); return; }
    const providers = (data.providers || []).filter(p => p.models && p.models.length);
    sheet = document.createElement('div');
    sheet.className = 'sheet open model-sheet';
    sheet.style.cssText = 'max-height:70vh;z-index:70;padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px))';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px';
    const title = document.createElement('h3'); title.style.cssText = 'margin:0'; title.textContent = 'model';
    const cur = loadChoice(currentConvo());
    const curLbl = document.createElement('span'); curLbl.className = 'chip model-current';
    curLbl.textContent = cur ? (cur.provider + ' / ' + cur.model)
      : (data.provider ? data.provider + ' / ' + data.model : 'upstream default');
    head.append(title, curLbl);
    sheet.appendChild(head);
    const list = document.createElement('div'); list.className = 'model-list';
    sheet.appendChild(list);
    // --- current model + effort at the TOP (fast level switching) ---
    {
      const cur2 = loadChoice(currentConvo());
      const ef = effortOf(currentConvo());
      const block = document.createElement('div');
      block.className = 'card model-current-card';
      block.style.cssText = 'margin:2px 0 10px;padding:10px 12px';
      const lbl2 = document.createElement('div');
      lbl2.style.cssText = 'font-weight:700;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      lbl2.textContent = cur2 ? (cur2.model) : 'upstream default';
      const sub2 = document.createElement('div');
      sub2.className = 'muted'; sub2.style.cssText = 'font-size:12px;margin:2px 0 8px';
      sub2.textContent = (cur2 ? cur2.provider : 'no model chosen') + (ef ? ' · effort ' + ef : ' · default effort');
      block.append(lbl2, sub2);
      const chips = document.createElement('div');
      chips.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
      for (const [label, value] of EFFORTS) {
        const cb = document.createElement('button');
        cb.className = 'chip effort-chip';
        cb.style.cssText = 'min-height:36px;padding:4px 10px;font-size:12px' + (value === ef ? ';border-color:var(--accent);color:var(--accent)' : '');
        cb.textContent = label;
        cb.onclick = () => {
          try { if (value) localStorage.setItem('hm2.effort.' + currentConvo(), value); else localStorage.removeItem('hm2.effort.' + currentConvo()); } catch {}
          toast('reasoning → ' + label);
          closeSheet();
        };
        chips.appendChild(cb);
      }
      block.appendChild(chips);
      sheet.insertBefore(block, list.parentNode ? list : null); // put above the scrollable list
    }

    if (!providers.length) {
      const none = document.createElement('div'); none.className = 'muted';
      none.style.padding = '12px 2px';
      none.textContent = 'no providers with models available';
      list.appendChild(none);
    }
    for (const p of providers) {
      const grp = document.createElement('div');
      grp.className = 'model-prov';
      grp.style.cssText = 'margin:8px 0 2px;font-size:12px;color:var(--muted)';
      grp.textContent = (p.name || p.slug) + (p.is_current ? ' (current)' : '') + (p.authenticated ? '' : ' — not configured');
      list.appendChild(grp);
      for (const m of p.models) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn model-item';
        btn.style.cssText = 'display:block;width:100%;text-align:left;margin:3px 0;min-height:44px;padding:8px 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        btn.textContent = m;
        btn.dataset.provider = p.slug || p.name || '';
        btn.dataset.model = m;
        btn.onclick = () => {
          const pick = { provider: p.slug || p.name || '', model: m };
          saveChoice(currentConvo(), pick);
          bus.emit('model:selected', pick);
          toast('model → ' + pick.provider.split('/')[0] + ' / ' + pick.model);
          openEffortSheet(currentConvo(), false); // chain: pick → effort (never adds a user message)
        };
        if (cur && cur.provider === (p.slug || p.name || '') && cur.model === m) btn.style.borderColor = 'var(--accent)';
        list.appendChild(btn);
      }
    }
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn model-close'; closeBtn.textContent = '✕ close';
    closeBtn.style.cssText = 'width:100%;margin-top:8px;min-height:44px';
    closeBtn.onclick = closeSheet;
    sheet.appendChild(closeBtn);
    sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });
    document.body.appendChild(sheet);
    setTimeout(() => document.addEventListener('pointerdown', function away2(e) {
      if (sheet && !sheet.contains(e.target) && e.target !== composerInput) { sheet && closeSheet(); }
      document.removeEventListener('pointerdown', away2, true);
    }, true), 0);
  }

  // -------------------------------------------------------------- composer wiring
  let mountTries = 0;
  function mount() {
    const c = document.querySelector('.composer');
    if (!c) { if (++mountTries < 40) setTimeout(mount, 250); return; } // composer not yet rendered; retry
    if (c === composer) return; // already wired
    composer = c;
    composerInput = composer.querySelector('#composer') || composer;
    const input = composerInput;
    const onKeyDown = e => {
      const v = input.value;
      if (!sheet) {
        if (v.startsWith('/')) openSheet();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation(); // capture-beats chat.js send handler
        exec(filtered[0] || null);
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); closeSheet();
      } else if (e.key === 'Backspace' && v === '/') {
        closeSheet();
      }
    };
    // capture phase so Enter/Esc are ours while the overlay is open (chat.js listens on bubble)
    input.addEventListener('keydown', onKeyDown, true);
    input.addEventListener('input', () => {
      const v = input.value;
      if (sheet && !v.startsWith('/')) closeSheet();
      else if (!sheet && v.startsWith('/')) openSheet();
      else if (sheet) renderList(v);
    });
    // '+'-adjacent '⌘' model-picker button (≥44px tap target)
    const tr = document.getElementById('toolrow');
    if (tr && !tr.querySelector('.model-btn')) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = '⌘'; b.title = 'model picker'; b.className = 'btn model-btn';
      b.style.cssText = 'min-width:44px;min-height:44px;font-size:18px;padding:0 10px';
      b.onclick = openPicker;
      tr.appendChild(b);
    } else if (!composer.querySelector('.model-btn') && !tr) {
      // fallback: composer row if toolrow absent
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = '⌘'; b.title = 'model picker'; b.className = 'btn model-btn';
      b.style.cssText = 'min-width:44px;min-height:44px;font-size:18px;padding:0 10px';
      b.onclick = openPicker;
      composer.insertBefore(b, composer.querySelector('#send') || composer.firstElementChild);
    }
  }

  bus.on('module:loaded', name => { if (name === 'chat') mount(); });
  bus.on('tab:switch', name => { if (name === 'chat') { mountTries = 0; mount(); } else closeSheet(); });

  // chat.js spine: active conversation key for per-conversation model persistence
  bus.on('session:switch', s => { if (s && s.conversation != null) window.__hm2_convo = s.conversation; });

  return {
    mount,
    _registry: REGISTRY,
    _openSheet: openSheet, _closeSheet: closeSheet,
    _openPicker: openPicker,
    _choice: loadChoice,
  };
})();
