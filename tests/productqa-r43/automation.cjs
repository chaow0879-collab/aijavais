'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const H=require('./harness.cjs'),{demo}=require('../../tools/agent-executor/demo'),{Executor}=require('../../tools/agent-executor/engine'),{Store}=require('../../tools/agent-executor/store'),{FakeAdapter}=require('../../tools/agent-executor/adapters');
const results=[];
function scenario(name,fn){try{const details=fn();results.push({name,status:'PASS',...details});}catch(e){results.push({name,status:'FAIL',error:e.message});}console.log(JSON.stringify(results.at(-1)));}
function fresh(){return fs.mkdtempSync(path.join(os.tmpdir(),'qa43-auto-'));}
function execute(d,dir,script=[{type:'result',tokens:17,elapsed:2}]){return new Executor(d.policy,new Store(dir)).run(d.request,d.approval,d.snapshot,new FakeAdapter(d.request.kind,'cli',script),d.now);}
scenario('default scheduler/executor/live-entry remain OFF',()=>{
 const outputs={};for(const file of ['agent-scheduler/cli.js','agent-executor/cli.js','agent-executor/runner-entry.js']){
  const r=spawnSync(process.execPath,['tools/'+file],{cwd:H.ROOT,encoding:'utf8',timeout:10000});const out=JSON.parse(r.stdout);assert.equal(out.actual_dispatch,false);assert.ok(['DISABLED','BLOCKED'].includes(out.state));outputs[file]={exitCode:r.status,output:out};
 }return {outputs,actual_agent_launches:0};
});
scenario('Fake integration→audit→QA with durable dedup across Store reopen',()=>{
 const dir=fresh(),track=[];try{for(const [phase,kind]of [['integration','claude'],['audit','codex'],['qa','codex']]){
  const d=demo(phase,kind),r=execute(d,dir);assert.equal(r.state,'SUCCESS');assert.equal(r.actual_dispatch,false);assert.equal(r.actual_launches,0);
  const again=execute(d,dir);assert.equal(again.reason,'DUPLICATE_JOB');track.push({phase,first:r,repeated:again});
 }const snapshot=new Store(dir).snapshot();assert.equal(Object.keys(snapshot.jobs).length,3);assert.ok(Object.values(snapshot.jobs).every(j=>j.actual_cost===null));H.write('fake-chain.json',{track,snapshot});return {jobs:3,duplicates_refused:3,actual_agent_launches:0};}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
for(const mutation of ['signature','sha','ci'])scenario('changed '+mutation+' cannot run even a Fake task',()=>{
 const d=demo(),dir=fresh();try{if(mutation==='signature')d.approval.signature='invalid';if(mutation==='sha')d.request.sha='a'.repeat(40);if(mutation==='ci')d.snapshot.runs[0].conclusion='failure';
 const r=execute(d,dir);assert.equal(r.state,'BLOCKED');assert.equal(Object.keys(new Store(dir).snapshot().jobs).length,0);return {reason:r.reason,actual_agent_launches:0};}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
for(const [mode,event,expected]of [['fail',{type:'fail'},'FAILED'],['incomplete',{type:'progress'},'HUMAN_REVIEW_REQUIRED'],['over-token',{type:'progress',tokens:101},'BLOCKED'],['stop',{type:'stop'},'STOPPED']])scenario('Fake '+mode+' retains evidence and cannot replay',()=>{
 const d=demo(),dir=fresh();try{const r=execute(d,dir,[event]);assert.equal(r.state,expected);assert.equal(execute(d,dir).reason,'DUPLICATE_JOB');const state=new Store(dir).snapshot();assert.equal(Object.keys(state.jobs).length,1);assert.equal(Object.values(state.jobs)[0].actual_cost,null);H.write('fake-'+mode+'.json',{response:r,state});return {result:r.state,actual_agent_launches:0};}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
(async()=>{
 const dir=fresh();try{const r=await require('../../tools/agent-executor/cli-runner').runStub({mode:'success'},{cwd:dir});assert.equal(r.state,'SUCCESS');assert.equal(r.actual_agent_launches,0);assert.equal(r.actual_dispatch,false);results.push({name:'fixed Node Stub process, not a real model CLI',status:'PASS',result:r});}catch(e){results.push({name:'fixed Node Stub',status:'FAIL',error:e.message});}finally{fs.rmSync(dir,{recursive:true,force:true});}
 H.write('automation-results.json',{businessSha:H.BUSINESS_SHA,simulationOnly:true,actual_agent_launches:0,model_cost:null,real_ten_minute_trigger:'NOT_RUN',results});H.manifest();console.log(JSON.stringify({cases:results.length,fail:results.filter(x=>x.status==='FAIL').length}));if(results.some(r=>r.status==='FAIL'))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
