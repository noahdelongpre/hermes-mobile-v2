
const {chromium} = require('playwright');
(async()=>{
 const b = await chromium.launch();
 const p = await (await b.newContext({viewport:{width:384,height:600}})).newPage();
 await p.goto('http://127.0.0.1:8124/',{waitUntil:'networkidle'});
 const res = await p.evaluate(async () => {
   try { const j = await API.post('/api/run/create', {input:'say APIPOST-OK', conversation:'hm2-main'});
     return {ok:true, j};
   } catch(e) { return {ok:false, e: e.message}; }
 });
 await p.evaluate(() => {});
 require('fs').writeFileSync('apipost.json', JSON.stringify(res));
 await b.close(); process.exit(0);
})();
