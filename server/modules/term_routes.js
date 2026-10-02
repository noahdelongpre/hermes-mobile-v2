'use strict';
// term_routes.js — Workstream E: PTY-free one-shot exec with streaming + per-term cwd.
// Zero npm deps. Stream protocol: SSE frames {chunk: text} while the child runs,
// then final {code: N} and close. First frame is {cwd: <abs>} so the client can
// echo a prompt line.
//
// NON-GOAL (wave 1): real PTY / interactive programs (vim, top, REPL stdin).
// Each exec is a fresh child spawned with shell:true and stdin closed — programs
// that read stdin see EOF. Wave-2 option per FEATURES.md §E: node-pty/ConPTY via a
// docker build arg.
//
// cwd persistence model: server-side Map "<workspaceId>:<termId>" -> abs cwd.
// After a command completes, if it *starts* with a `cd <dir>` (bare or as the first
// `&&` segment), and that dir validates, the stored cwd is pre-jumped before the
// remainder runs (so `cd sub && pwd` works as a shell would). LIMITATION (documented):
// directory changes performed by the child process itself (e.g. `pushd`, a script
// that cd's internally, `cd x & cd y` with &) are NOT tracked — we only parse a
// leading `cd`. Bare `cd` goes to the workspace root. Cwd is persisted to
// state/term_cwd.json so sessions survive server restarts.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_OUTPUT = 200 * 1024; // cap: drop chunks beyond 200KB
const TMO_MS = Number(process.env.TERM_TIMEOUT_MS) || 60_000;         // hard kill
// (TERM_TIMEOUT_MS exists for tests; default 60s per spec)

module.exports = { register(app) {
  const { workspaces, stateDir, log } = app.ctx;
  const cwdStore = new Map();
  const cwdFile = path.join(stateDir, 'term_cwd.json');
  try {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(cwdFile, 'utf8')))) cwdStore.set(k, v);
  } catch {}
  const saveCwds = () => { try { fs.writeFileSync(cwdFile, JSON.stringify(Object.fromEntries(cwdStore))); } catch {} };

  function rootOf(wsId) {
    // NO silent fallback: unknown workspace must 400 (validation, and avoids
    // accidentally running commands in a workspace the caller didn't select).
    if (wsId && !workspaces.has(wsId)) return null;
    const root = workspaces.get(wsId || 'default');
    return root ? path.resolve(root) : null;
  }
  // dir must be root itself or inside it — rejects .. traversal to foreign paths
  function inside(root, dir) {
    const abs = path.resolve(dir);
    return abs === root || abs.startsWith(root + path.sep);
  }

  app.post('/api/term/exec', async (req, res) => {
    const { workspaceId, termId = 'main', cmd } = req.body || {};
    if (typeof cmd !== 'string' || !cmd.trim()) return res.status(400).json({ error: 'cmd required' });
    const root = rootOf(workspaceId);
    if (!root) return res.status(400).json({ error: 'unknown workspace' });

    let cwd = cwdStore.get(`${workspaceId}:${termId}`);
    if (!cwd || !fs.existsSync(cwd) || !inside(root, cwd)) cwd = root;

    // Parse a LEADING `cd <dir>` (possibly `cd <dir> && rest`).
    const segs = cmd.split('&&').map(s => s.trim()).filter(Boolean);
    let runCmd = cmd;
    let cdLogged = null;
    if (segs[0] && /^cd(\s|$)/.test(segs[0])) {
      let arg = segs[0].replace(/^cd\s*/, '').replace(/^["']+|["']+$/g, '').trim();
      const target = arg ? path.resolve(cwd, arg) : root;
      const rest = segs.slice(1);
      if (rest.length) {
        if (!inside(root, target) || !fs.existsSync(target)) {
          const s = res.sse();
          s.send({ cwd });
          s.send({ chunk: `cd: no such directory (outside workspace?): ${arg || '/'}\n` });
          s.send({ code: 1 }); s.close();
          return;
        }
        cwd = target; cdLogged = arg || '/';
        runCmd = rest.join('&&'); // child's cwd already pre-jumped
      } else if (arg) {
        // `cd <dir>` with nothing else: change + persist cwd (like a shell would)
        if (!inside(root, target) || !fs.existsSync(target)) {
          const s = res.sse();
          s.send({ cwd });
          s.send({ chunk: `cd: no such directory (outside workspace?): ${arg}\n` });
          s.send({ code: 1 }); s.close();
          return;
        }
        cwdStore.set(`${workspaceId}:${termId}`, target);
        saveCwds();
        const s = res.sse();
        s.send({ cwd: target });
        s.send({ chunk: `(cwd → ${target})\n` });
        s.send({ code: 0 }); s.close();
        return;
      } else {
        // truly bare `cd`: report only, never change (would wipe anchors)
        const s = res.sse();
        s.send({ cwd });
        s.send({ chunk: `(cwd → ${cwd})\n` });
        s.send({ code: 0 }); s.close();
        return;
      }
    }

    const started = Date.now();
    log(`term ${termId}@${workspaceId} cwd=${cwd} cmd=${runCmd.slice(0, 100)}`);
    const s = res.sse();
    s.send({ cwd });
    if (cdLogged !== null) s.send({ chunk: `(cwd → ${cwd})\n` });

    const out = await runChild(runCmd, cwd, s);
    const code = out.code;
    s.send({ code }); s.close();
    log(`term done code=${code} in ${Date.now() - started}ms (${out.bytes} bytes)`);
  });

  // Spawn + stream chunks as SSE, cap 200KB, timeout-kill at 60s.
  function runChild(cmd, cwd, s) {
    return new Promise(resolve => {
      let bytes = 0, truncated = false, settled = false;
      const child = spawn(cmd, {
        shell: true, cwd, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], // stdin EOF: one-shot exec, no PTY
        env: { ...process.env, TERM: 'dumb' },
      });
      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        resolve({ code, bytes, truncated });
      };
      const push = (buf) => {
        if (!buf || !buf.length) return;
        bytes += buf.length;
        if (bytes <= MAX_OUTPUT) s.send({ chunk: buf.toString('utf8') });
        else if (!truncated) { truncated = true; s.send({ chunk: '\n[output truncated at 200KB cap]\n' }); }
      };
      child.stdout.on('data', push);
      child.stderr.on('data', push);
      const killer = setTimeout(() => {
        s.send({ chunk: `\n[timeout: killed after ${TMO_MS / 1000}s]\n` });
        killTree(child);
        // close may be delayed by taskkill; force settle shortly
        setTimeout(() => finish(null), 5000);
      }, TMO_MS);
      child.on('error', e => { s.send({ chunk: `spawn error: ${e.message}\n` }); finish(127); });
      child.on('close', code => finish(code === null ? 1 : code));
    });
  }

  function killTree(child) {
    if (process.platform === 'win32') {
      if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    }
  }

  // Current cwd of a term session (for reconnecting clients / tabs)
  app.get('/api/term/cwd', (req, res) => {
    const ws = req.query.get('ws') || 'default';
    const termId = req.query.get('termId') || 'main';
    const root = rootOf(ws);
    if (!root) return res.status(400).json({ error: 'unknown workspace' });
    let cwd = cwdStore.get(`${ws}:${termId}`);
    if (!cwd || !inside(root, cwd)) cwd = root;
    res.json({ cwd, workspaceId: ws });
  });
} };
