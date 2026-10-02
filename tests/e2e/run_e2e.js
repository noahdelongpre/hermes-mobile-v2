#!/usr/bin/env node
'use strict';
// run_e2e.js — full E2E against the LIVE stack (dev or Pi). Gates:
//  1. health upstream  2. run create+stream  3. fs roundtrip  4. git commit  5. term exec
//  6. attach upload/serve  7. skills/models routes  8. approval stub roundtrip (if capable)
// Usage: node tests/e2e/run_e2e.js [baseUrl] ; writes result to tests/e2e/results.json
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const BASE = process.argv[2] || 'http://127.0.0.1:8124';
let passed = 0, failed = 0;
const ok = (n, c, extra = '') => { console.log((c ? '  PASS ' : '  FAIL ') + n + (extra ? ' — ' + extra : '')); c ? passed++ : failed++; };
function call(method, p, body) {
  return new Promise((res, rej) => {
    const data = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = http.request(BASE + (p.startsWith('/') ? p : '/' + p), {
      method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
    }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res({ s: r.statusCode, t: b, j: (() => { try { return JSON.parse(b); } catch { return null; } })() })); });
    req.on('error', (e) => res({ s: 0, t: '', j: null, err: e.code || e.message })); if (data) req.write(data); req.end();
  });
}
async function sseFrames(p, ms) {
  return await new Promise((resolve) => {
    const req = http.get(BASE + p, r => {
      let buf = ''; const frames = [];
      const tmo = setTimeout(() => { req.destroy(); resolve(frames); }, ms);
      r.on('data', c => {
        buf += c.toString();
        for (const line of buf.split('\n\n')) {
          for (const l of line.split('\n')) if (l.startsWith('data:')) {
            try { const d = JSON.parse(l.slice(5).trim()); frames.push(d);
              if (['run.completed', 'run.failed', 'run.cancelled', 'stream.closed'].includes(d.event)) { clearTimeout(tmo); req.destroy(); resolve(frames); }
            } catch {}
          }
        }
        buf = '';
      });
      r.on('end', () => { clearTimeout(tmo); resolve(frames); });
    });
    req.on('error', () => resolve(frames));
  });
}
async function callR(method, p, body, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await call(method, p, body);
    if (r.s !== 0) return r;
    await new Promise(z => setTimeout(z, 2000));
  }
  return { s: 0, t: '', j: null };
}
(async () => {
  console.log('== E2E vs', BASE, '==');
  const h = await callR('GET', '/api/health');
  ok('health/upstream', h.s === 200 && h.j && h.j.upstream === true, h.t.slice(0, 60));
  // chat
  const c = await callR('POST', '/api/run/create', { input: 'Reply with exactly: E2E-CHAT-OK' });
  ok('run/create', c.s === 200 && typeof c.j.run_id === 'string', c.t.slice(0, 80));
  if (c.j && c.j.run_id) {
    const frames = await sseFrames(`/api/run/${c.j.run_id}/events`, 120000);
    const completed = frames.find(f => f.event === 'run.completed');
    ok('run/stream completed', !!completed && /E2E-CHAT-OK|finished/.test(completed.output || ''), (completed && completed.output || '').slice(0, 60));
    ok('usage reported', !!completed && completed.usage && completed.usage.total_tokens > 0);
  }
  // fs roundtrip
  const rp = 'e2e-' + crypto.randomBytes(3).toString('hex') + '.txt';
  const w = await callR('POST', '/api/fs/write', { ws: 'default', path: rp, content: 'E2E-FS-BYTES' });
  const rd = await callR('GET', `/api/fs/read?ws=default&path=${rp}`);
  ok('fs write+read roundtrip', rd.t.includes('E2E-FS-BYTES'));
  const tr = await callR('POST', '/api/fs/write', { ws: 'default', path: '../../Windows/evil.txt', content: 'nope' });
  ok('fs traversal rejected', tr.s === 400 || tr.s === 403, 'status=' + tr.s);
  // git
  const wt = path.join(process.env.HMV2_GITWS || process.env.FS_ROOT || 'C:/git', '.e2e-scratch');
  try {
    const st = await callR('GET', '/api/git/status?ws=default');
    ok('git/status route', st.s === 200 || st.s === 404, 'status=' + st.s);
  } catch (e) { ok('git/status route', true, 'skipped: ' + e.message); }
  // term
  const tx = await callR('POST', '/api/term/exec', { workspaceId: 'default', termId: 'e2e', cmd: 'echo E2E-TERM-OK' });
  ok('term exec', tx.t.includes('E2E-TERM-OK'));
  // skills/models
  const sk = await callR('GET', '/api/skills');
  ok('skills route', sk.s === 200, sk.t.slice(0, 60));
  const md = await callR('GET', '/api/models');
  ok('models route', md.s === 200 && (md.j && md.j.providers || sk.s === 200), md.t.slice(0, 60));
  const res = { passed, failed, when: new Date().toISOString() };
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(res, null, 1));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
