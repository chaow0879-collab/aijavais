'use strict';
// AUD-R43-01: all signatures/digests/refs are self-consistent in the attack cases.
// No actual model, paid API or remote GitHub state mutation.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {demo}=require('../../tools/agent-executor/demo'),{Executor}=require('../../tools/agent-executor/engine'),{Store}=require('../../tools/agent-executor/store'),{FakeAdapter}=require('../../tools/agent-executor/adapters'),P=require('../../tools/agent-executor/policy'),{evaluate}=require('../../tools/agent-scheduler/state');
const A='3'.repeat(40),B='9'.repeat(40);
function fixture(t,phase='qa',kind='codex'){
 const f=demo(phase,kind),dir=fs.mkdtempSync(path.join(os.tmpdir(),'r47-binding-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 f.dir=dir;f.store=new Store(dir);f.gate=()=>evaluate(f.snapshot,f.policy.gate_config,f.now);
 f.resign=()=>{f.payload.source_digest=P.digest(f.snapshot);f.payload.gate_digest=P.gateDigest(f.gate());return f.sign();};
 f.run=()=>new Executor(f.policy,f.store).run(f.request,f.resign(),f.snapshot,new FakeAdapter(kind,'cli',[{type:'result',tokens:1,elapsed:1}]),f.now);
 return f;
}
function cross(f,value=B){f.request.sha=value;f.request.observed_ref=value;f.snapshot.refs[f.request.branch]=value;f.payload.sha=value;}
function denied(f,reason){const r=f.run();assert.equal(r.state,'BLOCKED');if(reason)assert.equal(r.reason,reason);assert.equal(r.actual_dispatch,false);assert.equal(r.actual_launches,0);assert.equal(r.model_spend,null);assert.deepEqual(r.would_launch,[]);assert.equal(Object.keys(f.store.snapshot().jobs).length,0);assert.equal(f.store.snapshot().audit.filter(x=>x.type==='CLAIMED').length,0);return r;}
for(const phase of ['audit','qa'])for(const kind of ['claude','codex']){
 test(`R47 ${phase}/${kind}: exact candidate A still succeeds without expanding permissions/cost`,t=>{const f=fixture(t,phase,kind),r=f.run();assert.equal(f.gate().observed_shas.integration,A);assert.equal(r.state,'SUCCESS');assert.equal(r.actual_dispatch,false);assert.equal(r.actual_launches,0);assert.equal(r.model_spend,null);assert.equal(f.payload.max_model_spend,0);assert.equal(Object.values(f.store.snapshot().jobs)[0].actual_cost,null);assert.ok(P.FLAGS.every(k=>f.policy[k]===false));});
 for(const ci of [false,true])test(`R47 ${phase}/${kind}: valid re-sign/ref/source digest for B, own CI=${ci}, cannot borrow A gate`,t=>{const f=fixture(t,phase,kind);cross(f);if(ci)f.snapshot.runs.push({...structuredClone(f.snapshot.runs[0]),head_sha:B});assert.equal(f.gate().observed_shas.integration,A);assert.equal(f.snapshot.runs.some(r=>r.head_sha===B),ci);denied(f,'CANDIDATE_SHA_MISMATCH');});
 test(`R47 ${phase}/${kind}: matching request SHA without corresponding V1 candidate CI remains blocked`,t=>{const f=fixture(t,phase,kind);f.snapshot.runs=f.snapshot.runs.filter(r=>r.head_sha!==A);denied(f);});
}
for(const phase of ['audit','qa'])for(const [label,value] of [['missing',undefined],['null',null],['empty',''],['number',333],['array',[A]],['object',{sha:A}],['uppercase','A'.repeat(40)]])test(`R47 policy ${phase}: ${label} candidate rejected even with fresh gate signature`,t=>{const f=fixture(t,phase),g=f.gate();if(value===undefined)delete g.observed_shas.integration;else g.observed_shas.integration=value;f.payload.gate_digest=P.gateDigest(g);assert.throws(()=>P.verify(f.request,f.sign(),f.policy,g,f.now),/CANDIDATE_SHA_MISMATCH/);});
for(const value of [null,[],0,''])test('R47 invalid gate observations rejected before digest/type coercion '+JSON.stringify(value),t=>{const f=fixture(t),g=f.gate();g.observed_shas=value;assert.throws(()=>P.verify(f.request,f.sign(),f.policy,g,f.now),/CANDIDATE_GATE_INVALID/);});
for(const value of [null,'',333,[A],{sha:A}])test('R47 wrong-type request SHA does not reach claim '+JSON.stringify(value),t=>{const f=fixture(t);cross(f,value);denied(f);});
for(const phase of ['audit','qa'])test('R47 wrong phase cannot borrow gate authority: '+phase,t=>{const f=fixture(t,phase);f.request.phase=phase==='qa'?'audit':'qa';f.payload.phase=f.request.phase;denied(f,'HUMAN_REVIEW_REQUIRED');});
for(const mutate of [
 f=>{delete f.request.parent_shas;delete f.payload.parent_shas;},
 f=>{f.request.parent_shas=[A,B];f.payload.parent_shas=[A,B];},
 f=>{f.request.parent_shas=['1'.repeat(40)];f.payload.parent_shas=[...f.request.parent_shas];},
 f=>{f.payload.parent_shas=['1'.repeat(40),B];},
 f=>{f.request.base_sha=B;f.payload.base_sha=B;},
 f=>{delete f.request.base_sha;delete f.payload.base_sha;}
])test('R47 integration preparation requires explicitly signed exact dual inputs and target base',t=>{const f=fixture(t,'integration','claude');mutate(f);denied(f,'INTEGRATION_SOURCE_BINDING');});
test('R47 legitimate integration preparation retains explicit inputs/base and Fake-only behavior',t=>{const f=fixture(t,'integration','claude');assert.equal(f.gate().state,'INTEGRATION_READY');assert.deepEqual(f.request.parent_shas,['1'.repeat(40),'2'.repeat(40)]);assert.equal(f.request.base_sha,A);assert.equal(f.run().state,'SUCCESS');});
test('R47 integration cannot override an already supplied different candidate gate',t=>{const f=fixture(t,'integration','claude'),g=f.gate();g.observed_shas.integration=A;cross(f);f.request.base_sha=B;f.payload.base_sha=B;f.payload.gate_digest=P.gateDigest(g);assert.throws(()=>P.verify(f.request,f.sign(),f.policy,g,f.now),/CANDIDATE_SHA_MISMATCH/);});
for(const phase of ['audit','qa'])test(`R47 ${phase}: restart keeps good tombstone, denies re-signed B, and never creates B job`,t=>{const f=fixture(t,phase);assert.equal(f.run().state,'SUCCESS');const goodJobs=JSON.stringify(f.store.snapshot().jobs);f.store=new Store(f.dir);assert.equal(f.run().reason,'DUPLICATE_JOB');cross(f);for(let i=0;i<2;i++){f.store=new Store(f.dir);const r=f.run();assert.equal(r.reason,'CANDIDATE_SHA_MISMATCH');assert.deepEqual(r.would_launch,[]);assert.equal(JSON.stringify(f.store.snapshot().jobs),goodJobs);}assert.equal(Object.keys(f.store.snapshot().jobs).length,1);});
for(const phase of ['audit','qa'])test(`R47 ${phase}: inherited candidate excluded from signed canonical data cannot authorize`,t=>{const f=fixture(t,phase),g=f.gate();g.observed_shas=Object.create({integration:A});f.payload.gate_digest=P.gateDigest(g);assert.throws(()=>P.verify(f.request,f.sign(),f.policy,g,f.now),/CANDIDATE_SHA_MISMATCH/);});
