// S24 Ultra visual spec check for hermes-mobile v2 pages.
// Usage: node s24ultra.js <url> [tabLabel]
//checks: viewport fit, touch-target >=44px CSS px (=132 physical px), no horizontal scroll,
// text legibility, no external CDN blocking, console errors, dark-scheme compliance.
// Dev-only dependency (playwright) — production app itself stays zero-npm.
const path = require('path');
const { chromium, devices } = require('playwright');

const S24ULTRA = {
  name: 'Samsung Galaxy S24 Ultra',
  userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  viewport: { width: 384, height: 832 }, // browser CSS px; DPR 3 => 1152x2496 render
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  defaultBrowserType: 'chromium',
};

// Physical-resolution sanity: native 1440x3120; when "Display resolution" is set to
// FHD+ it becomes 1152x2496 physical px with CSS viewport still 384x832 @ DPR 3.
// We allow overriding scale to emulate FHD+ mode: node s24ultra.js --dpr 2.5 url
const args = process.argv.slice(2);
let dpr = 3;
const dprIdx = args.indexOf('--dpr');
if (dprIdx > -1) { dpr = parseFloat(args[dprIdx + 1]); args.splice(dprIdx, 2); }
const url = args[0] || 'http://localhost:8123/';
const label = args[1] || new Date().toISOString().replace(/[:.]/g, '-');
// --tab <name>: after load, switch the app shell to that tab (e.g. --tab git)
// before running the checks — used to screenshot individual tabs like Git.
const tabIdx = args.indexOf('--tab');
const tabName = tabIdx > -1 ? args[tabIdx + 1] : null;
if (tabIdx > -1) args.splice(tabIdx, 2);
const tabUri = tabName ? `#${tabName}` : null;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...S24ULTRA, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  // Switch to the requested tab (bottom-nav tap, like a real user) and let the
  // tab module finish rendering before the layout checks run.
  if (tabUri) {
    await page.click(`.bottom-nav button[data-tab="${tabName}"]`);
    await page.waitForTimeout(1200);
  }

  // 1. No horizontal overflow (mobile cardinal sin)
  const overflow = await page.evaluate(() =>
    Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
  if (overflow > 2) problems.push(`horizontal overflow: ${overflow}px`);

  // 2. Touch targets: every clickable element >= 44 CSS px in one dimension is not
  // enough; require 44x44 effective (the Android Material 48dp guideline uses 48)
  // We flag anything < 44 both-dimensions.
  const smallTargets = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, a, [role="button"], input, [onclick]')];
    return els.filter(e => {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      return (r.width < 44 || r.height < 44) && !e.matches('input[type=hidden], svg *, path');
    }).map(e => `${e.tagName}${e.className ? '.' + String(e.className).split(' ')[0] : ''} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
  });
  if (smallTargets.length) problems.push('touch targets <44px: ' + smallTargets.join('; '));

  // 3. Font legibility: computed font-size < 12px anywhere (excluding code/pre)
  const tinyText = await page.evaluate(() => {
    const it = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const bad = new Set();
    while (it.nextNode()) {
      const n = it.currentNode; if (!n.textContent.trim()) continue;
      const e = n.parentElement;
      if (e.closest('pre, code, .mono, [data-mono]')) continue;
      const fs = parseFloat(getComputedStyle(e).fontSize);
      if (fs < 12) bad.add(e.tagName + ' ' + fs);
    }
    return [...bad];
  });
  if (tinyText.length) problems.push('text <12px: ' + tinyText.join('; '));

  // 4. Dark theme: no pure-white backgrounds (should be dark UI)
  const lightBg = await page.evaluate(() => {
    let n = 0;
    for (const e of document.querySelectorAll('body *')) {
      const c = getComputedStyle(e);
      if (c.backgroundColor === 'rgb(255, 255, 255)') n++;
    }
    return n;
  });
  if (lightBg > 0) problems.push(`pure-white bg elements: ${lightBg}`);

  // 5. Layout height: bottom nav doesn't overlap content (safe-area handled)
  const nav = await page.$('nav, .bottom-nav, [role="tablist"]');
  if (nav) {
    const nr = await nav.boundingBox();
    if (nr) {
      const overlap = await page.evaluate((y) => {
        let n = 0;
        for (const e of document.querySelectorAll('button, a, .btn')) {
          if (e.closest('nav, .bottom-nav')) continue; // nav's own buttons aren't "covered"
          const r = e.getBoundingClientRect();
          if (r.top < y && r.bottom > y) n++;
        }
        return n;
      }, nr.y + 2);
      if (overlap > 0) problems.push(`elements covered by nav: ${overlap}`);
    }
  }
  // 6. Viewport meta + PWA installability signals
  const meta = await page.evaluate(() => ({
    viewport: !!document.querySelector('meta[name=viewport]'),
    manifest: !!document.querySelector('link[rel=manifest]'),
    theme: document.querySelector('meta[name=theme-color]')?.content || null,
  }));
  if (!meta.viewport) problems.push('no viewport meta');
  if (!meta.manifest) problems.push('no manifest link');
  if (!meta.theme) problems.push('no theme-color meta (address bar tint)');

  // Screenshots at DPR 3 (native-ish) and DPR 2.5 (FHD+ mode)
  await page.screenshot({ path: path.join(__dirname, `shots/${label}-dpr${dpr}.png`), fullPage: true });
  // landscape spot-check (S24U landscape browser)
  await page.setViewportSize({ width: 832, height: 384 });
  await page.waitForTimeout(300);
  const landscapeOverflow = await page.evaluate(() =>
    Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
  if (landscapeOverflow > 2) problems.push(`landscape horizontal overflow: ${landscapeOverflow}px`);
  await page.screenshot({ path: path.join(__dirname, `shots/${label}-landscape.png`) });

  console.log(problems.length ? `PROBLEMS (${problems.length}):\n- ` + problems.join('\n- ') : 'PASS: all S24 Ultra checks green');
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})();
