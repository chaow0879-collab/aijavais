'use strict';
// Auditor-owned fixed-SHA offline checks, synthetic signatures only, no child or network.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(process.env.REVIEWED_ROOT||path.join(__dirname,'snapshot')),{demo}=require(root+'/tools/agent-executor/demo'),{Executor}=require(root+'/tools/agent-executor/engine'),{Store}=require(root+'/tools/agent-executor/store'),{FakeAdapter}=require(root+'/tools/agent-executor/adapters'),P=require(root+'/tools/agent-executor/policy'),{evaluate}=require(root+'/tools/agent-scheduler/state');
const A='3'.repeat(40),B='9'.repeat(40),rows=[];
function withFixture(label,phase,kind,fn){
 const d=demo(phase,kind),dir=fs.mkdtempSync(path.join(os.tmpdir(),'r47-independent-')),store=new Store(dir);let claims=0;const original=store.claim.bind(store);store.claim=(...a)=>{claims++;return original(...a);};
 const f={d,store,get claims(){return claims;},reset(){claims=0;},gate:()=>evaluate(d.snapshot,d.policy.gate_config,d.now),run(script=[{type:'result',tokens:1,elapsed:1}]){d.payload.source_digest=P.digest(d.snapshot);d.payload.gate_digest=P.gateDigest(f.gate());return new Executor(d.policy,store).run(d.request,d.sign(),d.snapshot,new FakeAdapter(kind,'cli',script),d.now);}};
 try{const detail=fn(f);rows.push({label,pass:true,...detail});}finally{fs.rmSync(dir,{recursive:true,force:true});}
}
function cross(f,ci=false){const d=f.d;d.request.sha=B;d.request.observed_ref=B;d.snapshot.refs[d.request.branch]=B;d.payload.sha=B;if(ci)d.snapshot.runs.push({...structuredClone(d.snapshot.runs[0]),head_sha:B});}
function denied(f,expected){const r=f.run();assert.equal(r.state,'BLOCKED');if(expected)assert.equal(r.reason,expected);assert.equal(f.claims,0);assert.deepEqual(r.would_launch,[]);assert.equal(r.actual_dispatch,false);assert.equal(r.actual_launches,0);assert.equal(r.model_spend,null);const s=f.store.snapshot();assert.equal(Object.keys(s.jobs).length,0);assert.equal(Object.keys(s.daily).length,0);assert.equal(s.audit.filter(x=>x.type==='CLAIMED').length,0);return {state:r.state,reason:r.reason,claim_calls:f.claims,jobs:0,reservations:0};}
for(const phase of ['audit','qa'])for(const kind of ['claude','codex']){
 withFixture(phase+'/'+kind+' exact SHA positive',phase,kind,f=>{const r=f.run();assert.equal(r.state,'SUCCESS');assert.equal(f.claims,1);assert.equal(r.would_launch[0].sha,A);assert.equal(r.actual_dispatch,false);assert.equal(r.actual_launches,0);assert.equal(Object.values(f.store.snapshot().jobs)[0].actual_cost,null);return {state:r.state,claim_calls:f.claims,actual_dispatch:false};});
 for(const ci of [false,true])withFixture(phase+'/'+kind+' fully re-signed B, CI='+ci,phase,kind,f=>{cross(f,ci);assert.equal(f.gate().observed_shas.integration,A);assert.equal(f.d.snapshot.runs.some(r=>r.head_sha===B),ci);return denied(f,'CANDIDATE_SHA_MISMATCH');});
}
for(const phase of ['audit','qa']){
 withFixture(phase+' same SHA lacks integration CI',phase,'codex',f=>{f.d.snapshot.runs=f.d.snapshot.runs.filter(r=>r.head_sha!==A);return denied(f);});
 withFixture(phase+' cannot change role/phase with a valid signature',phase,'codex',f=>{const other=phase==='qa'?'audit':'qa';f.d.request.role=other;f.d.request.phase=other;f.d.payload.role=other;f.d.payload.phase=other;f.d.payload.permitted_roles=[other];return denied(f,'HUMAN_REVIEW_REQUIRED');});
 withFixture(phase+' invalid signature is still rejected',phase,'codex',f=>{const sign=f.d.sign;f.d.sign=()=>({...sign(),signature:'invalid'});return denied(f,'BLOCKED_APPROVAL');});
}
withFixture('actual carrier ref changed but declared observed_ref unchanged','qa','codex',f=>{f.d.snapshot.refs[f.d.request.branch]=B;return denied(f,'SOURCE_REF_CHANGED');});
withFixture('newer pending CI still defeats historical green','qa','codex',f=>{const r=f.d.snapshot.runs.find(r=>r.head_sha===A);Object.assign(r,{id:100,workflow_id:7,run_attempt:1});f.d.snapshot.runs.push({...structuredClone(r),id:101,status:'in_progress',conclusion:null});return denied(f);});
withFixture('normal explicitly approved integration preparation','integration','claude',f=>{const r=f.run();assert.equal(r.state,'SUCCESS');assert.deepEqual(f.d.request.parent_shas,['1'.repeat(40),'2'.repeat(40)]);assert.equal(f.d.request.base_sha,A);return {state:r.state,parent_binding:'exact',base_binding:'exact'};});
withFixture('new legitimate input pair and explicitly approved baseline remain usable','integration','claude',f=>{
 const d=f.d,oldNew=[['codex',15,'1'.repeat(40),'5'.repeat(40)],['claude',17,'2'.repeat(40),'6'.repeat(40)]];
 for(const [role,issue,oldSha,newSha] of oldNew){d.snapshot.refs[role]=newSha;d.snapshot.issues[issue].comments[0].body=d.snapshot.issues[issue].comments[0].body.replace('head_sha: '+oldSha,'head_sha: '+newSha);for(const c of d.snapshot.issues[10].comments)if(c.body.includes('authorized_role: '+role+'\n'))c.body=c.body.replace('candidate_sha: '+oldSha,'candidate_sha: '+newSha);for(const run of d.snapshot.runs)if(run.head_sha===oldSha)run.head_sha=newSha;}
 cross(f);d.request.base_sha=B;d.payload.base_sha=B;d.request.parent_shas=['5'.repeat(40),'6'.repeat(40)];d.payload.parent_shas=[...d.request.parent_shas];assert.equal(f.gate().state,'INTEGRATION_READY');const r=f.run();assert.equal(r.state,'SUCCESS');return {state:r.state,new_inputs:d.request.parent_shas,new_approved_base:B,actual_dispatch:r.actual_dispatch};
});
const integrationCases=[
 ['legacy request without explicit inputs/base',f=>{delete f.d.request.base_sha;delete f.d.payload.base_sha;delete f.d.request.parent_shas;delete f.d.payload.parent_shas;}],
 ['swapped input order',f=>{f.d.request.parent_shas.reverse();f.d.payload.parent_shas=[...f.d.request.parent_shas];}],
 ['payload inputs contradict request',f=>{f.d.payload.parent_shas=['1'.repeat(40),B];}],
 ['base not equal to target request SHA',f=>{f.d.request.base_sha=B;f.d.payload.base_sha=B;}],
 ['only one parent provided',f=>{f.d.request.parent_shas=['1'.repeat(40)];f.d.payload.parent_shas=[...f.d.request.parent_shas];}]
];
for(const [name,mutate] of integrationCases)withFixture('integration: '+name,'integration','claude',f=>{mutate(f);return denied(f,'INTEGRATION_SOURCE_BINDING');});
withFixture('integration preparation cannot impersonate QA','integration','claude',f=>{f.d.request.role='qa';f.d.request.phase='qa';f.d.payload.role='qa';f.d.payload.phase='qa';f.d.payload.permitted_roles=['qa'];return denied(f,'HUMAN_REVIEW_REQUIRED');});
for(const phase of ['audit','qa'])withFixture(phase+' denial preserves unfinished unknown fee and reservation',phase,'codex',f=>{
 const d=f.d;Object.assign(d.policy,{max_model_spend:2,max_daily_model_spend:4});Object.assign(d.payload,{max_model_spend:2,max_daily_model_spend:4});const first=f.run([{type:'progress',tokens:1,spend:1,elapsed:1}]);assert.equal(first.state,'HUMAN_REVIEW_REQUIRED');const before=f.store.snapshot();assert.equal(Object.values(before.jobs)[0].reserved,2);assert.equal(Object.values(before.jobs)[0].actual_cost,null);f.reset();cross(f,true);const r=f.run();assert.equal(r.reason,'CANDIDATE_SHA_MISMATCH');assert.equal(f.claims,0);const after=f.store.snapshot();assert.deepEqual(after.jobs,before.jobs);assert.deepEqual(after.daily,before.daily);assert.deepEqual(r.would_launch,[]);return {state:r.state,claim_calls:0,unknown_cost:null,reserved:2,jobs_and_daily_unchanged:true};
});
console.log(JSON.stringify({reviewed_sha:'fcf52ed855dfccacb16cef632d0e3eb202510718',pass:rows.length,fail:0,rows,actual_agent_launches:0},null,2));
