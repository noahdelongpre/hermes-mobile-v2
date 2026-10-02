'use strict';
// Run proxy routes — the only routes allowed to touch Hermes /v1/runs.
// POST /api/run/create {input, conversation?, model_options?} → upstream create, stores run→session link
// GET  /api/run/:id/status, /api/run/:id/events (SSE passthrough), /stop, /approval, /steer
const fs = require('fs');
const path = require('path');

module.exports = { register(app) {
  const { hermes, stateDir, log } = app.ctx;

  app.post('/api/run/create', async (req, res) => {
    const { input, conversation, session_id, model_options, workspaceId } = req.body || {};
    if (!input || typeof input !== 'string') { app.ctx.log('run/create REJECT body=', JSON.stringify(req.body || {}).slice(0, 200), 'ctype=', req.headers['content-type']); return res.status(400).json({ error: 'input required' }); }
    const body = { input }; if (session_id) body.session_id = session_id; if (conversation) body.conversation = conversation;
    if (model_options && typeof model_options === 'object') body.model_options = model_options;
    const r = await hermes.request('POST', '/v1/runs', { body, timeoutMs: 30000 });
    if (r.status !== 200 && r.status !== 202) return res.status(r.status >= 500 ? 502 : r.status).json({ error: r.json?.error || r.text.slice(0, 200) });
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
    res.raw.writeHead(r.status, { 'content-type': 'application/json' }); res.raw.end(r.text);
  });

  app.get('/api/run/:id/events', async (req, res) => {
    const s = res.sse();
    const upstream = await hermes.request('GET', `/v1/runs/${encodeURIComponent(req.params.id)}/events`, { raw: true, timeoutMs: 3600000 });
    if (upstream.statusCode && upstream.statusCode !== 200) {
      s.send({ event: 'upstream.error', status: upstream.statusCode }); s.close(); return;
    }
    let buf = '';
    upstream.on('data', c => {
      buf += c.toString();
      // upstream frames end with blank line; forward complete frames via s.send (keep JSON intact)
      if (!buf.includes('\n\n')) return;
      const blocks = buf.split('\n\n');
      buf = blocks.pop(); // keep trailing partial
      for (const block of blocks) {
        for (const line of block.split('\n')) {
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            try { s.send(JSON.parse(payload)); }
            catch { s.send({ event: 'raw', payload }); }
          }
        }
      }
    });
    upstream.on('end', () => { s.send({ event: 'stream.closed' }); s.close(); });
    upstream.on('error', e => { s.send({ event: 'upstream.error', message: e.message }); s.close(); });
    req.on('close', () => { try { upstream.destroy(); } catch {} });
  });

  app.post('/api/run/:id/stop', async (req, res) => {
    const r = await hermes.request('POST', `/v1/runs/${encodeURIComponent(req.params.id)}/stop`, { body: {}, timeoutMs: 15000 });
    res.raw.writeHead(r.status || 200, { 'content-type': 'application/json' }); res.raw.end(r.text);
  });

  app.post('/api/run/:id/approval', async (req, res) => {
    // Upstream contract (verified in gateway api_server_runs.py): {choice, request_id?}
    // where choice ∈ once|session|always|deny. Legacy 'decision' accepted as alias.
    const body = req.body || {};
    if (!body.choice && !body.decision) return res.status(400).json({ error: 'choice required (once|session|always|deny)' });
    if (!body.choice && body.decision) body.choice = body.decision;
    const r = await hermes.request('POST', `/v1/runs/${encodeURIComponent(req.params.id)}/approval`, { body, timeoutMs: 30000 }).catch(e => ({ status: 502, text: JSON.stringify({ error: String(e.message || e).slice(0, 200) }) }));
    log('approval', req.params.id, body.choice, '→', r.status);
    res.raw.writeHead(r.status || 200, { 'content-type': 'application/json' }); res.raw.end(r.text);
  });

  app.post('/api/run/:id/steer', async (req, res) => {
    const r = await hermes.request('POST', `/v1/runs/${encodeURIComponent(req.params.id)}/steer`, { body: req.body || {}, timeoutMs: 30000 });
    res.raw.writeHead(r.status || 200, { 'content-type': 'application/json' }); res.raw.end(r.text);
  });
} };
