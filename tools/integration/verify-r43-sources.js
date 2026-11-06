#!/usr/bin/env node
'use strict';
// Read-only provenance check for this frozen integration package. No Agent/API calls.
const {execFileSync}=require('node:child_process');
const path=require('node:path');
const cwd=path.resolve(__dirname,'../..');
const BASE='58c52f0084997f669eea763edc7b58e11d3ef4f4';
const SOURCES={product:'b377d427e6a018dc03fbf01c6ec1db40be156b4c',automation:'e891978b46490bccf2c2282df24c8e7b2f4ced42'};
// The sole coupled test fix is pinned by both old and new blob, not a path wildcard.
const COUPLED_TEST_FIXES={
 'tests/ui/claude-delivery.e2e.js':{from:'100644 blob 9f532302c13c45a28bcf5a29153360edac10037f',to:'100644 blob cd143f86f5fd8df7a74257f4c9e3e1e4da831138',reason:'Render identical downloaded SVG over local HTTP; retain all node and XSS assertions'}
};
const git=(args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
function tree(sha){
 const result=new Map();
 for(const record of git(['ls-tree','-r','-z',sha]).split('\0').filter(Boolean)){
  const tab=record.indexOf('\t');if(tab<0)throw Error('INVALID_GIT_TREE');
  result.set(record.slice(tab+1),record.slice(0,tab));
 }
 return result;
}
function verify(){
 const head=git(['rev-parse','HEAD']).trim(),headTree=git(['rev-parse','HEAD^{tree}']).trim(),current=tree(head);
 if(git(['merge-base',...Object.values(SOURCES)]).trim()!==BASE)throw Error('SOURCE_BASE_CHANGED');
 const violations=[],evidence=[],reviewed_test_fixes=[];
 for(const [name,sha] of Object.entries(SOURCES)){
  git(['merge-base','--is-ancestor',sha,head]);
  const source=tree(sha);
  const paths=git(['diff','--name-only','-z',BASE,sha]).split('\0').filter(p=>p&&!/^(?:docs|collab|\.github)\//.test(p));
  for(const file of paths)if(current.get(file)!==source.get(file)){
   const fix=COUPLED_TEST_FIXES[file];
   if(fix&&source.get(file)===fix.from&&current.get(file)===fix.to)reviewed_test_fixes.push({source:name,file,...fix});
   else violations.push({source:name,file,reason:'SOURCE_BLOB_OR_MODE_CHANGED'});
  }
  // Also check actual local tested bytes, rather than only the committed tree.
  if(paths.length)git(['diff','--no-ext-diff','--quiet','HEAD','--',...paths]);
  evidence.push({source:name,sha,checked_paths:paths.length});
 }
 return {schema:1,state:violations.length?'BLOCKED':reviewed_test_fixes.length?'PRESERVED_WITH_REVIEWED_TEST_FIX':'PRESERVED',head_sha:head,tree:headTree,merge_base:BASE,sources:evidence,reviewed_test_fixes,violations,real_dispatch:false,actual_agent_launches:0,cost:'NOT_VERIFIED'};
}
try{const report=verify();console.log(JSON.stringify(report,null,2));if(report.violations.length)process.exitCode=1;}catch{console.log(JSON.stringify({state:'BLOCKED',reason:'SOURCE_VERIFICATION_UNAVAILABLE_OR_WORKING_TREE_CHANGED',real_dispatch:false,actual_agent_launches:0}));process.exitCode=1;}
