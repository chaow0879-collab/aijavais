'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),{once}=require('node:events'),{DatabaseSync}=require('node:sqlite');
const H=require('./harness.cjs'),C=require('../../tools/auto-handoff-r46/contract'),T=require('../../tools/auto-handoff-r46/triggers'),P=require('../../tools/agent-pilot-r45/contract');
const {positive,config:gateConfig}=require('../agent-scheduler/fixtures.cjs');
function make(dir,mode='success',over={}){
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const f={now:Date.now(),dir,sourceRepo:H.ROOT,candidate_sha:H.BUSINESS_SHA,stateDir:path.join(dir,'journal')};
 f.snapshot=JSON.parse(JSON.stringify(positive(f.now)).replaceAll('3'.repeat(40),H.BUSINESS_SHA));
 f.snapshot.issues[4].comments[0].body=f.snapshot.issues[4].comments[0].body.replace('e4: PASS','e4: NOT_RUN').replace('e5: PASS','e5: NOT_RUN');
 for(const [id,issue]of Object.entries(f.snapshot.issues))issue.comments.forEach((c,n)=>c.html_url='https://github.com/'+C.REPO+'/issues/'+id+'#issuecomment-'+(500+Number(id)*10+n));
 const branch='integrate/codex-r51-first-pilot-readiness';f.config={...structuredClone(require('../../tools/auto-handoff-r46/config.json')),source_sha:H.BUSINESS_SHA,allowed_issues:[34],allowed_branches:[branch],allowed_senders:['qa49-dispatcher'],trusted_event_branches:[branch],max_cost:.1,max_daily_cost:.5,gate_config:structuredClone(gateConfig)};
 f.snapshot.refs[branch]=H.BUSINESS_SHA;
 f.envelope={schema:1,repo:C.REPO,task_id:over.task_id||'QA49-independent',source_sha:H.BUSINESS_SHA,issue:34,branch,kind:'claude',role:over.role||'audit',phase:over.phase||'audit',context_digest:C.digest('QA49 synthetic; no model request'),limits:{runtime_ms:over.runtime||3000,tokens:128,max_cost:.1},audit_refs:{audit:f.snapshot.issues[2].comments[0].html_url,qa:f.snapshot.issues[4].comments[0].html_url},expires_at:f.now+3500000,after:over.after||null};
 const pairs=Object.fromEntries(['v1_audit','v2_audit','operator'].map(r=>[r,crypto.generateKeyPairSync('ed25519')])),dispatch=crypto.generateKeyPairSync('ed25519');
 f.config.trusted_keys=Object.fromEntries(Object.entries(pairs).map(([r,k])=>[r,{qa49:k.publicKey.export({type:'spki',format:'pem'})}]));
 f.policy=require('../../tools/agent-pilot-r45/policy').loadPolicy({allow_fake_cli:true,pinned_gate_sha:H.BUSINESS_SHA,allowed_issues:[34],trusted_keys:{qa49:{pem:dispatch.publicKey.export({type:'spki',format:'pem'}),roles:['dispatcher']}}});
 f.refs={log_ref:'https://github.com/'+C.REPO+'/actions/runs/1',ci_ref:'https://github.com/'+C.REPO+'/actions/runs/1',report_ref:'https://github.com/'+C.REPO+'/issues/34#issuecomment-1'};
 f.counter=path.join(dir,'processes.jsonl');f.fakeExecutable=path.join(dir,'marked-cli');
 fs.writeFileSync(f.fakeExecutable,'#!/bin/sh\n# AIJAVAIS_FAKE_CLI QA49 independent test only\nexec "'+process.execPath+'" "'+path.join(__dirname,'fake-cli.cjs')+'" "'+f.counter+'" "'+mode+'" "$@"\n',{mode:0o700});
 f.launches=()=>fs.existsSync(f.counter)?fs.readFileSync(f.counter,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 f.sign=(trigger=T.tick(f.now,f.config),expiryOverrides={})=>{
  const e=f.envelope,c=f.config;e.idempotency_key=C.identity(e);e.dispatch_id=C.digest(['dispatch',e.idempotency_key]);f.trigger=trigger;
  if(!f.admission)f.admission={schema:'aijavais.first-pilot.admission/v1',evidence:'E3_FAKE',repo:e.repo,issue:e.issue,task_id:e.task_id,source_sha:e.source_sha,branch:e.branch,work_key:C.pilotWorkKey(e),dispatch_id:e.dispatch_id,issued_at:f.now,expires_at:f.now+60000,budget:{currency:'USD',cap_usd:e.limits.max_cost,max_tokens:e.limits.tokens,runtime_ms:e.limits.runtime_ms,enforcement:'SYNTHETIC_FAKE_ONLY'},auth:{kind:'SYNTHETIC_FAKE_ONLY',context_ref:'fixture:qa51-no-official-credential'},tools:['Read','Glob','Grep'],isolation:'nonproduction_readonly',stop_monitor_ms:50};
  const gate=require('../../tools/agent-scheduler/state').evaluate(f.snapshot,c.gate_config,f.now);
  const manifest={control_operation:f.operation||'RECONCILE',repo:C.REPO,issue:e.issue,allowed_issues:c.allowed_issues,branch:e.branch,allowed_branches:c.allowed_branches,sha:e.source_sha,fixed_gate_sha:'d54b29e11716a01f0812b3e8576982b9f5b9b234',isolation:'ephemeral_github_hosted',credentials_verified:true,cli_version_verified:true,native_token_cap_verified:true,native_spend_cap_verified:true,role_scope_verified:true,state_ref_protection_verified:true,fake_only:true,evidence:'E2_E3_FAKE',envelope_digest:C.digest(e),source_digest:C.digest(f.snapshot),gate_digest:require('../../tools/agent-executor/policy').gateDigest(gate)};
  manifest.r51_admission_digest=C.digest(f.admission);
  f.authorization={manifest,proofs:Object.fromEntries(Object.entries(pairs).map(([role,k])=>{const payload={role,manifest_digest:C.digest(manifest),expires_at:Object.hasOwn(expiryOverrides,role)?expiryOverrides[role]:f.now+3600000,verdict:'ACCEPT',approved:true};return [role,{key_id:'qa49',payload,signature:crypto.sign(null,Buffer.from(C.canonical(payload)),k.privateKey).toString('base64')}];}))};
  // Own serializer, cross-checked by production prepare/execute rather than taking its output as input.
  const frame={schema:'aijavais.pilot.envelope/v1',repo:e.repo,issue:e.issue,role:e.role==='integrator'?'developer':e.role,phase:e.phase,dispatch_id:e.dispatch_id,trigger:{kind:trigger.kind==='tick'?'fallback_tick':'github_event',event_id:trigger.id},source:{branch:e.branch,sha:e.source_sha},gate:{gate_sha:e.source_sha,audit:{verdict:'ACCEPT',reviewed_sha:e.source_sha,ref:e.audit_refs.audit},qa:{verdict:'PASS',reviewed_sha:e.source_sha,ref:e.audit_refs.qa},open_p0_p1:0},task:{cli:e.kind,mode:'readonly',template:'readonly-repo-summary',max_runtime_ms:e.limits.runtime_ms},cost:{billing:'capped',cap_usd:e.limits.max_cost},issued_at:new Date(f.now).toISOString(),expires_at:new Date(e.expires_at).toISOString()};
  f.signed={...frame,signature:{alg:'ed25519',key_id:'qa49',value:crypto.sign(null,Buffer.from(P.canonical(frame)),dispatch.privateKey).toString('base64')}};return f;
 };
 f.resignFrame=()=>{const body=P.unsigned(f.signed);f.signed.signature.value=crypto.sign(null,Buffer.from(P.canonical(body)),dispatch.privateKey).toString('base64');};
 f.input=(extra={})=>{const out={simulate:true};for(const k of ['candidate_sha','config','envelope','authorization','snapshot','now','signed','policy','refs','stateDir','sourceRepo','fakeExecutable','trigger','backend','admission'])out[k]=f[k];return {...out,...extra};};
 return f.sign();
}
function event(f,delivery='qa49-event',sender='qa49-dispatcher'){
 const secret='SYNTHETIC_QA49_LOCAL_WEBHOOK_SECRET_ONLY',body=JSON.stringify({action:'created',repository:{full_name:C.REPO,id:f.config.repository_id,fork:false},sender:{login:sender},issue:{number:32,author_association:'OWNER'},comment:{author_association:'OWNER',body:'Synthetic event is NOT authorization'}});
 return T.webhook({body,event:'issue_comment',delivery,secret,signature:'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')},f.config,f.now);
}
module.exports={make,event};
