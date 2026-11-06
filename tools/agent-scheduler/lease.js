'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
class PlanStore {
  constructor(dir,ttl=600000) {
    this.dir=path.resolve(dir);if(!this.dir.startsWith(path.resolve(os.tmpdir())+path.sep)||!Number.isSafeInteger(ttl)||ttl<1)throw Error('TEMP_SIMULATION_ONLY');
    fs.mkdirSync(this.dir,{recursive:true,mode:0o700});
    const st=fs.lstatSync(this.dir);if(!st.isDirectory()||(st.mode&0o077)!==0||st.uid!==process.getuid())throw Error('UNSAFE_SIMULATION_DIRECTORY');
    this.file=path.join(this.dir,'plans.json');this.lock=path.join(this.dir,'lease.lock');this.ttl=ttl;
  }
  claim({issue,role,phase,sha},now=Date.now()) {
    if(!Number.isSafeInteger(issue)||![role,phase].every(x=>typeof x==='string'&&x.length<100)||!/^[a-f0-9]{40}$/.test(sha))throw Error('INVALID_PLAN');
    const key=JSON.stringify([issue,role,phase,sha]);let fd;
    try{fd=fs.openSync(this.lock,'wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;const stale=now-fs.lstatSync(this.lock).mtimeMs>this.ttl;return {would_dispatch:false,actual_dispatch:false,warning:stale?'STALE_LOCK_HUMAN_REVIEW_REQUIRED':'LOCK_BUSY'};}
    try {
      const state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{version:1,plans:{}};
      if(state.version!==1||!state.plans||typeof state.plans!=='object')throw Error('CORRUPT_SIMULATION_SNAPSHOT');
      if(Object.hasOwn(state.plans,key))return {would_dispatch:false,actual_dispatch:false,warning:now>=state.plans[key].expires_at?'EXPIRED_LEASE_HUMAN_REVIEW_REQUIRED':'DUPLICATE_EVENT'};
      state.plans[key]={created_at:now,expires_at:now+this.ttl};
      const staged=this.file+'.'+crypto.randomUUID();fs.writeFileSync(staged,JSON.stringify(state),{mode:0o600,flag:'wx'});fs.renameSync(staged,this.file);
      return {would_dispatch:true,actual_dispatch:false,key};
    }finally{fs.closeSync(fd);fs.unlinkSync(this.lock);}
  }
}
function dispatchAgent(){throw Error('AGENT_DISPATCH_DISABLED_IN_V1');}
module.exports={PlanStore,dispatchAgent};
