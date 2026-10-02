'use strict';
// kanban_routes.js — Workstream H: DoneTick tri-view proxy (Backlog / In Progress / Done).
// DoneTick is the USER's personal tracker: this module NEVER creates tasks. It only
// READS/mirrors the existing list and allows the user to promote/demote a task between
// columns via a DoneTick update.
// Env: DONETICK_URL (base, no trailing slash), DONETICK_KEY (bearer token), optional
//      DONETICK_TOKEN (alias), DONETICK_USER + DONETICK_PASS (basic auth alt).
//      DONETICK_TASKS_PATH (default /api/v1/tasks) for testability.
// Cache: state/kanban_cache.json, TTL 2min; on upstream error serve stale cache
//        (200 with source:'stale-cache') like slash_routes.js, else a clear error shape.
// Zero npm deps. No hardcoded DoneTick URL. NEVER creates DoneTick tasks.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

module.exports = { register(app) {
  const { stateDir, log } = app.ctx;

  const baseUrl = () => (process.env.DONETICK_URL || '').replace(/\/+$/, '');
  const configured = () => !!baseUrl();

  function upstreamReq(method, urlPath, body) {
    return new Promise(resolve => {
      const base = baseUrl();
      if (!base) return resolve({ status: 0, text: 'donetick not configured' });
      let url;
      try { url = new URL(base + urlPath); } catch (e) {
        return resolve({ status: 0, text: 'bad DONETICK_URL: ' + e.message });
      }
      const isHttps = url.protocol === 'https:';
      const mod = isHttps ? https : http;
      const headers = { accept: 'application/json' };
      const key = process.env.DONETICK_KEY || process.env.DONETICK_TOKEN || '';
      if (key) headers.authorization = 'Bearer ' + key;
      if (process.env.DONETICK_USER && process.env.DONETICK_PASS) {
        headers.authorization = 'Basic ' + Buffer.from(process.env.DONETICK_USER + ':' + process.env.DONETICK_PASS).toString('base64');
      }
      if (body != null) headers['content-type'] = 'application/json';
      const r = mod.request({
        hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search, method, headers, timeout: 15000,
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, text, json });
        });
      });
      r.on('timeout', () => { r.destroy(); resolve({ status: 0, text: 'upstream timeout' }); });
      r.on('error', e => resolve({ status: 0, text: String(e.message) }));
      if (body != null) r.write(JSON.stringify(body));
      r.end();
    });
  }

  // ---- cache (2min TTL, stale-served fallback) -------------------------
  const cacheFile = path.join(stateDir, 'kanban_cache.json');
  let mem = null;
  function cacheRead(maxAgeMs) {
    if (mem && Date.now() - mem.ts < maxAgeMs) return { data: mem.data, fresh: true, ts: mem.ts };
    try {
      const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (!mem || ((j.ts || 0) > (mem.ts || 0))) mem = j;
    } catch {}
    if (mem && Date.now() - mem.ts < maxAgeMs) return { data: mem.data, fresh: true, ts: mem.ts };
    return mem ? { data: mem.data, fresh: false, stale: true, ts: mem.ts } : null;
  }
  function cacheWrite(data) {
    mem = { data, ts: Date.now() };
    try { fs.writeFileSync(cacheFile, JSON.stringify(mem)); }
    catch (e) { log('kanban cache write fail', e.message); }
    return mem;
  }

  // ---- shaping ---------------------------------------------------------
  const COLUMNS = ['backlog', 'in_progress', 'done'];
  const LABELS = { backlog: 'Backlog', in_progress: 'In Progress', done: 'Done' };
  const DONE_RE = /^done|completed|archived/i;
  const PROG_RE = /progress|doing|active/i;

  function columnFor(t) {
    const s = String(t.status != null ? t.status : t.status_id != null ? t.status_id : t.list_name || '').toLowerCase();
    if (DONE_RE.test(s)) return 'done';
    if (PROG_RE.test(s)) return 'in_progress';
    return 'backlog';
  }
  function shapeTask(t) {
    const id = t.id != null ? t.id : t.task_id;
    return {
      id,
      title: t.title || t.name || String(id),
      status: String(t.status != null ? t.status : t.status_id != null ? t.status_id : ''),
      source: 'donetick',
      updated_at: t.updated_at || null,
      url: t.url || (baseUrl() && id != null ? baseUrl() + '/tasks/' + id : null),
    };
  }
  function shapeColumns(tasks) {
    const cols = { backlog: [], in_progress: [], done: [] };
    for (const t of tasks) {
      const s = shapeTask(t);
      if (s.id == null) continue;
      cols[columnFor(t)].push(s);
    }
    for (const k of COLUMNS) cols[k].sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
    return { configured: true, columns: cols, labels: LABELS, source: 'donetick', open_url: baseUrl(), generated_at: new Date().toISOString() };
  }

  // DoneTick may return {tasks:[...]} / {data:[...]} / bare [...]
  function taskList(j) {
    if (Array.isArray(j)) return j;
    if (Array.isArray(j && j.tasks)) return j.tasks;
    if (Array.isArray(j && j.data)) return j.data;
    return null;
  }

  async function fetchBoard(req, res) {
    if (!configured()) {
      return res.status(200).json({
        configured: false,
        error: 'donetick not configured — set DONETICK_URL and DONETICK_KEY on the app server',
        columns: { backlog: [], in_progress: [], done: [] }, labels: LABELS, open_url: null,
      });
    }
    const cached = cacheRead(2 * 60 * 1000); // 2min TTL
    // read may be offered a fresh live cache for a different action; always prefer live
    const tasksPath = process.env.DONETICK_TASKS_PATH || '/api/v1/tasks';
    const r = await upstreamReq('GET', tasksPath).catch(() => ({ status: 0, text: 'net' }));
    if (r.status === 200 && r.json && Array.isArray(taskList(r.json))) {
      const shaped = shapeColumns(taskList(r.json));
      cacheWrite(shaped);
      return res.json(shaped);
    }
    // Failure path: serve whatever cache exists — an in-memory entry written earlier
    // in this process counts as fresh within TTL; file-only entries count as stale.
    if (cached && cached.fresh) return res.json(cached.data);
    if (cached && cached.stale) return res.json({ ...cached.data, source: 'stale-cache' });
    return res.status(502).json({
      configured: true,
      error: `donetick upstream unavailable (${r.status || 'net'})`,
      detail: String(r.text || '').slice(0, 200),
      columns: { backlog: [], in_progress: [], done: [] }, labels: LABELS, open_url: baseUrl(),
    });
  }

  // promote/demote: move a task between columns by updating its status on DoneTick.
  // Target status names map: backlog→"todo", in_progress→"in progress", done→"done".
  const STATUS_MAP = { backlog: 'todo', in_progress: 'in progress', done: 'done' };
  async function updateTask(req, res) {
    // Validate body FIRST so 400s are deterministic regardless of configured state.
    const { id, to } = req.body || {};
    if (id == null || !COLUMNS.includes(to)) return res.status(400).json({ error: 'id and to (backlog|in_progress|done) required' });
    if (!configured()) {
      return res.status(200).json({ configured: false, error: 'donetick not configured — set DONETICK_URL and DONETICK_KEY on the app server' });
    }
    const tasksPath = process.env.DONETICK_TASKS_PATH || '/api/v1/tasks';
    const r = await upstreamReq('PATCH', tasksPath + '/' + encodeURIComponent(id), { status: STATUS_MAP[to] });
    if (r.status === 200) {
      // optimistically adjust cache so a refresh shows the new position immediately
      const cached = cacheRead(10 * 60 * 1000);
      if (cached && cached.data && cached.data.columns) {
        const moved = COLUMNS.map(c => cached.data.columns[c].filter(t => String(t.id) !== String(id))).flat();
        const keep = [];
        for (const c of COLUMNS) for (const t of cached.data.columns[c]) if (String(t.id) === String(id)) keep.push(t);
        const upd = keep.length ? { ...keep[0], status: STATUS_MAP[to] } : null;
        if (upd) {
          const cols = { backlog: [], in_progress: [], done: [] };
          for (const t of moved) cols[columnFor(t)].push(shapeTask(t));
          if (upd) cols[to].push(upd);
          cacheWrite({ ...cached.data, columns: cols });
        }
      }
      return res.json({ ok: true, id, to, source: 'donetick' });
    }
    return res.status(502).json({ error: `donetick update failed (${r.status || 'net'})`, detail: String(r.text || '').slice(0, 200) });
  }

  app.get('/api/kanban/tasks', fetchBoard);
  app.post('/api/kanban/promote', updateTask);
  app.post('/api/kanban/demote', updateTask);
} };
