'use strict';
// Run proxy routes — the only routes allowed to touch Hermes /v1/runs.
// POST /api/run/create {input, conversation?, model_options?} → upstream create, stores run→session link
// GET  /api/run/:id/status, /api/run/:id/events (SSE passthrough), /stop, /approval, /steer
const fs = require('fs');
const path = require('path');

module.exports = { register(app) {
  const { hermes, stateDir, log } = app.ctx;

  app.post('/api/run/create', async (req, res) => {
    const { input, conversation, model_options, workspaceId } = req.body || {};
    if (!input || typeof input !== 'string') return res.status(400).json({ error: 'input required' });
    const body = { input }; if (conversation) body.conversation = conversation;
    if (model_options && typeof model_options === 'object') body.model_options = model_options;
    const r = await hermes.request('POST', '/v1/runs', { body, timeoutMs: 30000 });
    if (r.status !== 200) return res.status(r.status >= 500 ? 502 : r.status).json({ error: r.json?.error || r.text.slice(0, 200) });
    // record mapping for history resumption
    try {
      const runsFile = path.join(stateDir, 'runs.json');
      const runs = fs.existsSync(runsFile) ? JSON.parse(fs.readFileSync(runsFile, 'utf8')) : [];
      runs.push({ run_id: r.json.run_id, conversation: conversation || null, workspaceId: workspaceId || 'default', created: Date.now(), title: input.slice(0, 60) });
      fs.writeFileSync(runsFile, JSON.stringify(runs.slice(-500)));
    } catch {}
    res.json({ run_id: r.json.run_id, status: r.json.status });
  });

  app.get('/api/run/:id/status', async (req, res) => {
    const r = await hermes.request('GET', `/v1/runs/${encodeURIComponent(req.params.id)}`, { timeoutMs: 10000 });
    res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(r.text);
  });

  app.get('/api/run/:id/events', async (req, res) => {
    const s = res.sse();
    const upstream = await hermes.request('GET', `/v1/runs/${encodeURIComponent(req.params.id)}/events`, { raw: true, timeoutMs: 3600000 });
    if (upstream.statusCode !== 200) {
      s.send({ event: 'upstream.error', status: upstream.statusCode }); s.close(); return;
    }
    upstream.on('data', c => {
      const text = c.toString();
      // pass frames through verbatim (they're already SSE-formatted data: lines)
      for (const line of text.split('\n')) {
        if (line.startsWith('data:') || line.startsWith(':')) res.write(line + '\n');
      }
      res.write('\n');
    });
    upstream.on('end', () => { s.send({ event: 'stream.closed' }); s.close(); });
    upstream.on('error', e => { s.send({ event: 'upstream.error', message: e.message }); s.close(); });
    req.on('close', () => { try { upstream.destroy(); } catch {} });
  });

  app.post('/api/run/:id/stop', async (req, res) => {
    const r = await hermes.request('POST', `/v1/runs/${encodeURIComponent(req.params.id)}/stop`, { body: {}, timeoutMs: 15000 });
    res.writeHead(r.status || 200, { 'content-type': 'application/json' }); res.end(r.text);
  });

  app.post('/api/run/:id/approval', async (req, res) => {
    const { decision } = req.body || {};
    if (!decision) return res.status(400).json({ error: 'decision required' });
    const r = await hermes.request('POST', `/v1/runs/${encodeURIComponent(req.params.id)}/approval`, { body: req.body, timeoutMs: 30000 });
    log('approval', req.params.id, decision, '→', r.status);
    res.writeHead(r.status || 200, { 'content-type': 'application/json' }); res.end(r.text);
  });

  app.post('/api/run/:id/steer', async (req, res) => {
    const r = await hermes.request('POST', `/v1/runs/${encodeURIComponent(req.params.id)}/steer`, { body: req.body || {}, timeoutMs: 30000 });
    res.writeHead(r.status || 200, { 'content-type': 'application/json' }); res.end(r.text);
  });
} };
