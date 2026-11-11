'use strict';
// Real isolated Node runner; only a signed synthetic Fake envelope is passed.
const fs=require('node:fs'),path=require('node:path');
const input=JSON.parse(fs.readFileSync(process.argv[3],'utf8')),url=process.argv[2];
input.stateDir=path.join(path.dirname(input.stateDir),'runner-'+process.pid);
input.backend={async read(){const r=await fetch(url+'/state');if(!r.ok)throw Error('CAS_READ_FAILED');const data=await r.json();if(process.argv[4]==='kill-after-marker'&&Object.values(data.document.jobs).some(j=>j.state==='DISPATCHING'))process.kill(process.pid,'SIGKILL');return data;},async compareAndSwap(version,document){const r=await fetch(url+'/cas',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version,document})});if(!r.ok)throw Error('CAS_WRITE_FAILED');return r.json();}};
input.trigger=require('../../auto-handoff-r46/triggers').tick(input.now,input.config);
require('../../first-handoff-r49/control').execute(input).then(r=>console.log(JSON.stringify(r))).catch(()=>{process.exitCode=1;});
