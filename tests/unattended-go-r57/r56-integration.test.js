'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto');
const {fixture,signReviews,C,H}=require('./helpers.cjs'),W=require('../event-handoff-r56/world.cjs');
const Adapter=require('../../tools/unattended-go-r57/r56-adapter');
async function world(t){
 const f=await fixture(t,{durable:true,ticketPrefix:'r56'}),f0=f.stages[0].f,keys=W.reviewerKeys(),pipeline=W.pipeline(f0,keys),item=pipeline.work_items[0];
 const em=await W.emulator(t,path.join(f.dir,'r56-github.sqlite'));
 await W.seedCandidate(em,f0,item);await W.seedCi(em,f0,item);await W.seedReviews(em,f0,item,keys,Date.now());
 for(const s of f.stages){s.collectionPolicy.r56_pipeline_digest=C.digest({pipeline,item});s.f.authorization.manifest.r57_collection_policy_digest=C.digest(s.collectionPolicy);
  for(const [role,pair]of Object.entries(s.f.pairs)){const p=s.f.authorization.proofs[role];p.payload.manifest_digest=C.digest(s.f.authorization.manifest);p.signature=crypto.sign(null,Buffer.from(C.canonical(p.payload)),pair.privateKey).toString('base64');}}
 const find=key=>f.stages.find(s=>s.f.envelope.idempotency_key===key);
 const step=(trigger,over={})=>Adapter.step({mode:'fake',pipeline,item,trigger,readSnapshot:()=>em.client.snapshot(pipeline,item,Date.now()),readLedger:()=>f.backend.read(),
  provision:async ticket=>{const s=find(ticket.idempotency_key);assert.ok(s,'prepared original envelope for ticket');return s;},lookupCompleted:async key=>find(key),report:(issue,body)=>em.client.report(issue,body),now:Date.now(),...over});
 return {...f,em,pipeline,item,keys,step,event:()=>W.eventTrigger(f0,f.stages[0].x.store),tick:()=>W.tickTrigger()};
}
test('exact R56 trusted event/tickets drive R57 receipts and all three stages without prompt copying',async t=>{
 const f=await world(t),results=[];
 results.push(await f.step(f.event()));results.push(await f.step(f.tick()));results.push(await f.step(f.tick()));
 assert.ok(results.every(r=>r.state==='STAGE_SUCCEEDED'),JSON.stringify(results));assert.equal(f.launches(),3);
 const end=await f.step(f.tick());assert.equal(end.state,'HANDOFF_COMPLETE',JSON.stringify(end));assert.equal(end.r57_completed_receipts.length,3);assert.equal(end.manual_prompt_transfers,0);
 await f.step(f.tick());assert.equal(f.launches(),3);
 const stats=await f.em.stats();assert.equal(stats.post_report,3);
 const out=process.env.R57_EVIDENCE_DIR;if(out){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'r56-r57-unified-e3.json'),JSON.stringify({level:'E3_FAKE_ONLY',candidate_sha:H.HEAD,r56_source:'2b53e350d3b147b9216f8241a3e63350ceaf6b67',stage_states:results.map(r=>r.state),final:end.state,receipts:end.r57_completed_receipts,physical_fake_processes:f.launches(),manual_prompt_transfers:0,real_agents:0,real_agent_wake:'NOT_VERIFIED',real_github_ref_writes:0},null,2));}
});
test('R56 execution-complete does not bypass the last R57 receipt review; later evidence recheck starts no process',async t=>{
 const f=await world(t);let allowFinal=false;
 for(const s of f.stages)s.readReviews=c=>c.receipt.task_id.includes('-qa-')&&!allowFinal?null:signReviews(s.f,c);
 for(let i=0;i<3;i++)await f.step(f.tick());assert.equal(f.launches(),3);
 const pending=await f.step(f.tick());assert.equal(pending.state,'REVIEW_PENDING',JSON.stringify(pending));assert.equal(pending.r56_execution_state,'HANDOFF_COMPLETE');
 allowFinal=true;const end=await f.step(f.tick());assert.equal(end.state,'HANDOFF_COMPLETE',JSON.stringify(end));assert.equal(f.launches(),3);
});
test('R56 late signed veto during Fake process is rechecked by the existing R51 watch',async t=>{
 const f=await world(t),s=f.stages[0],bin=require('../agent-pilot-r45/helpers.cjs').fakeCli(path.join(f.dir,'r56-revoke-child'),'hang');s.packet.base.fakeExecutable=bin.file;
 const pending=f.step(f.tick());
 for(let n=0;n<300&&bin.launches()===0;n++)await new Promise(r=>setTimeout(r,10));assert.equal(bin.launches(),1);
 await f.em.comment({issue:2,login:'auditor',association:'MEMBER',created_at:new Date().toISOString(),body:W.verdictBody({role:'audit',key:f.keys.audit.privateKey,keyId:'aud-1',verdict:'REJECT',sha:s.f.candidate_sha,it:f.item,now:Date.now()})});
 const stopped=await pending;assert.notEqual(stopped.state,'STAGE_SUCCEEDED',JSON.stringify(stopped));
 const job=Object.values((await f.backend.read()).document.jobs)[0];assert.ok(['UNKNOWN','STOPPED'].includes(job.state));assert.equal(job.reservation,.1);assert.equal(job.outcome.cost,null);
 const next=await f.step(f.tick());assert.equal(next.state,'BLOCKED_REJECTED');assert.equal(bin.launches(),1);
});
test('R56/R57 default/live and forged trigger never reach preparation/getters',async()=>{
 let reads=0;const r=await Adapter.step({mode:'live',get provision(){reads++;throw Error('secret');},get pipeline(){reads++;throw Error('secret');}});assert.equal(r.reason,'LIVE_BUILD_DISABLED');assert.equal(reads,0);
 const fake=await Adapter.step({mode:'fake',pipeline:{},item:{},trigger:{kind:'github_webhook'},readSnapshot:()=>{throw Error('must not read');}});assert.equal(fake.reason,'UNTRUSTED_TRIGGER');
});
