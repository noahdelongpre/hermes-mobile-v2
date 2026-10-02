'use strict';
// bootstrap.js — tab wiring + module loader. Each module file exposes window.MODULES.<tab>.
window.MODULES = {};
const TABS = ['chat', 'files', 'git', 'term', 'board'];
const appRoot = document.getElementById('app');
const status = document.createElement('div'); status.className = 'testing-badge'; status.textContent = 'HMv2'; document.body.appendChild(status);

async function loadModules() {
  for (const t of TABS) {
    try {
      await new Promise((res, rej) => { const s = document.createElement('script'); s.src = `/js/${t}.js`; s.onload = res; s.onerror = () => rej(new Error('404 ' + t)); document.head.appendChild(s); });
    } catch (e) { console.warn('module missing:', t); MODULES[t] = { render: el => el.innerHTML = `<div class="card muted">module "${t}" not built yet</div>` }; }
    MODULES[t] && window.bus.emit('module:loaded', t);
  }
}

function switchTab(name) {
  document.querySelectorAll('.bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  location.hash = name;
  const el = appRoot; el.innerHTML = '';
  if (MODULES[name]) MODULES[name].render(el);
  window.bus.emit('tab:switch', name);
}
document.getElementById('nav').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]'); if (b) switchTab(b.dataset.tab);
});
window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (TABS.includes(t)) switchTab(t); });

API.fetch('/api/health').then(r => r.json()).then(h => window.bus.emit('health', h)).catch(() => {});
loadModules().then(() => {
  const t = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'chat';
  switchTab(t);
});
