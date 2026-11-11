#!/usr/bin/env node
'use strict';
const {reconcile}=require('./reconcile'),T=require('./triggers');
async function main(args=[]){
 if(args.length===0)return {state:'DISABLED',real_dispatch:false,actual_agent_launches:0,event_enabled:false,cron:'NOT_ENABLED',source_sha:require('./config.json').source_sha};
 if(args.length!==1||args[0]!=='--fake-demo')throw Error('R46_LIVE_EXECUTION_DISABLED');
 // Explicit checkout-only contract fixture. Its temporary signing keys are Fake,
 // never credentials or real Planner/CodeAudit/QA approvals, never printed/saved.
 const {fixture,webhook}=require('../../tests/auto-handoff-r46/fixtures.cjs');
 const f=fixture(),event=T.webhook(webhook(f),f.config,f.now);
 const first=await reconcile(f.input({trigger:event}));
 const repeat=await reconcile(f.input({trigger:T.tick(f.now+600000,f.config),now:f.now+600000}));
 const child=fixture({task_id:'followup-fixture',role:'qa',phase:'qa',after:f.envelope.idempotency_key});child.backend=f.backend;
 const next=await reconcile(child.input());
 return {state:first.state==='SUCCEEDED'&&next.state==='SUCCEEDED'?'FAKE_HANDOFF_COMPLETE':'BLOCKED',evidence:'E2_E3_FAKE',first:first.state,ten_minute_tick:repeat.reason,next:next.state,simulated_runner_calls:f.runner.calls+child.runner.calls,real_dispatch:false,actual_agent_launches:0,cost:'NOT_VERIFIED',event_enabled:false,cron:'NOT_ENABLED',R45_integration:'CONTRACT_FIXTURE_ONLY'};
}
if(require.main===module)main(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r,null,2))).catch(()=>{console.log(JSON.stringify({state:'BLOCKED',reason:'R46_LIVE_EXECUTION_DISABLED',real_dispatch:false,actual_agent_launches:0}));process.exitCode=2;});
module.exports={main};
