'use strict';
// git_routes.js — workstream D: git explorer routes. Zero deps, plain git CLI.
// Security: NO user text is ever interpolated into a shell string. Every git
// invocation is execFile-style: execGit(cwd, [args...]) — argv array only, cwd
// = workspace root. Client-supplied paths run behind a literal `--` guard, and
// GIT_LITERAL_PATHSPECS=1 keeps glob-ish filenames from becoming pathspecs.
// Workspaces with no .git get a clear 404.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const sl = (u, k) => u.query.get(k);
const KIND = { A: 'added', M: 'modified', D: 'deleted', T: 'typechange', R: 'renamed', C: 'copied', U: 'conflict' };

module.exports = { register(app) {
  const ctx = app.ctx;
  const GIT_TIMEOUT = 15000;

  // Run git in a workspace. argv is a trusted array; user text only ever
  // appears as whole array elements (never inside a shell line).
  function execGit(cwd, args, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      execFile('git', args, {
        cwd, timeout: GIT_TIMEOUT, windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0',
          ...(opts.literalPaths ? { GIT_LITERAL_PATHSPECS: '1' } : {}) },
      }, (err, stdout, stderr) => {
        if (err && !opts.allowNonZero) {
          resolve({ ok: false, code: err.code || 1, stdout: String(stdout || ''),
            stderr: String(stderr || err.message) });
        } else {
          resolve({ ok: true, code: err ? (err.code || 0) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
        }
      });
    });
  }

  // Resolve ws param → absolute dir; 404 with a clear error when not a repo.
  async function wsGit(req, res) {
    const ws = sl(req, 'ws') || 'default';
    const root = ctx.resolveInWorkspace(ws, '');
    if (!root) { res.status(400).json({ error: 'bad workspace' }); return null; }
    if (!fs.existsSync(path.join(root, '.git'))) {
      res.status(404).json({ error: `workspace '${ws}' is not a git repository`, workspace: root });
      return null;
    }
    return root;
  }

  // porcelain-v2 -z single record path extraction.
  // 1 XY sub mH mI mW hH hI <path>  → path idx 8+
  // 2 XY ... Xscore <path>          → path idx 9+ (origPath arrives as its own '\0' item)
  // u XY ... h3 <path>              → path idx 10+
  function recordPath(parts) {
    const idx = parts[0] === '2' ? 9 : parts[0] === 'u' ? 10 : 8;
    return parts.slice(idx).join(' ');
  }

  // ---- GET /api/git/status ------------------------------------------
  app.get('/api/git/status', async (req, res) => {
    const root = await wsGit(req, res); if (!root) return;
    const r = await execGit(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
    if (!r.ok) return res.status(500).json({ error: (r.stderr || 'git status failed').trim() });
    let branch = null, ahead = 0, behind = 0;
    const files = [];
    for (const it of r.stdout.split('\0')) {
      if (!it) continue;
      if (it.startsWith('# branch.head ')) branch = it.slice(14).trim();
      else if (it.startsWith('# branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(it);
        if (m) { ahead = +m[1]; behind = +m[2]; }
      } else if (it.startsWith('? ')) {
        files.push({ file: it.slice(2), staged: '', unstaged: 'untracked' });
      } else if (it.startsWith('1 ') || it.startsWith('2 ') || it.startsWith('u ')) {
        const p = it.split(' ');
        const xy = p[1];
        const file = recordPath(p);
        files.push({
          file,
          staged: xy[0] !== '.' ? (KIND[xy[0]] || xy[0]) : '',
          unstaged: xy[1] !== '.' ? (KIND[xy[1]] || (xy[1] === '?' ? 'untracked' : xy[1])) : '',
        });
      }
      // skip other # headers and rename origPath items
    }
    files.sort((a, b) => a.file.localeCompare(b.file));
    res.json({ branch, ahead, behind, files });
  });

  // ---- GET /api/git/diff?ws=&path=&staged=1 --------------------------
  app.get('/api/git/diff', async (req, res) => {
    const root = await wsGit(req, res); if (!root) return;
    const p = sl(req, 'path');
    const args = ['diff', '--no-color', '-U3', '--no-ext-diff'];
    if (sl(req, 'staged') === '1') args.push('--cached');
    args.push('--');
    if (p) args.push(p);
    const r = await execGit(root, args);
    if (!r.ok) return res.status(500).json({ error: (r.stderr || 'git diff failed').trim() });
    res.json({ diff: r.stdout.replace(/\r\n/g, '\n').trim(), path: p || null, staged: sl(req, 'staged') === '1' });
  });

  // ---- GET /api/git/log?ws=&n= ---------------------------------------
  app.get('/api/git/log', async (req, res) => {
    const root = await wsGit(req, res); if (!root) return;
    let n = parseInt(sl(req, 'n') || '20', 10);
    if (!Number.isFinite(n) || n < 1) n = 20;
    if (n > 100) n = 100;
    const r = await execGit(root, ['log', '-z', '-n', String(n),
      '--pretty=format:%H%x09%h%x09%an%x09%at%x09%s'], { allowNonZero: true });
    if (!r.ok || /fatal/.test(r.stderr)) {
      // unborn HEAD (no commits yet) is not an error for the UI
      return res.json({ commits: [], empty: true });
    }
    const commits = r.stdout.split('\0').filter(Boolean).map(rec => {
      const m = rec.split('\t');
      return { hash: m[0], short: m[1], author: m[2], ts: +m[3] || 0, subject: m.slice(4).join('\t') };
    });
    res.json({ commits, empty: false });
  });

  // ---- GET /api/git/branch (list) — POST /api/git/branch (switch) ----
  app.get('/api/git/branch', async (req, res) => {
    const root = await wsGit(req, res); if (!root) return;
    const r = await execGit(root, ['for-each-ref', 'refs/heads',
      '--format=%(HEAD)%(refname)']);
    if (!r.ok) return res.status(500).json({ error: (r.stderr || 'git branch failed').trim() });
    let current = null;
    const branches = [];
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      const cur = line.startsWith('*');
      const name = line.replace(/^\*/, '').trim();
      branches.push(name.replace(/^refs\/heads\//, ''));
      if (cur) current = name.replace(/^refs\/heads\//, '');
    }
    branches.sort((a, b) => a.localeCompare(b));
    res.json({ branches, current });
  });

  app.post('/api/git/branch', async (req, res) => {
    const root = await wsGit(req, res); if (!root) return;
    const body = req.body || {};
    if (typeof body.branch !== 'string' || !body.branch.trim()) {
      return res.status(400).json({ error: "field 'branch' required" });
    }
    const branch = body.branch.trim();
    if (!/^[^\s~^:?*[\\]+$/.test(branch) || branch.startsWith('-') || branch.endsWith('.lock')) {
      return res.status(400).json({ error: 'invalid branch name' });
    }
    // `git switch --` (modern); one fallback to `checkout` for ancient git.
    let r = await execGit(root, ['switch', '--', branch], { allowNonZero: true });
    if (!r.ok) r = await execGit(root, ['checkout', '--', branch], { allowNonZero: true });
    if (!r.ok) return res.status(400).json({ error: (r.stderr || 'branch switch failed').trim().split('\n').pop() });
    const who = await execGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    res.json({ ok: true, current: (who.stdout || '').trim() || branch });
  });

  // ---- POST /api/git/stage {files:[...], unstage?:true} ---------------
  app.post('/api/git/stage', async (req, res) => {
    const root = await wsGit(req, res); if (!root) return;
    const body = req.body || {};
    if (!Array.isArray(body.files) || !body.files.length) {
      return res.status(400).json({ error: "field 'files' (array) required" });
    }
    const files = body.files;
    if (files.length > 200) return res.status(413).json({ error: 'too many files (max 200)' });
    for (const f of files) {
      if (typeof f !== 'string' || !f.trim() || f.includes('..') || f.startsWith('-') || f.length > 400) {
        return res.status(400).json({ error: `invalid path: ${String(f).slice(0, 60)}` });
      }
    }
    const args = body.unstage ? ['reset', '-q', '--'] : ['add', '--'];
    args.push(...files);
    const r = await execGit(root, args, { literalPaths: true });
    if (!r.ok) return res.status(500).json({ error: (r.stderr || 'git add failed').trim().split('\n').pop() });
    res.json({ ok: true, op: body.unstage ? 'unstage' : 'stage', count: files.length });
  });

  // ---- POST /api/git/commit {message, files?:[...]} -------------------
  // files present → stage exactly those first (commit -m, no editor).
  app.post('/api/git/commit', async (req, res) => {
    const root = await wsGit(req, res); if (!root) return;
    const body = req.body || {};
    if (typeof body.message !== 'string' || !body.message.trim()) {
      return res.status(400).json({ error: "field 'message' required" });
    }
    const msg = body.message.trim();
    if (msg.length > 300) return res.status(400).json({ error: 'message too long (max 300)' });
    if (body.files != null) {
      if (!Array.isArray(body.files) || !body.files.length) {
        return res.status(400).json({ error: "field 'files' must be a non-empty array when present" });
      }
      const st = await execGit(root, ['add', '--'].concat(body.files), { literalPaths: true });
      if (!st.ok) return res.status(500).json({ error: (st.stderr || 'git add failed').trim().split('\n').pop() });
    }
    const r = await execGit(root, ['commit', '-m', msg], { allowNonZero: true });
    if (!r.ok) {
      const errLine = (r.stderr || '').trim().split('\n').pop();
      return res.status(400).json({ error: errLine || 'commit failed' });
    }
    const sha = await execGit(root, ['rev-parse', '--short', 'HEAD']);
    res.json({ ok: true, commit: (sha.stdout || '').trim(), message: msg });
  });
} };
