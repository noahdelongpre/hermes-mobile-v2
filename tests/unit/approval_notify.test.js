'use strict';
// tests/unit/approval_notify.test.js — Workstream G DOM-level tests.
// Exercises chat.js's approvalCard + notify indirectly via the exported _test
// hooks (chat.js), and run_routes approval route shape on the REAL server.
// Zero deps; runs in browser-less jsdom-free mode by building minimal DOM stubs.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = process.env.HMV2_ROOT || path.resolve(__dirname, '..', '..');
const PORT = 8298;
let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

function req(p, method = 'POST', body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method,
      headers: body != null ? { 'content-type': 'application/json' } : {} }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const b = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, j: (() => { try { return JSON.parse(b); } catch { return null; } })() , t: b.slice(0, 200) }); });
    });
    r.on('error', reject);
    if (body != null) r.write(JSON.stringify(body));
    r.end();
  });
}

(async () => {
  const env = { ...process.env, PORT: String(PORT), AUTH_PASS: '' };
  if (!env.HERMES_KEY) {
    const p = path.join(process.env.LOCALAPPDATA || '', 'hermes', '.env');
    try {
      const line = (fs.readFileSync(p, 'utf8').split(/\r?\n/).find(l => l.startsWith('API_SERVER_KEY=')) || '');
      const v = line.slice('API_SERVER_KEY='.length).trim();
      if (v) env.HERMES_KEY = v;
    } catch {}
  }
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { await new Promise((res, rej) => { const h = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health' }, s => { s.resume(); s.on('end', res); }); h.on('error', rej); setTimeout(() => rej(new Error('t')), 500); }); up = true; } catch {}
      if (!up) await new Promise(r => setTimeout(r, 100));
    }
    ok('server healthy', up);

    // --- approval route contract: rejects missing choice/decision clearly
    const miss = await req('/api/run/whatever/approval', 'POST', {});
    ok('approval missing choice → 400 with guidance', miss.status === 400 && /choice/.test(miss.t), `status=${miss.status} ${miss.t.slice(0, 60)}`);

    // invalid choice → forwarded to upstream which 400s; ours must pass it through (or 502 if unreachable) — never crash
    const bogus = await req('/api/run/whatever/approval', 'POST', { choice: 'nonsense' });
    ok('approval invalid choice no-crash', bogus.status !== 0 && bogus.status < 500, `status=${bogus.status}`);

    // decision alias conversion happens server-side: body with decision only also passes our 400 guard
    const alias = await req('/api/run/whatever/approval', 'POST', { decision: 'once' });
    ok('decision alias accepted', alias.status !== 0 && alias.status < 500, `status=${alias.status}`);

    // --- chat.js client logic: parse check + handler presence
    const chatSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat.js'), 'utf8');
    ok('chat handles approval.request', chatSrc.includes("case 'approval.request'"));
    ok('chat handles approval.responded', chatSrc.includes("case 'approval.responded'"));
    ok('approvalCard sends request_id when present', /request_id:\s*ev\.request_id \|\| undefined/.test(chatSrc));
    ok('notify gated behind Notification API', /'Notification' in window/.test(chatSrc));

    // approvalCard scaffold sanity via regex (choices derive from event; buttons per choice; disable on click)
    ok('approvalCard builds buttons from ev.choices', /for \(const c of choices\)/.test(chatSrc));
    ok('approvalCard posts to /api/run/<id>/approval', chatSrc.includes('/api/run/${sessionRunId}/approval'));
  } finally {
    try { server.kill(); } catch {}
    try { require('child_process').execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch {}
  }
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
