#!/usr/bin/env node
'use strict';
// R52 authorship guard is meaningful at R52's frozen source, not at a joint tree.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync,spawnSync}=require('node:child_process'),M=require('./sources.json'),repo=path.resolve(__dirname,'../..');
function run(){if(!M.r52)throw Error('WAIT_R52');const root=fs.mkdtempSync(path.join(os.tmpdir(),'r53-source-r52-')),dir=path.join(root,'repo'),home=path.join(root,'home');fs.mkdirSync(home,{mode:0o700});
 const env={PATH:process.env.PATH,HOME:home,LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',...(process.env.R52_OUT?{R52_OUT:process.env.R52_OUT}:{})};
 const git=(args,cwd=repo)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 try{git(['clone','--quiet','--no-hardlinks','--no-checkout','--',repo,dir]);git(['checkout','--quiet','--detach',M.r52.head],dir);if(git(['rev-parse','HEAD'],dir)!==M.r52.head)throw Error('SOURCE_MISMATCH');const r=spawnSync(process.execPath,['--test','tests/haloflux-workbench-r52/workbench.test.js'],{cwd:dir,env,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.status!==0||r.error)throw Error('R52_FROZEN_REGRESSION_FAILED');console.log(JSON.stringify({mode:'FROZEN_R52_SOURCE_CONFORMANCE',r52_source_sha:M.r52.head,orchestrator_sha:git(['rev-parse','HEAD']),real_model_calls:0}));}finally{fs.rmSync(root,{recursive:true,force:true});}
}
if(require.main===module)try{run();}catch{console.error('BLOCKED_R52_SOURCE_CONFORMANCE');process.exitCode=1;}
module.exports={run};
