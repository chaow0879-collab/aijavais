'use strict';
const {performance}=require('node:perf_hooks');
const A=require('./admission'),O=require('./official-port'),C=require('../auto-handoff-r46/contract'),R49=require('../first-handoff-r49/control'),P=require('../agent-pilot-r45/contract'),Policy=require('../agent-pilot-r45/policy'),{Ledger}=require('../auto-handoff-r46/state');
const report=(reason)=>({...O.blocked(),reason});
const CODES=new Set(['BLOCKED_ADMISSION_SCOPE','BLOCKED_ADMISSION_BINDING','BLOCKED_ADMISSION_EXPIRY','BLOCKED_BUDGET_BINDING','BLOCKED_OFFICIAL_CREDENTIAL','BLOCKED_READONLY_OR_STOP','BLOCKED_ADMISSION_SIGNATURE_BINDING','BLOCKED_TRUSTED_SIGNATURE_BROKER','REMOTE_STOP_UNVERIFIED','PERSISTENT_HALT','ADMISSION_WINDOW_EXPIRED']);
function assertPublic(value,seen=new Set(),depth=0){
 if(depth>64)throw Error('NON_JSON_CONSTRAINTS');
 if(value&&typeof value==='object'){
  if(seen.has(value)||!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype)throw Error('NON_JSON_CONSTRAINTS');seen.add(value);
  for(const d of Object.values(Object.getOwnPropertyDescriptors(value))){if(d.get||d.set)throw Error('NON_JSON_CONSTRAINTS');assertPublic(d.value,seen,depth+1);}seen.delete(value);
 }
}
function publicClone(value){assertPublic(value);return structuredClone(value);}
function boundedBackend(backend,timeout=1000){
 const call=async(method,args)=>{let timer;try{return await Promise.race([Promise.resolve().then(()=>backend[method](...args)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('REMOTE_TIMEOUT'),{code:'REMOTE_TIMEOUT'})),timeout);})]);}finally{clearTimeout(timer);}};
 return {read:()=>call('read',[]),compareAndSwap:(...args)=>call('compareAndSwap',args)};
}
async function runPilot(input={}){
 if(input.mode!=='fake')return O.runOfficialOneShot(input);
 let timer,watch,controller;
 try{
  // Copy only public protocol fields, never enumerate a credential context.
  const b={};for(const k of ['admission','candidate_sha','config','envelope','authorization','snapshot','now','signed','policy','refs'])b[k]=publicClone(input[k]);
  for(const k of ['trigger','sourceRepo','stateDir','fakeExecutable'])b[k]=input[k];
  b.now??=Date.now();A.validate(b.admission,b);
  const prepared=R49.prepare(b);
  if(!b.signed||P.canonical(P.unsigned(b.signed))!==P.canonical(prepared.unsigned_envelope)||Policy.authorize(b.signed,b.policy,b.now))return report('BLOCKED_TRUSTED_SIGNATURE_BROKER');
  b.backend=boundedBackend(input.backend);controller=new AbortController();const started=performance.now(),clock=()=>b.now+Math.floor(performance.now()-started);
  let stopReason=null;
  const stop=reason=>{stopReason??=reason;controller.abort();};
  const abort=()=>stop('CALLER_CANCELLED');
  if(input.signal?.aborted)abort();else input.signal?.addEventListener('abort',abort,{once:true});
  const check=async()=>{if(clock()>=b.admission.expires_at){stop('ADMISSION_WINDOW_EXPIRED');return;}try{const state=await new Ledger(b.backend,b.config).read(clock());if(state.document.halted)stop('PERSISTENT_HALT');}catch{stop('REMOTE_STOP_UNVERIFIED');}
   if(!controller.signal.aborted&&input.authorityCheck){let deadline;try{const ok=await Promise.race([Promise.resolve().then(()=>input.authorityCheck(clock())),new Promise((_,no)=>{deadline=setTimeout(()=>no(Error('AUTHORITY_TIMEOUT')),1000);})]);if(ok!==true)stop('APPROVAL_OR_SOURCE_REVOKED');}catch{stop('APPROVAL_OR_SOURCE_REVOKED');}finally{clearTimeout(deadline);}}
  };
  try{
   await check();if(controller.signal.aborted)return report(stopReason);
   // Short-lived per-run safety watch, never a daemon, event listener service or
   // ten-minute scheduler. One read at a time; any uncertainty stops the child.
   timer=setInterval(()=>{if(!watch)watch=check().finally(()=>{watch=null;});},b.admission.stop_monitor_ms);
   const beforeLaunchCheck=async()=>{await check();return !controller.signal.aborted;};
   const r=await R49.execute({...b,simulate:true,beforeLaunchCheck,signal:controller.signal});
   clearInterval(timer);if(watch)await watch;
   return {...r,...(stopReason&&r.state==='SUCCEEDED'?{state:'HUMAN_REVIEW_REQUIRED',reason:'STOP_OR_REMOTE_STATUS_CHANGED'}:{}),pilot_mode:'E3_FAKE',stop_reason:stopReason,provider_hard_cap:'NOT_VERIFIED',official_credential:'NOT_CONFIGURED',real_state_ref_write:'NOT_RUN'};
  }finally{clearInterval(timer);input.signal?.removeEventListener('abort',abort);if(watch)await watch;}
 }catch(e){return report(CODES.has(e?.code)?e.code:'BLOCKED_PILOT_CONTRACT_OR_GATE');}
 finally{clearInterval(timer);}
}
module.exports={runPilot,boundedBackend,publicClone,halt:require('../auto-handoff-r46/reconcile').halt};
