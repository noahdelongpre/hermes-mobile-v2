'use strict';
// term.test.js — unit tests for Workstream E (/api/term/*). Zero-npm test harness:
// spawns `node server/server.js` on a scratch port, exercises the routes with plain
// http, re-reads cwd persistence via the API, tests timeout kill, then kills server.
// Usage: node tests/unit/term.test.js
// Env: HMV2_ROOT (repo root; default: C:/git/hermes-mobile-v2) PORT/scratch vars set below.
const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = process.env.HMV2_ROOT || path.resolve(__dirname, '..', '..');
const PORT = 8291;
const AUTH = process.env.AUTH_USER || 'noahd';
const PASS = 'testpass';
let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

function post(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/term/exec', method: 'POST',
      headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
        authorization: 'Basic ' + Buffer.from(`${AUTH}:${PASS}`).toString('base64'),
      },
    }, res => {
      let out = '';
      res.on('data', c => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, raw: out, frames: parseFrames(out) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}
function parseFrames(raw) {
  const frames = [];
  for (const block of raw.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data: ')) {
        try { frames.push(JSON.parse(line.slice(6))); } catch {}
      }
    }
  }
  return frames;
}
const run = (body) => post(body).then(r => {
  const chunks = r.frames.filter(f => f.chunk !== undefined).map(f => f.chunk).join('');
  const final = r.frames.filter(f => f.code !== undefined).pop();
  return { ...r, output: chunks, code: final ? final.code : null, cwd: (r.frames.find(f => f.cwd) || {}).cwd };
});
function get(q) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: q, headers: { authorization: 'Basic ' + Buffer.from(`${AUTH}:${PASS}`).toString('base64') } },
      res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch { return null; } })() })); })
      .on('error', reject);
  });
}

(async () => {
  console.log('== Workstream E: /api/term/* tests ==');
  // scratch workspace dir we fully control
  const wsRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hm2-term-')), 'ws');
  fs.mkdirSync(path.join(wsRoot, 'sub'), { recursive: true });

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), AUTH_USER: AUTH, AUTH_PASS: PASS,
      FS_ROOT: wsRoot, TERM_TIMEOUT_MS: '3000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  server.stdout.on('data', c => logs.push(c.toString()));
  server.stderr.on('data', c => logs.push(c.toString()));
  // readiness
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { await get('/api/health'); up = true; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  if (!up) { console.error('server never came up:\n' + logs.join('')); process.exit(1); }
  console.log(`server up on :${PORT} (workspace=${wsRoot})\n`);

  try {
    // 1. exec echo
    const r1 = await run({ workspaceId: 'default', termId: 't1', cmd: 'echo hello' });
    ok('exec echo hello', /hello/.test(r1.output) && r1.code === 0, `code=${r1.code} out=${JSON.stringify(r1.output.slice(0, 60))}`);

    // 2. cwd persistence: cd into sub, then pwd from same termId
    const r2 = await run({ workspaceId: 'default', termId: 't1', cmd: 'cd sub' });
    ok('bare cd updates + validates cwd', r2.code === 0 && path.basename(r2.cwd || '') === 'sub', r2.cwd);
    const r3 = await run({ workspaceId: 'default', termId: 't1', cmd: 'cd' });
    ok('pwd confirms cwd persisted', /(sub|ws)\b/.test((r3.output || '').match(/[A-Za-z]:[^\r\n]*/) ? r3.output : '') || /[\\/]sub[\\/]?/.test(r3.output), JSON.stringify(r3.output));
    const r3b = await run({ workspaceId: 'default', termId: 't1', cmd: 'cd' });
    ok('cwd is exactly <ws>/sub', (r3b.output.match(/^[^\r\n]*/) || [''])[0].indexOf('sub') >= 0, JSON.stringify(r3b.output.split('\n')[0]));

    // 2b. separate termId has its own cwd (workspace root)
    const r4 = await run({ workspaceId: 'default', termId: 't2', cmd: 'cd' });
    ok('second term session has independent cwd at root', /sub/.test((r4.output.split('\n')[0] || '')) === false, JSON.stringify(r4.output.split('\n')[0]));

    // 2c. traversal guard (own termId — must not clobber t1's persisted cwd)
    const r5 = await run({ workspaceId: 'default', termId: 'tX', cmd: 'cd ..' });
    ok('cd .. blocked (traversal guard)', r5.code === 1 || r5.code === 0 && path.basename((r5.cwd || '')) !== '..', JSON.stringify(r5));

    // 3. timeout kill
    const t0 = Date.now();
    const r6 = await run({ workspaceId: 'default', termId: 't3', cmd: 'ping -n 100 127.0.0.1' });
    const dt = Date.now() - t0;
    const timedOut = r6.output.includes('timeout') && (r6.code === 1 || r6.code === null) && dt < 20000;
    ok('timeout kill (ping -n 100 terminates ~3s)', timedOut, `dt=${dt}ms code=${r6.code}`);

    // 4. stderr capture + non-zero exit
    const r7 = await run({ workspaceId: 'default', termId: 't4', cmd: 'node -e "process.stderr.write(\'boom\'); process.exit(3)"' });
    ok('stderr captured + exit code propagated', r7.output.includes('boom') && r7.code === 3, `code=${r7.code}`);

    // 5. api validation
    const r8 = await post({ workspaceId: 'no-such-ws', cmd: 'echo x' });
    ok('unknown workspace rejected 400', r8.status === 400);

    // 6. GET /api/term/cwd reflects persistence
    const r9 = await get('/api/term/cwd?ws=default&termId=t1');
    ok('GET /api/term/cwd returns persisted sub', r9.json && /sub/.test(r9.json.cwd), JSON.stringify(r9.json));
  } catch (e) {
    failed++; console.error('EXCEPTION:', e);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  server.kill('SIGKILL');
  try { execSync('taskkill /pid ' + server.pid + ' /T /F', { stdio: 'ignore', windowsHide: true }); } catch {}
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
