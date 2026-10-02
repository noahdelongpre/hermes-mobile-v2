// hermes_client.js — THE ONLY file allowed to talk to upstream Hermes.
// Owns: IP-literal URL rewriting (Pi container DNS-death rule), bearer key auth,
// timeouts, retries. Everything else imports this.
'use strict';
const http = require('http');
const https = require('https');
const dns = require('dns');

const RAW_URL = process.env.HERMES_URL || 'http://127.0.0.1:8642';
const HERMES_KEY = process.env.HERMES_KEY || '';

// Rewrite hostnames to IP literals where a static map provides one.
// In the Pi container, getaddrinfo fails for ALL hostnames (pihole resolv.conf + musl).
const HOST_MAP = {}; // e.g. { 'thefridge': '192.168.86.39' } via env HOSTMAP "thefridge=192.168.86.39,foo=10.0.0.2"
for (const pair of (process.env.HOSTMAP || '').split(',').filter(Boolean)) {
  const [h, ip] = pair.split('=');
  if (h && ip) HOST_MAP[h.trim().toLowerCase()] = ip.trim();
}
function rewriteIPs(u) {
  try {
    const url = new URL(u);
    const lower = url.hostname.toLowerCase();
    if (HOST_MAP[lower]) { url.hostname = HOST_MAP[lower]; return url.toString(); }
    if (/^(localhost|thefridge|blackbox|.*\.local|.*\.ts\.net)$/i.test(lower) && !/^\d+\.\d+\.\d+\.\d+$/.test(lower)) {
      // no map entry: leave as-is but caller should ensure .env uses IPs; log loudly
      console.warn(`[hermes_client] WARNING: hostname "${lower}" may not resolve inside Pi container; use IP literal`);
    }
    return url.toString();
  } catch { return u; }
}
const BASE = rewriteIPs(RAW_URL.replace(/\/+$/, ''));

function request(method, path, { body, headers = {}, timeoutMs = 120000, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const bare = BASE.replace(/\/+$/, '');
    const url = new URL(bare + (path.startsWith('/') ? path : '/' + path));
    const mod = url.protocol === 'https:' ? https : http;
    const data = body != null && !raw ? JSON.stringify(body) : body;
    const reqPath = url.pathname.replace(/\/+$/, '') + (url.search || '') || '/';
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: reqPath,
      method,
      headers: {
        ...(data != null ? { 'content-length': Buffer.byteLength(data) } : {}),
        ...(HERMES_KEY ? { authorization: `Bearer ${HERMES_KEY}` } : {}),
        ...(body != null && !raw ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      if (raw) return resolve(res); // caller streams
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(buf.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, json: parsed, text: buf.toString('utf8') });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`upstream timeout ${timeoutMs}ms ${path}`)));
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}
async function health() {
  try { const r = await request('GET', '/health', { timeoutMs: 5000 }); return r.status === 200; }
  catch { return false; }
}
module.exports = { BASE, request, health, rewriteIPs, HERMES_KEY: !!HERMES_KEY };
