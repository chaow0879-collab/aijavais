'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fixture,signReviews,R50,H,C}=require('./helpers.cjs');
const Control=require('../../unattended-go-r57/control'),Receipts=require('../../unattended-go-r57/receipts');
test('default/live/forged enablement never touch credentials, transports, callbacks or spawn',async()=>{
 for(const mode of [undefined,'live','fake ',true]){let touched=0;const input={mode};for(const k of ['credentialEnv','packet','stages','readGitHub','readReviews','provider_allowance'])Object.defineProperty(input,k,{get(){touched++;throw Error('private');}});
  for(const f of [Control.runOnce,Control.runChain]){const r=await f(input);assert.equal(r.state,'BLOCKED');assert.equal(r.reason,'LIVE_BUILD_DISABLED');assert.equal(r.actual_agent_launches,0);assert.equal(touched,0);}}
});
test('three unattended readonly packages use existing R50 -> R51 -> R46 CAS -> R45, real HTTP SQLite and Git; tick dedupes',async t=>{
 const f=await fixture(t,{durable:true}),r=await Control.runChain({mode:'fake',stages:f.stages});
 assert.equal(r.state,'DONE',JSON.stringify(r));assert.equal(f.launches(),3);assert.equal(r.manual_prompt_transfers,0);assert.equal(r.actual_agent_launches,0);
 assert.ok(r.stages.every(s=>s.state==='DONE'&&s.collected.receipt.work_sha===H.HEAD));
 const before=await f.backend.read();assert.equal(Object.keys(before.document.jobs).length,3);assert.ok(Object.values(before.document.jobs).every(j=>j.state==='SUCCEEDED'&&j.outcome.cost_known));
 for(const s of f.stages)s.packet.kind='tick';
 const duplicate=await Control.runChain({mode:'fake',stages:f.stages});assert.equal(duplicate.state,'DONE',JSON.stringify(duplicate));assert.equal(f.launches(),3);
 assert.ok(f.state.requests.every(x=>x.method==='GET'));assert.ok(r.stages[0].history.includes('CLAIMED'));assert.ok(r.stages[2].history.includes('QA_PENDING'));
 const out=process.env.R57_EVIDENCE_DIR;if(out){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'three-stage-e3.json'),JSON.stringify({candidate_sha:H.HEAD,source:f.source,level:'E3_FAKE_ONLY',actual_fake_cli_processes:f.launches(),real_agent_launches:0,manual_prompt_transfers:0,sqlite_service_processes:1,ci_validation_processes:f.state.ciProcesses,synthetic_identities:true,real_github_state_writes:0,stages:r.stages.map(s=>({state:s.state,history:s.history,receipt:s.collected.receipt}))},null,2));}
});
for(const [fault,expected]of [['ref','COLLECT_REF_MOVED'],['commit','COLLECT_COMMIT_BINDING'],['sha','COLLECT_CI_BINDING'],['pr','COLLECT_CI_BINDING'],['workflow','COLLECT_CI_BINDING'],['author','COLLECT_REPORT_IDENTITY'],['prose','COLLECT_STRUCTURED_REPORT_REQUIRED'],['report-sha','COLLECT_REPORT_BINDING'],['429','COLLECT_RATE_LIMITED'],['500','COLLECT_UNAVAILABLE']])test('machine evidence refuses '+fault+' without redispatch or release',async t=>{
 const f=await fixture(t,{count:1});f.state.fault=fault;const a=await Control.runOnce(f.stages[0]);assert.equal(a.state,'BLOCKED',JSON.stringify(a));assert.equal(a.reason,expected);assert.equal(f.launches(),1);
 const before=await f.backend.read();assert.equal(Object.values(before.document.jobs)[0].reservation,.1);
 f.stages[0].packet.kind='tick';const b=await Control.runOnce(f.stages[0]);assert.equal(b.state,'BLOCKED');assert.equal(f.launches(),1);assert.deepEqual(await f.backend.read(),before);
});
for(const [fault,state]of [['pending','CI_PENDING'],['ci-fail','REWORK_OR_NEXT']])test('CI '+fault+' never queues another package',async t=>{const f=await fixture(t);f.state.fault=fault;const r=await Control.runChain({mode:'fake',stages:f.stages});assert.equal(r.state,state,JSON.stringify(r));assert.equal(r.stages.length,1);assert.equal(f.launches(),1);assert.equal(r.next_allowed,false);});
test('no independent identity waits instead of turning developer report or green CI into review',async t=>{const f=await fixture(t);f.stages[0].readReviews=()=>null;const r=await Control.runChain({mode:'fake',stages:f.stages});assert.equal(r.state,'REVIEW_PENDING');assert.equal(r.reason,'WAIT_AUTHORIZED_REVIEWER');assert.equal(f.launches(),1);});
for(const [name,change]of [
 ['wrong reviewed SHA',p=>p.reviewed_sha='f'.repeat(40)],['expired review',p=>p.expires_at=1],
 ['audit veto',(p,r)=>{if(r==='v1_audit')p.verdict='REJECT';}],['QA fail',(p,r)=>{if(r==='v2_audit')p.product_verdict='FAIL';}],
 ['same reviewer',(p,r)=>{if(r==='v2_audit')p.reviewer_login='synthetic-audit';}],['developer self review',(p,r)=>{if(r==='v1_audit')p.reviewer_login='synthetic-developer';}]
])test('signed '+name+' is not approval of next work',async t=>{const f=await fixture(t);f.stages[0].readReviews=c=>signReviews(f.stages[0].f,c,change);const r=await Control.runChain({mode:'fake',stages:f.stages});assert.equal(r.state,'BLOCKED',JSON.stringify(r));assert.equal(f.launches(),1);assert.equal(r.stages.length,1);});
test('synthetic signed pending QA is QA_PENDING, not DONE',async t=>{const f=await fixture(t);f.stages[0].readReviews=c=>signReviews(f.stages[0].f,c,(p,r)=>{if(r==='v2_audit')p.product_verdict='PENDING';});const r=await Control.runChain({mode:'fake',stages:f.stages});assert.equal(r.state,'QA_PENDING');assert.equal(f.launches(),1);});
test('cross-receipt replay and tampered signature fail even at the same source SHA',async t=>{const f=await fixture(t);let bundle;f.stages[0].readReviews=c=>(bundle=signReviews(f.stages[0].f,c));const first=await Control.runOnce(f.stages[0]);assert.equal(first.state,'DONE');
 const forged=structuredClone(bundle);forged.proofs.v1_audit.signature=Buffer.alloc(64).toString('base64');assert.throws(()=>Receipts.reviews(forged,first.collected,f.stages[0].collectionPolicy,f.stages[0].f.now));
 const other={...first.collected,digest:'0'.repeat(64)};assert.throws(()=>Receipts.reviews(bundle,other,f.stages[0].collectionPolicy,f.stages[0].f.now),/COLLECT_REVIEW_BINDING/);
});
test('direct next-stage invocation cannot bypass missing parent reviews',async t=>{const f=await fixture(t);f.stages[0].readReviews=()=>null;const first=await Control.runOnce(f.stages[0]);assert.equal(first.state,'REVIEW_PENDING');const second=await Control.runOnce({...f.stages[1],parentEnvelope:f.stages[0].f.envelope,readReviews:()=>null});assert.equal(second.reason,'WAIT_PARENT_INDEPENDENT_REVIEWS');assert.equal(f.launches(),1);});
test('untrusted replayed event cannot reuse an old success to authorize progression',async t=>{const f=await fixture(t,{count:1});assert.equal((await Control.runOnce(f.stages[0])).state,'DONE');const r=await Control.runOnce(f.stages[0]);assert.equal(r.state,'BLOCKED');assert.equal(f.launches(),1);});
test('unknown bill keeps null, reservation and tombstone; no second package',async t=>{const f=await fixture(t,{mode:'nocost'});const r=await Control.runChain({mode:'fake',stages:f.stages});assert.equal(r.state,'UNKNOWN',JSON.stringify(r));assert.equal(f.launches(),1);const j=Object.values((await f.backend.read()).document.jobs)[0];assert.equal(j.outcome.cost,null);assert.equal(j.reservation,.1);f.stages[0].packet.kind='tick';await Control.runChain({mode:'fake',stages:f.stages});assert.equal(f.launches(),1);});
test('invalid parent and pre-cancelled chain launch zero processes',async t=>{const f=await fixture(t);const a=new AbortController();a.abort();assert.equal((await Control.runChain({mode:'fake',stages:f.stages,signal:a.signal})).state,'BLOCKED');assert.equal(f.launches(),0);f.stages[0].f.envelope.after='a'.repeat(64);assert.equal((await Control.runChain({mode:'fake',stages:f.stages})).reason,'PARENT_CHAIN_BINDING');});
test('bounded chain and owner matrix cannot be used as config enablement',async()=>{assert.equal((await Control.runChain({mode:'fake',stages:Array(5).fill({})})).state,'BLOCKED');const m=require('../../unattended-go-r57/OWNER_GO_MATRIX.json');assert.equal(m.state,'NO_GO');assert.equal(m.gates.LIVE_BUILD_ENABLED,'NO');assert.equal(m.gates.PROVIDER_TOTAL_USD_HARD_CAP,'NOT_VERIFIED');});
test('a hung independent review reader is bounded and never releases the completed job',async t=>{const f=await fixture(t,{count:1});f.stages[0].readReviews=()=>new Promise(()=>{});const r=await Control.runOnce(f.stages[0]);assert.equal(r.reason,'REMOTE_TIMEOUT');assert.equal(f.launches(),1);const j=Object.values((await f.backend.read()).document.jobs)[0];assert.equal(j.state,'SUCCEEDED');assert.equal(j.reservation,.1);});
test('partial HTTP timeout stays blocked without redispatch',async t=>{const f=await fixture(t,{count:1});f.state.fault='timeout';const r=await Control.runOnce(f.stages[0]);assert.equal(r.reason,'COLLECT_TIMEOUT');assert.equal(f.launches(),1);});
test('producer workflow provenance is distinct from the fixed-SHA validation CI',async t=>{
 const old=process.env.GITHUB_RUN_ID,repo=process.env.GITHUB_REPOSITORY,server=process.env.GITHUB_SERVER_URL;
 Object.assign(process.env,{GITHUB_RUN_ID:'42440725126',GITHUB_REPOSITORY:C.REPO,GITHUB_SERVER_URL:'https://github.com'});
 t.after(()=>{for(const [key,value]of Object.entries({GITHUB_RUN_ID:old,GITHUB_REPOSITORY:repo,GITHUB_SERVER_URL:server})){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
 const f=await fixture(t,{count:1}),r=await Control.runOnce(f.stages[0]);assert.equal(r.state,'DONE',JSON.stringify(r));assert.equal(r.collected.receipt.producer_ci_ref,'https://github.com/'+C.REPO+'/actions/runs/42440725126');assert.equal(r.collected.receipt.ci.id,101);assert.equal(r.collected.receipt.ci.sha,H.HEAD);
});
