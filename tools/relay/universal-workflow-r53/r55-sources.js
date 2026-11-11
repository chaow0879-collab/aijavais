#!/usr/bin/env node
'use strict';
const {execFileSync}=require('node:child_process'),path=require('node:path'),M=require('./r55-sources.json'),cwd=path.resolve(__dirname,'../..');
const git=args=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const tree=ref=>new Map(git(['ls-tree','-r','-z',ref]).split('\0').filter(Boolean).map(r=>{const i=r.indexOf('\t');return [r.slice(i+1),r.slice(0,i)];}));
function verify(){const head=git(['rev-parse','HEAD']).trim(),base=tree(M.base),expected=new Map(base),actual=tree(head),violations=[];git(['merge-base','--is-ancestor',M.base,head]);
 if(M.r54){git(['merge-base','--is-ancestor',M.r54.base,M.r54.head]);const source=tree(M.r54.head);for(const p of git(['diff','--name-only','-z',M.r54.base,M.r54.head]).split('\0').filter(Boolean)){
  if(!['public/project-intake.html','public/project-intake/','public/haloflux-workbench-r52/','tests/haloflux-workbench-r54/','tests/haloflux-workbench-r52/','docs/UNIVERSAL-WORKBENCH-R54.md','.github/workflows/claude-r54-workbench.yml'].some(x=>p===x||x.endsWith('/')&&p.startsWith(x)))violations.push('R54_OUT_OF_SCOPE:'+p);
  if(source.has(p))expected.set(p,source.get(p));else expected.delete(p);
 }}
 for(const [p,b]of Object.entries(M.deltas)){if((base.get(p)||null)!==b.from)violations.push('BASE_CHANGED:'+p);expected.set(p,b.to);}
 const own=p=>['tools/universal-workflow-r53/','tests/universal-workflow-r53/','tests/security-r55/','docs/SECURITY-PRODUCT-R55.md','.github/workflows/codex-r55-unified.yml'].some(x=>p===x||x.endsWith('/')&&p.startsWith(x));
 for(const [p,b]of expected)if(!own(p)&&actual.get(p)!==b)violations.push('SOURCE_BLOB_OR_MODE_CHANGED:'+p);
 for(const p of actual.keys())if(!expected.has(p)&&!own(p))violations.push('UNOWNED_PATH:'+p);
 git(['diff','--quiet','HEAD']);return {head_sha:head,tree:git(['rev-parse','HEAD^{tree}']).trim(),base_sha:M.base,r54:M.r54||'WAIT_R54',deltas:M.deltas,violations,state:violations.length?'BLOCKED':'PRESERVED_WITH_R55_DELTAS_PENDING_INDEPENDENT_REVIEW',real_model_calls:0};
}
if(require.main===module)try{const r=verify();console.log(JSON.stringify(r,null,2));if(r.violations.length)process.exitCode=1;}catch{console.log(JSON.stringify({state:'BLOCKED',reason:'SOURCE_OR_WORKING_TREE_UNVERIFIABLE'}));process.exitCode=1;}
module.exports={verify};
