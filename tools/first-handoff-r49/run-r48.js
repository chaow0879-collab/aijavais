#!/usr/bin/env node
'use strict';
// Historical conformance must run at its exact source SHA: its frozen-suite
// asserts R45 is unchanged. Never edit R48 assertions to hide R49 safety fixes.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync,spawnSync}=require('node:child_process');
const M=require('./sources.json'),repo=path.resolve(__dirname,'../..');
function run(){
 const sha=M.r48?.head;if(typeof sha!=='string'||!/^[a-f0-9]{40}$/.test(sha))throw Error('WAIT_R48');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'r49-frozen-r48-')),dir=path.join(root,'repo'),home=path.join(root,'home');fs.mkdirSync(home,{mode:0o700});
 const env={PATH:process.env.PATH,HOME:home,LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',...(process.env.RUNNER_TEMP?{RUNNER_TEMP:process.env.RUNNER_TEMP}:{}),...(process.env.R48_OUT?{R48_OUT:process.env.R48_OUT}:{})};
 const git=(args,cwd=repo)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 try{
  git(['clone','--quiet','--no-hardlinks','--no-checkout','--',repo,dir]);git(['checkout','--quiet','--detach',sha],dir);
  if(git(['rev-parse','HEAD'],dir)!==sha)throw Error('BLOCKED_SOURCE');
  const files=['sources-bridge','matrix','frozen-suites'].map(f=>'tests/agent-interop-r48/'+f+'.test.js');
  const r=spawnSync(process.execPath,['--test',...files],{cwd:dir,env,encoding:'utf8',timeout:600000,maxBuffer:4*1024*1024});
  process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');
  if(r.status!==0||r.error)throw Error('R48_HISTORICAL_CONFORMANCE_FAILED');
  console.log(JSON.stringify({orchestrator_sha:git(['rev-parse','HEAD']),r48_source_sha:sha,mode:'HISTORICAL_FROZEN_SOURCE_CONFORMANCE',unsafe_acceptance_is_a_historical_observation_not_security_pass:true,actual_agent_launches:0}));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
if(require.main===module)try{run();}catch(e){console.error(['WAIT_R48','R48_HISTORICAL_CONFORMANCE_FAILED'].includes(e.message)?e.message:'BLOCKED_SOURCE');process.exitCode=1;}
module.exports={run};
