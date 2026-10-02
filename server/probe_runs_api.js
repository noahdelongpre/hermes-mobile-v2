#!/usr/bin/env node
'use strict';
// Prove Hermes Runs API shapes empirically. Key findings already confirmed:
// POST /v1/runs takes {"input": "..."} (NOT messages[]). Key from env HERMES_KEY.
const { BASE, request } = require('./hermes_client');
const fs = require('fs');
const HK = process.env.HERMES_KEY;

(async () => {
  const probes = {};
  const mo = await request('GET', '/api/model/options', { timeoutMs: 15000 });
  probes.model_options = { status: mo.status, topKeys: mo.json ? Object.keys(mo.json) : null,
    provider0: mo.json?.providers?.[0] ? Object.keys(mo.json.providers[0]) : null };
  const run = await request('POST', '/v1/runs', { body: { input: 'Reply with exactly: PROBE-OK' }, timeoutMs: 180000 });
  probes.create_run = run.json;
  if (run.json && run.json.run_id) {
    const id = run.json.run_id;
    // stream events (raw)
    const ev = await request('GET', `/v1/runs/${id}/events`, { raw: true, timeoutMs: 150000 });
    let sse = '';
    await new Promise(res => { ev.on('data', c => sse += c.toString()); ev.on('end', res); setTimeout(res, 60000); });
    probes.sse_sample = sse.slice(0, 5000);
    probes.sse_event_types = [...new Set([...sse.matchAll(/^event:\s*(.+)$/gm)].map(m => m[1]))];
    const fin = await request('GET', `/v1/runs/${id}`);
    probes.run_status = fin.json;
  }
  fs.writeFileSync(__dirname + '/runs_api_probes.json', JSON.stringify(probes, null, 2));
  console.log('OK. event types:', probes.sse_event_types?.join(', '));
})().catch(e => { console.error('PROBE FAIL:', e.message); process.exit(1); });
