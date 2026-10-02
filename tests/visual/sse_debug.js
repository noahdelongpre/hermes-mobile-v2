
const {chromium} = require('playwright');
(async()=>{
 const b = await chromium.launch();
 const p = await (await b.newContext({viewport:{width:384,height:600}})).newPage();
 const msgs=[];
 p.on('console', m=>msgs.push(m.type()+':'+m.text().slice(0,200)));
 await p.goto('http://127.0.0.1:8124/',{waitUntil:'networkidle'});
 const res = await p.evaluate(async () => {
   const createRes = await fetch('/api/run/create', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({input:'say DYNO-SSE'})});
   const created = await createRes.json();
   if (!created.run_id) return {fail:'create: '+JSON.stringify(created)};
   const es = new EventSource('/api/run/'+created.run_id+'/events');
   return await new Promise(resolve => {
     const got = [];
     es.onmessage = e => { got.push(e.data);
       try { const d = JSON.parse(e.data); if (d.event === 'run.completed' || d.event === 'stream.closed') { es.close(); resolve({events: got.slice(0,4)}); } }
       catch {}
     };
     es.onerror = e => { es.close(); resolve({fail:'EventSource error', got}); };
     setTimeout(() => { es.close(); resolve({fail:'timeout after 60s', got}); }, 60000);
   });
 });
 require('fs').writeFileSync('sse_debug.json', JSON.stringify({res, msgs}, null, 1));
 await b.close(); process.exit(0);
})();
