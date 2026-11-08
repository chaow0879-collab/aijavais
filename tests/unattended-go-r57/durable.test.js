'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {fixture,signReviews,H,C}=require('./helpers.cjs'),Control=require('../../tools/unattended-go-r57/control');
function wire(f){const s=f.stages[0],base={};for(const k of ['candidate_sha','config','envelope','authorization','snapshot','policy','refs','admission','sourceRepo','stateDir','fakeExecutable'])base[k]=s.packet.base[k];
 const packet={};for(const k of ['mode','kind','now','delivery','webhookSecret','oidcToken','jwks','approval'])packet[k]=s.packet[k];packet.kind='tick';
 const x={synthetic:true,base,packet,collectionPolicy:s.collectionPolicy,seed:f.seed.toString('hex'),brokerPolicy:s.x.broker.policy,separated:s.x.separated,store:s.x.store.file,cas:f.svc.url,github:f.url,
  privatePairs:Object.fromEntries(Object.entries(s.f.pairs).map(([role,p])=>[role,p.privateKey.export({type:'pkcs8',format:'pem'})]))};
 const file=path.join(f.dir,'synthetic-worker-input.json');fs.writeFileSync(file,JSON.stringify(x),{mode:0o600});return file;
}
function worker(file){const child=spawn(process.execPath,[path.join(__dirname,'worker.cjs'),file],{env:{PATH:process.env.PATH,LANG:'C.UTF-8',...(process.env.RUNNER_TEMP?{RUNNER_TEMP:process.env.RUNNER_TEMP}:{}),...(process.env.TMPDIR?{TMPDIR:process.env.TMPDIR}:{})},stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',b=>out+=b);const done=once(child,'close').then(([code,signal])=>({code,signal,report:out?JSON.parse(out):null}));return {child,done};}
test('four real controller processes race on original HTTP SQLite CAS; one Fake, one durable work key',async t=>{
 const f=await fixture(t,{count:1,durable:true}),file=wire(f),workers=Array.from({length:4},()=>worker(file));const rs=await Promise.all(workers.map(w=>w.done));
 assert.ok(rs.every(r=>r.code===0),JSON.stringify(rs));assert.equal(f.launches(),1);assert.equal(rs.filter(r=>r.report.state==='DONE').length>=1,true,JSON.stringify(rs));
 const d=(await f.backend.read()).document;assert.equal(Object.keys(d.jobs).length,1);assert.equal(Object.values(d.jobs)[0].state,'SUCCEEDED');
 const out=process.env.R57_EVIDENCE_DIR;if(out){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'four-process-cas.json'),JSON.stringify({level:'E3_FAKE',head_sha:H.HEAD,controller_processes:rs.map(r=>r.report),physical_fake_processes:f.launches(),real_agents:0,jobs:Object.values(d.jobs).map(j=>({state:j.state,reservation:j.reservation,work_hash:j.work_hash}))},null,2));}
});
for(const stage of [1,2,3])test('real persisted CAS loses ACK at stage '+stage+'; later tick never replays',async t=>{
 const f=await fixture(t,{count:1,durable:true}),s=f.stages[0],old=f.backend.compareAndSwap.bind(f.backend);let calls=0;
 f.backend.compareAndSwap=async(...args)=>{const r=await old(...args);if(++calls===stage)throw Error('OWNED_FIXTURE_ACK_LOST');return r;};
 const a=await Control.runOnce(s);assert.notEqual(a.state,'DONE',JSON.stringify(a));f.backend.compareAndSwap=old;s.packet.kind='tick';await Control.runOnce(s);
 assert.equal(f.launches(),stage===3?1:0);const jobs=Object.values((await f.backend.read()).document.jobs);assert.equal(jobs.length,1);assert.equal(jobs[0].reservation,.1);assert.equal(jobs[0].state,stage===1?'CLAIMED':stage===2?'UNKNOWN':'SUCCEEDED');
});
test('SIGKILL after dispatch + expired lease recovers UNKNOWN with reservation, never a new Fake',async t=>{
 const f=await fixture(t,{count:1,durable:true,mode:'hang'}),w=worker(wire(f));
 t.after(()=>{try{w.child.kill('SIGKILL');}catch{}});
 for(let n=0;n<300&&(f.launches()===0||!fs.existsSync(path.join(path.dirname(f.stages[0].f.cli.counter),'hang-pids.json')));n++)await new Promise(r=>setTimeout(r,10));assert.equal(f.launches(),1);
 const ownedPids=JSON.parse(fs.readFileSync(path.join(path.dirname(f.stages[0].f.cli.counter),'hang-pids.json'),'utf8'));
 const cwd=fs.readlinkSync('/proc/'+ownedPids[0]+'/cwd'),workspaceRoot=path.dirname(cwd);
 assert.equal(path.dirname(workspaceRoot),path.resolve(process.env.RUNNER_TEMP||require('node:os').tmpdir()));assert.match(path.basename(workspaceRoot),/^aij-pilot-/);assert.equal(path.basename(cwd),'repo');
 t.after(()=>{require('../../tools/first-pilot-r51/workspace-seal').restore(workspaceRoot);fs.rmSync(workspaceRoot,{recursive:true,force:true});});
 w.child.kill('SIGKILL');await w.done;
 // Kill only PIDs written by this owned Fake fixture, including its grandchild.
 const pids=JSON.parse(fs.readFileSync(path.join(path.dirname(f.stages[0].f.cli.counter),'hang-pids.json'),'utf8'));
 for(const pid of pids)try{process.kill(pid,'SIGKILL');}catch{}
 const before=Object.values((await f.backend.read()).document.jobs)[0];assert.equal(before.state,'DISPATCHING');
 const early=before.lease_until-1;
 await require('../../tools/auto-handoff-r46/reconcile').recover({simulate:true,config:f.stages[0].f.config,backend:f.backend,trigger:require('../../tools/auto-handoff-r46/triggers').tick(early,f.stages[0].f.config),now:early});
 assert.equal(Object.values((await f.backend.read()).document.jobs)[0].state,'DISPATCHING');
 const now=before.lease_until+1;
 await require('../../tools/auto-handoff-r46/reconcile').recover({simulate:true,config:f.stages[0].f.config,backend:f.backend,trigger:require('../../tools/auto-handoff-r46/triggers').tick(now,f.stages[0].f.config),now});
 const j=Object.values((await f.backend.read()).document.jobs)[0];assert.equal(j.state,'UNKNOWN');assert.equal(j.reservation,.1);assert.equal(j.outcome,null);
 f.stages[0].packet.kind='tick';await Control.runOnce(f.stages[0]);assert.equal(f.launches(),1);
});
test('daily budget exhausted by completed task prevents next valid signed package',async t=>{
 const f=await fixture(t),first=await Control.runOnce(f.stages[0]);assert.equal(first.state,'DONE');
 f.stages[1].packet.base.config.max_daily_cost=.1;
 const r=await Control.runOnce({...f.stages[1],parentEnvelope:f.stages[0].f.envelope});
 assert.equal(r.reason,'DAILY_BUDGET',JSON.stringify(r));assert.equal(f.launches(),1);
});
test('persistent HALT prevents any process',async t=>{
 const f=await fixture(t,{count:1}),s=f.stages[0],{seal,log}=require('../../tools/auto-handoff-r46/state');
 const r=await f.backend.read(),d=structuredClone(r.document);d.halted=true;d.clock=s.f.now;log(d,'HALTED',null,s.f.now);
 await f.backend.compareAndSwap(r.version,seal(d));assert.notEqual((await Control.runOnce(s)).state,'DONE');assert.equal(f.launches(),0);
});
test('collection policy key/workflow substitution blocked before spawn',async t=>{const f=await fixture(t,{count:1});f.stages[0].collectionPolicy.workflow_paths=['evil.yml'];const r=await Control.runOnce(f.stages[0]);assert.equal(r.reason,'COLLECTION_POLICY_NOT_AUTHORIZED');assert.equal(f.launches(),0);});
test('revoke parent QA during following Fake work: existing R51 watch cancels, unknown cost stays reserved',async t=>{
 const f=await fixture(t),first=await Control.runOnce(f.stages[0]);assert.equal(first.state,'DONE');
 const s=f.stages[1];
 // Replace only this owned test executable with the existing marked hang fixture.
 const bin=require('../agent-pilot-r45/helpers.cjs').fakeCli(path.join(f.dir,'hang-next'),'hang');s.packet.base.fakeExecutable=bin.file;
 s.readReviews=c=>signReviews(s.f,c,(p,r)=>{if(r==='v2_audit'&&bin.launches()>0)p.product_verdict='PENDING';});
 const r=await Control.runOnce({...s,parentEnvelope:f.stages[0].f.envelope});assert.notEqual(r.state,'DONE',JSON.stringify(r));assert.equal(bin.launches(),1);
 const j=(await f.backend.read()).document.jobs[s.f.envelope.idempotency_key];assert.ok(j&&['STOPPED','UNKNOWN'].includes(j.state),JSON.stringify(j));assert.equal(j.reservation,.1);assert.equal(j.outcome?.cost,null);
});
