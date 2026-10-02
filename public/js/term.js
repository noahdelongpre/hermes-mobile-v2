'use strict';
// term.js — Workstream E terminal UI. Multi-session exec terminal against /api/term/exec.
// Protocol: POST with XHR streaming read; server sends SSE-format data: frame JSON objects:
//   {cwd:"..."} | {chunk:"..."}* (while child runs) | {code:0} (final).
// Multi-session: Map termId -> {name, cwd, buffer, history[]}; localStorage-backed history.
// Mobile special keys: Esc/Tab/Ctrl-C (empty cmd → kill is unsupported one-shot; Ctrl-C
// pre-fills nothing but terminates could not aim at a live child — we send an explicit
// empty exec which server rejects; instead Ctrl-C clears the input line, matching REPL
// convention for a queued-command model). Up/Down = history recall.
MODULES.term = (function () {
  const histKey = 'hm2.term.history';
  const sessKey = 'hm2.term.sessions';
  const MAX_HIST = 100;

  let history = [];
  let sessions = [];            // [{id,name}]
  let active = null;
  let running = new Set();      // session ids with a request in flight
  let wsId = 'default';
  let els = null;

  function load() {
    try { history = JSON.parse(localStorage.getItem(histKey) || '[]').slice(-MAX_HIST); } catch { history = []; }
    try { sessions = JSON.parse(localStorage.getItem(sessKey) || 'null'); } catch {}
    if (!Array.isArray(sessions) || !sessions.length) sessions = [{ id: 'main', name: 'main' }];
    active = sessions[0].id;
  }
  const store = () => {
    localStorage.setItem(histKey, JSON.stringify(history.slice(-MAX_HIST)));
    localStorage.setItem(sessKey, JSON.stringify(sessions));
  };
  const bufOf = (id) => { const b = sessionBuffers[id]; return b || (sessionBuffers[id] = { text: '', cwd: '' }); };
  const sessionBuffers = {};

  function esc(s) { return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  function render(el) {
    load();
    el.innerHTML = `
      <div class="term-wrap" style="display:flex;flex-direction:column;height:calc(100vh - var(--nav-h) - env(safe-area-inset-bottom,0px) - 12px);gap:8px;padding:8px">
        <div id="term-tabs" style="display:flex;gap:6px;overflow-x:auto;flex:0 0 auto"></div>
        <pre id="term-out" class="mono" style="flex:1 1 auto;overflow-y:auto;margin:0;font-size:14px;line-height:1.45;white-space:pre-wrap;word-break:break-word;min-height:200px"></pre>
        <div style="display:flex;gap:6px;flex:0 0 auto">
          <input id="term-in" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="command…" style="flex:1;font-family:var(--mono);font-size:15px">
          <button id="term-send" class="primary">SEND</button>
        </div>
        <div id="term-keys" style="display:flex;gap:6px;flex:0 0 auto;overflow-x:auto;padding-bottom:2px"></div>
        <div style="display:flex;gap:6px;flex:0 0 auto">
          <button id="term-clear">Clear</button>
          <button id="term-more">+ Session</button>
          <button id="term-ctx">Send output as context</button>
        </div>
      </div>`;
    els = {
      tabs: el.querySelector('#term-tabs'), out: el.querySelector('#term-out'),
      input: el.querySelector('#term-in'), keys: el.querySelector('#term-keys'),
    };
    renderTabs(); renderKeys();

    els.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); recall(-1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); recall(1); }
      else if (e.key === 'Tab') { e.preventDefault(); insert('Tab'); }
      else if (e.key === 'Escape') { els.input.value = ''; }
    });
    el.querySelector('#term-send').onclick = () => send();
    el.querySelector('#term-clear').onclick = () => { bufOf(active).text = ''; paint(); };
    el.querySelector('#term-more').onclick = () => {
      const n = sessions.length + 1;
      const s = { id: 's' + Date.now().toString(36), name: 'sh' + n };
      sessions.push(s); active = s.id; store(); renderTabs();
    };
    el.querySelector('#term-ctx').onclick = () => {
      const b = bufOf(active);
      const txt = `$ ${lastCmd[active] || ''}\n${b.text.slice(-4000)}`;
      bus.emit('composer:insert', '$ ' + txt);
      toast('output queued into composer');
    };
    // repaint when switching back to the tab
    bus.on('tab:switch', n => { if (n === 'term' && els) paint(); });
    paint();
  }

  function recall(dir) {
    if (!history.length) return;
    histIdx += dir;
    if (histIdx < -1) histIdx = -1;
    if (histIdx >= history.length) histIdx = history.length - 1;
    els.input.value = histIdx === -1 ? '' : history[histIdx];
  }
  let histIdx = -1;
  const lastCmd = {};

  function insert(kind) {
    if (kind === 'Tab') els.input.value += ' ';
    els.input.focus();
  }

  function renderKeys() {
    const keys = [
      ['Esc', () => { els.input.value = ''; }],
      ['↑', () => recall(-1)],
      ['↓', () => recall(1)],
      ['Tab', () => insert('Tab')],
      ['Ctrl-C', () => { els.input.value = ''; toast('input cleared'); }],
      ['|', () => { els.input.value += ' | '; }],
      ['&&', () => { els.input.value += ' && '; }],
      ['~/', () => { els.input.value += '~/'; }],
      ['*', () => { els.input.value += '*'; }],
      ['../', () => { els.input.value += '../'; }],
      [' space', () => { els.input.value += ' '; }],
    ];
    els.keys.innerHTML = '';
    keys.forEach(([label, fn]) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'min-height:44px;min-width:48px;padding:4px 12px;font-size:14px;font-family:var(--mono)';
      b.onclick = fn;
      els.keys.appendChild(b);
    });
  }

  function renderTabs() {
    els.tabs.innerHTML = '';
    sessions.forEach(s => {
      const chip = document.createElement('button');
      chip.textContent = s.name + (running.has(s.id) ? ' ●' : '');
      chip.className = s.id === active ? 'primary chipbtn' : 'chipbtn';
      chip.style.cssText = 'font-size:15px;padding:4px 16px';
      chip.onclick = () => { active = s.id; renderTabs(); paint(); };
      els.tabs.appendChild(chip);
      if (sessions.length > 1) {
        const x = document.createElement('button');
        x.textContent = '×';
        x.setAttribute('aria-label', 'close session ' + s.name);
        x.style.cssText = 'min-height:44px;min-width:32px;padding:4px 8px';
        x.onclick = () => { sessions = sessions.filter(t => t.id !== s.id); if (active === s.id) active = sessions[0].id; store(); renderTabs(); paint(); };
        els.tabs.appendChild(x);
      }
    });
  }

  // Paint full pane content (echo buffer + prompt line for cwd)
  function paint() {
    const b = bufOf(active);
    const cwd = b.cwd ? `\n[${short(b.cwd)}]$ ` : '[workspace]$ ';
    els.out.textContent = b.text + (running.has(active) ? cwd + '…' : cwd);
    autoscroll();
  }
  const short = (c) => c.length > 48 ? '…' + c.slice(-47) : c;

  function autoscroll() { els.out.scrollTop = els.out.scrollHeight; }

  async function send() {
    const cmd = els.input.value.trim();
    if (!cmd) return;
    els.input.value = '';
    histIdx = -1;
    if (!history.length || history[history.length - 1] !== cmd) { history.push(cmd); history = history.slice(-MAX_HIST); }
    store();
    const tid = active;
    const b = bufOf(tid);
    b.text += `$ ${cmd}\n`;
    lastCmd[tid] = cmd;
    running.add(tid); renderTabs(); paint();
    try {
      const r = await API.fetch('/api/term/exec', {
        method: 'POST', body: { workspaceId: currentWs(), termId: tid, cmd },
      });
      // stream-read the SSE-style response
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let acc = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        let i;
        while ((i = acc.indexOf('\n\n')) >= 0) {
          const frame = acc.slice(0, i); acc = acc.slice(i + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            let obj; try { obj = JSON.parse(line.slice(6)); } catch { continue; }
            if (obj.chunk !== undefined) { b.text += obj.chunk; if (tid === active) { paint(); } }
            if (obj.cwd) b.cwd = obj.cwd;
            if (obj.code !== undefined) b.text += `[exit ${obj.code}]\n`;
          }
          if (tid === active) paint(); else autoscroll();
        }
      }
    } catch (e) {
      b.text += `request failed: ${e.message}\n`;
    }
    running.delete(tid); renderTabs();
    if (active === tid) paint(); else autoscroll();
  }

  let wsTimer = null;
  function currentWs() {
    // pick the first registered workspace unless a session overrides it
    clearTimeout(wsTimer);
    return window._hm2ws || wsId;
  }

  return { render };
})();
