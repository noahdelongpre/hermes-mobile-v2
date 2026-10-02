'use strict';
/* voice.test.js — unit tests for Workstream F (/api/voice/*). Zero-npm test harness:
 * spawns `node server/server.js` on scratch port 8295, exercises /api/voice/status
 * and /api/voice/stt with a real WAV (8000 Hz 16-bit mono sine 'hello') constructed
 * in code. Asserts non-500 behavior either way (transcript or clean 400/no-engine).
 * Usage: node tests/unit/voice.test.js
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = process.env.HMV2_ROOT || path.resolve(__dirname, '..', '..');
const PORT = 8295;
let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

// ---- synth a real WAV: 0.8s of a ~440Hz sine potted with an envelope (16-bit PCM mono 8k) ----
function makeWav() {
  const rate = 8000, secs = 0.8, n = Math.floor(rate * secs);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    // two short "syllable" bursts (amplitude envelope) = crude word shape
    const burst = Math.sin(Math.PI * (t % 0.4) / 0.4);
    const amp = Math.round(12000 * burst);
    const v = Math.round(Math.sin(2 * Math.PI * 440 * t) * amp);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28);
  hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
  return Buffer.concat([hdr, data]);
}

function request(method, p, body, ctype) {
  return new Promise((resolve, reject) => {
    const headers = { authorization: 'Basic ' + Buffer.from('noahd:testpass').toString('base64') };
    if (ctype) headers['content-type'] = ctype;
    if (body) headers['content-length'] = body.length;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers,
      timeout: 120_000 }, res => {
      let out = '';
      res.on('data', c => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, raw: out, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const child = spawn(process.execPath || 'node', [path.join(ROOT, 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), AUTH_USER: 'noahd', AUTH_PASS: 'testpass' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', c => (serverLog += c));
  child.stderr.on('data', c => (serverLog += c));

  // wait for listen
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise(r => setTimeout(r, 250));
    try { const r = await request('GET', '/api/voice/status'); if (r.status) up = true; } catch {}
  }
  try {
    if (!up) { console.log('  FAIL server did not start\n' + serverLog); process.exit(1); }

    console.log('\n== /api/voice/status ==');
    const st = await request('GET', '/api/voice/status');
    ok('status 200 json', st.status === 200 && st.json);
    ok('status has stt field (whisper-http|whisper-cli|none)', st.json && ['whisper-http', 'whisper-cli', 'none'].includes(st.json.stt), JSON.stringify(st.json));
    ok('status has ffmpeg bool', st.json && typeof st.json.ffmpeg === 'boolean', 'ffmpeg=' + (st.json && st.json.ffmpeg));

    console.log('\n== POST /api/voice/stt (real wav) ==');
    const wav = makeWav();
    const r1 = await request('POST', '/api/voice/stt', wav, 'audio/wav');
    ok('stt does not 500', r1.status !== 500, `status=${r1.status} raw=${r1.raw.slice(0, 200)}`);
    if (r1.status === 200) {
      ok('stt 200 returns transcript string', r1.json && typeof r1.json.transcript === 'string', JSON.stringify(r1.json));
      ok('stt 200 returns engine string', r1.json && typeof r1.json.engine === 'string', 'engine=' + (r1.json && r1.json.engine));
      ok('engine is a real mode', r1.json && ['whisper-http', 'whisper-cli', 'none'].includes(r1.json.engine));
    } else {
      ok('stt clean 400 when no engine', r1.status === 400 && r1.json && !!r1.json.error, `status=${r1.status}`);
    }

    console.log('\n== rejects malformed ==');
    const r2 = await request('POST', '/api/voice/stt', Buffer.from('{}'), 'application/json');
    ok('json body rejected 400', r2.status === 400, `status=${r2.status}`);
    const r3 = await request('POST', '/api/voice/stt', Buffer.alloc(10), 'audio/wav');
    ok('tiny body rejected 400', r3.status === 400, `status=${r3.status}`);
  } finally {
    try { child.kill(); } catch {}
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
