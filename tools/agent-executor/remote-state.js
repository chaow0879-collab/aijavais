'use strict';
// Cross-runner protocol, exercised only against an atomic Fake transport here.
// An eventual GitHub ref backend must CAS a reviewed state commit (no force),
// keep records public-safe, and fail closed on missing/ambiguous acknowledgments.
const {digest}=require('./policy'),crypto=require('node:crypto');
const {valid}=require('./github-ref-backend');
const REPO='chaow0879-collab/aijavais';
class RemoteJobs{
 constructor(transport){this.transport=transport;this.owner=crypto.randomBytes(32).toString('hex');}
 async claim(request,now=Date.now()){
  const blocked=reason=>({state:'BLOCKED',reason,actual_dispatch:false});
  if(request.repo!==REPO||!Number.isSafeInteger(request.issue)||!['integrator','audit','qa'].includes(request.role)||!request.phase||!request.approval_version||!/^[a-f0-9]{40}$/.test(request.sha||''))return blocked('REMOTE_SCOPE');
  const key=digest([request.repo,request.issue,request.role,request.phase,request.sha,request.approval_version]);
  try{
   const read=await this.transport.read();
   if(!read||typeof read.version!=='string'||!read.document||read.document.schema!==1||!valid(read.document))return blocked('REMOTE_STATE_UNKNOWN');
   const doc=JSON.parse(JSON.stringify(read.document));
   if(doc.jobs[key])return blocked('REMOTE_DUPLICATE');
   if(Object.values(doc.jobs).some(j=>j.role===request.role&&['CLAIMED','RUNNING','UNKNOWN'].includes(j.state)))return blocked('REMOTE_ROLE_BUSY');
   const day=new Date(now).toISOString().slice(0,10),max=request.limits?.max_model_spend||0,daily=request.limits?.max_daily_model_spend||0;
   if(!Number.isFinite(max)||max<0||!Number.isFinite(daily)||daily<0||Object.values(doc.jobs).filter(j=>j.day===day).reduce((n,j)=>n+(j.max_spend||0),0)+max>daily)return blocked('REMOTE_DAILY_BUDGET');
   doc.jobs[key]={owner_hash:digest(this.owner),day,max_spend:max,heartbeat:now,role:request.role,issue:request.issue,sha:request.sha,state:'CLAIMED',claimed_at:now,actual_cost:null};
   const ack=await this.transport.compareAndSwap(read.version,doc);
   // Never retry a write with an unknown response or lost acknowledgment.
   if(ack?.committed!==true)return blocked('REMOTE_CAS_UNKNOWN_OR_CONFLICT');
   return {state:'CLAIMED',key,actual_dispatch:false};
  }catch{return blocked('REMOTE_NETWORK_OR_AMBIGUOUS_WRITE');}
 }
 async update(key,next,now=Date.now()){
  try{const r=await this.transport.read(),doc=JSON.parse(JSON.stringify(r.document)),j=doc.jobs[key];
   const transitions={CLAIMED:['RUNNING','UNKNOWN'],RUNNING:['SUCCESS','FAILED','STOPPED','UNKNOWN']};
   if(!j||j.owner_hash!==digest(this.owner)||!transitions[j.state]?.includes(next))return {state:'BLOCKED',reason:'REMOTE_OWNER_OR_STATE',actual_dispatch:false};
   j.state=next;j.heartbeat=now;const ack=await this.transport.compareAndSwap(r.version,doc);
   return {state:ack?.committed===true?next:'BLOCKED',actual_dispatch:false};
  }catch{return {state:'BLOCKED',reason:'REMOTE_UPDATE_UNKNOWN',actual_dispatch:false};}
 }
}
class FakeAtomicRemote{
 constructor(seed){this.state=seed?JSON.parse(JSON.stringify(seed)):{version:'0',document:{schema:1,jobs:{}}};}
 async read(){return JSON.parse(JSON.stringify(this.state));}
 async compareAndSwap(version,document){if(version!==this.state.version)return {committed:false};this.state={version:String(Number(version)+1),document:JSON.parse(JSON.stringify(document))};return {committed:true};}
 export(){return JSON.parse(JSON.stringify(this.state));}
}
const {LiveGithubRefTransport}=require('./github-ref-backend');
module.exports={RemoteJobs,FakeAtomicRemote,LiveGithubRefTransport};
