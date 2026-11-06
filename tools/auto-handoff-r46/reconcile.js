'use strict';
const crypto=require('node:crypto'),{performance}=require('node:perf_hooks');
const C=require('./contract'),G=require('./gates'),T=require('./triggers'),{Ledger,log}=require('./state'),{isFake}=require('./r45-adapter');
const ACTIVE=['CLAIMED','DISPATCHING','UNKNOWN'];
const report=(state,reason,extra={})=>({state,reason,real_dispatch:false,actual_agent_launches:0,cost:'NOT_VERIFIED',evidence:'E2_E3_FAKE',...extra});
const ERROR_CODES=new Set('R46_DISABLED_OR_INVALID_POLICY INVALID_CLOCK UNTRUSTED_OR_STALE_TRIGGER ENVELOPE_SCOPE ENVELOPE_LIMITS GATE_REFS ENVELOPE_EXPIRY_OR_PARENT ENVELOPE_IDENTITY FAKE_RUNNER_REQUIRED GATE_OPERATION_BINDING SIGNED_SOURCE_BINDING APPROVAL_EXPIRED INDEPENDENT_GATES_NOT_ACCEPTED INDEPENDENT_IDENTITIES_REQUIRED BLOCKED_READINESS LIVE_SCOPE_DENIED READINESS_IDENTITY_CONFLICT BLOCKED_GATE_OR_AUDIT BLOCKED_CREDENTIALS_OR_LIMIT_ENFORCEMENT REMOTE_STATE_CORRUPT CLOCK_SKEW LEDGER_CAPACITY CAS_UNKNOWN_OR_CONFLICT DISPATCH_STATE_OR_STOP DISPATCH_READBACK_OR_STOP RUNNER_OUTCOME_INVALID RESULT_OWNER_OR_STATE REMOTE_TIMEOUT'.split(' '));
const safeError=e=>ERROR_CODES.has(e?.code)?e.code:'REMOTE_OR_RUNNER_UNKNOWN';
function record(e,t,at,c,owner,state,reason=null){return {envelope_hash:C.digest(e),task_hash:C.taskHash(e),work_hash:C.pilotWorkKey(e),dispatch_id:e.dispatch_id,source_sha:e.source_sha,role:e.role,phase:e.phase,state,owner_hash:C.digest(owner),claimed_at:at,heartbeat:at,lease_until:at+c.lease_ms,reservation:e.limits.max_cost,day:new Date(at).toISOString().slice(0,10),outcome:null,reason,trigger_hash:t.id};}
async function reconcile({simulate=false,config,envelope:e,authorization,snapshot,trigger,backend,runner,now=Date.now(),signal}={}){
 if(!simulate)return report('DISABLED','DEFAULT_OFF');
 const started=performance.now(),clock=()=>now+Math.floor(performance.now()-started);
 let ledger,owner=crypto.randomBytes(32).toString('hex'),key,claimed=false;
 try{
  config=structuredClone(config);e=structuredClone(e);authorization=structuredClone(authorization);snapshot=structuredClone(snapshot);
  G.policy(config);if(!Number.isSafeInteger(now)||now<0)C.reject('INVALID_CLOCK');T.check(trigger,config,now);C.validateEnvelope(e,config,now);if(!isFake(runner))C.reject('FAKE_RUNNER_REQUIRED');
  ledger=new Ledger(backend,config);key=e.idempotency_key;
  // Failures of a trusted, well-scoped job are permanent tombstones. An untrusted
  // trigger never gets this far and cannot poison the ledger by guessing an ID.
  let gateError=null;try{G.verify(e,authorization,snapshot,config,now);}catch(error){gateError=safeError(error);}
  const claim=await ledger.change(clock(),(d,at)=>{
   if(d.halted)return {unchanged:true,state:'BLOCKED',reason:'KILL_SWITCH'};
   if(Object.values(d.jobs).some(j=>j.task_hash===C.taskHash(e)&&j.envelope_hash!==C.digest(e)))return {unchanged:true,state:'BLOCKED',reason:'TASK_PARAMETERS_CHANGED'};
   const prior=d.jobs[key];if(prior){
    if(['CLAIMED','DISPATCHING'].includes(prior.state)&&at>=prior.lease_until){prior.state='UNKNOWN';prior.reason='EXPIRED_NO_REPLAY';prior.heartbeat=at;log(d,'UNKNOWN',key,at);return {state:'UNKNOWN',reason:'EXPIRED_NO_REPLAY'};}
    if(gateError)return {unchanged:true,state:'BLOCKED',reason:gateError};
    return {unchanged:true,state:prior.state,reason:'DUPLICATE_NO_REPLAY',outcome:prior.outcome};
   }
   if(Object.values(d.jobs).some(j=>j.work_hash===C.pilotWorkKey(e)))return {unchanged:true,state:'BLOCKED',reason:'RUNNER_WORK_ALREADY_RECORDED'};
   const denial=gateError||(signal?.aborted?'CANCELLED_BEFORE_DISPATCH':null);
   if(denial){d.jobs[key]=record(e,trigger,at,config,owner,'BLOCKED',denial);log(d,'BLOCKED',key,at);return {state:'BLOCKED',reason:denial};}
   if(e.after&&!(d.jobs[e.after]?.state==='SUCCEEDED'&&d.jobs[e.after]?.outcome?.fixed_sha===e.source_sha&&d.jobs[e.after]?.outcome?.cost_known===true))return {unchanged:true,state:'WAIT_PARENT',reason:'PARENT_NOT_VERIFIED'};
   if(Object.values(d.jobs).some(j=>j.role===e.role&&ACTIVE.includes(j.state)))return {unchanged:true,state:'WAIT_ROLE',reason:'ROLE_BUSY'};
   const day=new Date(at).toISOString().slice(0,10),reserved=Object.values(d.jobs).filter(j=>j.day===day).reduce((n,j)=>n+j.reservation,0);
   if(reserved+e.limits.max_cost>config.max_daily_cost)return {unchanged:true,state:'BLOCKED',reason:'DAILY_BUDGET'};
   d.jobs[key]=record(e,trigger,at,config,owner,'CLAIMED');log(d,'CLAIMED',key,at);return {state:'CLAIMED',reason:null};
  });
  if(claim.state!=='CLAIMED'||claim.unchanged)return report(claim.state,claim.reason,{outcome:claim.outcome||null});claimed=true;
  await ledger.change(clock(),(d,at)=>{
   const j=d.jobs[key];if(d.halted||signal?.aborted||!j||j.owner_hash!==C.digest(owner)||j.state!=='CLAIMED'||at>=j.lease_until)C.reject('DISPATCH_STATE_OR_STOP');
   j.state='DISPATCHING';j.heartbeat=at;log(d,'DISPATCHING',key,at);return {state:j.state};
  });
  // Durable read-back before crossing the R45 seam. Lost ACK, conflicting writer,
  // expired/recovered lease, or halt -> never call runner, never retry the call.
  const check=await ledger.read(clock()),j=check.document.jobs[key];
  if(check.document.halted||signal?.aborted||j?.state!=='DISPATCHING'||j.owner_hash!==C.digest(owner)||j.envelope_hash!==C.digest(e)||clock()>=j.lease_until)C.reject('DISPATCH_READBACK_OR_STOP');
  C.validateEnvelope(e,config,clock());G.verify(e,authorization,snapshot,config,clock());
  const raw=await runner.run(e,signal),o=C.outcome(raw,e),next=!o.cost_known?'UNKNOWN':({SUCCESS:'SUCCEEDED',FAILED:'FAILED',STOPPED:'STOPPED',UNKNOWN:'UNKNOWN'}[o.state]);
  await ledger.change(clock(),(d,at)=>{
   const j=d.jobs[key];if(!j||j.owner_hash!==C.digest(owner)||j.state!=='DISPATCHING')C.reject('RESULT_OWNER_OR_STATE');
   j.state=d.halted||signal?.aborted?'STOPPED':next;j.reason=!o.cost_known?'COST_UNKNOWN_NO_REPLAY':null;j.heartbeat=at;
   j.outcome=Object.fromEntries(['state','fixed_sha','exit_code','cost_known','cost','log_ref','ci_ref','report_ref','run_id','evidence'].map(k=>[k,o[k]]));log(d,j.state,key,at);return {state:j.state};
  });
  const final=await ledger.read(clock());return report(final.document.jobs[key].state,final.document.jobs[key].reason,{outcome:final.document.jobs[key].outcome});
 }catch(error){
  // Only the current owner may make its uncertainty explicit; no reserve release,
  // no re-claim, no success on failed/ambiguous settlement. Unknown writes are read
  // back by a future tick, never blindly replayed in this invocation.
  if(claimed&&ledger&&key)try{await ledger.change(clock(),(d,at)=>{const j=d.jobs[key];if(j?.owner_hash===C.digest(owner)&&['CLAIMED','DISPATCHING'].includes(j.state)){j.state='UNKNOWN';j.reason=safeError(error);j.heartbeat=at;log(d,'UNKNOWN',key,at);return {state:'UNKNOWN'};}return {unchanged:true};});}catch{}
  const error_class=error?.status===403?'AUTHORIZATION_DENIED':error?.status===429?'READ_RATE_LIMITED':error?.status>=500?'READ_TRANSIENT':'AMBIGUOUS_OR_SECURITY_FAILURE';
  return report(claimed?'UNKNOWN':'BLOCKED',safeError(error),{error_class,retry_after_ms:!claimed&&error?.status===429?600000:!claimed&&error?.status>=500?60000:null,retry_decision:'READ_ONLY_RECHECK_NEVER_REDISPATCH'});
 }
}
async function bundle(items){const results=[];for(const item of items){if(results.length>=4)C.reject('BUNDLE_LIMIT');results.push(await reconcile(item));}return results;}
async function recover({simulate=false,config,trigger,backend,now=Date.now()}={}){
 if(!simulate)return report('DISABLED','DEFAULT_OFF');
 try{G.policy(config);T.check(trigger,config,now);let count=0;await new Ledger(backend,config).change(now,(d,at)=>{for(const [key,j] of Object.entries(d.jobs))if(['CLAIMED','DISPATCHING'].includes(j.state)&&at>=j.lease_until){j.state='UNKNOWN';j.reason='EXPIRED_NO_REPLAY';j.heartbeat=at;log(d,'UNKNOWN',key,at);count++;}return count?{count}:{unchanged:true};});return report('RECOVERED','NO_REPLAY',{recovered:count});}catch(e){return report('BLOCKED',safeError(e));}
}
async function halt({simulate=false,config,envelope,authorization,snapshot,trigger,backend,now=Date.now()}={}){
 if(!simulate)return report('DISABLED','DEFAULT_OFF');
 try{G.policy(config);T.check(trigger,config,now);C.validateEnvelope(envelope,config,now);G.verify(envelope,authorization,snapshot,config,now,'HALT');await new Ledger(backend,config).change(now,(d,at)=>{if(d.halted)return {unchanged:true};d.halted=true;log(d,'HALTED',null,at);return {state:'HALTED'};});return report('HALTED','PERSISTENT_STOP');}catch(e){return report('BLOCKED',safeError(e));}
}
module.exports={reconcile,bundle,recover,halt};
