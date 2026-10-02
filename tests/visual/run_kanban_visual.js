// run_kanban_visual.js — one-shot: spawn the app server WITH DoneTick-stub env,
// wait for /api/health, then run the S24 Ultra visual spec against /#board, and
// kill the server on exit. (Workaround: background-shell env stripping.)
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = process.env.KANBAN_TEST_PORT || 8137;

const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), AUTH_PASS: '', DONETICK_URL: 'http://127.0.0.1:8295', DONETICK_KEY: 'stub-key' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { await new Promise((res, rej) => { const r = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health' }, s => { s.resume(); s.on('end', res); }); r.on('error', rej); setTimeout(() => rej(new Error('t')), 600); }); up = true; } catch { await wait(150); }
  }
  const tasks = await new Promise(res => { http.get({ host: '127.0.0.1', port: PORT, path: '/api/kanban/tasks' }, r2 => { let b = ''; r2.on('data', c => b += c); r2.on('end', () => res(b)); }).on('error', e => res('ERR ' + e.message)); });
  console.log('API tasks:', tasks.slice(0, 250));
  const pw = spawn(process.execPath, process.argv[2] === '--e2e'
    ? [path.join(__dirname, 'kanban_e2e_browser.js')]
    : process.argv[2] === '--debug'
    ? [path.join(__dirname, 'api_promote_probe.js')]
    : [path.join(__dirname, 's24ultra.js'), '--dpr', '2.5', `http://localhost:${PORT}/#board`, 'kanban_board_cfg'], { stdio: 'inherit', env: process.env });
  pw.on('exit', c => {
    child.kill('SIGKILL');
    try { execSync('taskkill /pid ' + child.pid + ' /T /F', { stdio: 'ignore', windowsHide: true }); } catch {}
    console.log('SERVER OUT:', out.slice(0, 500));
    process.exit(c || 0);
  });
})().catch(e => { console.error('FE', e); child.kill('SIGKILL'); process.exit(1); });
