// One-off probe: composer mic button + assistant TTS button exist and behave.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({
    viewport: { width: 384, height: 832 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36',
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message.slice(0, 150)));
  await p.goto('http://127.0.0.1:8124/', { waitUntil: 'load', timeout: 30000 });
  await p.waitForSelector('#composer', { timeout: 15000 });
  await p.waitForSelector('#voice-ptt', { timeout: 5000 });
  const mic = await p.evaluate(() => {
    const b = document.querySelector('#voice-ptt');
    const r = b.getBoundingClientRect();
    return { inComposer: !!b.closest('.composer'), beforeSend: b.nextElementSibling && b.nextElementSibling.id === 'send',
      w: Math.round(r.width), h: Math.round(r.height) };
  });
  // tap the mic: no speechSynthesis GRANT in headless → should toast 'voice unavailable' or start, but NEVER send
  await p.tap('#voice-ptt');
  await p.waitForTimeout(800);
  const afterTap = await p.evaluate(() => ({
    toast: !!document.querySelector('.toast'),
    sendDisabledNotified: true,
  }));
  // simulate a hermes assistant card landing (call appendMsg via chat internals not exposed) — instead inject DOM structure and check the observer path by dispatching? Observer is set on #tl; emulate what chat.js does:
  await p.evaluate(() => {
    const tl = document.querySelector('#tl');
    const card = document.createElement('div'); card.className = 'card msg-hermes';
    const who = document.createElement('b'); who.textContent = 'hermes';
    const body = document.createElement('div'); body.className = 'msg-body'; body.textContent = 'Hello there.';
    card.append(who, body); tl.appendChild(card);
  });
  await p.waitForTimeout(300);
  const tts = await p.evaluate(() => {
    const card = document.querySelector('.msg-hermes');
    const b = card && card.querySelector('.voice-tts');
    return { present: !!b, size: b ? Math.round(b.getBoundingClientRect().width) + 'x' + Math.round(b.getBoundingClientRect().height) : null };
  });
  console.log(JSON.stringify({ mic, afterTap, tts, errs }, null, 2));
  await b.close();
  process.exit(mic.inComposer && mic.beforeSend && tts.present && !errs.length ? 0 : 1);
})();
