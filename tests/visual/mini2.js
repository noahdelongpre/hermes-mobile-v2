
const {chromium} = require('playwright');
(async()=>{
 const b = await chromium.launch({timeout: 30000});
 const p = await b.newPage();
 console.log('opening...');
 await p.goto('http://127.0.0.1:8124/', {timeout: 10000}).then(()=>console.log('LOADED')).catch(e=>console.log('NAV FAIL', e.message.slice(0,100)));
 await p.waitForTimeout(2500);
 console.log('ALIVE-CHECK');
 await b.close(); process.exit(0);
})().catch(e=>{console.log('FATAL', e.message.slice(0,150)); process.exit(1);});
