'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {runStub}=require('../agent-executor/cli-runner');
const {reject}=require('./contract');
const instances=new WeakMap();
// The only executable seam in this build is R43's fixed repository-owned Node
// Stub. No arbitrary callback/command/SDK/plugin, no real R45 CLI implementation.
class FakeR45Runner{
 constructor(mode='success'){if(!['success','fail','timeout','stop','unknown-cost','wrong-sha','malformed','throw'].includes(mode))reject('FAKE_SCENARIO');instances.set(this,{mode,calls:0});Object.freeze(this);}
 get calls(){return instances.get(this).calls;}
 async run(e,signal){
  const s=instances.get(this);s.calls++;if(s.mode==='throw')throw Error('UNTRUSTED_RAW_ERROR_NOT_LOGGED');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r46-node-stub-'));
  let r;try{r=await runStub({mode:s.mode==='timeout'?'hang':s.mode==='fail'?'fail':'success'},{cwd:dir,signal,timeoutMs:Math.min(e.limits.runtime_ms,s.mode==='timeout'?80:1000)});}finally{fs.rmSync(dir,{recursive:true,force:true});}
  const state=s.mode==='stop'||r.state==='STOPPED'?'STOPPED':s.mode==='timeout'?'UNKNOWN':r.state==='SUCCESS'?'SUCCESS':'FAILED';
  const unknown=['unknown-cost','timeout','stop'].includes(s.mode)||r.state==='STOPPED';
  const o={schema:1,dispatch_id:e.dispatch_id,idempotency_key:e.idempotency_key,run_id:'FAKE_'+e.dispatch_id.slice(0,20),source_sha:e.source_sha,fixed_sha:s.mode==='wrong-sha'?'9'.repeat(40):e.source_sha,state,exit_code:r.exitCode,cost_known:!unknown,cost:unknown?null:0,log_ref:'https://github.com/chaow0879-collab/aijavais/actions/runs/1',ci_ref:'https://github.com/chaow0879-collab/aijavais/actions/runs/1',report_ref:'https://github.com/chaow0879-collab/aijavais/issues/30#issuecomment-1',retry:'NEVER',evidence:'E2_E3_FAKE',actual_agent_launches:0};
  if(s.mode==='malformed')o.secret='PRIVATE_FIXTURE_DO_NOT_LOG';return o;
 }
}
Object.freeze(FakeR45Runner.prototype);
const isFake=x=>instances.has(x)&&Object.getPrototypeOf(x)===FakeR45Runner.prototype;
class LiveR45Runner{constructor(){reject('R46_REAL_RUNNER_DISABLED');}}
module.exports={FakeR45Runner,LiveR45Runner,isFake,SEAM_VERSION:'aijavais.handoff/1'};
