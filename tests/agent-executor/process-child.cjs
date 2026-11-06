'use strict';
const fs=require('node:fs');const {Store}=require('../../tools/agent-executor/store');
const [mode,dir]=process.argv.slice(2),store=new Store(dir);
const request={repo:'chaow0879-collab/aijavais',issue:22,role:'audit',phase:'audit',sha:'1'.repeat(40),approval_version:'fake-1'};
const limits={max_model_spend:2,max_daily_model_spend:10};
try{
 const result=store.claim(request,limits,Date.now());
 if(mode==='crash'&&!result.blocked){store.transition(result.key,'RUNNING',Date.now());fs.writeSync(1,JSON.stringify(result)+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
 else fs.writeSync(1,JSON.stringify(result)+'\n');
}catch(e){fs.writeSync(1,JSON.stringify({blocked:e.code||'STORE_FAILURE'})+'\n');}
