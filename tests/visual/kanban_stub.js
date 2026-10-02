
const http=require('http');
const stubTasks=[{id:'t1',title:'fix PI DNS rewrite',status:'todo',updated_at:'2026-10-01T01:00:00Z'},{id:'t2',title:'wire SSE fanout',status:'in progress',updated_at:'2026-10-01T02:00:00Z'},{id:'t3',title:'ship kanban ui',status:'done',updated_at:'2026-10-01T03:00:00Z'}];
http.createServer((rq,res)=>{
  if(rq.method==='GET'&&rq.url==='/api/v1/tasks'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({tasks:stubTasks}));}
  if(rq.method==='PATCH'){let b='';rq.on('data',c=>b+=c);rq.on('end',()=>{const id=decodeURIComponent(rq.url.split('/').pop());const t=stubTasks.find(x=>x.id===id);if(t&&JSON.parse(b||'{}').status)t.status=JSON.parse(b).status;res.writeHead(200);res.end('{}');});return;}
  res.writeHead(404);res.end();
}).listen(8295,'127.0.0.1',()=>console.log('stub up'));
