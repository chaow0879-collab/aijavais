#!/usr/bin/env node
'use strict';
const {execFileSync}=require('node:child_process'),path=require('node:path'),M=require('./sources.json'),cwd=path.resolve(__dirname,'../..');
const git=args=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const tree=ref=>new Map(git(['ls-tree','-r','-z',ref]).split('\0').filter(Boolean).map(r=>{const i=r.indexOf('\t');return [r.slice(i+1),r.slice(0,i)];}));
function verify(){const head=git(['rev-parse','HEAD']).trim(),actual=tree(head),base=tree(M.base),expected=new Map(base),violations=[];git(['merge-base','--is-ancestor',M.base,head]);
 for(const source of [M.r44,M.r52].filter(Boolean)){const original=tree(source.head);git(['merge-base','--is-ancestor',source.base,source.head]);for(const p of git(['diff','--name-only','-z',source.base,source.head]).split('\0').filter(Boolean)){if(original.has(p))expected.set(p,original.get(p));else expected.delete(p);}}
 for(const [p,b]of Object.entries(M.backend)){if((base.get(p)||null)!==b.from)violations.push('BACKEND_BASE_CHANGED:'+p);expected.set(p,b.to);}
 const own=p=>['tools/universal-workflow-r53/','tests/universal-workflow-r53/','docs/UNIVERSAL-WORKFLOW-R53.md','.github/workflows/codex-r53-universal.yml'].some(prefix=>p.startsWith(prefix));
 for(const [p,b]of expected)if(!own(p)&&actual.get(p)!==b)violations.push('SOURCE_BLOB_OR_MODE_CHANGED:'+p);
 for(const p of actual.keys())if(!expected.has(p)&&!own(p))violations.push('UNOWNED_PATH:'+p);
 git(['diff','--quiet','HEAD']);return {head_sha:head,base_sha:M.base,r44:M.r44,r52:M.r52||'WAIT_R52',backend:M.backend,violations,state:violations.length?'BLOCKED':'PRESERVED_WITH_R53_BACKEND_DELTAS_PENDING_REVIEW',real_model_launches:0};
}
if(require.main===module)try{const r=verify();console.log(JSON.stringify(r,null,2));if(r.violations.length)process.exitCode=1;}catch{console.log(JSON.stringify({state:'BLOCKED',reason:'SOURCE_OR_WORKING_TREE_NOT_VERIFIABLE'}));process.exitCode=1;}
module.exports={verify};
