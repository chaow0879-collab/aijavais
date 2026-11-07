#!/usr/bin/env node
'use strict';
// Exact source selection, including explicit pending-review runtime deltas.
// Does not infer independent ACCEPT from hashes or a green CI.
const {execFileSync}=require('node:child_process'),path=require('node:path');
const M=require('./sources.json'),cwd=path.resolve(__dirname,'../..');
const git=args=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const listing=sha=>new Map(git(['ls-tree','-r','-z',sha]).split('\0').filter(Boolean).map(x=>{const i=x.indexOf('\t');return [x.slice(i+1),x.slice(0,i)];}));
function verify(){
 const sha=git(['rev-parse','HEAD']),current=listing(sha),violations=[],sources=[];
 git(['merge-base','--is-ancestor',M.base_sha,sha]);
 try{git(['merge-base','--is-ancestor',M.excluded_r44,sha]);violations.push('R44_ANCESTRY_POLLUTION');}catch{}
 const check=(from,files,source)=>{for(const file of files){const actual=current.get(file),expected=from.get(file),exception=M.exceptions[file];if(actual===expected)continue;if(!exception||exception.from!==expected||exception.to!==actual)violations.push(source+':'+file);}};
 check(listing(M.base_sha),[...listing(M.base_sha).keys()],'R47_BASE');
 for(const [name,s] of Object.entries(M.selected)){
  if(git(['rev-parse',s.head+'^'])!==s.parent)throw Error('SOURCE_PARENT_MISMATCH');
  const files=git(['diff','--name-only','-z',s.base,s.head]).split('\0').filter(Boolean);
  if(files.some(f=>!s.prefixes.some(p=>f.startsWith(p))))throw Error('SOURCE_SCOPE_MISMATCH');
  check(listing(s.head),files,name);sources.push({name,...s,checked_files:files.length});
 }
 const ownPrefixes=['tools/first-handoff-r49/','tests/first-handoff-r49/','docs/FIRST-REAL-HANDOFF-R49.md','.github/workflows/codex-r49-integration.yml'];
 const selected=new Set(sources.flatMap(s=>git(['diff','--name-only','-z',s.base,s.head]).split('\0').filter(Boolean)));
 const changed=git(['diff','--name-only','-z',M.base_sha,sha]).split('\0').filter(Boolean);
 for(const f of changed)if(!selected.has(f)&&!M.exceptions[f]&&!ownPrefixes.some(p=>f.startsWith(p)))violations.push('UNOWNED_PATH:'+f);
 git(['diff','--quiet','HEAD']);
 return {head_sha:sha,tree:git(['rev-parse','HEAD^{tree}']),state:violations.length?'BLOCKED':'SOURCE_PRESERVED_WITH_PENDING_REVIEW_DELTAS',sources,exceptions:M.exceptions,violations,r48:M.r48||'WAIT_R48',r47_independent_gate:'NOT_INFERRED_FROM_AUTHOR_CODE',real_agent_launches:0,schedule:'NOT_ENABLED'};
}
if(require.main===module)try{const r=verify();console.log(JSON.stringify(r,null,2));if(r.violations.length)process.exitCode=1;}catch{console.log(JSON.stringify({state:'BLOCKED',reason:'SOURCE_TREE_PARENT_OR_WORKING_BYTES_MISMATCH',real_agent_launches:0}));process.exitCode=1;}
module.exports={verify};
