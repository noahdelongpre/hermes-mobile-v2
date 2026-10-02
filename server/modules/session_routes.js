'use strict';
// Session routes — REST wrapper over Hermes /api/sessions (tree = localStorage mirror in browser).
module.exports = { register(app) {
  const { hermes } = app.ctx;

    app.get('/api/session/list', async (req, res) => {
    const lim = req.query.get('limit') || 50, off = req.query.get('offset') || 0;
    const r = await hermes.request('GET', `/api/sessions?limit=${lim}&offset=${off}`, { timeoutMs: 15000 });
    if (r.status !== 200) { res.writeHead(r.status, { 'content-type': 'application/json' }); return res.end(r.text); }
    const d = r.json || {};
    const rows = (d.data || []).map(s => ({
      id: s.id, title: s.title, model: s.model, source: s.source,
      message_count: s.message_count, last_active: s.last_active, started_at: s.started_at,
      archived: !!s.archived, pinned: !!s.pinned,
      cost_usd: s.estimated_cost_usd, tokens: (s.input_tokens || 0) + (s.output_tokens || 0),
      parent: s.parent_session_id || null,
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions: rows, has_more: !!d.has_more, offset: d.offset || 0 }));
  });

  app.get('/api/session/:id/messages', async (req, res) => {
    const inc = req.query.get('inline_images') === 'false' ? '&inline_images=false' : '';
    const r = await hermes.request('GET', `/api/sessions/${encodeURIComponent(req.params.id)}/messages?include_compacted=true${inc}`, { timeoutMs: 30000 });
    res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(r.text);
  });

  app.post('/api/session/:id/fork', async (req, res) => {
    const r = await hermes.request('POST', `/api/sessions/${encodeURIComponent(req.params.id)}/fork`, { body: req.body || {}, timeoutMs: 30000 });
    res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(r.text);
  });

  app.patch('/api/session/:id', async (req, res) => {
    const r = await hermes.request('PATCH', `/api/sessions/${encodeURIComponent(req.params.id)}`, { body: req.body || {}, timeoutMs: 15000 });
    res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(r.text);
  });

  app.delete('/api/session/:id', async (req, res) => {
    const r = await hermes.request('DELETE', `/api/sessions/${encodeURIComponent(req.params.id)}`, { timeoutMs: 15000 });
    res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(r.text);
  });

  app.get('/api/session/:id', async (req, res) => {
    const r = await hermes.request('GET', `/api/sessions/${encodeURIComponent(req.params.id)}`, { timeoutMs: 15000 });
    res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(r.text);
  });
} };
