'use strict';
// tests/unit/attach.test.js — workstream J server-side tests.
// Spawns the real server on PORT=8292 and exercises /api/attach/* with plain http.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 8292;
const ROOT = path.join(__dirname, '..', '..');
const ATTACH_DIR = path.join(ROOT, 'state', 'attachments');
let child;
const uploads = []; // ids to clean up

function req(method, p, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

test.before(async () => {
  fs.rmSync(ATTACH_DIR, { recursive: true, force: true });
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), AUTH_PASS: '', ATTACH_MAX_AGE_MS: '1500', ATTACH_PURGE_INTERVAL_MS: '700' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.env.DEBUG_TEST && process.stdout.write('[srv] ' + d));
  child.stderr.on('data', d => process.stderr.write('[srverr] ' + d));
  // wait for health
  for (let i = 0; i < 50; i++) {
    try { await req('GET', '/api/health'); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

test.after(async () => {
  // cleanup uploaded files
  for (const id of uploads) await req('DELETE', `/api/attach/${id}`).catch(() => {});
  child.kill();
});

// Minimal valid 1x1 PNG built programmatically
function oneGoneOnePng() {
  const IHDR = Buffer.from([0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const crc32 = (buf) => {
    let c, table = [];
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
    let crc = 0xffffffff;
    for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crcB = Buffer.alloc(4); crcB.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crcB]);
  };
  const idat = chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x01, 0x01, 0x00, 0x18, 0xdd, 0xa6, 0xef, 0x6f]));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'binary'), IHDR, idat, iend]);
}

test('upload png via raw bytes, serve back byte-identical', async () => {
  const png = oneGoneOnePng();
  const up = await req('POST', '/api/attach/upload', {
    body: png,
    headers: { 'content-type': 'image/png', 'x-attach-type': 'image/png', 'x-attach-name': 'self-test.png' },
  });
  console.log('PASS upload:status', up.status, 'body', up.buf.toString().slice(0, 200));
  assert.equal(up.status, 200);
  const meta = JSON.parse(up.buf.toString());
  assert.equal(meta.type, 'image/png');
  assert.equal(meta.size, png.length);
  uploads.push(meta.id);

  const got = await req('GET', meta.url);
  console.log('PASS serve:status', got.status, 'ctype', got.headers['content-type'], 'disp', got.headers['content-disposition'], 'bytes', got.buf.length, 'identical', got.buf.equals(png));
  assert.equal(got.status, 200);
  assert.equal(got.headers['content-type'], 'image/png');
  assert.ok((got.headers['content-disposition'] || '').startsWith('inline;'));
  assert.equal(got.headers['x-content-type-options'], 'nosniff');
  assert.ok(got.buf.equals(png), 'served bytes must be byte-identical');
});

test('reject fake png (text named .png)', async () => {
  const fake = Buffer.from('this is definitely not a png image');
  const up = await req('POST', '/api/attach/upload', {
    body: fake,
    headers: { 'content-type': 'image/png', 'x-attach-type': 'image/png', 'x-attach-name': 'fake.png' },
  });
  console.log('PASS fake-png:status', up.status, 'body', up.buf.toString());
  assert.equal(up.status, 415);
});

test('reject >10MB file', async () => {
  const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41); // 'A' repeated
  const up = await req('POST', '/api/attach/upload', {
    body: big,
    headers: { 'content-type': 'text/plain', 'x-attach-type': 'text/plain', 'x-attach-name': 'big.txt' },
  });
  console.log('PASS big:status', up.status, 'body', up.buf.toString().slice(0, 120));
  assert.ok([413].includes(up.status), 'expect 413, got ' + up.status);
});

test('multipart upload path (handcrafted body)', async () => {
  const png = oneGoneOnePng();
  const boundary = '----attachjs' + Date.now();
  const pre = Buffer.from(
    `--${boundary}\r\n` +
    `content-disposition: form-data; name="file"; filename="multip ART-test.png"\r\n` +
    `content-type: image/png\r\n\r\n`);
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([pre, png, post]);
  const up = await req('POST', '/api/attach/upload', {
    body,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  console.log('PASS multipart:status', up.status, 'body', up.buf.toString().slice(0, 300));
  assert.equal(up.status, 200);
  const meta = JSON.parse(up.buf.toString());
  assert.match(meta.name, /^multip_ART-test\.png$/, 'spaces sanitized');
  uploads.push(meta.id);
  const got = await req('GET', meta.url);
  console.log('PASS multipart-serve:status', got.status, 'identical', got.buf.equals(png));
  assert.ok(got.buf.equals(png));
});

test('reject disallowed type (exe)', async () => {
  const up = await req('POST', '/api/attach/upload', {
    body: Buffer.from('MZ\x90\x00'),
    headers: { 'content-type': 'application/octet-stream', 'x-attach-type': 'application/x-msdownload', 'x-attach-name': 'evil.exe' },
  });
  console.log('PASS exe:status', up.status, 'body', up.buf.toString());
  assert.equal(up.status, 415);
});

test('auto-purge old attachments (>10min default, shortened via env)', async () => {
  // upload
  const up = await req('POST', '/api/attach/upload', {
    body: Buffer.from('purge me later, gone in a second and a half'),
    headers: { 'content-type': 'text/plain', 'x-attach-type': 'text/plain', 'x-attach-name': 'shortlived.txt' },
  });
  assert.equal(up.status, 200);
  const meta = JSON.parse(up.buf.toString());
  console.log('PASS purge-upload:status', up.status, 'id', meta.id);
  // wait 2s (> ATTACH_MAX_AGE_MS=1500; purger interval 700ms)
  await new Promise(r => setTimeout(r, 2200));
  const got = await req('GET', meta.url);
  console.log('PASS purge-serve-after:status', got.status, 'body', got.buf.toString().slice(0, 100));
  assert.equal(got.status, 404, 'attachment should be purged');
  const onDisk = fs.readdirSync(ATTACH_DIR).filter(f => f !== 'index.json');
  console.log('PASS purge-disk-files-left', onDisk);
  assert.equal(onDisk.length, 0, 'no stale files on disk');
});

test('list endpoint is 200 and reflects purge state', async () => {
  // uploads from earlier tests are older than ATTACH_MAX_AGE_MS (1500ms) and were
  // purged by the background purger, so nothing should remain; a fresh upload must appear.
  const list = await req('GET', '/api/attach/list');
  console.log('PASS list:status', list.status, 'body', list.buf.toString().slice(0, 300));
  assert.equal(list.status, 200);
  assert.equal(JSON.parse(list.buf.toString()).length, 0, 'all uploads purged by now');
  const up = await req('POST', '/api/attach/upload', {
    body: Buffer.from('fresh for the list test'),
    headers: { 'content-type': 'text/plain', 'x-attach-type': 'text/plain', 'x-attach-name': 'fresh.txt' },
  });
  const meta = JSON.parse(up.buf.toString());
  const list2 = await req('GET', '/api/attach/list');
  const arr = JSON.parse(list2.buf.toString());
  console.log('PASS list-fresh:status', list2.status, 'ids', arr.map(e => e.id));
  assert.ok(arr.some(e => e.id === meta.id), 'fresh upload appears in list');
});
