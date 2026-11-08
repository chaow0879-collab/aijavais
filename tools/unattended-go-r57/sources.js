'use strict';
const {execFileSync}=require('node:child_process'),path=require('node:path'),M=require('./sources.json');
const root=path.resolve(__dirname,'../..'),git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const tree=ref=>new Map(git(['ls-tree','-r','-z',ref]).split('\0').filter(Boolean).map(l=>{const n=l.indexOf('\t');return [l.slice(n+1),l.slice(0,n)];}));
function verify(){
 const head=git(['rev-parse','HEAD']),base=tree(M.base),expected=new Map(base),actual=tree(head),violations=[];
 git(['merge-base','--is-ancestor',M.base,head]);
 if(M.r56){git(['merge-base','--is-ancestor',M.base,M.r56.head]);const source=tree(M.r56.head);
  for(const p of git(['diff','--name-only','-z',M.base,M.r56.head]).split('\0').filter(Boolean)){
   if(!['tools/event-handoff-r56/','tests/event-handoff-r56/','docs/EVENT-HANDOFF-R56.md','.github/workflows/claude-r56-event-handoff.yml'].some(x=>p===x||x.endsWith('/')&&p.startsWith(x)))violations.push('R56_OUT_OF_SCOPE:'+p);
   if(source.has(p))expected.set(p,source.get(p));else expected.delete(p);
  }
 }
 for(const [p,d]of Object.entries(M.deltas)){
  if(p!=='tools/first-pilot-r51/r50-bridge.js'||base.get(p)!==d.from)violations.push('UNEXPECTED_RUNTIME_EXCEPTION:'+p);
  expected.set(p,d.to);
 }
 const own=p=>['tools/unattended-go-r57/','tests/unattended-go-r57/','docs/UNATTENDED-GO-R57.md','.github/workflows/codex-r57-unattended.yml'].some(x=>p===x||x.endsWith('/')&&p.startsWith(x));
 for(const [p,v]of expected)if(!own(p)&&actual.get(p)!==v)violations.push('SOURCE_BLOB_OR_MODE_CHANGED:'+p);
 for(const p of actual.keys())if(!expected.has(p)&&!own(p))violations.push('UNOWNED_PATH:'+p);
 git(['diff','--quiet','HEAD']);return {head_sha:head,tree_sha:git(['rev-parse','HEAD^{tree}']),base_sha:M.base,r56:M.r56,exceptions:M.deltas,violations,review:'AUTHOR_CANDIDATE_NOT_INDEPENDENT_ACCEPT',real_model_calls:0};
}
if(require.main===module)try{const r=verify();console.log(JSON.stringify(r,null,2));process.exitCode=r.violations.length?1:0;}catch{console.log(JSON.stringify({state:'BLOCKED',reason:'UNVERIFIABLE_SOURCE'}));process.exitCode=1;}
module.exports={verify};
