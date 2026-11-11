'use strict';
const fs=require('node:fs');
const {reconcile}=require('../../auto-handoff-r46/reconcile'),{tick}=require('../../auto-handoff-r46/triggers'),{FakeR45Runner}=require('../../auto-handoff-r46/r45-adapter');
const [url,file,mode]=process.argv.slice(2),f=JSON.parse(fs.readFileSync(file,'utf8'));
const backend={
 async read(){const r=await fetch(url+'/state',{signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('fixture read');return r.json();},
 async compareAndSwap(version,document){const r=await fetch(url+'/cas',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version,document}),signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('fixture cas');const ack=await r.json();if(mode==='kill-after-marker'&&ack.committed&&Object.values(document.jobs).some(j=>j.state==='DISPATCHING'))process.kill(process.pid,'SIGKILL');return ack;}
};
const runner=new FakeR45Runner();
reconcile({simulate:true,...f,backend,trigger:tick(f.now,f.config),runner}).then(r=>console.log(JSON.stringify({...r,simulated_runner_calls:runner.calls}))).catch(()=>{process.exitCode=1;});
