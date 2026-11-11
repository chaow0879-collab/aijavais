'use strict';
const crypto=require('node:crypto');
const C=require('../../auto-handoff-r46/contract'),{FakeAtomicRemote}=require('../../agent-executor/remote-state'),{empty}=require('../../auto-handoff-r46/state');
const {evaluate}=require('../../agent-scheduler/state'),{gateDigest}=require('../../agent-executor/policy'),F=require('../agent-scheduler/fixtures.cjs');
const {FakeR45Runner}=require('../../auto-handoff-r46/r45-adapter');
function fixture(options={}){
 const now=options.now||Date.now(),config=JSON.parse(JSON.stringify(require('../../auto-handoff-r46/config.json')));config.allowed_senders=['planner'];config.gate_config=structuredClone(F.config);
 const snapshot=JSON.parse(JSON.stringify(F.positive(now)).replaceAll(F.sha(3),C.SOURCE));
 for(const [id,i] of Object.entries(snapshot.issues))for(const [n,c] of i.comments.entries())c.html_url=`https://github.com/${C.REPO}/issues/${id}#issuecomment-${100+Number(id)*10+n}`;
 snapshot.issues[4].comments[0].body=snapshot.issues[4].comments[0].body.replace('e4: PASS','e4: NOT_RUN').replace('e5: PASS','e5: NOT_RUN');
 const e={schema:1,repo:C.REPO,task_id:options.task_id||'fixture-task',source_sha:C.SOURCE,issue:30,branch:config.allowed_branches[0],kind:options.kind||'codex',role:options.role||'audit',phase:options.phase||'audit',context_digest:C.digest('fixture context only; no actual model request'),limits:{runtime_ms:1000,tokens:128,max_cost:0},audit_refs:{audit:snapshot.issues[2].comments[0].html_url,qa:snapshot.issues[4].comments[0].html_url},expires_at:now+3600000,after:options.after||null};
 const pairs={};config.trusted_keys={};for(const role of ['v1_audit','v2_audit','operator']){const p=crypto.generateKeyPairSync('ed25519');pairs[role]=p;config.trusted_keys[role]={fixture:p.publicKey.export({type:'spki',format:'pem'})};}
 const f={now,config,snapshot,envelope:e,backend:new FakeAtomicRemote({version:'0',document:empty()}),runner:new FakeR45Runner(options.mode),pairs};
 f.sign=()=>{
  e.idempotency_key=C.identity(e);e.dispatch_id=C.digest(['dispatch',e.idempotency_key]);
  const manifest={control_operation:f.operation||'RECONCILE',repo:C.REPO,issue:e.issue,allowed_issues:config.allowed_issues,branch:e.branch,allowed_branches:config.allowed_branches,sha:e.source_sha,fixed_gate_sha:f.fixedGate||'d54b29e11716a01f0812b3e8576982b9f5b9b234',isolation:'ephemeral_github_hosted',credentials_verified:true,cli_version_verified:true,native_token_cap_verified:true,native_spend_cap_verified:true,role_scope_verified:true,state_ref_protection_verified:true,fake_only:true,evidence:'E2_E3_FAKE',envelope_digest:C.digest(e),source_digest:C.digest(snapshot),gate_digest:gateDigest(evaluate(snapshot,config.gate_config,now))};
  const proofs={};for(const role of Object.keys(pairs)){const payload={role,manifest_digest:C.digest(manifest),expires_at:now+3600000,verdict:'ACCEPT',approved:true};proofs[role]={key_id:'fixture',payload,signature:crypto.sign(null,Buffer.from(C.canonical(payload)),pairs[role].privateKey).toString('base64')};}
  f.authorization={manifest,proofs};return f;
 };
 f.input=(extra={})=>({simulate:true,config:f.config,envelope:f.envelope,authorization:f.authorization,snapshot:f.snapshot,trigger:require('../../auto-handoff-r46/triggers').tick(f.now,f.config),backend:f.backend,runner:f.runner,now:f.now,...extra});
 return f.sign();
}
function wire(f){return {now:f.now,config:f.config,envelope:f.envelope,authorization:f.authorization,snapshot:f.snapshot};}
function webhook(f,over={}){
 const secret='FAKE_WEBHOOK_SECRET_NOT_A_CREDENTIAL_0123456789';const payload={action:'created',repository:{full_name:C.REPO,id:f.config.repository_id,fork:false},sender:{login:'planner'},issue:{number:30,author_association:'OWNER'},comment:{author_association:'OWNER',body:'This comment is not an authorization'}};
 Object.assign(payload,over);const body=JSON.stringify(payload);return {body,signature:'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex'),delivery:'fixture-delivery',event:'issue_comment',secret};
}
module.exports={fixture,wire,webhook};
