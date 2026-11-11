#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {runLive,runStub}=require('./cli-runner');
async function main(args){
 if(args.length===1&&args[0]==='--probe'){const E=require('./environment');const clients=Object.fromEntries(await Promise.all(['codex','claude'].map(async kind=>[kind,await E.probe(kind)])));return {...E.readiness({clients}),environment:E.contextHealth(),probe_only:true};}
 if(args.length===2&&args[0]==='--plan'){
  let input;try{const file=args[1],s=fs.statSync(file);if(!s.isFile()||s.size>32768)throw Error();input=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('INVALID_PLAN_INPUT');}
  return require('./rehearsal').plan(input);
 }
 if(args.length&&!(args.length===1&&args[0]==='--stub'))throw Error('INVALID_RUNNER_ARGUMENTS');
 if(args.includes('--stub')){const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'executor-cli-stub-'));try{return await runStub({mode:'success'},{cwd});}finally{fs.rmSync(cwd,{recursive:true,force:true});}}
 // No secrets are read, and no actual CLI starts in this revision.
 await runLive();
}
if(require.main===module)main(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r,null,2))).catch(error=>{const reason=['LIVE_BUILD_DISABLED','INVALID_RUNNER_ARGUMENTS','INVALID_PLAN_INPUT','INVALID_REHEARSAL'].includes(error.message)?error.message:'RUNNER_FAILED';console.log(JSON.stringify({state:'BLOCKED',reason,actual_dispatch:false,actual_agent_launches:0}));process.exitCode=2;});
module.exports={main};
