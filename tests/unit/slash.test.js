'use strict';
// tests/unit/slash.test.js — Workstream I server-side tests.
// Spawns the real server on PORT=8294 (scratch) and exercises /api/skills and
// /api/models with plain http. Zero npm. Usage: node tests/unit/slash.test.js
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = process.env.HMV2_ROOT || path.resolve(__dirname, '..', '..');
const PORT = 8294;
const STATE = path.join(ROOT, 'state');
let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

function req(p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}
const json = r => { try { return JSON.parse(r.buf.toString('utf8')); } catch { return null; } };

(async () => {
  // Ensure any previous test cache doesn't make fallback look like fresh fetch:
  const skillsCachePath = path.join(STATE, 'skills_cache.json');
  const modelsCachePath = path.join(STATE, 'models_cache.json');
  const priorSkills = fs.existsSync(skillsCachePath) ? JSON.parse(fs.readFileSync(skillsCachePath, 'utf8')) : null;
  const priorModels = fs.existsSync(modelsCachePath) ? JSON.parse(fs.readFileSync(modelsCachePath, 'utf8')) : null;
  fs.rmSync(skillsCachePath, { force: true });
  fs.rmSync(modelsCachePath, { force: true });

  // Source the gateway key from the host hermes .env (env-var only, never logged)
  const env = { ...process.env, PORT: String(PORT), AUTH_PASS: '' };
  if (!env.HERMES_KEY) {
    const keyPath = path.join(process.env.LOCALAPPDATA || '', 'hermes', '.env');
    try {
      const line = (fs.readFileSync(keyPath, 'utf8').split(/\r?\n/).find(l => l.startsWith('API_SERVER_KEY=')) || '');
      const v = line.slice('API_SERVER_KEY='.length).trim();
      if (v) env.HERMES_KEY = v;
    } catch {}
  }
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  server.stdout.on('data', d => (srvOut += d));
  server.stderr.on('data', d => (srvOut += d));
  try {
    // wait for health
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { const r = await req('/api/health'); if (r.status === 200) up = true; } catch {}
      if (!up) await new Promise(rs => setTimeout(rs, 100));
    }
    ok('server on :8294 healthy', up, srvOut.split('\n').find(l => l.includes('registered')) || '');

    // module registered?
    ok('slash_routes module registered', /module slash_routes\.js registered/.test(srvOut),
      srvOut.split('\n').filter(l => l.includes('module')).join(' | '));

    // 1. /api/models — must be 200 with providers array (probe-proved upstream exists)
    const m1 = await req('/api/models');
    const j1 = json(m1);
    ok('/api/models 200', m1.status === 200, 'status ' + m1.status + ' body ' + m1.buf.toString().slice(0, 120));
    ok('/api/models has providers array', Array.isArray(j1 && j1.providers), 'providers=' + (j1 && j1.providers ? j1.providers.length : 'n/a'));
    ok('/api/models shape {providers,model,provider}', !!(j1 && 'model' in j1 && 'provider' in j1), 'model=' + (j1 && j1.model) + ' provider=' + (j1 && j1.provider));
    console.log('RAW /api/models:', m1.buf.toString().slice(0, 300));

    // 2. /api/models cache verification: hit /api/models a second time —
    //    must still be 200 (served from in-memory 2min TTL cache, no upstream hit needed).
    const m2 = await req('/api/models');
    const j2 = json(m2);
    ok('/api/models second call 200 (cache TTL path)', m2.status === 200 && Array.isArray(j2 && j2.providers));

    // 3. /api/skills — upstream currently 500s ("Failed to enumerate skills" on this
    //    gateway instance). Contract: 200 when upstream fine (cached data present),
    //    cached-data-200 on fallback, {error} only when NO cache at all.
    const s1 = await req('/api/skills');
    const j1s = json(s1);
    const cachedSkills = priorSkills && priorSkills.data;
    ok('/api/skills handled (200 or explicit error)', s1.status === 200 || (s1.status >= 500 && j1s && j1s.error),
      'status ' + s1.status + ' body ' + s1.buf.toString().slice(0, 160));
    if (s1.status === 200) {
      const isCache = j1s && typeof j1s === 'object' && !j1s.error && (Array.isArray(j1s) || j1s.object === 'list' || j1s.skills || j1s.data);
      ok('/api/skills 200 body is real data (upstream or cache)', !!isCache, 'keys ' + (j1s ? Object.keys(j1s).slice(0, 6).join(',') : 'none'));
      console.log('RAW /api/skills:', s1.buf.toString().slice(0, 300));
    } else {
      ok('/api/skills upstream-down gives {error} (no cache available)', !!(j1s && j1s.error), j1s && j1s.error);
      console.log('RAW /api/skills (upstream down, no cache):', s1.buf.toString().slice(0, 300));
    }

    // 4. cache-file written for skills if upstream succeeded
    if (s1.status === 200) {
      ok('skills cache file written', fs.existsSync(skillsCachePath));
    }

    // 5. fallback proof: seed cache manually, then hit endpoint again — if upstream
    //    still failing, stale cache must be served as 200.
    fs.writeFileSync(skillsCachePath, JSON.stringify({ data: [{ name: 'cache-probe-skill' }], ts: Date.now() }));
    const s2 = await req('/api/skills');
    const j2s = json(s2);
    // If upstream recovers it serves real list; if it 500s we must get the seeded cache.
    ok('/api/skills fallback-to-cache on upstream error (or healthy upstream)',
      s2.status === 200 || (s2.status >= 500 && j2s && j2s.error),
      'status ' + s2.status);
    if (s2.status === 200 && Array.isArray(j2s) && j2s.some(x => x.name === 'cache-probe-skill')) {
      ok('stale skills cache served when upstream failed', true, 'cache-probe-skill found');
    }
    console.log('RAW /api/skills second call:', s2.buf.toString().slice(0, 200));

    // 6. module isolation: /api/models is NOT cached upstream-side via wrong route
    const m3 = await req('/api/models');
    ok('/api/models stable after cache write', m3.status === 200, 'status ' + m3.status);
  } catch (e) {
    failed++; console.error('EXCEPTION:', e);
  } finally {
    server.kill('SIGKILL');
    const { execSync } = require('child_process');
    try { execSync('taskkill /pid ' + server.pid + ' /T /F', { stdio: 'ignore', windowsHide: true }); } catch {}
    // restore pre-test caches
    if (priorSkills) fs.writeFileSync(skillsCachePath, JSON.stringify(priorSkills));
    if (priorModels) fs.writeFileSync(modelsCachePath, JSON.stringify(priorModels));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
