
const {chromium} = require('playwright');
(async()=>{
 const b = await chromium.launch();
 const p = await (await b.newContext({viewport:{width:384,height:832},isMobile:true,hasTouch:true})).newPage();
 const msgs=[];
 p.on('console', m=>msgs.push(m.type()+':'+m.text().slice(0,150)));
 p.on('pageerror', e=>msgs.push('PAGEERROR:'+e.message.slice(0,150)));
 await p.goto('http://127.0.0.1:8124/',{waitUntil:'networkidle'});
 await p.waitForSelector('#composer', {timeout:15000});
 // fill + send and wait ≤75s, dump timeline + module state
 await p.fill('#composer', "Reply with EXACTLY this markdown and no commentary: |A|B|\n|-|-|\n|1|2|\n\n```python\nprint(1)\n```");
 await p.tap('#send');
 await p.waitForTimeout(75000);
 const out = await p.evaluate(() => ({
   timeline: document.querySelector('#tl')?.textContent.slice(0,500),
   tables: document.querySelectorAll('#tl table').length,
   codes: document.querySelectorAll('#tl pre code').length }));
 require('fs').writeFileSync('e2e_result.json', JSON.stringify({out, msgs}, null, 1));
 await b.close(); process.exit(0);
})();
