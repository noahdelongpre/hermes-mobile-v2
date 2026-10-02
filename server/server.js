'use strict';
// hermes-mobile v2 app server. Static + /api/* module routers. Zero npm deps.
// Modules self-register from server/modules/*_routes.js (loud skip if broken).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const hermes = require('./hermes_client');

const PORT = process.env.PORT || 8124;
const AUTH_USER = process.env.AUTH_USER || 'noahd';
const AUTH_PASS = process.env.AUTH_PASS || '';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATE_DIR = path.join(__dirname, '..', 'state');
fs.mkdirSync(STATE_DIR, { recursive: true });

// --- auth (basic) ---------------------------------------------------
function authOk(req) {
  if (!AUTH_PASS) return true; // dev mode
  const m = /^Basic\s+(.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const dec = Buffer.from(m[1], 'base64').toString('utf8');
  const i = dec.indexOf(':'); if (i < 0) return false;
  const u = dec.slice(0, i), p = dec.slice(i + 1);
  const a = crypto.createHmac('sha256', 'u').update(u).digest();
  const b = crypto.createHmac('sha256', 'u').update(AUTH_USER).digest();
  return crypto.timingSafeEqual(a, b) && p === AUTH_PASS;
}
function challenge(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="hermes-mobile-v2"', 'Content-Type': 'text/plain' });
  res.end('Authentication required');
}

// --- workspace registry --------------------------------------------
const workspaces = new Map(); // id -> absolute path
function loadWorkspaces() {
  try {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'workspaces.json'), 'utf8')))) workspaces.set(k, v);
  } catch {}
  if (!workspaces.has('default')) workspaces.set('default', process.env.FS_ROOT || 'C:/git');
}
function saveWorkspaces() {
  fs.writeFileSync(path.join(STATE_DIR, 'workspaces.json'), JSON.stringify(Object.fromEntries(workspaces), null, 2));
}
loadWorkspaces();

const ctx = { hermes, workspaces, saveWorkspaces, stateDir: STATE_DIR,
  log: (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a),
  resolveInWorkspace(ws, rel) {
    const root = workspaces.get(ws) || workspaces.get('default');
    if (!root) return null;
    const abs = path.resolve(root, '.' + path.sep + (rel || ''));
    const deterministicRoot = path.resolve(root);
    if (abs !== deterministicRoot && !abs.startsWith(deterministicRoot + path.sep)) return null; // traversal guard
    return abs;
  } };

// --- mini router -----------------------------------------------------
const routes = [];
function add(method, pattern, handler) {
  // pattern like /api/fs/list — exact or :param segments
  const parts = pattern.split('/').filter(Boolean);
  routes.push({ method, parts, handler });
}
const app = {
  get: (p, h) => add('GET', p, h),
  post: (p, h) => add('POST', p, h),
  patch: (p, h) => add('PATCH', p, h),
  delete: (p, h) => add('DELETE', p, h),
  sse: (p, h) => add('SSE', p, h),
  ctx,
};
app.ctx.resolveInWorkspace = ctx.resolveInWorkspace;

// --- module auto-load ------------------------------------------------
const MOD_DIR = path.join(__dirname, 'modules');
fs.mkdirSync(MOD_DIR, { recursive: true });
for (const f of fs.readdirSync(MOD_DIR)) {
  if (!f.endsWith('_routes.js')) continue;
  try {
    const mod = require(path.join(MOD_DIR, f));
    mod.register(app);
    ctx.log(`module ${f} registered`);
  } catch (e) {
    console.error(`[module-load] SKIPPED ${f}: ${e.message}`);
  }
}

// core routes owned by lead (thin ones here; heavier in modules/)
app.get('/api/settings', (req, res) => res.json({
  workspaces: [...workspaces.entries()].map(([id, root]) => ({ id, root })),
  features: { steer: true },
}));
app.post('/api/settings', (req, res, c) => {
  const { action, id, root } = req.body || {};
  if (action === 'addWorkspace' && id && root) {
    const abs = path.resolve(root);
    if (!fs.existsSync(abs)) return res.status(400).json({ error: 'path not found' });
    workspaces.set(id, abs); c.saveWorkspaces(); return res.json({ ok: true });
  }
  if (action === 'delWorkspace' && id && id !== 'default') { workspaces.delete(id); c.saveWorkspaces(); return res.json({ ok: true }); }
  res.status(400).json({ error: 'bad action' });
});
app.get('/api/health', async (req, res) => res.json({ upstream: await hermes.health() }));

// SSE helper for modules
function doSSE(req, res, handler) {
  res.writeHead(200, {
    'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  const hb = setInterval(() => res.write(': keepalive\n\n'), 12000);
  req.on('close', () => clearInterval(hb));
  handler(req, res, { ...ctx, cleanup: () => clearInterval(hb) });
}

// --- static + dispatch ----------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function matchRoute(method, urlPath) {
  const segs = urlPath.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method || r.parts.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      const p = r.parts[i];
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(segs[i]);
      else if (p !== segs[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

function readBody(req, limit = 21 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const urlPath = u.pathname;
  if (!authOk(req)) return challenge(res);

  // API dispatch
  if (urlPath.startsWith('/api/')) {
    const m = matchRoute(req.method === 'SSE' ? 'SSE' : req.method, urlPath);
    // allow explicit SSE via query or method GET on registered SSE routes
    const m2 = m || (req.method === 'GET' ? matchRoute('SSE', urlPath) : null);
    if (!m2) return res.status(404).json({ error: 'no route' });
    let body = null;
    if (req.method === 'POST' || req.method === 'PATCH') {
      const ctype = req.headers['content-type'] || '';
      try {
        const buf = await readBody(req);
        if (ctype.includes('application/json')) { try { body = JSON.parse(buf.toString() || '{}'); } catch { return res.status(400).json({ error: 'bad json' }); } }
        else body = buf; // raw (uploads)
      } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    }
    req.query = u.searchParams; req.body = body; req.params = m2.params;
    const wrap = { json: o => res.writeHead(200, { 'content-type': 'application/json' }) && res.end(JSON.stringify(o)),
      status(s) { res.statusCode = s; return this; }, end: d => res.end(d),
      sse: () => { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.write(': connected\n\n'); return {
        send: (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`),
        close: () => { clearInterval(hbRef); res.write(': stream closed\n\n'); res.end(); },
        setHeartbeat: fn => { hbRef = fn; },
      }; },
    };
    let hbRef = setInterval(() => res.write(': keepalive\n\n'), 12000);
    req.on('close', () => clearInterval(hbRef));
    try {
      await m2.handler(req, wrap, ctx);
    } catch (e) {
      console.error('[handler-error]', urlPath, e.stack || e.message);
      if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Static
  let p = urlPath === '/' ? '/index.html' : urlPath;
  p = path.normalize(p).replace(/^(\.\.[\/\\])+/, '');
  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR)) return res.status(403).end();
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => ctx.log(`hermes-mobile v2 on :${PORT} (upstream ${hermes.BASE})`));
