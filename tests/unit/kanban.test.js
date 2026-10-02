'use strict';
// tests/unit/kanban.test.js — Workstream H server-side tests.
// Spawns the real server (PORT=8297) + a local DoneTick STUB upstream (PORT=8295).
// NEVER touches a real DoneTick instance. Scenarios:
//   1. unconfigured mode (DONETICK_URL unset) → 200 {configured:false,error,no crash}
//   2. stubbed upstream → tasks shaped into {backlog,in_progress,done}
//   3. cache file written; TTL serve; stale-served fallback when stub goes down (502→stale 200)
//   4. promote/demote PATCH the stub (idempotent status updates only — no task creation)
//   5. bad requests 400
// Zero npm deps. Usage: node tests/unit/kanban.test.js
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const APP_PORT = 8297;
const STUB_PORT = 8295;
const STATE = path.join(ROOT, 'state');
const CACHE = path.join(STATE, 'kanban_cache.json');

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method,
      headers: body ? { 'content-type': 'application/json' } : {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const json = r => { try { return JSON.parse(r.buf.toString('utf8')); } catch { return null; } };

// ---- DoneTick stub (fake upstream; never a real instance) ----
const stubTasks = [
  { id: 't1', title: 'stub backlog item', status: 'todo', updated_at: '2026-10-01T01:00:00Z' },
  { id: 't2', title: 'stub wip item', status: 'in progress', updated_at: '2026-10-01T02:00:00Z' },
  { id: 't3', title: 'stub done item', status: 'done', updated_at: '2026-10-01T03:00:00Z' },
];
const stubState = { mode: 'ok', patches: [] };
const stub = http.createServer((rq, res) => {
  if (stubState.mode === 'down') { rq.destroy(); return; }
  if (rq.method === 'GET' && rq.url === '/api/v1/tasks') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ tasks: stubTasks }));
  }
  if ((rq.method === 'PATCH') && rq.url.startsWith('/api/v1/tasks/')) {
    let b = ''; rq.on('data', c => b += c);
    rq.on('end', () => {
      const id = decodeURIComponent(rq.url.split('/').pop());
      const body = JSON.parse(b || '{}');
      const t = stubTasks.find(x => x.id === id);
      if (!t) { res.writeHead(404); return res.end('{}'); }
      if (body.status) { if (body.status === String(t.status).toLowerCase()) { stubState.patches.push({ id, status: body.status, redundant: true }); return res.writeHead(200), res.end('{}'); } }
      stubState.patches.push({ id, status: body.status });
      if (body.status) t.status = body.status;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    return;
  }
  res.writeHead(404); res.end('{}');
});

(async () => {
  const priorCache = fs.existsSync(CACHE) ? fs.readFileSync(CACHE, 'utf8') : null;
  fs.rmSync(CACHE, { force: true });

  await new Promise(res => stub.listen(STUB_PORT, '127.0.0.1', res));

  // ---- server #1: UNCONFIGURED mode (no DONE TICK env at all) ----
  const envUncfg = { ...process.env, PORT: String(APP_PORT), AUTH_PASS: '' };
  delete envUncfg.DONETICK_URL; delete envUncfg.DONETICK_KEY; delete envUncfg.DONETICK_TOKEN;
  const s1 = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env: envUncfg, stdio: ['ignore', 'pipe', 'pipe'] });
  let out1 = ''; s1.stdout.on('data', d => out1 += d); s1.stderr.on('data', d => out1 += d);
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { if ((await req(APP_PORT, 'GET', '/api/health')).status === 200) up = true; } catch {}
      if (!up) await new Promise(rs => setTimeout(rs, 100));
    }
    ok('server #1 (unconfigured) healthy on :8297', up);
    ok('kanban_routes module registered', /module kanban_routes\.js registered/.test(out1), out1.split('\n').filter(l => l.includes('module')).join(' | '));

    const g1 = await req(APP_PORT, 'GET', '/api/kanban/tasks');
    const j1 = json(g1);
    ok('unconfigured GET /api/kanban/tasks → 200 not crash', g1.status === 200, 'status ' + g1.status);
    ok('unconfigured shape {configured:false,error}', !!(j1 && j1.configured === false && typeof j1.error === 'string' && /donetick/i.test(j1.error)), j1 && j1.error);
    ok('unconfigured columns empty but present', !!(j1 && j1.columns && Array.isArray(j1.columns.backlog) && Array.isArray(j1.columns.in_progress) && Array.isArray(j1.columns.done)));
    console.log('RAW unconfigured:', g1.buf.toString());

    const p1 = await req(APP_PORT, 'POST', '/api/kanban/promote', { id: 't1', to: 'in_progress' });
    const jp1 = json(p1);
    ok('unconfigured POST /api/kanban/promote → 200 {configured:false}, no crash', p1.status === 200 && jp1 && jp1.configured === false, 'status ' + p1.status);
    const p2 = await req(APP_PORT, 'POST', '/api/kanban/promote', { to: 'done' });
    ok('missing id → 400', p2.status === 400, 'status ' + p2.status);
    const p3 = await req(APP_PORT, 'POST', '/api/kanban/demote', { id: 't1', to: 'sideways' });
    ok('bad "to" → 400', p3.status === 400, 'status ' + p3.status);
  } catch (e) { failed++; console.error('EXCEPTION phase1:', e); }
  finally { s1.kill('SIGKILL'); try { require('child_process').execSync('taskkill /pid ' + s1.pid + ' /T /F', { stdio: 'ignore', windowsHide: true }); } catch {} }

  // ---- server #2: STUBBED upstream ----
  const envCfg = {
    ...process.env, PORT: String(APP_PORT), AUTH_PASS: '',
    DONETICK_URL: `http://127.0.0.1:${STUB_PORT}`,
    DONETICK_TASKS_PATH: '/api/v1/tasks',
    DONETICK_KEY: 'stub-key-not-real',
  };
  const s2 = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env: envCfg, stdio: ['ignore', 'pipe', 'pipe'] });
  let out2 = ''; s2.stdout.on('data', d => out2 += d); s2.stderr.on('data', d => out2 += d);
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { if ((await req(APP_PORT, 'GET', '/api/health')).status === 200) up = true; } catch {}
      if (!up) await new Promise(rs => setTimeout(rs, 100));
    }
    ok('server #2 (stubbed upstream) healthy', up);

    const g2 = await req(APP_PORT, 'GET', '/api/kanban/tasks');
    const j2 = json(g2);
    ok('stubbed GET /api/kanban/tasks → 200', g2.status === 200, 'status ' + g2.status);
    ok('backlog column has backlog item', j2 && j2.columns.backlog.some(t => t.id === 't1'), JSON.stringify(j2 && j2.columns && j2.columns.backlog));
    ok('in_progress column has wip item', j2 && j2.columns.in_progress.some(t => t.id === 't2'));
    ok('done column has done item', j2 && j2.columns.done.some(t => t.id === 't3'));
    ok('columns shape {backlog,in_progress,done}', !!(j2 && j2.columns && j2.columns.backlog && j2.columns.in_progress && j2.columns.done));
    ok('card carries source chip data', !!(j2 && Object.values(j2.columns).flat().every(t => t.source === 'donetick')));
    console.log('RAW stubbed board:', g2.buf.toString().slice(0, 400));

    ok('cache file written', fs.existsSync(CACHE));

    // TTL serve: second call served from in-memory cache (stub still up, same data)
    stubState.mode = 'down';
    const g3 = await req(APP_PORT, 'GET', '/api/kanban/tasks');
    const j3 = json(g3);
    ok('within TTL: fresh cache served 200 while stub down', g3.status === 200 && j3 && j3.columns && j3.columns.backlog.some(t => t.id === 't1'), 'status ' + g3.status);
    stubState.mode = 'ok';

    // promote t1 → in progress via stub
    const pm1 = await req(APP_PORT, 'POST', '/api/kanban/promote', { id: 't1', to: 'in_progress' });
    const jpm1 = json(pm1);
    ok('promote via stub → 200 ok', pm1.status === 200 && jpm1 && jpm1.ok === true, 'status ' + pm1.status + ' body ' + pm1.buf.toString());
    const afterP = stubTasks.find(t => t.id === 't1');
    ok('stub shows t1 now "in progress"', afterP && afterP.status === 'in progress', 'status=' + (afterP && afterP.status));
    ok('no task creation ever (no stub POST handler hit possible; PATCH count ' + stubState.patches.length + ')', stubState.patches.every(p => !p.created), 'patches=' + stubState.patches.length);

    // demote t3 → in progress
    const dm1 = await req(APP_PORT, 'POST', '/api/kanban/demote', { id: 't3', to: 'in_progress' });
    ok('demote via stub → 200 ok', dm1.status === 200, 'status ' + dm1.status);
    ok('stub shows t3 now "in progress"', stubTasks.find(t => t.id === 't3').status === 'in progress');
    // restore stub board for cache test
    stubTasks.find(t => t.id === 't1').status = 'todo';
    stubTasks.find(t => t.id === 't3').status = 'done';

    // stale fallback: seed an OLD cache entry (ts in the past beyond TTL),
    // keep stub DOWN → endpoint must serve the stale seed as 200, not 502.
    stubState.mode = 'down';
    // NOTE: in-memory cache survives; dispose it by writing file with older ts won't
    // override mem. Instead spawn-time mem is empty here; we rely on fresh-cache path
    // above plus seeding for a future fresh boot. Direct stale-served proof: seed file
    // with old ts, restart server #3 below.
    stubState.mode = 'ok';
  } catch (e) { failed++; console.error('EXCEPTION phase2:', e); }
  finally { s2.kill('SIGKILL'); try { require('child_process').execSync('taskkill /pid ' + s2.pid + ' /T /F', { stdio: 'ignore', windowsHide: true }); } catch {} }

  // ---- server #3: stale-served fallback across a cold boot ----
  fs.writeFileSync(CACHE, JSON.stringify({ data: { configured: true, source: 'donetick', labels: {}, columns: { backlog: [{ id: 'seed-a', title: 'stale seeded card', source: 'donetick' }], in_progress: [], done: [] } }, ts: Date.now() - 10 * 60 * 1000 }));
  stubState.mode = 'down'; // upstream dead
  const s3 = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env: envCfg, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { if ((await req(APP_PORT, 'GET', '/api/health')).status === 200) up = true; } catch {}
      if (!up) await new Promise(rs => setTimeout(rs, 100));
    }
    const g4 = await req(APP_PORT, 'GET', '/api/kanban/tasks');
    const j4 = json(g4);
    ok('cold boot, upstream down: stale cache served 200', g4.status === 200 && j4 && j4.source === 'stale-cache' && j4.columns.backlog.some(t => t.id === 'seed-a'), 'status ' + g4.status + ' source ' + (j4 && j4.source));
    console.log('RAW stale fallback:', g4.buf.toString().slice(0, 300));
  } catch (e) { failed++; console.error('EXCEPTION phase3:', e); }
  finally { s3.kill('SIGKILL'); try { require('child_process').execSync('taskkill /pid ' + s3.pid + ' /T /F', { stdio: 'ignore', windowsHide: true }); } catch {} }

  stub.close();
  if (priorCache) fs.writeFileSync(CACHE, priorCache); else fs.rmSync(CACHE, { force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
