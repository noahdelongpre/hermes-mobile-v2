'use strict';
// attach_routes.js — workstream J: attachment upload/serve/delete + background purge.
// Zero-npm multipart parser, magic-byte sniffing, size caps before storing.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE = 10 * 1024 * 1024;      // 10MB per file
const MAX_TOTAL = 20 * 1024 * 1024;     // 20MB per request
const MAX_FILES = 5;
const MAX_AGE_MS = 10 * 60 * 1000;      // purge attachments older than 10 min

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'audio/webm', 'audio/wav', 'text/plain', 'application/pdf']);

// Magic-byte sniffers: f(bytes) => true if bytes match. Declared type must match
// actual bytes (defense in depth) — claimed text/plain can be anything though.
function sniff(type, b) {
  if (!b || b.length < 4) return false;
  const starts = (s) => Buffer.from(s, 'binary').compare(b, 0, Buffer.from(s, 'binary').length) === 0;
  switch (type) {
    case 'image/png': return starts('\x89PNG');
    case 'image/jpeg': return starts('\xff\xd8');
    case 'image/gif': return starts('GIF8');
    case 'image/webp': return b.length > 12 && starts('RIFF') && b.toString('ascii', 8, 12) === 'WEBP';
    case 'audio/wav': return starts('RIFF') && b.length > 12 && b.toString('ascii', 8, 12) === 'WAVE';
    case 'audio/webm': return starts('\x1a\x45\xdf\xa3');
    case 'application/pdf': return starts('%PDF');
    case 'text/plain': return true; // no defined magic; size cap + serving as plain text only
    default: return false;
  }
}

function sanitizeName(name) {
  return (name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 96) || 'file';
}

function attachmentsDir(c) {
  const d = path.join(c.stateDir, 'attachments');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Parse a hand-rolled multipart/form-data body into [{name, filename, type, data}]. No deps.
function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw Object.assign(new Error('missing multipart boundary'), { status: 400 });
  const boundary = '--' + (m[1] || m[2]);
  const delim = Buffer.from(boundary);
  const parts = [];
  let idx = 0;
  // find part start positions
  let start = body.indexOf(delim);
  while (start !== -1) {
    const headEnd = body.indexOf('\r\n\r\n', start);
    if (headEnd === -1) break;
    const next = body.indexOf(delim, headEnd + 4);
    if (next === -1) break;
    const headerBlock = body.slice(start + delim.length, headEnd).toString('utf8').replace(/^\r\n/, '');
    const data = body.slice(headEnd + 4, next - 2); // strip trailing \r\n of part
    const headers = {};
    headerBlock.split('\r\n').forEach(h => {
      const i = h.indexOf(':');
      if (i > 0) headers[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
    });
    // filename value (not the part field name) is what we store sanitized
    const cd = headers['content-disposition'] || '';
    const fileM = /filename="([^"]*)"/.exec(cd);
    parts.push({
      filename: fileM ? fileM[1] : undefined,
      type: headers['content-type'],
      data,
    });
    start = next;
  }
  return parts;
}

// Load attachment metadata index (id -> {name, type, size, file, at})
let index = new Map();
function loadIndex(c) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(c.stateDir, 'attachments', 'index.json'), 'utf8'));
    index = new Map(Object.entries(raw));
  } catch { index = new Map(); }
}
function saveIndex(c) {
  const d = attachmentsDir(c);
  // only persist entries whose file still exists
  const kept = {};
  for (const [id, e] of index) if (fs.existsSync(e.file)) kept[id] = e;
  index = new Map(Object.entries(kept));
  fs.writeFileSync(path.join(d, 'index.json'), JSON.stringify(kept, null, 2));
}

function purge(c, maxAge = parseInt(process.env.ATTACH_MAX_AGE_MS || MAX_AGE_MS, 10)) {
  const now = Date.now();
  let n = 0;
  for (const [id, e] of [...index]) {
    if (now - e.at > maxAge) {
      try { fs.unlinkSync(e.file); } catch {}
      index.delete(id); n++;
    }
  }
  // also sweep orphan files not in index (older than maxAge)
  try {
    const d = attachmentsDir(c);
    for (const f of fs.readdirSync(d)) {
      if (f === 'index.json') continue;
      const fp = path.join(d, f);
      try {
        if (!fs.statSync(fp).isFile()) continue;
        const lookup = [...index.values()].some(e => e.file === fp);
        if (lookup) continue;
        if (now - fs.statSync(fp).mtimeMs > maxAge) { fs.unlinkSync(fp); n++; }
      } catch {}
    }
  } catch {}
  if (n) saveIndex(c);
  return n;
}

function startPurger(c) {
  const interval = parseInt(process.env.ATTACH_PURGE_INTERVAL_MS || (5 * 60 * 1000), 10);
  if (register._purger) clearInterval(register._purger);
  register._purger = setInterval(() => purge(c), interval);
  register._purger.unref && register._purger.unref();
}

function register(app) {
  const c0 = app.ctx;
  loadIndex(c0);
  startPurger(c0);

  // POST /api/attach/upload — multipart/form-data or raw octet-stream (single file)
  app.post('/api/attach/upload', async (req, res, c) => {
    const ctype = req.headers['content-type'] || '';
    let files = [];
    if (ctype.startsWith('multipart/form-data')) {
      files = parseMultipart(req.body, ctype).filter(p => p.filename !== undefined)
        .map(p => ({ ...p, name: p.filename }));
    } else {
      // non-multipart raw body: single file, type from X-Attach-Type or the content-type
      const declared = req.headers['x-attach-type'] || (ctype.split(';')[0].trim() || 'application/octet-stream');
      files.push({ name: req.headers['x-attach-name'] || 'upload.bin', type: declared, data: req.body });
    }
    if (!files.length) return res.status(400).json({ error: 'no files in request' });
    if (files.length > MAX_FILES) return res.status(400).json({ error: `max ${MAX_FILES} files per request` });
    const totalSize = files.reduce((a, f) => a + f.data.length, 0);
    if (totalSize > MAX_TOTAL) return res.status(413).json({ error: 'total payload exceeds 20MB' });

    const dir = attachmentsDir(c);
    const out = [];
    const errors = [];
    for (const f of files) {
      if (f.data.length > MAX_FILE) { errors.push(`${f.name}: exceeds 10MB`); continue; }
      const type = (f.type || '').split(';')[0].trim();
      if (!ALLOWED.has(type)) { errors.push(`${f.name}: type ${type || 'unknown'} not allowed`); continue; }
      if (!sniff(type, f.data)) { errors.push(`${f.name}: declared ${type} but content does not match`); continue; }
      const id = crypto.randomBytes(4).toString('hex');
      const safe = sanitizeName(f.name);
      const fp = path.join(dir, `${id}-${safe}`);
      // id is hex-uuid8, not user-supplied: no traversal possible. Write after ALL checks pass.
      fs.writeFileSync(fp, f.data);
      const entry = { id, name: safe, type, size: f.data.length, file: fp, at: Date.now() };
      index.set(id, entry);
      out.push({ id, url: `/api/attach/file/${id}`, name: safe, type, size: f.data.length });
    }
    saveIndex(c);
    purge(c);
    out.forEach(e => c.log(`attach stored ${e.id} ${e.name} (${e.size}b)`));
    if (!out.length && errors.length === 1 && files.length === 1) {
      const err = errors[0];
      const status = err.includes('exceeds') ? 413 : err.includes('not allowed') || err.includes('does not match') ? 415 : 400;
      return res.status(status).json({ error: err });
    }
    if (errors.length) return res.status(207).json({ files: out, errors });
    return res.json(files.length === 1 ? { ...out[0] } : { files: out });
  });

  // GET /api/attach/file/:id — serve bytes, inline content-disposition
  app.get('/api/attach/file/:id', (req, res, c) => {
    const e = index.get(req.params.id);
    if (!e || !fs.existsSync(e.file)) return res.status(404).json({ error: 'attachment not found' });
    res.raw.writeHead(200, {
      'content-type': e.type === 'audio/wav' ? 'audio/x-wav' : e.type,
      'content-disposition': `inline; filename="${e.name}"`,
      'x-content-type-options': 'nosniff',
      'content-length': e.size,
      'cache-control': 'private, max-age=600',
    });
    fs.createReadStream(e.file).pipe(res.raw);
  });

  // DELETE /api/attach/:id
  app.delete('/api/attach/:id', (req, res, c) => {
    const e = index.get(req.params.id);
    if (!e) return res.status(404).json({ error: 'not found' });
    try { fs.unlinkSync(e.file); } catch {}
    index.delete(req.params.id);
    saveIndex(c);
    return res.json({ ok: true });
  });

  // GET /api/attach/list (small helper for debugging / re-render)
  app.get('/api/attach/list', (req, res) => {
    res.json([...index.values()].map(({ id, name, type, size, at }) => ({ id, name, type, size, at })));
  });
}

module.exports = { register, sniff, sanitizeName, parseMultipart, purge, MAX_FILE, MAX_TOTAL, MAX_AGE_MS, _setIndex: m => index = m };
