'use strict';
const {execFileSync}=require('node:child_process'),path=require('node:path'),M=require('./sources.json');
const root=path.resolve(__dirname,'../..'),git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const POST_R57=Object.freeze({base:'049a3376a2d08042fcac1833b324bc87b0137ba1',changes:Object.freeze({
  "AGENTS.md":{from:"100644 blob 784c6bc3d30d03a64b6512f6d4e908adbde815c0",to:null,reason:"cleanup: obsolete Codex/ChatGPT-era handoff or legacy doc, superseded by CLAUDE.md + #20 (owner decision 2026-11-09)"},
  "CLAUDE.md":{from:"100644 blob 9740136ae5e6cf6c57662756a837339b74c23f29",to:"100644 blob a85d8c666005621c4fa46b70cc48ae5dbc476afc",reason:"governance: Claude supreme commander, full planning authority (owner decisions 2026-11-09)"},
  "README.md":{from:"100644 blob 26aed375f5795eda89b695037312d5b9e13336d7",to:"100644 blob 21a8a5aa1f419b95e3c64ed98a1f8d5133a46f31",reason:"docs: point to CLAUDE.md and #20 instead of removed handoff"},
  "collab/ACTIVE-DEVELOPMENT.md":{from:"100644 blob 6a630b8941f2cd2cf5c9e58072f8becf1b463664",to:null,reason:"cleanup: obsolete Codex/ChatGPT-era handoff or legacy doc, superseded by CLAUDE.md + #20 (owner decision 2026-11-09)"},
  "collab/HANDOFF.md":{from:"100644 blob 3f300723be9115ea576ca8c62ccddf9a4b666c68",to:null,reason:"cleanup: obsolete Codex/ChatGPT-era handoff or legacy doc, superseded by CLAUDE.md + #20 (owner decision 2026-11-09)"},
  "collab/README.md":{from:"100644 blob cf296ad6e88143b282cf32cd6fb648604801e89b",to:null,reason:"cleanup: obsolete Codex/ChatGPT-era handoff or legacy doc, superseded by CLAUDE.md + #20 (owner decision 2026-11-09)"},
  "collab/handoffs/codex-to-claude-code.md":{from:"100644 blob 5cda29c1ccf1aa4a00391f155badcc57689a14ca",to:null,reason:"cleanup: obsolete Codex/ChatGPT-era handoff or legacy doc, superseded by CLAUDE.md + #20 (owner decision 2026-11-09)"},
  "collab/handoffs/current.md":{from:"100644 blob 45de530eb52181f63f9ae993af24ba21716b7787",to:null,reason:"cleanup: obsolete Codex/ChatGPT-era handoff or legacy doc, superseded by CLAUDE.md + #20 (owner decision 2026-11-09)"},
  "collab/inbox/claude/.gitkeep":{from:"100644 blob e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",to:null,reason:"cleanup: obsolete Codex/ChatGPT-era handoff or legacy doc, superseded by CLAUDE.md + #20 (owner decision 2026-11-09)"},
  "collab/inbox/openai/20261105-claude-to-openai-batch2-review-request.md":{from:"100644 blob 175786f1226acbd4614b9c38ec7406fd6620ad43",to:null,reason:"cleanup: obsolete Codex/ChatGPT-era handoff or legacy doc, superseded by CLAUDE.md + #20 (owner decision 2026-11-09)"},
  "collab/inbox/openai/20261105-claude-to-openai-phase3-review-request.md":{from:"100644 blob 1d56a8551b62d2429615f0c268f313f7b291221f",to:null,reason:"cleanup: obsolete Codex/ChatGPT-era handoff or legacy doc, superseded by CLAUDE.md + #20 (owner decision 2026-11-09)"},
  "collab/reviews/review-203b6c3.md":{from:"100644 blob cabbac788ca9037669361cec603fa1ca93ec915f",to:null,reason:"cleanup: obsolete Codex/ChatGPT-era handoff or legacy doc, superseded by CLAUDE.md + #20 (owner decision 2026-11-09)"},
  "collab/roles/code-audit.md":{from:null,to:"100644 blob c4b4b680c81856e0a8f025c571cb18093f9f587c",reason:"governance: independent audit session prompt"},
  "collab/roles/product-qa.md":{from:null,to:"100644 blob a6b0c34599d336818f1cafd1f7b82e77c745d291",reason:"governance: independent product QA session prompt"},
  "collab/roles/server-ops.md":{from:null,to:"100644 blob 660933ff4fcc9087249f9874e85be025e2ac1ce0",reason:"governance: server operations (aiops sudo, dispatch and discipline)"},
  "public/haloflux-workbench-r52/app.js":{from:"100644 blob a6652e82e2b678710f87107207a49652370a7a96",to:"100644 blob e6f73a18ec8b5d8d0534df96a7f22440e028ef1b",reason:"AUD-R55-01: own-property permission lookup"},
  "public/haloflux-workbench-r52/projector.js":{from:"100644 blob 93d1fcc526864ee5354948a3f829db2b14281903",to:"100644 blob 6db633c571fca8c2b4794c154c1be693a413c8a2",reason:"AUD-R55-01: null-prototype role/cost dictionaries"},
  "tests/audit-fixes/r57-gate-fixes.test.js":{from:null,to:"100644 blob c36b8487aa5099ddaefbd71a726b7b012b2fccc5",reason:"regressions for every R57 and BC72 audit counterexample"},
  "tests/event-handoff-r56/github-emulator.cjs":{from:"100644 blob bdeed52c0f2ec4a06f50360e807bf786e738c30b",to:"100644 blob c2a6cc924e85e31c6122e1be1537b38f91d73596",reason:"emulator returns total_count for runs and jobs like GitHub"},
  "tests/event-handoff-r56/handoff.test.js":{from:"100644 blob a9c79c7e2b44ab18ef4f2e8e612e8c018626fee0",to:"100644 blob 1048577b769fbdc2f93d9c3c745841c93e840f9a",reason:"E2 fixture carries the now-required CI fields"},
  "tests/event-handoff-r56/world.cjs":{from:"100644 blob 707abaaf6e6bc2d0f1144c0af85c59b08fc586ac",to:"100644 blob c71fbd6aa809d4b1852343ebfab6b60402ebf4c7",reason:"fixtures carry workflow_id/run_attempt/job status now required by the gate"},
  "tests/haloflux-workbench-r52/workbench.test.js":{from:"100644 blob 854003e6f5acb3a70da6d8a81a7b41ba4ceb134c",to:"100644 blob 8526a008bfcc2eccf5e6479e344df5f732cf42cf",reason:"AUD-BC72-06: assert the real R53 run_cancelled{server_shutdown} event instead of the pre-R53 gap"},
  "tools/event-handoff-r56/facts.js":{from:"100644 blob aabe99ab7d2b16ec2eb368d8f4195a43d5153b94",to:"100644 blob a466d43a098a4ebef93df1b5ef79a30d06ab8cb6",reason:"AUD-R57-01/AUD-BC72-01..03: every run latest attempt green; unknown fields block"},
  "tools/event-handoff-r56/github.js":{from:"100644 blob c68869e17fda46fe3ae5b679576ac23d1b917b64",to:"100644 blob 5b6f531082369572bb13d4f5fd9d1289a9758475",reason:"AUD-R57-01/AUD-BC72-03: keep run/job identity and completeness; run-list total_count check"},
  "tools/event-handoff-r56/machine.js":{from:"100644 blob 6e58b656cbe14cbc0f9be34e560925c16b838055",to:"100644 blob d62f4d8307b1c7e5f6c0f5116094f9579b2dfa40",reason:"AUD-R57-01: surface ci_problem in WAIT_CI decisions"},
  "使用说明.md":{from:"100644 blob fe8b8f272f63368e0875438c6fcfc345ddbbc6da",to:null,reason:"cleanup: obsolete Codex/ChatGPT-era handoff or legacy doc, superseded by CLAUDE.md + #20 (owner decision 2026-11-09)"},
  "部署到Render.md":{from:"100644 blob a7d74c3c6519ca6fea4254ad76fb702f242ff1fd",to:null,reason:"cleanup: obsolete Codex/ChatGPT-era handoff or legacy doc, superseded by CLAUDE.md + #20 (owner decision 2026-11-09)"},
})});
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
 // Post-R57 changes (single-developer era, AUD-BC72-05): the allowed paths and BOTH their base (`from`)
 // and resulting (`to`) blobs are hard-coded here, not read from editable data. Undeclared paths, base or
 // result mismatches and undeclared deletions stay violations. This list is author-declared: it records
 // what changed; independent acceptance still comes only from the independent audit (#2).
 git(['merge-base','--is-ancestor',POST_R57.base,head]);const post=tree(POST_R57.base);
 for(const p of git(['diff','--name-only','-z',POST_R57.base,head]).split('\0').filter(Boolean)){
  const d=POST_R57.changes[p];
  if(!d){if(!['tools/unattended-go-r57/','tests/unattended-go-r57/','docs/UNATTENDED-GO-R57.md','.github/workflows/codex-r57-unattended.yml'].some(x=>p===x||x.endsWith('/')&&p.startsWith(x)))violations.push('POST_R57_UNDECLARED:'+p);continue;}
  if((post.get(p)||null)!==d.from)violations.push('POST_R57_BASE_MISMATCH:'+p);
  if((actual.get(p)||null)!==d.to)violations.push('POST_R57_BLOB_MISMATCH:'+p);
  if(d.to===null)expected.delete(p);else expected.set(p,d.to);
 }
 const own=p=>['tools/unattended-go-r57/','tests/unattended-go-r57/','docs/UNATTENDED-GO-R57.md','.github/workflows/codex-r57-unattended.yml'].some(x=>p===x||x.endsWith('/')&&p.startsWith(x));
 for(const [p,v]of expected)if(!own(p)&&actual.get(p)!==v)violations.push('SOURCE_BLOB_OR_MODE_CHANGED:'+p);
 for(const p of actual.keys())if(!expected.has(p)&&!own(p))violations.push('UNOWNED_PATH:'+p);
 git(['diff','--quiet','HEAD']);return {head_sha:head,tree_sha:git(['rev-parse','HEAD^{tree}']),base_sha:M.base,r56:M.r56,exceptions:M.deltas,violations,review:'AUTHOR_CANDIDATE_NOT_INDEPENDENT_ACCEPT',real_model_calls:0};
}
if(require.main===module)try{const r=verify();console.log(JSON.stringify(r,null,2));process.exitCode=r.violations.length?1:0;}catch{console.log(JSON.stringify({state:'BLOCKED',reason:'UNVERIFIABLE_SOURCE'}));process.exitCode=1;}
module.exports={verify,POST_R57};
