'use strict';
// tests/unit/git.test.js — Workstream D server-side tests.
// Spawns the REAL server (like slash.test.js) on scratch port 8295, points
// workspace 'default' at a TEMP scratch git repo seeded via
// state/workspaces.json (restored after), and exercises the /api/git/* routes
// through plain http. Zero npm deps. Usage: node tests/unit/git.test.js
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = process.env.HMV2_ROOT || path.resolve(__dirname, '..', '..');
const PORT = 8295;
const STATE = path.join(ROOT, 'state');
const WSJSON = path.join(STATE, 'workspaces.json');

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: body ? { 'content-type': 'application/json' } : {},
    }, res => {
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
function git(args, cwd) {
  return execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim();
}

(async () => {
  // ---- scratch git repo in state/tmp --------------------------------
  const tmp = path.join(STATE, 'tmp', 'git-test-' + Date.now());
  fs.mkdirSync(path.join(tmp, 'sub'), { recursive: true });
  git(['init', '-b', 'main'], tmp);
  git(['config', 'user.email', 't@t'], tmp);
  git(['config', 'user.name', 'Test'], tmp);
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'line1\nline2\n');
  fs.writeFileSync(path.join(tmp, 'sub', 'b.txt'), 'bee one\nbee two\nbee three\n');
  git(['add', '.'], tmp);
  git(['commit', '-m', 'init commit'], tmp);
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'line1\nline2 CHANGED\nnew line3\n');
  fs.writeFileSync(path.join(tmp, 'untracked.txt'), 'u\n');
  git(['branch', 'feature/x'], tmp);

  // ---- workspaces.json seed (restore after) --------------------------
  let prior = null;
  try { prior = JSON.parse(fs.readFileSync(WSJSON, 'utf8')); } catch {}
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(WSJSON, JSON.stringify({ ...(prior || {}), default: tmp }));

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), AUTH_PASS: '', FS_ROOT: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  server.stdout.on('data', d => (srvOut += d));
  server.stderr.on('data', d => (srvOut += d));
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { const r = await req('GET', '/api/health'); if (r.status === 200) up = true; } catch {}
      if (!up) await new Promise(rs => setTimeout(rs, 100));
    }
    ok('server on :8295 healthy', up);
    ok('git_routes module registered', /module git_routes\.js registered/.test(srvOut),
      srvOut.split('\n').filter(l => l.includes('module')).join(' | ').slice(0, 200));

    // --- status -------------------------------------------------------
    const st1 = json(await req('GET', '/api/git/status?ws=default'));
    ok('status 200 body shape', Array.isArray(st1.files) && typeof st1.branch === 'string',
       'branch=' + st1.branch);
    ok('status sees modified a.txt', st1.files.some(f => f.file === 'a.txt'),
       JSON.stringify(st1.files));
    ok('status sees untracked.txt', st1.files.some(f => f.file === 'untracked.txt'));
    const aRow = st1.files.find(f => f.file === 'a.txt');
    ok('a.txt shows unstaged modified', aRow && /M|untracked|modified/.test(JSON.stringify(aRow)),
       JSON.stringify(aRow));

    // --- diff ----------------------------------------------------------
    const d1 = json(await req('GET', '/api/git/diff?ws=default&path=a.txt'));
    ok('diff 200 has diff text', d1 && typeof d1.diff === 'string' && d1.diff.length > 0,
       (d1.diff || '').split('\n').slice(0, 4).join(' | ').slice(0, 160));
    ok('diff is git unified format w/ hunks', /@@/.test(d1.diff) && /\+line2 CHANGED/.test(d1.diff));

    // --- log -----------------------------------------------------------
    const l1 = json(await req('GET', '/api/git/log?ws=default'));
    ok('log 200 one commit', l1.commits.length === 1, 'subject=' + (l1.commits[0] && l1.commits[0].subject));

    // --- branch list ----------------------------------------------------
    const br1 = json(await req('GET', '/api/git/branch?ws=default'));
    ok('branch list has main + feature/x',
       br1.branches.includes('main') && br1.branches.includes('feature/x') && br1.current === 'main',
       JSON.stringify(br1));

    // --- stage / status after stage ------------------------------------
    const s1 = json(await req('POST', '/api/git/stage?ws=default', { files: ['a.txt', 'sub/b.txt'] }));
    ok('stage 200', s1.ok === true, JSON.stringify(s1));
    const st2 = json(await req('GET', '/api/git/status?ws=default'));
    const a2 = st2.files.find(f => f.file === 'a.txt');
    ok('a.txt now staged (staged modified, clean worktree)',
       a2 && a2.staged === 'modified' && !a2.unstaged, JSON.stringify(a2));

    // staged diff
    const d2 = json(await req('GET', '/api/git/diff?ws=default&path=a.txt&staged=1'));
    ok('staged diff has change', d2 && /\+line2 CHANGED/.test(d2.diff));

    // --- commit ---------------------------------------------------------
    const c1 = json(await req('POST', '/api/git/commit?ws=default', { message: 'test: stage+commit via api' }));
    ok('commit 200 w/ sha', c1.ok === true && typeof c1.commit === 'string' && c1.commit.length >= 7,
       JSON.stringify(c1));
    const st3 = json(await req('GET', '/api/git/status?ws=default'));
    ok('a.txt gone from status after commit', !st3.files.some(f => f.file === 'a.txt'),
       JSON.stringify(st3.files));
    const l2 = json(await req('GET', '/api/git/log?ws=default'));
    ok('log now 2 commits w/ our subject', l2.commits.length === 2 && /stage\+commit via api/.test(l2.commits[0].subject),
       l2.commits.map(c => c.subject).join(' | '));
    ok('log card shape {hash,short,author,ts,subject}',
       !!l2.commits[0] && l2.commits[0].short.length <= 12 && typeof l2.commits[0].ts === 'number');

    // --- branch switch ---------------------------------------------------
    const b2 = json(await req('POST', '/api/git/branch?ws=default', { branch: 'feature/x' }));
    ok('branch switch to feature/x ok', b2.ok === true && b2.current === 'feature/x', JSON.stringify(b2));
    const br2 = json(await req('GET', '/api/git/branch?ws=default'));
    ok('branch list now current=feature/x', br2.current === 'feature/x', JSON.stringify(br2));
    const b3 = json(await req('POST', '/api/git/branch?ws=default', { branch: 'main' }));
    ok('branch switch back to main', b3.ok === true && b3.current === 'main', JSON.stringify(b3));

    // --- security / negative paths ---------------------------------------
    const b4 = json(await req('POST', '/api/git/branch?ws=default', { branch: '-oProxyCommand=evil' }));
    ok('branch switch rejects flag-injection name (400 invalid branch name)',
       b4 && b4.error === 'invalid branch name', JSON.stringify(b4));
    const stX = json(await req('POST', '/api/git/stage?ws=default', { files: ['../outside.txt'] }));
    ok('stage rejects .. traversal (400)', stX && stX.error === 'invalid path: ../outside.txt', JSON.stringify(stX));
    const stY = json(await req('POST', '/api/git/stage?ws=default', { files: ['--upload-pack=crazy'] }));
    ok('stage rejects flag-like path (400)', stY && !!stY.error, JSON.stringify(stY));
    // commit with empty message
    const c2 = json(await req('POST', '/api/git/commit?ws=default', { message: '   ' }));
    ok('commit empty message 400', c2 && !!c2.error, JSON.stringify(c2));
    // commit with explicit files stage-then-commit
    fs.writeFileSync(path.join(tmp, 'fresh.txt'), 'f1\n');
    const c3 = json(await req('POST', '/api/git/commit?ws=default', { message: 'test: file-scoped commit', files: ['fresh.txt'] }));
    ok('commit with files param 200', c3.ok === true && typeof c3.commit === 'string', JSON.stringify(c3));
    const st4 = json(await req('GET', '/api/git/status?ws=default'));
    ok('fresh.txt committed, not in status', !st4.files.some(f => f.file === 'fresh.txt'),
       JSON.stringify(st4.files));

    // --- non-git workspace ------------------------------------------------
    // Point `default` at a fresh NON-git dir (server is dead-reading? no: the
    // workspaces.json reseed trick needs a live server; instead use ws param of
    // another negative path — ws=nonexistent-resolves-to-default). Simplest:
    // reseed workspaces.json mid-flight won't reload. So test ws that no longer
    // exists in map: resolveInWorkspace falls back to default workspace (which
    // here IS the scratch git repo). Cover the not-a-repo branch directly:
    const nodir = path.join(STATE, 'tmp', 'not-a-git-repo-' + Date.now());
    fs.mkdirSync(nodir, { recursive: true });
    // can't re-seed live map... but we CAN register a second workspace by POST /api/settings
    const s2r = json(await req('POST', '/api/settings', { action: 'addWorkspace', id: 'nogit', root: nodir }));
    const r1 = await req('GET', '/api/git/status?ws=nogit');
    const j1 = json(r1);
    ok('non-git workspace → 404 with clear error', r1.status === 404 && /not a git repository/.test(j1.error || ''),
       `status=${r1.status} ${JSON.stringify(j1)}`);
    // cleanup extra workspace
    await req('POST', '/api/settings', { action: 'delWorkspace', id: 'nogit' });
    try { fs.rmSync(nodir, { recursive: true, force: true }); } catch {}
  } catch (e) {
    failed++; console.error('EXCEPTION:', e);
  } finally {
    server.kill('SIGKILL');
    const { execSync } = require('child_process');
    try { execSync('taskkill /pid ' + server.pid + ' /T /F', { stdio: 'ignore', windowsHide: true }); } catch {}
    // restore workspaces.json
    if (prior) fs.writeFileSync(WSJSON, JSON.stringify(prior, null, 2));
    else fs.rmSync(WSJSON, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
