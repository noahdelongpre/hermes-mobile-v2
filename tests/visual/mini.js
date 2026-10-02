
const {chromium} = require('playwright');
(async()=>{
 const b = await chromium.launch();
 const ctx = await b.newContext({viewport:{width:384,height:832},deviceScaleFactor:2,isMobile:true,hasTouch:true});
 const p = await ctx.newPage();
 const msgs=[]; p.on('pageerror',e=>msgs.push('PE:'+e.message.slice(0,120)));
 await p.goto('http://127.0.0.1:8124/',{waitUntil:'load'});
 await p.waitForSelector('#composer', {timeout:15000});
 await p.fill('#composer', "Reply with EXACTLY this markdown and no commentary: |A|B|\n|-|-|\n|1|2|\n\n```python\nprint(1)\n```");
 await p.tap('#send');
 const t0 = Date.now();
 while (Date.now() - t0 < 120000) {
   await p.waitForTimeout(5000);
   const s = await p.evaluate(() => ({tables: document.querySelectorAll('#tl table').length,
     codes: document.querySelectorAll('#tl pre code').length,
     tails: document.querySelector('#tl')?.textContent.slice(-120)}));
   if (s.tables >= 1 && s.codes >= 1) { require('fs').writeFileSync('mini.json', JSON.stringify({ok:true, s})); await b.close(); process.exit(0); }
 }
 const s = await p.evaluate(() => ({tables: document.querySelectorAll('#tl table').length,
   codes: document.querySelectorAll('#tl pre code').length,
   text: document.querySelector('#tl')?.textContent.slice(0,400)}));
 require('fs').writeFileSync('mini.json', JSON.stringify({ok:false, s, msgs}));
 await b.close(); process.exit(1);
})().catch(e=>{try{require('fs').writeFileSync('mini.json','ERR:'+e.message.slice(0,300));}catch{}; process.exit(1);});
