'use strict';
// Keep server-reported source_sha bound to the reviewed business SHA, not the QA commit.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const SHA='049a3376a2d08042fcac1833b324bc87b0137ba1',ROOT=path.resolve(__dirname,'../..');
if(!process.env.QA57_BUSINESS_ROOT){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qa57-subject-')),repo=path.join(dir,'repo');const git=(args,cwd)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();git(['clone','--quiet','--no-hardlinks','--no-checkout','--',ROOT,repo],dir);git(['checkout','--quiet','--detach',SHA],repo);if(git(['rev-parse','HEAD'],repo)!==SHA||git(['status','--porcelain'],repo))throw Error('SUBJECT_NOT_PINNED_CLEAN');process.env.QA57_BUSINESS_ROOT=repo;process.once('exit',()=>fs.rmSync(dir,{recursive:true,force:true}));}
const verifiedRoot=process.env.QA57_BUSINESS_ROOT;for(const [args,expected] of [[['rev-parse','HEAD'],SHA],[['status','--porcelain'],'']])if(execFileSync('git',args,{cwd:verifiedRoot,encoding:'utf8'}).trim()!==expected)throw Error('SUBJECT_NOT_PINNED_CLEAN');
module.exports=verifiedRoot;
