'use strict';
// Session routes — REST wrapper over Hermes /api/sessions (tree = localStorage mirror in browser).
module.exports = { register(app) {
  const { hermes } = app.ctx;

  app.get('/api/session/list', async (req, res) => {
    const lim = req.query.get('limit') || 50, off = req.query.get('offset') || 0;
    const r = await hermes.request('GET', `/api/sessions?limit=${lim}&offset=${off}`, { timeoutMs: 15000 });
    res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(r.text);
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
