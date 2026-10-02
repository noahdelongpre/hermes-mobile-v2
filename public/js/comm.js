'use strict';
// comm.js — shared client kernel: auth state, fetch helpers, SSE, tiny event bus.
window.bus = (() => { const m = {}; return {
  on(k, f) { (m[k] = m[k] || []).push(f); return () => m[k] = m[k].filter(x => x !== f); },
  emit(k, d) { (m[k] || []).forEach(f => { try { f(d); } catch (e) { console.error('bus', k, e); } }); },
}; })();

window.API = {
  async fetch(path, opts = {}) {
    const r = await fetch(path, {
      headers: opts.body && !(opts.body instanceof Buffer) && !(opts.body instanceof Blob) ? { 'content-type': 'application/json' } : {},
      credentials: 'include',
      ...opts,
      body: opts.body && typeof opts.body === 'object' && !(opts.body instanceof Blob) && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
    });
    if (r.status === 401) { bus.emit('auth:needed'); throw new Error('auth required'); }
    return r;
  },
  async json(path, opts) { const r = await this.fetch(path, opts); const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status }); return j; },
  post(path, body) { return this.json(path, { method: 'POST', body }); },
  // SSE subscription with auto-reconnect; onEvent(dataObj)
  sse(path, onEvent, onOpen) {
    let es = null, backoff = 500, closed = false;
    const connect = () => {
      es = new EventSource(path, { withCredentials: true });
      es.onopen = () => { backoff = 500; onOpen && onOpen(); };
      es.onmessage = (e) => {
        if (!e.data) return;
        try { onEvent(JSON.parse(e.data)); } catch { onEvent({ raw: e.data }); }
      };
      es.onerror = () => { es.close(); if (closed) return; setTimeout(connect, backoff = Math.min(backoff * 2, 15000)); };
    };
    connect();
    return () => { closed = true; es && es.close(); };
  },
};
window.toast = (msg, ms = 2500) => {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
};
window.confirmSheet = (title, bodyHtml, buttons) => new Promise(resolve => {
  const s = document.createElement('div'); s.className = 'sheet open';
  s.innerHTML = `<h3 style="margin:0 0 8px">${title}</h3><div>${bodyHtml}</div><div style="display:flex;gap:8px;margin-top:12px"></div>`;
  const row = s.lastElementChild;
  buttons.forEach(([label, cls, val]) => {
    const b = document.createElement('button'); b.className = cls || ''; b.textContent = label;
    b.onclick = () => { s.remove(); resolve(val); }; row.appendChild(b);
  });
  document.body.appendChild(s);
});
window.fuzzy = (needle, items, keyOf = x => x) => {
  const n = needle.toLowerCase();
  return items.map(it => { const k = keyOf(it).toLowerCase(); let i = 0, score = 0;
    for (const c of n) { i = k.indexOf(c, i); if (i < 0) return null; score += i === 0 ? 2 : 1; i++; }
    return { it, score }; }).filter(Boolean).sort((a, b) => b.score - a.score).map(x => x.it).slice(0, 12);
};
