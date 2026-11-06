#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const defaults=require('./config.json');const {evaluate,summarize}=require('./state');const {collect}=require('./github');const {PlanStore}=require('./lease');
async function main(args) {
  const value=flag=>{const i=args.indexOf(flag);return i<0?null:args[i+1];};
  if(!args.includes('--once'))return {state:'DISABLED',enabled:false,poll_interval_minutes:10,actual_dispatch:false,would_dispatch:[]};
  const config={...defaults,...(value('--config')?JSON.parse(fs.readFileSync(value('--config'),'utf8')):{})};
  // No daemon/timer/cron implementation. Explicit one-shot is the only entry.
  const snapshot=value('--fixture')?JSON.parse(fs.readFileSync(value('--fixture'),'utf8')):args.includes('--live')?await collect():null;
  const report=evaluate(snapshot,config);
  const target={INTEGRATION_READY:[10,'integrator','integration'],AUDITING:[2,'audit','audit'],PRODUCT_QA:[4,'qa','qa']}[report.state];
  if(target&&args.includes('--simulate-plan')){
    const sha=report.observed_shas.integration||report.observed_shas[15];
    const dir=value('--state-dir')||fs.mkdtempSync(path.join(os.tmpdir(),'aij-scheduler-'));
    const lease=new PlanStore(dir,config.lease_ttl_ms).claim({issue:target[0],role:target[1],phase:target[2]+(report.state==='INTEGRATION_READY'?':'+report.observed_shas[17]:''),sha});
    report.simulation=lease;if(lease.would_dispatch)report.would_dispatch.push({issue:target[0],role:target[1],phase:target[2]+(report.state==='INTEGRATION_READY'?':'+report.observed_shas[17]:''),sha});
  }
  report.summary_zh=summarize(report);return report;
}
if(require.main===module)main(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r,null,2))).catch(()=>{console.log(JSON.stringify({state:'BLOCKED',blockers:['UNKNOWN_CONFIG_OR_SNAPSHOT'],actual_dispatch:false,would_dispatch:[]}));process.exitCode=2;});
module.exports={main};
