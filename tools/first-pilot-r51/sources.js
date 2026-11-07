#!/usr/bin/env node
'use strict';
const {execFileSync}=require('node:child_process'),path=require('node:path'),M=require('./sources.json'),cwd=path.resolve(__dirname,'../..');
const git=args=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const tree=sha=>new Map(git(['ls-tree','-r','-z',sha]).split('\0').filter(Boolean).map(x=>{const tab=x.indexOf('\t');return [x.slice(tab+1),x.slice(0,tab)];}));
function verify(){const head=git(['rev-parse','HEAD']),current=tree(head),base=tree(M.base_sha),violations=[];git(['merge-base','--is-ancestor',M.base_sha,head]);for(const [file,blob] of base)if(current.get(file)!==blob){const x=M.exceptions[file];if(!x||x.from!==blob||x.to!==current.get(file))violations.push('R49_CHANGED:'+file);}
 let r50Paths=[];if(M.r50){if(git(['rev-parse',M.r50.head+'^'])!==M.r50.parent)throw Error('R50_PARENT_CHANGED');const t=tree(M.r50.head);r50Paths=git(['diff','--name-only','-z',M.base_sha,M.r50.head]).split('\0').filter(Boolean);for(const f of r50Paths)if(!M.r50.prefixes.some(p=>f.startsWith(p))||base.has(f)||current.get(f)!==t.get(f))violations.push('R50_SOURCE_OR_SCOPE_CHANGED:'+f);}
 const own=['tools/first-pilot-r51/','tests/first-pilot-r51/','docs/FIRST-PILOT-R51.md','.github/workflows/codex-r51-pilot.yml'];for(const f of git(['diff','--name-only','-z',M.base_sha,head]).split('\0').filter(Boolean))if(!base.has(f)&&!r50Paths.includes(f)&&!own.some(p=>f.startsWith(p)))violations.push('UNOWNED_PATH:'+f);
 git(['diff','--quiet','HEAD']);return {head_sha:head,tree:git(['rev-parse','HEAD^{tree}']),base_sha:M.base_sha,state:violations.length?'BLOCKED':'PRESERVED_WITH_PROPOSED_R51_SEAMS',exceptions:M.exceptions,r50:M.r50||'WAIT_R50',r50_paths:r50Paths.length,violations,real_agent_launches:0,real_schedule:'NOT_ENABLED'};}
if(require.main===module)try{const r=verify();console.log(JSON.stringify(r,null,2));if(r.violations.length)process.exitCode=1;}catch{console.log(JSON.stringify({state:'BLOCKED',reason:'SOURCE_PARENT_SCOPE_OR_WORKING_TREE_CHANGED'}));process.exitCode=1;}
module.exports={verify};
