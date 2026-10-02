'use strict';
// files.test.js — unit tests for Workstream C (/api/fs/*). Zero-npm harness:
// spawns `node server/server.js` on scratch port 8293 with a scratch FS_ROOT
// workspace, exercises routes via plain http, kills server when done.
// Usage: node tests/unit/files.test.js
const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = process.env.HMV2_ROOT || path.resolve(__dirname, '..', '..');
const PORT = 8293;
const AUTH = process.env.AUTH_USER || 'noahd';
const PASS = 'testpass';
let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: {
        authorization: 'Basic ' + Buffer.from(`${AUTH}:${PASS}`).toString('base64'),
        ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let b = '';
      res.on('data', c => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch { return null; } })(), raw: b }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const get = (p) => req('GET', p);
const post = (p, body) => req('POST', p, body);

// URL-encode the path param but deliberately PRESERVE an encoded traversal
// example: rel = '..%2F' encodes to '..%252F' which decodes back to '..%2F'.
function enc(s) { return encodeURIComponent(s); }

(async () => {
  console.log('== Workstream C: /api/fs/* tests ==');
  const wsRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hm2-files-')), 'ws');
  fs.mkdirSync(path.join(wsRoot, 'sub', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, 'hello.txt'), 'alpha\nbeta\n');
  fs.writeFileSync(path.join(wsRoot, 'sub', 'nested', 'deep.js'), 'function f(){return 42}\n');
  fs.writeFileSync(path.join(wsRoot, 'sub', 'data.bin'), Buffer.from([0x4e, 0x00, 0x4f, 0x01, 0x50, 0x00, 0x51]));
  const nodeMod = path.join(wsRoot, 'sub', 'node_modules');
  fs.mkdirSync(nodeMod, { recursive: true });
  fs.writeFileSync(path.join(nodeMod, 'should-not-find.txt'), 'hidden');

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), AUTH_USER: AUTH, AUTH_PASS: PASS, FS_ROOT: wsRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  server.stdout.on('data', c => logs.push(c.toString()));
  server.stderr.on('data', c => logs.push(c.toString()));
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { await get('/api/health'); up = true; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  if (!up) { console.error('server never came up:\n' + logs.join('')); process.exit(1); }
  console.log(`server up on :${PORT} (workspace=${wsRoot})\n`);

  const WS = enc('default');
  try {
    // 1. list root — expects known files
    const l0 = await get(`/api/fs/list?ws=${WS}&path=`);
    ok('list root returns known files', l0.status === 200 && l0.json
      && (l0.json.files || []).some(f => f.name === 'hello.txt')
      && (l0.json.dirs || []).some(d => d.name === 'sub'),
      JSON.stringify(l0.json && { dirs: l0.json.dirs, files: l0.json.files }));
    ok('list includes size+mtime', l0.json.files.every(f => 'size' in f && 'mtime' in f));

    // 2. list subdir
    const l1 = await get(`/api/fs/list?ws=${WS}&path=${enc('sub')}`);
    ok('list sub shows nested dir', l1.json && l1.json.dirs.some(d => d.name === 'nested'));

    // 3. read round-trip
    const content = 'line-A\nline-B with ünïcode\nfinal';
    const w1 = await post('/api/fs/write', { ws: 'default', path: 'sub/round.txt', content });
    ok('write creates file', w1.status === 200 && w1.json && w1.json.ok, JSON.stringify(w1.json));
    const rd = await get(`/api/fs/read?ws=${WS}&path=${enc('sub/round.txt')}`);
    ok('read round-trip equals written content', rd.status === 200 && rd.json.content === content, JSON.stringify(rd.json && rd.json.content));
    ok('read reports size', rd.json.size === Buffer.byteLength(content), `size=${rd.json.size}`);
    ok('read not truncated/binary', rd.json.truncated === false && rd.json.binary === false);

    // 4. binary sniff
    const rb = await get(`/api/fs/read?ws=${WS}&path=${enc('sub/data.bin')}`);
    ok('binary file flagged binary:true', rb.status === 200 && rb.json.binary === true, JSON.stringify(rb.json));

    // 5. traversal rejected at both shapes → 400
    const t1 = await get(`/api/fs/read?ws=${WS}&path=${enc(enc('../outside.txt'))}`);
    ok('traversal ..%2F read → 400', t1.status === 400, `status=${t1.status}`);
    const t1b = await get(`/api/fs/read?ws=${WS}&path=${enc('..%2Foutside.txt')}`);
    ok('traversal literal ..%2F read → 400', t1b.status === 400, `status=${t1b.status}`);
    const t2 = await get(`/api/fs/list?ws=${WS}&path=${enc('../')}`);
    ok('traversal list → 400', t2.status === 400);
    const t3 = await post('/api/fs/write', { ws: 'default', path: '../evil.txt', content: 'x' });
    ok('traversal write → 400', t3.status === 400, `status=${t3.status}`);
    const t4 = await post('/api/fs/move', { ws: 'default', from: 'hello.txt', to: '../outside.txt' });
    ok('traversal move → 400', t4.status === 400);
    const leaked = fs.existsSync(path.join(wsRoot, '..', 'outside.txt')) || fs.existsSync(path.join(wsRoot, '..', 'evil.txt'));
    ok('no file materialized outside workspace', !leaked);

    // 6. mkdir + delete empty dir
    const m1 = await post('/api/fs/mkdir', { ws: 'default', path: 'sub/newdir' });
    ok('mkdir ok', m1.status === 200 && m1.json.ok, JSON.stringify(m1.json));
    const l2 = await get(`/api/fs/list?ws=${WS}&path=${enc('sub')}`);
    ok('mkdir visible in listing', l2.json.dirs.some(d => d.name === 'newdir'));
    const d1 = await post('/api/fs/delete', { ws: 'default', path: 'sub/newdir' });
    ok('delete empty dir ok', d1.status === 200 && d1.json.ok);
    const d1b = await post('/api/fs/delete', { ws: 'default', path: 'sub/newdir' });
    ok('delete missing → 404', d1b.status === 404);

    // 7. delete file
    const d2 = await post('/api/fs/delete', { ws: 'default', path: 'hello.txt' });
    ok('delete file ok', d2.status === 200);
    const l3 = await get(`/api/fs/list?ws=${WS}&path=`);
    ok('deleted file gone from listing', !(l3.json.files || []).some(f => f.name === 'hello.txt'));

    // 8. move (rename)
    const w2 = await post('/api/fs/write', { ws: 'default', path: 'moveme.txt', content: 'movable' });
    ok('write moveme.txt', w2.json && w2.json.ok);
    const mv = await post('/api/fs/move', { ws: 'default', from: 'moveme.txt', to: 'sub/moved.txt' });
    ok('move renames file', mv.status === 200 && mv.json.ok, JSON.stringify(mv.json));
    const rd2 = await get(`/api/fs/read?ws=${WS}&path=${enc('sub/moved.txt')}`);
    ok('moved content intact', rd2.status === 200 && rd2.json.content === 'movable');
    const rd3 = await get(`/api/fs/read?ws=${WS}&path=${enc('moveme.txt')}`);
    ok('original gone after move → 404', rd3.status === 404, `status=${rd3.status}`);

    // 9. search finds nested file, skips node_modules
    const s1 = await get(`/api/fs/search?ws=${WS}&q=${enc('deep')}`);
    ok('search finds nested deep.js', s1.json.results.includes('sub/nested/deep.js'), JSON.stringify(s1.json.results));
    const s2 = await get(`/api/fs/search?ws=${WS}&q=${enc('should-not-find')}`);
    ok('search skips node_modules', s2.json.results.length === 0, JSON.stringify(s2.json.results));

    // 10. read nonexistent + write validation
    const r404 = await get(`/api/fs/read?ws=${WS}&path=${enc('nope.txt')}`);
    ok('read missing → 404', r404.status === 404);
    const wbad = await post('/api/fs/write', { ws: 'default', path: 'x.txt' });
    ok('write without content → 400', wbad.status === 400, `status=${wbad.status}`);

    // 11. 1MB cap
    const big = 'x'.repeat(1024 * 1024 + 1);
    const wbig = await post('/api/fs/write', { ws: 'default', path: 'big.txt', content: big });
    ok('write >1MB → 413', wbig.status === 413, `status=${wbig.status}`);

    // 12. security: writes inside workspace root never escape — nested with ..
    // (resolveInWorkspace blocks mid-path traversal)
    const tw = await post('/api/fs/write', { ws: 'default', path: 'sub/../../evil.txt', content: 'x' });
    ok('mid-path traversal write → 400', tw.status === 400, `status=${tw.status}`);
  } catch (e) {
    failed++; console.error('EXCEPTION:', e);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  server.kill('SIGKILL');
  try { execSync('taskkill /pid ' + server.pid + ' /T /F', { stdio: 'ignore', windowsHide: true }); } catch {}
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
