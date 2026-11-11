'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const SHA=/^[a-f0-9]{40}$/;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const validPlan=p=>Number.isSafeInteger(p?.issue)&&[p.role,p.phase].every(x=>typeof x==='string'&&x.length>0&&x.length<100)&&SHA.test(p.sha||'');
// AUD-26-SCH-04: only an exact {version:1, plans:{<key>:{created_at,expires_at}}} record is
// a ledger. Arrays, null, primitives, unknown fields, malformed keys or entries are corrupt:
// fail closed, never "repair" by deleting history, never produce would_dispatch.
function validState(state) {
  if(!plain(state)||Object.keys(state).sort().join()!=='plans,version'||state.version!==1||!plain(state.plans))return false;
  for(const [key,entry] of Object.entries(state.plans)){
    let k;try{k=JSON.parse(key);}catch{return false;}
    if(!Array.isArray(k)||k.length!==4||!validPlan({issue:k[0],role:k[1],phase:k[2],sha:k[3]})||JSON.stringify(k)!==key)return false;
    if(!plain(entry)||Object.keys(entry).sort().join()!=='created_at,expires_at'||!Number.isFinite(entry.created_at)||!Number.isFinite(entry.expires_at)||entry.expires_at<entry.created_at)return false;
  }
  return true;
}
// The single encoding this tool writes: {"version":1,"plans":{<key>:{"created_at","expires_at"}}}.
const canonical=state=>JSON.stringify({version:state.version,plans:Object.fromEntries(Object.entries(state.plans).map(([k,v])=>[k,{created_at:v.created_at,expires_at:v.expires_at}]))});
class PlanStore {
  constructor(dir,ttl=600000) {
    this.dir=path.resolve(dir);if(!this.dir.startsWith(path.resolve(os.tmpdir())+path.sep)||!Number.isSafeInteger(ttl)||ttl<1)throw Error('TEMP_SIMULATION_ONLY');
    fs.mkdirSync(this.dir,{recursive:true,mode:0o700});
    const st=fs.lstatSync(this.dir);if(!st.isDirectory()||(st.mode&0o077)!==0||st.uid!==process.getuid())throw Error('UNSAFE_SIMULATION_DIRECTORY');
    this.file=path.join(this.dir,'plans.json');this.lock=path.join(this.dir,'lease.lock');this.ttl=ttl;
  }
  readState() {
    let st;try{st=fs.lstatSync(this.file);}catch(e){if(e.code==='ENOENT')return {version:1,plans:{}};throw e;}
    if(!st.isFile())throw Error('CORRUPT_SIMULATION_SNAPSHOT');
    // AUD-33-SCH-03: JSON.parse silently keeps the last of duplicate keys, so the shape
    // check alone cannot see an erased history. The writer only ever emits the canonical
    // JSON.stringify encoding; any other byte sequence (duplicate or escaped-equivalent
    // keys, reordering, whitespace) is corrupt. Fail closed and keep the original bytes.
    const raw=fs.readFileSync(this.file,'utf8');
    let state;try{state=JSON.parse(raw);}catch{throw Error('CORRUPT_SIMULATION_SNAPSHOT');}
    if(!validState(state)||canonical(state)!==raw)throw Error('CORRUPT_SIMULATION_SNAPSHOT');
    return state;
  }
  claim({issue,role,phase,sha},now=Date.now()) {
    if(!validPlan({issue,role,phase,sha})||!Number.isFinite(now))throw Error('INVALID_PLAN');
    const key=JSON.stringify([issue,role,phase,sha]);let fd;
    try{fd=fs.openSync(this.lock,'wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;let metadata;try{metadata=fs.lstatSync(this.lock);}catch(readError){if(readError.code==='ENOENT')return {would_dispatch:false,actual_dispatch:false,warning:'LOCK_CHANGED_RETRY_READONLY'};throw readError;}const stale=now-metadata.mtimeMs>this.ttl;return {would_dispatch:false,actual_dispatch:false,warning:stale?'STALE_LOCK_HUMAN_REVIEW_REQUIRED':'LOCK_BUSY'};}
    try {
      const state=this.readState();
      if(Object.hasOwn(state.plans,key))return {would_dispatch:false,actual_dispatch:false,warning:now>=state.plans[key].expires_at?'EXPIRED_LEASE_HUMAN_REVIEW_REQUIRED':'DUPLICATE_EVENT'};
      state.plans[key]={created_at:now,expires_at:now+this.ttl};
      const staged=this.file+'.'+crypto.randomUUID();fs.writeFileSync(staged,canonical(state),{mode:0o600,flag:'wx'});fs.renameSync(staged,this.file);
      // Read back: the persisted ledger must contain the key before any plan is reported.
      if(!Object.hasOwn(this.readState().plans,key))throw Error('CORRUPT_SIMULATION_SNAPSHOT');
      return {would_dispatch:true,actual_dispatch:false,key};
    }finally{fs.closeSync(fd);fs.unlinkSync(this.lock);}
  }
}
function dispatchAgent(){throw Error('AGENT_DISPATCH_DISABLED_IN_V1');}
module.exports={PlanStore,dispatchAgent,validState};
