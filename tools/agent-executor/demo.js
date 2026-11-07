'use strict';
const crypto=require('node:crypto');
const defaults=require('./config.json'),gateDefaults=require('../agent-scheduler/config.json');
const {canonical,digest,gateDigest,REPO}=require('./policy');
const {evaluate}=require('../agent-scheduler/state');
const SHA=n=>String(n).repeat(40);
function comment(actor,fields,tag='AGENT_REPORT_V1'){
 return {user:{login:actor},author_association:'OWNER',created_at:new Date().toISOString(),html_url:'https://github.com/FAKE/'+actor,body:'['+tag+']\n'+Object.entries(fields).map(([k,v])=>k+': '+(typeof v==='string'?v:JSON.stringify(v))).join('\n')+'\n[/'+tag+']'};
}
// Synthetic reports and approvals. These are never sent to GitHub or a model.
function demo(phase='integration',kind='claude',now=Date.now()){
 const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
 const gate_config={...gateDefaults,trustedActors:Object.fromEntries(['planner','codex','claude','integrator','audit','qa'].map(k=>[k,[k]]))};
 const policy={...defaults,gate_config,allowed_identities:['FAKE_OPERATOR'],approver_public_keys:{fixture:publicKey.export({type:'spki',format:'pem'})}};
 const snapshot={complete:true,checked_at:now,issues:Object.fromEntries([2,4,10,12,15,16,17,22].map(i=>[i,{comments:[]}])),refs:{codex:SHA(1),claude:SHA(2),integration:SHA(3),[defaults.allowed_branches[0]]:SHA(3)},runs:[],pulls:[]};
 function grant(role,issue,branch,sha){snapshot.issues[10].comments.push(comment('planner',{approved:true,authorized_role:role,issue,branch,candidate_sha:sha},'PLANNER_DECISION_V1'));}
 for(const [issue,actor,n,count] of [[15,'codex',1,3],[17,'claude',2,4]]){
  snapshot.issues[issue].comments.push(comment(actor,{role:actor==='codex'?'Codex-Developer':'Claude',status:'READY_FOR_REVIEW',head_sha:SHA(n),base_sha:SHA(0),branch:actor,completed_milestones:Array.from({length:count},(_,i)=>'M'+(i+1))}));grant(actor,issue,actor,SHA(n));
 }
 for(const n of [1,2,3])snapshot.runs.push({head_sha:SHA(n),status:'completed',conclusion:'success',jobs:['tests','browser','container'].map(name=>({name,status:'completed',conclusion:'success',steps:[{status:'completed',conclusion:'success'}]}))});
 if(['audit','qa'].includes(phase)){
  snapshot.issues[10].comments.push(comment('integrator',{role:'Integrator',status:'READY_FOR_REVIEW',head_sha:SHA(3),branch:'integration',parent_shas:[SHA(1),SHA(2)]}));grant('integrator',10,'integration',SHA(3));
 }
 if(phase==='qa'){
  snapshot.issues[2].comments.push(comment('audit',{role:'CodeAudit',status:'READY_FOR_REVIEW',verdict:'ACCEPT',review_phase:'FINAL',reviewed_sha:SHA(3),branch:'integration'}));grant('audit',2,'integration',SHA(3));
 }
 const request={repo:REPO,issue:22,kind,role:{integration:'integrator',audit:'audit',qa:'qa'}[phase],phase,sha:SHA(3),observed_ref:SHA(3),branch:defaults.allowed_branches[0],approval_version:'FAKE-v1',fast_forward:true,clean_workspace:true,context:{context_pack:'#20 compact fixture; no real authorization',task:'#22 FAKE scenario only'}};
 if(phase==='integration'){request.base_sha=request.sha;request.parent_shas=[SHA(1),SHA(2)];}
 request.context_digest=digest(request.context);
 const gate=evaluate(snapshot,gate_config,now);
 const payload={...Object.fromEntries(['repo','issue','kind','role','phase','sha','branch','approval_version','context_digest'].map(k=>[k,request[k]])),source_digest:digest(snapshot),fake_only:true,approved_scope:'fake_simulation',allowed_issues:[22],allowed_branches:[request.branch],permitted_roles:[request.role],identity:{actor:'FAKE_OPERATOR'},expires_at:now+60000,gate_digest:gateDigest(gate),max_job_runtime:100,max_tokens:100,max_model_spend:0,max_daily_model_spend:0,max_retries:1};
 if(phase==='integration'){payload.base_sha=request.base_sha;payload.parent_shas=[...request.parent_shas];}
 const sign=()=>({payload,key_id:'fixture',signature:crypto.sign(null,Buffer.from(canonical(payload)),privateKey).toString('base64')});
 return {request,snapshot,policy,payload,approval:sign(),sign,now};
}
module.exports={demo};
