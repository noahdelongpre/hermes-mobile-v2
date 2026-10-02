'use strict';
// Session routes — REST wrapper over Hermes /api/sessions (tree = localStorage mirror in browser).
// Upstream shapes verified 2026-10-02 against the live gateway:
//   POST /api/sessions            → {object:'hermes.session', session:{id,...}}
//   GET  /api/sessions            → {object,data:[rows],limit,offset,has_more}
//     row keys incl: id,title,model,message_count,last_active,preview,archived,pinned,estimated_cost_usd,parent_session_id
//   GET  /api/sessions/:id        → {session:{...}}
//   GET  /api/sessions/:id/messages?include_compacted=true → {object:'list',session_id,data:[{role,content,tool_name,...}]}
//     content is string | null; ascending order; tool rows carry tool_name/tool_call_id.
//   PATCH /api/sessions/:id {title} → {session}; unknown fields → 400 unsupported_session_field
//   POST /v1/runs {input, session_id} → run bound to that session (history PERSISTS there).
//     {conversation: <label>} does NOT persist (run.session_id = run_id = ephemeral).
// NOTE: handlers receive the WRAPPED response helper (res.raw / res.json / res.status)
// — res.writeHead would crash (raw ServerResponse methods live on res.raw).
module.exports = { register(app) {
  const { hermes } = app.ctx;
  const JS = { 'content-type': 'application/json' };
  // upstream net/timeout errors: degrade to 502 with a clear body, never a crash
  const tolerant = fn => fn.catch(e => ({ status: 502, text: JSON.stringify({ error: String(e.message || e).slice(0, 200) }) }));
  const send = (res, status, bodyText) => { res.raw.writeHead(status, JS); res.raw.end(bodyText); };

  app.post('/api/session', async (req, res) => {
    const r = await tolerant(hermes.request('POST', '/api/sessions', { body: req.body || {}, timeoutMs: 15000 }));
    send(res, r.status, r.text);
  });

  app.get('/api/session/list', async (req, res) => {
    const lim = req.query.get('limit') || 50, off = req.query.get('offset') || 0;
    const r = await tolerant(hermes.request('GET', `/api/sessions?limit=${lim}&offset=${off}`, { timeoutMs: 15000 }));
    if (r.status !== 200) return send(res, r.status, r.text || JSON.stringify({ error: 'upstream error' }));
    const d = r.json || {};
    const rows = (d.data || []).map(s => ({
      id: s.id, title: s.title, preview: s.preview, model: s.model, source: s.source,
      message_count: s.message_count, last_active: s.last_active, started_at: s.started_at,
      archived: !!s.archived, pinned: !!s.pinned,
      cost_usd: s.estimated_cost_usd, tokens: (s.input_tokens || 0) + (s.output_tokens || 0),
      parent: s.parent_session_id || null,
    }));
    send(res, 200, JSON.stringify({ sessions: rows, has_more: !!d.has_more, offset: d.offset || 0 }));
  });

  app.get('/api/session/:id/messages', async (req, res) => {
    const inc = req.query.get('inline_images') === 'false' ? '&inline_images=false' : '';
    const r = await tolerant(hermes.request('GET', `/api/sessions/${encodeURIComponent(req.params.id)}/messages?include_compacted=true${inc}`, { timeoutMs: 30000 }));
    send(res, r.status, r.text);
  });

  app.post('/api/session/:id/fork', async (req, res) => {
    const r = await tolerant(hermes.request('POST', `/api/sessions/${encodeURIComponent(req.params.id)}/fork`, { body: req.body || {}, timeoutMs: 30000 }));
    send(res, r.status, r.text);
  });

  app.patch('/api/session/:id', async (req, res) => {
    const r = await tolerant(hermes.request('PATCH', `/api/sessions/${encodeURIComponent(req.params.id)}`, { body: req.body || {}, timeoutMs: 15000 }));
    send(res, r.status, r.text);
  });

  app.delete('/api/session/:id', async (req, res) => {
    const r = await tolerant(hermes.request('DELETE', `/api/sessions/${encodeURIComponent(req.params.id)}`, { timeoutMs: 15000 }));
    send(res, r.status, r.text);
  });

  app.get('/api/session/:id', async (req, res) => {
    const r = await tolerant(hermes.request('GET', `/api/sessions/${encodeURIComponent(req.params.id)}`, { timeoutMs: 15000 }));
    send(res, r.status, r.text);
  });
} };
