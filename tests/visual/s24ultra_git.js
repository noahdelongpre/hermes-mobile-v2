'use strict';
const { chromium } = require('playwright');
const path = require('path');
// Spin up the real server pointed at a scratch git workspace, then run the
// S24 Ultra visual gate against the Git tab. Keeps the real app untouched.
const { spawn, execFileSync } = require('child_process');
const os = require('os'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 8129;

(async () => {
  // ---- scratch repo BEFORE server start (workspaces.json seeds from cwd root) ----
  const tmp = path.join(os.tmpdir(), 'hm2-visual-git-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  const g = a => execFileSync('git', a, { cwd: tmp, encoding: 'utf8' });
  g(['init', '-b', 'main']);
  g(['config', 'user.email', 'v@v']); g(['config', 'user.name', 'Visual']);
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'line1\nline2\n');
  g(['add', '.']);
  g(['commit', '-m', 'seed commit']);
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'line1\nline2 changed\nadded line3\n');
  fs.writeFileSync(path.join(tmp, 'untracked.txt'), 'u\n');

  // workspaces.json takes precedence over FS_ROOT — seed it (restore in finally)
  const wsPath = path.join(ROOT, 'state', 'workspaces.json');
  let priorWs = null;
  try { priorWs = fs.readFileSync(wsPath, 'utf8'); } catch {}
  fs.writeFileSync(wsPath, JSON.stringify({ default: tmp.replace(/\\/g, '/') }));
  const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), AUTH_PASS: '', FS_ROOT: tmp },
    stdio: 'ignore',
  });
  await new Promise(rs => setTimeout(rs, 1500));

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 384, height: 832 }, deviceScaleFactor: 2.5, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${PORT}/#git`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000); // let git tab status/diff/log fetches settle

  // 1. horizontal overflow
  const overflow = await page.evaluate(() =>
    Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
  if (overflow > 2) problems.push(`horizontal overflow: ${overflow}px`);

  // 2. touch targets
  const small = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, a, [role="button"], input, [onclick]')];
    return els.filter(e => {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      return (r.width < 44 || r.height < 44) && !e.matches('input[type=hidden], svg *, path, .git-file-row input');
    }).map(e => `${e.tagName}.${String(e.className).split(' ')[0]} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
  });
  if (small.length) problems.push('touch targets <44px: ' + small.join('; '));

  // 3. tiny text
  const tiny = await page.evaluate(() => {
    const it = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const bad = new Set();
    while (it.nextNode()) {
      const n = it.currentNode; if (!n.textContent.trim()) continue;
      const e = n.parentElement;
      if (e.closest('pre, code, .mono, [data-mono], .diff-body, .diff-title')) continue;
      const fsz = parseFloat(getComputedStyle(e).fontSize);
      if (fsz < 12) bad.add(e.tagName + ' ' + fsz);
    }
    return [...bad];
  });
  if (tiny.length) problems.push('text <12px: ' + tiny.join('; '));

  // 4. pure-white backgrounds
  const white = await page.evaluate(() => {
    let n = 0;
    for (const e of document.querySelectorAll('body *'))
      if (getComputedStyle(e).backgroundColor === 'rgb(255, 255, 255)') n++;
    return n;
  });
  if (white > 0) problems.push(`pure-white bg elements: ${white}`);

  // 5. nav overlap
  const nav = await page.$('.bottom-nav');
  const nr = await nav.boundingBox();
  const overlapped = await page.evaluate((y) => {
    let n = 0;
    for (const e of document.querySelectorAll('button, a, .btn')) {
      if (e.closest('.bottom-nav')) continue;
      const r = e.getBoundingClientRect();
      if (r.top < y && r.bottom > y) n++;
    }
    return n;
  }, nr.y + 2);
  if (overlapped > 0) problems.push(`elements covered by nav: ${overlapped}`);

  // 6. Git tab sanity: status list + commit box + branch dropdown rendered
  const sanity = await page.evaluate(() => ({
    hasGitHeading: /Git/.test(document.querySelector('#app h2, h2')?.textContent || ''),
    fileRows: document.querySelectorAll('.git-file-row').length,
    diffCards: document.querySelectorAll('.diffview').length,
    hasCommitBox: !!document.querySelector('textarea[placeholder*="Commit"]'),
    hasBranchSelect: !!document.querySelector('#app select'),
    logCards: [...document.querySelectorAll('#app .card')].length,
  }));
  // open diff on a.txt (render path exercising DiffView)
  await page.evaluate(() => { const f = [...document.querySelectorAll('#app .git-file')].find(n => n.textContent === 'a.txt'); if (f) f.click(); });
  await page.waitForTimeout(800);
  const diffShown = await page.evaluate(() => document.querySelectorAll('#app .diffview').length > 0);
  if (!sanity.hasCommitBox) problems.push('Git tab: commit textarea missing');
  if (!sanity.hasBranchSelect) problems.push('Git tab: branch select missing');
  if (!sanity.fileRows) problems.push('Git tab: no status file rows');
  if (!diffShown) problems.push('Git tab: diff viewer did not render on file tap');

  await page.screenshot({ path: path.join(__dirname, 'shots', 'git-s24-dpr2.5.png'), fullPage: true });
  await page.screenshot({ path: path.join(__dirname, 'shots', 'git-s24-diff.png'), fullPage: true });
  await page.setViewportSize({ width: 832, height: 384 });
  await page.waitForTimeout(300);
  const lo = await page.evaluate(() =>
    Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
  if (lo > 2) problems.push(`landscape horizontal overflow: ${lo}px`);

  console.log(problems.length ? `PROBLEMS (${problems.length}):\n- ` + problems.join('\n- ') : 'PASS: all S24 Ultra checks green (Git tab)');
  console.log('sanity:', JSON.stringify({ ...sanity, diffShown }));
  await browser.close();
  const { execSync } = require('child_process');
  try { execSync('taskkill /pid ' + srv.pid + ' /T /F', { stdio: 'ignore', windowsHide: true }); } catch {}
  if (priorWs) fs.writeFileSync(wsPath, priorWs);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(problems.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
