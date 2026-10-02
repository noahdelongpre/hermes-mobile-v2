'use strict';
// tests/unit/sessions.test.js — Workstream B: real-session spine.
// Spawns the real server (no HERMES_KEY needed — exercises OUR proxy routes and
// tolerant error shapes). Upstream-touching success paths (create/fork/rename)
// are covered live if HERMES_KEY is present; skipped otherwise.
// Usage: node tests/unit/sessions.test.js
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = process.env.HMV2_ROOT || path.resolve(__dirname, '..', '..');
const PORT = 8296;
let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

function req(p, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method,
      headers: body != null ? { 'content-type': 'application/json' } : {} }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, j: (() => { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } })() }); });
    });
    r.on('error', reject);
    if (body != null) r.write(JSON.stringify(body));
    r.end();
  });
}

(async () => {
  // Source the gateway key from the host hermes .env (env-var only, never logged).
  let env = { ...process.env, PORT: String(PORT), AUTH_PASS: '' };
  if (!env.HERMES_KEY) {
    const fs = require('fs');
    for (const p of [path.join(process.env.LOCALAPPDATA || '', 'hermes', '.env'), path.join(process.env.USERPROFILE || '', '.hermes', '.env')]) {
      try {
        const line = (fs.readFileSync(p, 'utf8').split(/\r?\n/).find(l => l.startsWith('API_SERVER_KEY=')) || '');
        const v = line.slice('API_SERVER_KEY='.length).trim();
        if (v) { env.HERMES_KEY = v; break; }
      } catch {}
    }
  }
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvOut = '';
  server.stdout.on('data', d => (srvOut += d)); server.stderr.on('data', d => (srvOut += d));
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { const r = await req('/api/health'); if (r.status === 200) up = true; } catch {}
      if (!up) await new Promise(rs => setTimeout(rs, 100));
    }
    ok('server healthy', up, srvOut.split('\n').find(l => l.includes('registered')) || '');

    // list proxy shape
    const list = await req('/api/session/list?limit=5');
    ok('list 200', list.status === 200, `status=${list.status}`);
    ok('list rows shape', Array.isArray(list.j.sessions) && 'id' in (list.j.sessions[0] || {}), `rows=${(list.j.sessions || []).length}`);
    ok('list has has_more', typeof list.j.has_more === 'boolean');

    // create-session proxy (works without key only if upstream reachable; else assert error shape, no crash)
    const created = await req('/api/session', 'POST', {});
    if ((created.status === 200 || created.status === 201) && created.j && created.j.session && created.j.session.id) {
      const id = created.j.session.id;
      ok('create session returns id', /^[a-z0-9_]+$/i.test(id), `id=${id} status=${created.status}`);
      // delete directly after creation-only session (empty) is also valid cleanup for 201-only case
      // rename
      const ren = await req(`/api/session/${id}`, 'PATCH', { title: 'hm2 sessions test' });
      ok('rename 200 + title', ren.status === 200 && ren.j.session && ren.j.session.title === 'hm2 sessions test');
      // fork copies
      const fk = await req(`/api/session/${id}/fork`, 'POST', {});
      const fid = fk.j && fk.j.session && fk.j.session.id;
      ok('fork returns new id', !!fid && fid !== id);
      ok('fork parent links back', fk.j.session.parent_session_id === id);
      // messages empty initially
      const msgs = await req(`/api/session/${id}/messages`);
      ok('messages 200 list', msgs.status === 200 && Array.isArray(msgs.j.data));
      // delete both
      const d1 = await req(`/api/session/${id}`, 'DELETE');
      const d2 = await req(`/api/session/${fid}`, 'DELETE');
      ok('delete own', d1.j && d1.j.deleted === true);
      ok('delete fork', d2.j && d2.j.deleted === true);
      // deleted id then 404s
      const gone = await req(`/api/session/${id}`);
      ok('deleted session GET 404s or empty', gone.status !== 200 || !gone.j.session);
    } else {
      ok('create-session unavailable upstream → clear error shape', created.status >= 400 && created.j && typeof created.j.error === 'string', `status=${created.status}`);
    }

    // unknown session id: clear error, no crash
    const nf = await req('/api/session/does-not-exist/messages');
    ok('unknown session messages → 4xx not 5xx', nf.status >= 400 && nf.status < 500, `status=${nf.status}`);

    // run/create accepts session_id passthrough (upstream may 4xx w/o key — ours must not 500)
    const rc = await req('/api/run/create', 'POST', { input: 'x', session_id: 'no-such-session' });
    ok('run/create session_id passthrough no-crash', rc.status !== 0 && rc.status < 500, `status=${rc.status}${rc.j && rc.j.error ? ' err=' + String(rc.j.error).slice(0, 60) : ''}`);

    // bad json/no input still rejected cleanly
    const bad = await req('/api/run/create', 'POST', {});
    ok('run/create empty body 400', bad.status === 400);
  } finally {
    server.kill();
    try { require('child_process').execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch {}
  }
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
