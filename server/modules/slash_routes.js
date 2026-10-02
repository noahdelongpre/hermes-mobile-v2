'use strict';
// slash_routes.js — Workstream I: caching proxies for slash/pickers.
// GET /api/skills  → upstream GET /v1/skills; cache state/skills_cache.json 5min TTL;
//                     on upstream error fall back to stale cache, else {error}.
// GET /api/models  → upstream GET /api/model/options; cache state/models_cache.json
//                     2min TTL; same fallback. Upstream shape: {providers:[...], model, provider}.
// Zero npm deps. Never constructed Hermes URLs here — only hermes_client.request(path).
const fs = require('fs');
const path = require('path');

module.exports = { register(app) {
  const { hermes, stateDir, log } = app.ctx;

  function cacheWrap(name, ttlMs) {
    const file = path.join(stateDir, name);
    let mem = null; // {data, ts}
    return {
      read(maxAgeMs) {
        if (mem && Date.now() - mem.ts < maxAgeMs) return { data: mem.data, fresh: true, ts: mem.ts };
        try {
          const j = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!mem || mem.ts < j.ts) mem = j;
        } catch {}
        if (mem && Date.now() - mem.ts < maxAgeMs) return { data: mem.data, fresh: true, ts: mem.ts };
        return mem ? { data: mem.data, fresh: false, stale: true, ts: mem.ts } : null;
      },
      write(data) {
        mem = { data, ts: Date.now() };
        try { fs.writeFileSync(file, JSON.stringify(mem)); } catch (e) { log('cache write fail', name, e.message); }
        return mem;
      },
    };
  }

  const skillsCache = cacheWrap('skills_cache.json', 0);
  const modelsCache = cacheWrap('models_cache.json', 0);

  app.get('/api/skills', async (req, res) => {
    const cached = skillsCache.read(5 * 60 * 1000); // 5min TTL
    if (cached && cached.fresh) return res.json(cached.data);
    const r = await hermes.request('GET', '/v1/skills', { timeoutMs: 15000 }).catch(e => ({ status: 0, text: String(e.message) }));
    if (r.status === 200 && r.json) {
      skillsCache.write(r.json);
      return res.json(r.json);
    }
    log('skills upstream failed', r.status, String(r.text || '').slice(0, 120));
    if (cached && cached.stale) return res.json(cached.data); // stale-but-served fallback
    return res.status(502).json({ error: `skills upstream unavailable (${r.status || 'net'})`, detail: String(r.text || '').slice(0, 200) });
  });

  app.get('/api/models', async (req, res) => {
    const cached = modelsCache.read(2 * 60 * 1000); // 2min TTL
    if (cached && cached.fresh) return res.json(cached.data);
    const r = await hermes.request('GET', '/api/model/options', { timeoutMs: 15000 }).catch(e => ({ status: 0, text: String(e.message) }));
    if (r.status === 200 && r.json && Array.isArray(r.json.providers)) {
      modelsCache.write(r.json);
      return res.json(r.json);
    }
    log('models upstream failed', r.status, String(r.text || '').slice(0, 120));
    if (cached && cached.stale) return res.json(cached.data);
    return res.status(502).json({ error: `model options upstream unavailable (${r.status || 'net'})`, detail: String(r.text || '').slice(0, 200) });
  });
} };
