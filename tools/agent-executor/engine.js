'use strict';
const {evaluate,parse}=require('../agent-scheduler/state');
const {verify,disabled,gateDigest,digest,reject}=require('./policy');
const {isFake}=require('./adapters');
class Executor{
 constructor(policy,store){disabled(policy);this.policy=JSON.parse(JSON.stringify(policy));this.store=store;this.stopped=false;}
 stop(){this.stopped=true;return {actual_dispatch:false,state:'STOPPED'};}
 run(request,approval,snapshot,adapter,now=Date.now()){
  let key=null;
  const report={actual_dispatch:false,actual_launches:0,model_spend:null,would_launch:[],state:'BLOCKED',fake_only:true};
  try{
   disabled(this.policy);if(this.stopped)reject('STOP_SWITCH');if(!isFake(adapter))reject('FAKE_ONLY');
   const gate=evaluate(snapshot,this.policy.gate_config,now);report.gate_state=gate.state;
   const limits=verify(request,approval,this.policy,gate,now);
   if(limits.source_digest!==digest(snapshot))reject('SOURCE_REVISION_CHANGED');
   if(gate.evidence.some(e=>['CLAIMED','RUNNING','IN_PROGRESS'].includes(e.status)))reject('ROLE_ALREADY_RUNNING');
   const qaReports=(snapshot.issues[4]?.comments||[]).filter(c=>(this.policy.gate_config.trustedActors.qa||[]).includes(c.user?.login)&&['OWNER','MEMBER','COLLABORATOR'].includes(c.author_association)).map(c=>parse(c.body,'AGENT_REPORT_V1')).filter(Boolean);
   const qa=qaReports.at(-1);
   if(qa&&qa.reviewed_sha===gate.observed_shas.integration&&(qa.verdict==='FAIL'||qa.verdict==='REJECT'||qa.t2_complete===false))reject('HUMAN_REVIEW_REQUIRED');
   if(snapshot.refs[request.branch]!==request.sha)reject('SOURCE_REF_CHANGED');
   if(adapter.kind!==request.kind||adapter.backend!==this.policy[request.kind==='codex'?'CODEX_EXEC_BACKEND':'CLAUDE_EXEC_BACKEND'])reject('ADAPTER_MISMATCH');
   const claim=this.store.claim(request,limits,now);if(claim.blocked)reject(claim.blocked);key=claim.key;report.key=key;
   this.store.transition(key,'RUNNING',now);
   report.would_launch=[{kind:adapter.kind,backend:adapter.backend,role:request.role,phase:request.phase,sha:request.sha,context_digest:request.context_digest,gate_digest:gateDigest(gate)}];
   let tokens=0,spend=0,elapsed=0,final=false;
   for(const event of adapter.events()){
    if(this.stopped){this.store.transition(key,'STOPPED',now+elapsed,{tokens,spend});report.state='STOPPED';return report;}
    const next={tokens:tokens+event.tokens,spend:spend+event.spend};elapsed+=event.elapsed;
    if(next.tokens>limits.max_tokens||next.spend>limits.max_model_spend||elapsed>limits.max_job_runtime||now+elapsed>=limits.expires_at){this.store.transition(key,'BLOCKED',now+elapsed,{tokens,spend});report.reason='FAKE_LIMIT_EXCEEDED';report.state='BLOCKED';return report;}
    tokens=next.tokens;spend=next.spend;this.store.heartbeat(key,now+elapsed);
    if(['result','fail','stop'].includes(event.type)){
     const state={result:'SUCCESS',fail:'FAILED',stop:'STOPPED'}[event.type];this.store.transition(key,state,now+elapsed,{tokens,spend});report.state=state;final=true;break;
    }
   }
   if(!final){this.store.transition(key,'HUMAN_REVIEW_REQUIRED',now+elapsed,{tokens,spend});report.state='HUMAN_REVIEW_REQUIRED';report.reason='FAKE_INCOMPLETE_NO_AUTOMATIC_RETRY';}
   report.fake_usage={tokens,spend,elapsed};return report;
  }catch(e){report.reason=typeof e.code==='string'?e.code:'STORE_OR_FAKE_FAILURE';if(key)report.state='HUMAN_REVIEW_REQUIRED';else {try{this.store.transaction(s=>this.store.log(s,'DENIED',null,now,{reason:report.reason}));}catch{report.audit_recorded=false;}}return report;}
 }
}
module.exports={Executor};
