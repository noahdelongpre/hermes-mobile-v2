'use strict';
// fs_routes.js — workstream C: workspace file system routes. Zero deps, stock fs.
// ALL paths resolved via ctx.resolveInWorkspace(ws, rel) → null = traversal → 400.
const fs = require('fs');
const path = require('path');
const fsp = fs.promises;

const sl = (u, k) => u.query.get(k);
const SLASH = p => p.replace(/\\/g, '/');
module.exports = { register(app) {
  const ctx = app.ctx;

  function checkRel(res, rel) {
    // catch encoded traversal that resolveInWorkspace cannot see: raw '..' inside
    // the REL string itself (any case, any separator style) → 400 BEFORE resolution.
    const r = String(rel || '').toLowerCase();
    if (r.includes('..') || r.includes('%2e') || r.includes('\\')) {
      res.status(400).json({ error: 'path traversal rejected' });
      return false;
    }
    return true;
  }

  function wsRes(req, res) {
    const ws = sl(req, 'ws');
    const rel = sl(req, 'path') || '';
    if (!checkRel(res, rel)) return null;
    const abs = ctx.resolveInWorkspace(ws || 'default', rel);
    if (!abs) { res.status(400).json({ error: 'path traversal rejected' }); return null; }
    return { abs, rel: SLASH(rel), ws: ws || 'default' };
  }

  function bodyRes(res, body, fields) {
    for (const f of fields) {
      if (typeof body[f] !== 'string') { res.status(400).json({ error: `field '${f}' required` }); return null; }
    }
    if (fields.includes('path') || typeof body.path === 'string') {
      if (!checkRel(res, body.path)) return null;
    }
    const abs = ctx.resolveInWorkspace(body.ws || 'default', body.path);
    if (!abs) { res.status(400).json({ error: 'path traversal rejected' }); return null; }
    return abs;
  }

  app.get('/api/fs/list', async (req, res) => {
    const r = wsRes(req, res); if (!r) return;
    let st;
    try { st = await fsp.stat(r.abs); } catch { return res.status(404).json({ error: 'not found' }); }
    if (!st.isDirectory()) return res.status(400).json({ error: 'not a directory' });
    let ents = [];
    try { ents = await fsp.readdir(r.abs, { withFileTypes: true }); }
    catch (e) { return res.status(404).json({ error: 'not found' }); }
    const dirs = [], files = [];
    for (const e of ents) {
      const fpath = path.join(r.abs, e.name);
      let stt = null;
      try { stt = await fsp.stat(fpath); } catch {}
      if (e.isDirectory()) dirs.push({ name: e.name });
      else if (e.isFile()) files.push({ name: e.name, size: stt ? stt.size : 0, mtime: stt ? stt.mtimeMs : 0 });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ path: r.rel, dirs, files });
  });

  app.get('/api/fs/read', async (req, res) => {
    const r = wsRes(req, res); if (!r) return;
    let st;
    try { st = await fsp.stat(r.abs); } catch { return res.status(404).json({ error: 'not found' }); }
    if (!st.isFile()) return res.status(400).json({ error: 'not a file' });
    const CAP = 1024 * 1024;
    let buf;
    try { buf = await fsp.readFile(r.abs); } catch (e) { return res.status(500).json({ error: e.message }); }
    // binary sniff: NUL byte in first 8KB or non-UTF8 replacement storm
    const head = buf.subarray(0, 8192);
    const isBinary = head.includes(0) || (() => {
      const s = head.toString('utf8');
      if (!s.includes('\uFFFD')) return false;
      // verify round-trip: re-encoded replacing replacement chars differs → invalid utf8
      const back = Buffer.from(head.toString('latin1'), 'latin1');
      return Buffer.from(s, 'utf8').compare(back) !== 0 && s.replace(/\uFFFD/g, '').length < head.length * 0.25;
    })();
    if (isBinary) { res.json({ binary: true, size: st.size, truncated: false }); return; }
    const truncated = st.size > CAP;
    const content = truncated ? buf.subarray(0, CAP).toString('utf8') : buf.toString('utf8');
    res.json({ content, size: st.size, truncated, binary: false, path: r.rel });
  });

  app.post('/api/fs/write', async (req, res) => {
    const abs = bodyRes(res, req.body || {}, ['path', 'content']); if (!abs) return;
    const content = req.body.content || '';
    if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) return res.status(413).json({ error: 'content exceeds 1MB' });
    try {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, 'utf8');
      res.json({ ok: true, path: SLASH(req.body.path), size: Buffer.byteLength(content) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/fs/mkdir', async (req, res) => {
    const abs = bodyRes(res, req.body || {}, ['path']); if (!abs) return;
    try { await fsp.mkdir(abs, { recursive: true }); res.json({ ok: true, path: SLASH(req.body.path) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/fs/delete', async (req, res) => {
    const abs = bodyRes(res, req.body || {}, ['path']); if (!abs) return;
    let st;
    try { st = await fsp.stat(abs); } catch { return res.status(404).json({ error: 'not found' }); }
    if (st.isDirectory()) {
      const entries = fs.readdirSync(abs); // only delete empty dirs
      if (entries.length) return res.status(400).json({ error: 'directory not empty' });
      await fsp.rmdir(abs);
    } else await fsp.unlink(abs);
    res.json({ ok: true });
  });

  app.post('/api/fs/move', async (req, res) => {
    const body = req.body || {};
    if (typeof body.from !== 'string' || typeof body.to !== 'string') {
      return res.status(400).json({ error: "fields 'from' and 'to' required" });
    }
    if (!checkRel(res, body.from) || !checkRel(res, body.to)) return;
    const from = ctx.resolveInWorkspace(body.ws || 'default', body.from);
    if (!from) { res.status(400).json({ error: 'path traversal rejected' }); return; }
    const to = ctx.resolveInWorkspace(body.ws || 'default', body.to);
    if (!to) { res.status(400).json({ error: 'path traversal rejected' }); return; }
    try {
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rename(from, to);
      res.json({ ok: true, from: SLASH(body.from), to: SLASH(body.to) });
    } catch (e) { res.status(e.code === 'ENOENT' ? 404 : 500).json({ error: e.message }); }
  });

  app.get('/api/fs/search', async (req, res) => {
    const ws = sl(req, 'ws');
    const q = (sl(req, 'q') || '').toLowerCase();
    if (!q) return res.status(400).json({ error: 'q required' });
    const root = ctx.resolveInWorkspace(ws || 'default', '');
    if (!root) { res.status(400).json({ error: 'path traversal rejected' }); return; }
    const SKIP = new Set(['node_modules', '.git']);
    const results = [];
    async function walk(dir, depth) {
      if (depth > 8 || results.length >= 200) return;
      let ents;
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (results.length >= 200) return;
        if (SKIP.has(e.name)) continue;
        if (e.name.toLowerCase().includes(q)) results.push(path.relative(root, path.join(dir, e.name)).replace(/\\/g, '/'));
        if (e.isDirectory() && depth < 8) await walk(path.join(dir, e.name), depth + 1);
      }
    }
    const rootName = path.basename(root).toLowerCase();
    if (rootName.includes(q)) results.push('');
    await walk(root, 0);
    res.json({ q, results: results.slice(0, 200), truncated: false });
  });
} };
