
const {chromium} = require('playwright');
(async()=>{
 // markdown render E2E: force deterministic content by verifying md.js directly in the page context
 const b = await chromium.launch();
 const p = await (await b.newContext({viewport:{width:384,height:832},deviceScaleFactor:2,isMobile:true,hasTouch:true})).newPage();
 await p.goto('http://127.0.0.1:8124/', {waitUntil:'load'});
 const r = await p.evaluate(() => {
   const html = MD.render('|A|B|\n|-|-|\n|1|2|\n\n```python\nprint(1)\n```\n\n<script>alert(1)</script>');
   const d = document.createElement('div'); d.innerHTML = html;
   return {tables: d.querySelectorAll('table').length, codes: d.querySelectorAll('pre code').length,
     noScript: d.querySelectorAll('script').length === 0};
 });
 console.log('MD-IN-PAGE:', JSON.stringify(r));
 await b.close(); process.exit(r.tables===1&&r.codes===1&&r.noScript?0:1);
})();
