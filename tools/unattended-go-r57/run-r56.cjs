'use strict';
// Authorship assertions are run at their actual author's frozen tree, unchanged.
// The SAME R56 behavioral assertions also run on the integrated runtime in CI.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync,spawnSync}=require('node:child_process');
const M=require('./sources.json'),root=path.resolve(__dirname,'../..');
if(!M.r56)throw Error('WAIT_R56_SOURCE');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'r57-frozen-r56-')),repo=path.join(temp,'repo'),home=path.join(temp,'home');
fs.mkdirSync(home,{mode:0o700});if(process.env.R56_OUT)fs.mkdirSync(process.env.R56_OUT,{recursive:true});
const env={PATH:process.env.PATH,HOME:home,LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',...(process.env.R56_OUT?{R56_OUT:process.env.R56_OUT}:{})};
const git=(args,cwd=root)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
try{
 git(['clone','--quiet','--shared','--no-checkout','--',root,repo]);git(['checkout','--quiet','--detach',M.r56.head],repo);
 if(git(['rev-parse','HEAD'],repo)!==M.r56.head)throw Error('FROZEN_R56_SOURCE_MISMATCH');
 const r=spawnSync(process.execPath,['--test','tests/event-handoff-r56/handoff.test.js'],{cwd:repo,env,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
 process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');
 if(r.status!==0||r.error)throw Error('FROZEN_R56_REGRESSION_FAILED');
 console.log(JSON.stringify({source:M.r56.head,orchestrator:git(['rev-parse','HEAD']),evidence:'HISTORICAL_SOURCE_CONFORMANCE_NOT_INDEPENDENT_ACCEPT',real_model_calls:0}));
}finally{fs.rmSync(temp,{recursive:true,force:true});}
