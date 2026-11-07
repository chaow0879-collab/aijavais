'use strict';
// ProductQA-owned differential scenarios; demo is synthetic input, never a test oracle.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync,spawnSync}=require('node:child_process'),H=require('./harness.cjs');
const {demo}=require('../../tools/agent-executor/demo'),P=require('../../tools/agent-executor/policy');
const {Executor}=require('../../tools/agent-executor/engine'),{Store}=require('../../tools/agent-executor/store');
const {FakeAdapter}=require('../../tools/agent-executor/adapters'),{evaluate}=require('../../tools/agent-scheduler/state');
const OLD='ab3e07979f67924e795426737e26c5c4d84b8501',A='3'.repeat(40),B='9'.repeat(40),results=[];
function resign(d){d.payload.source_digest=P.digest(d.snapshot);d.payload.gate_digest=P.gateDigest(evaluate(d.snapshot,d.policy.gate_config,d.now));return d.sign();}
function cross(d,ci){d.request.sha=B;d.request.observed_ref=B;d.payload.sha=B;d.snapshot.refs[d.request.branch]=B;if(ci)d.snapshot.runs.push({...structuredClone(d.snapshot.runs[0]),head_sha:B});}
function execute(d,dir,script=[{type:'result',tokens:5,elapsed:1}]){
 const store=new Store(dir);let claims=0;const real=store.claim.bind(store);store.claim=(...a)=>{claims++;return real(...a);};
 const report=new Executor(d.policy,store).run(d.request,resign(d),d.snapshot,new FakeAdapter(d.request.kind,'cli',script),d.now);
 assert.equal(report.actual_dispatch,false);assert.equal(report.actual_launches,0);assert.equal(report.model_spend,null);
 return {report,claimInvocations:claims,state:store.snapshot()};
}
function deny(d,dir,reason){const r=execute(d,dir);assert.equal(r.report.state,'BLOCKED');if(reason)assert.equal(r.report.reason,reason);assert.equal(r.claimInvocations,0,'must reject BEFORE Store.claim');assert.deepEqual(r.report.would_launch,[]);assert.equal(Object.keys(r.state.jobs).length,0);assert.equal(r.state.audit.filter(e=>e.type==='CLAIMED').length,0);return r;}
function scenario(id,fn){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qa47-'));try{const detail=fn(dir);results.push({id,status:'PASS'});H.write(id+'.json',{id,status:'PASS',detail});}catch(e){results.push({id,status:'FAIL',error:e.message,stack:e.stack});H.write(id+'.json',results.at(-1));throw e;}finally{fs.rmSync(dir,{recursive:true,force:true});}console.log('R47_CASE '+JSON.stringify(results.at(-1)));}
try{
 scenario('D01-exact-source-difference',()=>{
  const git=(...args)=>execFileSync('git',args,{cwd:H.ROOT,encoding:'utf8'}).trim();
  const changed=git('diff','--name-only',OLD,H.BUSINESS_SHA).split('\n');
  assert.deepEqual([...changed].sort(),['.github/workflows/integrated-acceptance-26.yml','collab/ACTIVE-DEVELOPMENT.md','collab/HANDOFF.md','docs/R43-SHA-BINDING-R47.md','tests/agent-executor/r47-sha-binding.test.js','tools/agent-executor/demo.js','tools/agent-executor/policy.js','tools/integration/verify-r43-sources.js'].sort());
  const productPaths=['server.js','lib','public','catalog','package.json','tools/p2','tools/database.js'];
  assert.equal(git('diff','--name-only',OLD,H.BUSINESS_SHA,'--',...productPaths),'');
  const trees=Object.fromEntries(productPaths.map(p=>[p,{before:git('ls-tree',OLD,'--',p),after:git('ls-tree',H.BUSINESS_SHA,'--',p)}]));
  const configs=['tools/agent-executor/config.json','tools/agent-scheduler/config.json'];
  for(const p of configs)assert.equal(git('diff',OLD,H.BUSINESS_SHA,'--',p),'');
  const config=require('../../tools/agent-executor/config.json');assert.ok(P.FLAGS.every(k=>config[k]===false));assert.equal(config.cron_enabled,false);assert.equal(config.webhook_enabled,false);
  const off={};for(const p of ['agent-scheduler/cli.js','agent-executor/cli.js','agent-executor/runner-entry.js']){const child=spawnSync(process.execPath,['tools/'+p],{cwd:H.ROOT,encoding:'utf8'});const r=JSON.parse(child.stdout);assert.ok([0,2].includes(child.status));assert.equal(r.actual_dispatch,false);assert.ok(['DISABLED','BLOCKED'].includes(r.state));off[p]={exitCode:child.status,report:r};}
  return {reviewed_sha:H.BUSINESS_SHA,old_sha:OLD,changed,trees,configsUnchanged:configs,off};
 });
 for(const phase of ['audit','qa']){
  scenario('D02-'+phase+'-same-candidate-and-reopen',dir=>{
   const d=demo(phase,'codex'),first=execute(d,dir);assert.equal(first.report.state,'SUCCESS');assert.equal(first.claimInvocations,1);
   const again=execute(d,dir);assert.equal(again.report.reason,'DUPLICATE_JOB');assert.equal(Object.keys(again.state.jobs).length,1);
   assert.deepEqual(again.state.jobs,first.state.jobs);assert.ok(Object.values(again.state.jobs).every(j=>j.actual_cost===null));return {first,again};
  });
  for(const ci of [false,true])scenario('D03-'+phase+'-fully-resigned-B-ci-'+ci,dir=>{
   const d=demo(phase,'claude');cross(d,ci);assert.equal(evaluate(d.snapshot,d.policy.gate_config,d.now).observed_shas.integration,A);
   const r=deny(d,dir,'CANDIDATE_SHA_MISMATCH');return {ownBCI:ci,request:d.request,result:r};
  });
  scenario('D04-'+phase+'-same-SHA-missing-CI',dir=>{const d=demo(phase);d.snapshot.runs=d.snapshot.runs.filter(r=>r.head_sha!==A);return deny(d,dir);});
  scenario('D05-'+phase+'-resigned-wrong-role',dir=>{const d=demo(phase);d.request.role='integrator';d.payload.role='integrator';d.payload.permitted_roles=['integrator'];return deny(d,dir,'HUMAN_REVIEW_REQUIRED');});
  scenario('D06-'+phase+'-restart-unknown-reservation',dir=>{
   const d=demo(phase);d.payload.max_model_spend=.05;d.payload.max_daily_model_spend=.1;d.policy.max_model_spend=.05;d.policy.max_daily_model_spend=.1;
   // Simulate a real child abruptly leaving CLAIMED: no actual model is attached.
   const reqFile=path.join(dir,'synthetic-input.json');fs.writeFileSync(reqFile,JSON.stringify({request:d.request,limits:d.payload,now:d.now}));
   const child=execFileSync(process.execPath,['-e',"const fs=require('fs'),{Store}=require(process.argv[1]);const x=JSON.parse(fs.readFileSync(process.argv[2]));const s=new Store(process.argv[3]);s.claim(x.request,x.limits,x.now);process.exit(0)",path.join(H.ROOT,'tools/agent-executor/store.js'),reqFile,dir],{encoding:'utf8'});assert.equal(child,'');
   const before=new Store(dir).snapshot();assert.equal(Object.values(before.jobs)[0].state,'CLAIMED');assert.equal(Object.values(before.jobs)[0].reserved,.05);
   const repeated=execute(d,dir);assert.equal(repeated.report.reason,'DUPLICATE_JOB');const job=Object.values(repeated.state.jobs)[0];assert.equal(job.state,'HUMAN_REVIEW_REQUIRED');assert.equal(job.actual_cost,null);assert.equal(job.reserved,.05);
   cross(d,true);const denied=execute(d,dir);assert.equal(denied.report.reason,'CANDIDATE_SHA_MISMATCH');assert.equal(denied.claimInvocations,0);assert.deepEqual(denied.state.jobs,repeated.state.jobs);assert.deepEqual(denied.state.daily,repeated.state.daily);return {before,repeated,denied};
  });
 }
 scenario('D07-integration-explicit-dual-input-base',dir=>{const d=demo('integration');assert.deepEqual(d.request.parent_shas,['1'.repeat(40),'2'.repeat(40)]);assert.equal(d.request.base_sha,A);const r=execute(d,dir);assert.equal(r.report.state,'SUCCESS');return r;});
 for(const mutation of ['wrong-base','missing-base','swapped-parents','unsigned-parent-change'])scenario('D08-integration-'+mutation,dir=>{
  const d=demo('integration');if(mutation==='wrong-base'){d.request.base_sha=B;d.payload.base_sha=B;}if(mutation==='missing-base'){delete d.request.base_sha;delete d.payload.base_sha;}
  if(mutation==='swapped-parents'){d.request.parent_shas.reverse();d.payload.parent_shas=[...d.request.parent_shas];}if(mutation==='unsigned-parent-change')d.request.parent_shas[1]=B;
  return deny(d,dir,'INTEGRATION_SOURCE_BINDING');
 });
 scenario('D09-old-vs-new-original-cross-SHA-reproduction',()=>{
  // Materialize ONLY historical simulation modules in a private temp tree.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qa47-old-'));try{
   const files=execFileSync('git',['ls-tree','-r','--name-only',OLD,'--','tools/agent-executor','tools/agent-scheduler'],{cwd:H.ROOT,encoding:'utf8'}).trim().split('\n');
   for(const p of files){fs.mkdirSync(path.dirname(path.join(root,p)),{recursive:true});fs.writeFileSync(path.join(root,p),execFileSync('git',['show',OLD+':'+p],{cwd:H.ROOT}));}
   const track=[];for(const phase of ['audit','qa']){
    const d=require(path.join(root,'tools/agent-executor/demo')).demo(phase),dir=fs.mkdtempSync(path.join(os.tmpdir(),'qa47-oldstore-'));
    try{cross(d,false);const oldP=require(path.join(root,'tools/agent-executor/policy'));d.payload.source_digest=oldP.digest(d.snapshot);d.payload.gate_digest=oldP.gateDigest(require(path.join(root,'tools/agent-scheduler/state')).evaluate(d.snapshot,d.policy.gate_config,d.now));
     const r=new (require(path.join(root,'tools/agent-executor/engine')).Executor)(d.policy,new (require(path.join(root,'tools/agent-executor/store')).Store)(dir)).run(d.request,d.sign(),d.snapshot,new (require(path.join(root,'tools/agent-executor/adapters')).FakeAdapter)(d.request.kind,'cli',[{type:'result'}]),d.now);
     assert.equal(r.state,'SUCCESS');assert.equal(r.actual_launches,0);track.push({phase,old_sha:OLD,old_result:r,new_expected:'BLOCKED/CANDIDATE_SHA_MISMATCH; see D03'});
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
   }return track;
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 });
}catch(e){H.write('ALERT.json',{severity:'REVIEW_REQUIRED',message:e.message});process.exitCode=1;}
H.write('delta-results.json',{reviewed_sha:H.BUSINESS_SHA,test_sha:execFileSync('git',['rev-parse','HEAD'],{cwd:H.ROOT,encoding:'utf8'}).trim(),simulationOnly:true,real_agent_launches:0,results});H.manifest();console.log('R47_SUMMARY '+JSON.stringify({cases:results.length,pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL').length}));
