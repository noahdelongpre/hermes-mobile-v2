
const {chromium} = require('playwright');
(async()=>{
 const b = await chromium.launch();
 const ctx = await b.newContext({viewport:{width:384,height:832},isMobile:true,hasTouch:true});
 const p = await ctx.newPage();
 await p.goto('http://127.0.0.1:8124/', {waitUntil:'load', timeout:20000});
 await p.waitForSelector('#composer',{timeout:10000});
 await p.fill('#composer', 'X');
 await p.click('#send');
 await p.waitForTimeout(30000);
 const text = await p.evaluate(() => document.querySelector('#tl')?.textContent || 'EMPTY');
 await p.close(); await b.close();
 require('fs').writeFileSync('mini.json', JSON.stringify({text: text.slice(0,400)}));
 process.exit(0);
})().catch(e=>{require('fs').writeFileSync('mini.json','ERR:'+e.message.slice(0,200)); process.exit(1);});
