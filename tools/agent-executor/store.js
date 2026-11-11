'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {canonical,digest,reject}=require('./policy');
const ACTIVE=['CLAIMED','RUNNING','HUMAN_REVIEW_REQUIRED'];
function alive(pid){try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
class Store{
 constructor(dir,ttl=600000){
  this.dir=path.resolve(dir);if(!this.dir.startsWith(path.resolve(os.tmpdir())+path.sep)||!Number.isSafeInteger(ttl)||ttl<1)reject('TEMP_SIMULATION_ONLY');
  fs.mkdirSync(this.dir,{recursive:true,mode:0o700});const st=fs.lstatSync(this.dir);
  if(!st.isDirectory()||(st.mode&0o777)!==0o700||typeof process.getuid!=='function'||st.uid!==process.getuid())reject('UNSAFE_STORE');
  this.file=path.join(this.dir,'executor.json');this.lock=path.join(this.dir,'transaction.lock');this.ttl=ttl;
 }
 transaction(fn){
  let fd;try{fd=fs.openSync(this.lock,'wx',0o600);}catch(e){if(e.code==='EEXIST'){try{if(Date.now()-fs.lstatSync(this.lock).mtimeMs>this.ttl)reject('STALE_STORE_LOCK_HUMAN_REVIEW');}catch(readError){if(readError.code==='ENOENT')reject('STORE_LOCK_CHANGED_HUMAN_REVIEW');throw readError;}}reject('STORE_LOCKED_HUMAN_REVIEW');}
  try{
   let s={version:1,jobs:{},daily:{},audit:[]};
   if(fs.existsSync(this.file)){
    const st=fs.lstatSync(this.file);if(!st.isFile()||(st.mode&0o777)!==0o600||st.size>4*1024*1024)reject('UNSAFE_STORE');
    const parsed=JSON.parse(fs.readFileSync(this.file,'utf8')),checksum=parsed.checksum;delete parsed.checksum;
    if(parsed.version!==1||checksum!==digest(parsed)||!parsed.jobs||!parsed.daily||!Array.isArray(parsed.audit))reject('CORRUPT_STORE');s=parsed;
   }
   const result=fn(s);
   const encoded=canonical({...s,checksum:digest(s)});const tmp=path.join(this.dir,'write-'+crypto.randomUUID());
   const out=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(out,encoded);fs.fsyncSync(out);}finally{fs.closeSync(out);}
   fs.renameSync(tmp,this.file);return result;
  }finally{fs.closeSync(fd);fs.unlinkSync(this.lock);}
 }
 log(s,type,key,now,detail={}){const event={type,key,at:now,...detail,previous:s.audit.at(-1)?.hash||null};s.audit.push({...event,hash:digest(event)});}
 recover(s,now){for(const [key,j] of Object.entries(s.jobs))if(['CLAIMED','RUNNING'].includes(j.state)&&(!alive(j.pid)||now-j.heartbeat>this.ttl)){
  j.state='HUMAN_REVIEW_REQUIRED';j.actual_cost=null;j.recovery='POSSIBLY_INTERRUPTED_NO_REPLAY';this.log(s,'RECOVERED_UNKNOWN',key,now);
 }}
 claim(request,limits,now){return this.transaction(s=>{
  this.recover(s,now);
  const key=digest([request.repo,request.issue,request.role,request.phase,request.sha,request.approval_version]);
  if(s.jobs[key])return {blocked:'DUPLICATE_JOB',key};
  if(Object.values(s.jobs).some(j=>j.role===request.role&&ACTIVE.includes(j.state)))return {blocked:'ROLE_BUSY',key};
  const day=new Date(now).toISOString().slice(0,10),d=s.daily[day]||{reserved:0,used:0};
  if(d.reserved+d.used+limits.max_model_spend>limits.max_daily_model_spend)return {blocked:'DAILY_BUDGET',key};
  d.reserved+=limits.max_model_spend;s.daily[day]=d;
  s.jobs[key]={role:request.role,issue:request.issue,sha:request.sha,state:'CLAIMED',pid:process.pid,heartbeat:now,day,reserved:limits.max_model_spend,used_tokens:0,simulated_spend:0,actual_cost:null};
  this.log(s,'CLAIMED',key,now);return {key};
 });}
 transition(key,state,now,usage){return this.transaction(s=>{
  const j=s.jobs[key];const allowed={CLAIMED:['RUNNING','STOPPED'],RUNNING:['SUCCESS','FAILED','BLOCKED','STOPPED','HUMAN_REVIEW_REQUIRED']};
  if(!j||j.pid!==process.pid||!allowed[j.state]?.includes(state))reject('INVALID_TRANSITION');
  j.state=state;j.heartbeat=now;
  if(usage){j.used_tokens=usage.tokens;j.simulated_spend=usage.spend;}
  if(['SUCCESS','FAILED','BLOCKED','STOPPED'].includes(state)){
   const d=s.daily[j.day];d.reserved-=j.reserved;d.used+=j.simulated_spend;j.reserved=0;
  }
  this.log(s,state,key,now,{tokens:j.used_tokens,simulated_spend:j.simulated_spend});return {...j};
 });}
 heartbeat(key,now){return this.transaction(s=>{const j=s.jobs[key];if(!j||j.pid!==process.pid||j.state!=='RUNNING')reject('NOT_RUNNING');j.heartbeat=now;this.log(s,'HEARTBEAT',key,now);return true;});}
 snapshot(){return this.transaction(s=>JSON.parse(JSON.stringify(s)));}
}
module.exports={Store};
