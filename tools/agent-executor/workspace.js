'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {reject}=require('./policy');
const instances=new WeakSet();
function git(args,cwd){return execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd,encoding:'utf8',timeout:15000,maxBuffer:1048576,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}}).trim();}
function prepare(source,branch,sha){
 if(process.platform!=='linux'||!/^(?:feat|fix|test)\/[A-Za-z0-9_./-]+$/.test(branch)||branch.includes('..')||!/^[a-f0-9]{40}$/.test(sha))reject('INVALID_WORKSPACE');
 source=path.resolve(source);const st=fs.lstatSync(source);if(!st.isDirectory()||st.isSymbolicLink())reject('INVALID_WORKSPACE');
 if(git(['rev-parse','HEAD'],source)!==sha||git(['status','--porcelain=v1'],source))reject('SOURCE_NOT_PINNED_CLEAN');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-isolated-')),dir=path.join(root,'repo');
 try{git(['clone','--no-hardlinks','--no-checkout','--',source,dir],root);git(['switch','--detach',sha],dir);git(['switch','-c',branch],dir);if(git(['rev-parse','HEAD'],dir)!==sha)reject('WORKSPACE_SHA_MISMATCH');}catch{fs.rmSync(root,{recursive:true,force:true});reject('WORKSPACE_PREPARATION_FAILED');}
 const out=Object.freeze({root,dir,branch,sha});instances.add(out);return out;
}
function health(instance){if(!instances.has(instance))reject('UNKNOWN_WORKSPACE');return {sha:git(['rev-parse','HEAD'],instance.dir),clean:git(['status','--porcelain=v1'],instance.dir)==='',isolated:true};}
function cleanup(instance){if(!instances.has(instance))reject('UNKNOWN_WORKSPACE');fs.rmSync(instance.root,{recursive:true,force:true});instances.delete(instance);}
function verifyChanges(instance,role,allowedPaths=[]){
 if(!instances.has(instance)||!Array.isArray(allowedPaths)||allowedPaths.some(p=>typeof p!=='string'||p.startsWith('/')||p.includes('..')||p.startsWith('.git')))reject('INVALID_FILE_SCOPE');
 const paths=[...git(['diff','--name-only','-z','HEAD'],instance.dir).split('\0'),...git(['ls-files','--others','--exclude-standard','-z'],instance.dir).split('\0')].filter(Boolean);
 if(paths.some(p=>role==='audit'||(role==='qa'&&!p.startsWith('tests/'))||!allowedPaths.some(prefix=>p===prefix||p.startsWith(prefix.endsWith('/')?prefix:prefix+'/'))))reject('WORKSPACE_SCOPE_VIOLATION');
 return true;
}
module.exports={prepare,health,cleanup,verifyChanges};
