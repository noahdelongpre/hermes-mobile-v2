'use strict';
// comm.js — shared client kernel: auth state, fetch helpers, SSE, tiny event bus.
window.bus = (() => { const m = {}; return {
  on(k, f) { (m[k] = m[k] || []).push(f); return () => m[k] = m[k].filter(x => x !== f); },
  emit(k, d) { (m[k] || []).forEach(f => { try { f(d); } catch (e) { console.error('bus', k, e); } }); },
}; })();

window.API = {
  async fetch(path, opts = {}) {
    const r = await fetch(path, {
      // JSON body => application/json. (Buffer guard only matters in node tests.)
      headers: opts.body != null && !(typeof Blob !== 'undefined' && opts.body instanceof Blob) && !(typeof FormData !== 'undefined' && opts.body instanceof FormData) && !(opts.body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {},
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
  // SSE subscription. onEvent returning TRUE closes the stream (no auto-reconnect).
  sse(path, onEvent, onOpen) {
    let es = null, backoff = 500, closed = false;
    const connect = () => {
      es = new EventSource(path, { withCredentials: true });
      es.onopen = () => { backoff = 500; onOpen && onOpen(); };
      es.onmessage = (e) => {
        if (!e.data) return;
        let ev;
        try { ev = JSON.parse(e.data); } catch { ev = { raw: e.data }; }
        let stop = false;
        try { stop = onEvent(ev) === true; } catch (err) { console.error('sse handler', err); }
        // Terminal events end the stream: run completed/failed/cancelled or server stream.closed.
        const t = ev && ev.event;
        if (stop || t === 'run.completed' || t === 'run.failed' || t === 'run.cancelled' || t === 'stream.closed') {
          es.close(); closed = true;
        }
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

// ---- pull-to-refresh (custom) ---------------------------------------------
// Standalone/home-screen installs never show Chrome's native overscroll refresh,
// so the app implements its own: drag down >=78px from the top of any scroll
// region (tab pane, chat timeline) → location.reload() to pick up new assets.
(() => {
  const PULL_ARM = 78, RESIST = 0.32, SHOW = -40;
  let startY = 0, pane = null, armed = false, pulling = false, indicator = null;

  const ensureIndicator = () => indicator || ((indicator = document.createElement('div')).id = 'ptr-indicator',
    indicator.style.cssText = 'position:fixed;top:-40px;left:50%;transform:translateX(-50%);'
      + 'width:34px;height:34px;border-radius:50%;background:var(--accent);z-index:98;'
      + 'display:flex;align-items:center;justify-content:center;font-size:17px;color:#171511;'
      + 'box-shadow:0 2px 10px rgba(0,0,0,.5);transition:top .12s ease;pointer-events:none',
    indicator.textContent = '⟳', document.body.appendChild(indicator), indicator);
  const hide = () => { if (indicator) { indicator.remove(); indicator = null; } };
  const reset = () => { armed = false; pulling = false; pane = null; };

  function scrollablePanes() {
    const tl = document.querySelector('.scrollpane');
    const panes = [...document.querySelectorAll('#app > div')];
    if (tl) panes.push(tl);
    return panes.filter(Boolean);
  }

  document.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { reset(); return; }
    const t = e.touches[0];
    pane = null;
    for (const p of scrollablePanes()) {
      if (p.contains(e.target) && p.scrollTop <= 2) { pane = p; break; }
    }
    armed = !!pane;
    startY = t.clientY;
    pulling = false;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!armed || !pane) return;
    const dy = e.touches[0].clientY - startY;
    if (!pulling) {
      if (dy < 14 || pane.scrollTop > 4) return;   // require clear downward intent at top
      if (dy < 0) return;
      pulling = true;
    }
    const d = Math.max(0, dy * RESIST);
    const ind = ensureIndicator();
    ind.style.top = (SHOW + d) + 'px';
    ind.style.transform = 'translateX(-50%) rotate(' + (d * 2) + 'deg)';
    if (dy > PULL_ARM) ind.style.transform = 'translateX(-50%) rotate(540deg) scale(1.15)';
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (pulling) {
      const dy = (e.changedTouches[0] && e.changedTouches[0].clientY - startY) || 0;
      if (dy >= PULL_ARM) {                         // spinner fling, then reload
        const ind = ensureIndicator();
        ind.style.transition = 'transform .4s ease, top .4s ease';
        ind.style.transform = 'translateX(-50%) rotate(720deg)';
        ind.style.top = '-58px';
        setTimeout(() => location.reload(), 170);
        reset();
        return;
      }
    }
    hide(); reset();
  }, { passive: true });
  document.addEventListener('touchcancel', () => { hide(); reset(); }, { passive: true });
})();
