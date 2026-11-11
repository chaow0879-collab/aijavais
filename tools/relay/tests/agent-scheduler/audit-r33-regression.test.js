'use strict';
// Regression for the independent CodeAudit REJECT of 1e7b092 (#2 comment 6677345745):
// AUD-33-SCH-01 (P1), AUD-33-SCH-02 (P1), AUD-33-SCH-03 (P2). Each auditor minimal
// reproduction is kept verbatim, followed by adjacent negative AND legitimate positive
// cases so the fixes cannot silently block valid authorizations, matrix jobs or leases.
// Offline only: no --live, no GitHub, no Agent; actual_dispatch must stay false.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {evaluate}=require('../../agent-scheduler/state');
const {PlanStore}=require('../../agent-scheduler/lease');
const F=require('./fixtures.cjs');
const OTHER_BASE='7'.repeat(40);
const run=(mutate,config=F.config)=>{const s=F.positive();mutate(s);return evaluate(s,config);};
const ready=r=>{assert.equal(r.state,'READY_FOR_HUMAN_GATE',JSON.stringify(r.missing_gates));assert.equal(r.actual_dispatch,false);assert.deepEqual(r.would_dispatch,[]);};
const blocked=(r,gate)=>{assert.notEqual(r.state,'READY_FOR_HUMAN_GATE');assert.equal(r.actual_dispatch,false);assert.deepEqual(r.would_dispatch,[]);assert.ok(r.missing_gates.length);if(gate)assert.match(r.missing_gates[0],gate);};
const grant=f=>F.comment('planner',f,'PLANNER_DECISION_V1');
const later=(c,minutes)=>({...c,created_at:new Date(Date.UTC(2026,10,6,1,minutes)).toISOString()});
// Remove the fixture's exact grant for a role so only the decisions under test remain.
const dropGrant=(s,role)=>{s.issues[10].comments=s.issues[10].comments.filter(c=>!c.body.includes('authorized_role: '+role+'\n'));};
const addField=(s,issue,field,value,login)=>{const c=s.issues[issue].comments.find(x=>!login||x.user.login===login);c.body=c.body.replace(/\[\/AGENT_REPORT_V1\]$/,field+': '+value+'\n[/AGENT_REPORT_V1]');};

// ================= AUD-33-SCH-01: candidate/base binding =================
test('AUDITOR R33 probe: other-candidate grant with the same base never authorizes codex',()=>{
 const s=F.positive();
 s.issues[10].comments=s.issues[10].comments.filter(c=>!c.body.includes('authorized_role: codex\n'));
 s.issues[10].comments.push(F.comment('planner',{authorized_role:'codex',issue:15,branch:'codex',approved:true,candidate_sha:F.sha(9),base_sha:F.BASE},'PLANNER_DECISION_V1'));
 const r=evaluate(s,F.config);blocked(r,/NO_PLANNER_AUTHORIZATION_15/);
});
// Per-role matrix. Integration reports carry no base in the fixture; give it one so that
// base-bound cases are meaningful for the integrator too (as the auditor did).
const ROLES=[['codex',15,'codex',F.sha(1),/NO_PLANNER_AUTHORIZATION_15/],['claude',17,'claude',F.sha(2),/NO_PLANNER_AUTHORIZATION_17/],['integrator',10,'integration',F.sha(3),/INTEGRATION_NOT_VERIFIED/]];
const prep=(s,role)=>{if(role==='integrator')addField(s,10,'base_sha',F.BASE,'integrator');dropGrant(s,role);};
for(const [role,issue,branch,head,gate] of ROLES){
 const g=f=>grant({authorized_role:role,issue,branch,approved:true,...f});
 test(`SCH-01/${role}: wrong candidate + right base is not an authorization`,()=>blocked(run(s=>{prep(s,role);s.issues[10].comments.push(g({candidate_sha:F.sha(9),base_sha:F.BASE}));}),gate));
 test(`SCH-01/${role}: right candidate + wrong base (inconsistent) is not an authorization`,()=>blocked(run(s=>{prep(s,role);s.issues[10].comments.push(g({candidate_sha:head,base_sha:OTHER_BASE}));}),gate));
 test(`SCH-01/${role}: right candidate + malformed base is not an authorization`,()=>blocked(run(s=>{prep(s,role);s.issues[10].comments.push(g({candidate_sha:head,base_sha:'abc'}));}),gate));
 test(`SCH-01/${role}: POSITIVE candidate and base both consistent`,()=>ready(run(s=>{prep(s,role);s.issues[10].comments.push(g({candidate_sha:head,base_sha:F.BASE}));})));
 test(`SCH-01/${role}: POSITIVE legitimate base-only package grant`,()=>ready(run(s=>{prep(s,role);s.issues[10].comments.push(g({base_sha:F.BASE}));})));
 test(`SCH-01/${role}: POSITIVE candidate-only grant`,()=>ready(run(s=>{prep(s,role);s.issues[10].comments.push(g({candidate_sha:head}));})));
 test(`SCH-01/${role}: newer revocation of ANOTHER candidate sharing the base does not revoke this one`,()=>ready(run(s=>{prep(s,role);s.issues[10].comments.push(g({candidate_sha:head}),grant({authorized_role:role,issue,branch,approved:false,status:'REVOKED',candidate_sha:F.sha(9),base_sha:F.BASE}));})));
 test(`SCH-01/${role}: newer base-only revocation revokes every candidate on that base`,()=>blocked(run(s=>{prep(s,role);s.issues[10].comments.push(g({candidate_sha:head}),grant({authorized_role:role,issue,branch,approved:false,status:'REVOKED',base_sha:F.BASE}));}),gate));
 test(`SCH-01/${role}: exact-candidate revocation is not revived by an OLDER base-only grant`,()=>blocked(run(s=>{prep(s,role);s.issues[10].comments.push(later(g({base_sha:F.BASE}),1),later(grant({authorized_role:role,issue,branch,approved:false,status:'REVOKED',candidate_sha:head}),2));}),gate));
 test(`SCH-01/${role}: POSITIVE explicit NEWER re-authorization after the revocation`,()=>ready(run(s=>{prep(s,role);s.issues[10].comments.push(later(grant({authorized_role:role,issue,branch,approved:false,status:'REVOKED',candidate_sha:head}),1),later(g({candidate_sha:head,base_sha:F.BASE}),2));})));
 test(`SCH-01/${role}: other-candidate decision is ordered out even when newest`,()=>ready(run(s=>{prep(s,role);s.issues[10].comments.push(later(g({candidate_sha:head}),1),later(g({candidate_sha:F.sha(9),base_sha:F.BASE}),2));})));
}
for(const [role,issue,branch,gate] of [['audit',2,'integration',/AUDIT_SHA_OR_PHASE_MISMATCH/],['qa',4,'qa-test',/QA_SHA_CI_OR_T2/]]){
 const g=f=>grant({authorized_role:role,issue,branch,approved:true,...f});
 test(`SCH-01/${role}: other candidate + base is not an authorization`,()=>blocked(run(s=>{dropGrant(s,role);s.issues[10].comments.push(g({candidate_sha:F.sha(9),base_sha:F.BASE}));}),gate));
 test(`SCH-01/${role}: base-only never authorizes a final gate`,()=>blocked(run(s=>{dropGrant(s,role);s.issues[10].comments.push(g({base_sha:F.BASE}));}),gate));
 test(`SCH-01/${role}: exact reviewed SHA + a base the report does not carry is inconsistent`,()=>blocked(run(s=>{dropGrant(s,role);s.issues[10].comments.push(g({candidate_sha:F.sha(3),base_sha:F.BASE}));}),gate));
 test(`SCH-01/${role}: POSITIVE exact reviewed SHA only`,()=>ready(run(s=>{dropGrant(s,role);s.issues[10].comments.push(g({candidate_sha:F.sha(3)}));})));
}
test('SCH-01/E4-E5: other-candidate trials approval with a base never applies; positives still pass',()=>{
 const drop=s=>{s.issues[10].comments=s.issues[10].comments.filter(c=>!c.body.includes('human_trials_approved'));};
 blocked(run(s=>{drop(s);s.issues[10].comments.push(grant({human_trials_approved:true,candidate_sha:F.sha(9),base_sha:F.BASE}));}),/E4_E5/);
 blocked(run(s=>{drop(s);s.issues[10].comments.push(grant({human_trials_approved:true,base_sha:F.BASE}));}),/E4_E5/);
 blocked(run(s=>{drop(s);s.issues[10].comments.push(grant({human_trials_approved:true,candidate_sha:F.sha(3),base_sha:OTHER_BASE}));}),/E4_E5/);
 ready(run(s=>{drop(s);s.issues[10].comments.push(grant({human_trials_approved:true,candidate_sha:F.sha(3)}));}));
 ready(run(s=>{addField(s,10,'base_sha',F.BASE,'integrator');drop(s);s.issues[10].comments.push(grant({human_trials_approved:true,candidate_sha:F.sha(3),base_sha:F.BASE}));}));
 ready(run(s=>s.issues[10].comments.push(grant({human_trials_approved:false,status:'REVOKED',candidate_sha:F.sha(9),base_sha:F.BASE}))));
});

// ================= AUD-33-SCH-02: every same-name required job must pass =================
const dupJob=(job,over)=>({...structuredClone(job),...over});
test('AUDITOR R33 probe: successful same-name job hides a skipped one',()=>{
 const s=F.positive();
 s.runs[0].jobs[0].id=501;
 s.runs[0].jobs.push({...structuredClone(s.runs[0].jobs[0]),id:502,conclusion:'skipped',steps:[]});
 blocked(evaluate(s,F.config),/CI_NOT_VERIFIED_15/);
});
for(const [label,over] of [['failure',{conclusion:'failure'}],['cancelled',{conclusion:'cancelled'}],['in_progress',{status:'in_progress',conclusion:null}],['queued/pending',{status:'queued',conclusion:null}],['missing status',{status:undefined}],['missing conclusion',{conclusion:undefined}],['no steps',{steps:[]}],['skipped step',{steps:[{status:'completed',conclusion:'skipped'}]}]])
 for(const order of ['after','before'])
  test(`SCH-02 same-name tests job ${label} (${order} the green one) blocks`,()=>blocked(run(s=>{const ok=s.runs[0].jobs[0];ok.id=501;const bad=dupJob(ok,{id:502,...over});if(order==='after')s.runs[0].jobs.push(bad);else s.runs[0].jobs.unshift(bad);}),/CI_NOT_VERIFIED_15/));
test('SCH-02 applies to the integration SHA and to every required name (browser, container)',()=>{
 for(const idx of [1,2])blocked(run(s=>{const ok=s.runs[2].jobs[idx];ok.id=600+idx;s.runs[2].jobs.push(dupJob(ok,{id:700+idx,conclusion:'failure'}));}),/INTEGRATION_NOT_VERIFIED/);
});
test('SCH-02 QA HTTP/Chromium same-name failure is not hidden',()=>{
 for(const idx of [0,1])blocked(run(s=>{const ok=s.runs[3].jobs[idx];ok.id=800+idx;s.runs[3].jobs.push(dupJob(ok,{id:900+idx,conclusion:'failure'}));}),/QA_SHA_CI/);
});
test('SCH-02 POSITIVE legitimate matrix: two distinct same-name jobs both green pass',()=>{
 ready(run(s=>{const ok=s.runs[0].jobs[0];ok.id=501;s.runs[0].jobs.push(dupJob(ok,{id:502,name:'tests'}));}));
 ready(run(s=>{const ok=s.runs[3].jobs[1];ok.id=801;s.runs[3].jobs.push(dupJob(ok,{id:802}));}));
});
test('SCH-02 two records claiming the same job id are contradictory and block',()=>{
 blocked(run(s=>{const ok=s.runs[0].jobs[0];ok.id=501;s.runs[0].jobs.push(dupJob(ok,{id:501}));}),/CI_NOT_VERIFIED_15/);
 blocked(run(s=>{const ok=s.runs[0].jobs[0];ok.id=501;s.runs[0].jobs.push(dupJob(ok,{id:501,conclusion:'failure'}));}),/CI_NOT_VERIFIED_15/);
});
test('SCH-02 newest attempt with a failing same-name copy blocks; POSITIVE newest attempt all green passes',()=>{
 const base=s=>{Object.assign(s.runs[0],{id:100,workflow_id:7,run_attempt:1,conclusion:'failure'});s.runs[0].jobs[0].conclusion='failure';const a2=structuredClone(s.runs[0]);Object.assign(a2,{run_attempt:2,conclusion:'success'});a2.jobs[0].conclusion='success';s.runs.push(a2);return a2;};
 ready(run(s=>{base(s);}));
 blocked(run(s=>{const a2=base(s);a2.jobs.push(dupJob(a2.jobs[0],{id:999,conclusion:'failure'}));}),/CI_NOT_VERIFIED_15/);
});
test('SCH-02 another required workflow whose newest run has a failing same-name job blocks; optional workflow does not',()=>{
 const other=(conclusion,name='tests')=>({id:300,workflow_id:8,head_sha:F.sha(1),status:'completed',conclusion:'success',jobs:[{id:1,name,status:'completed',conclusion:'success',steps:[{status:'completed',conclusion:'success'}]},{id:2,name,status:'completed',conclusion,steps:[{status:'completed',conclusion:'success'}]}]});
 blocked(run(s=>{Object.assign(s.runs[0],{id:200,workflow_id:7});s.runs.push(other('failure'));}),/CI_NOT_VERIFIED_15/);
 ready(run(s=>{Object.assign(s.runs[0],{id:200,workflow_id:7});s.runs.push(other('failure','lint'));}));
 ready(run(s=>{Object.assign(s.runs[0],{id:200,workflow_id:7});s.runs.push(other('success'));}));
});

// ================= AUD-33-SCH-03: duplicate keys / non-canonical ledgers =================
function area(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'scheduler-r33-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
const plan={issue:2,role:'audit',phase:'audit',sha:'3'.repeat(40)};
test('AUDITOR R33 probe: claim, then duplicate "plans" key, then retry: no second plan, bytes preserved',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'audit-r33-lease-'));
 try {
  const first=new PlanStore(d).claim(plan);
  const f=path.join(d,'plans.json'),valid=fs.readFileSync(f,'utf8');
  const corrupt=valid.slice(0,-1)+',"plans":{}}';
  fs.writeFileSync(f,corrupt,{mode:0o600});
  assert.equal(first.would_dispatch,true);assert.equal(first.actual_dispatch,false);
  assert.throws(()=>new PlanStore(d).claim(plan),/CORRUPT_SIMULATION_SNAPSHOT/);
  assert.equal(fs.readFileSync(f,'utf8'),corrupt,'original corrupt bytes preserved (not re-serialised)');
  assert.equal(fs.existsSync(path.join(d,'lease.lock')),false,'lock released');
  assert.throws(()=>new PlanStore(d).claim({...plan,sha:'4'.repeat(40)}),/CORRUPT/,'restart with another key is also refused');
 } finally { fs.rmSync(d,{recursive:true,force:true}); }
});
const claimed=t=>{const d=area(t);new PlanStore(d).claim(plan);const f=path.join(d,'plans.json');return {d,f,valid:fs.readFileSync(f,'utf8')};};
const key=JSON.stringify(JSON.stringify([plan.issue,plan.role,plan.phase,plan.sha]));
for(const [label,mutate] of [
 ['duplicate top-level plans',v=>v.slice(0,-1)+',"plans":{}}'],
 ['duplicate top-level version',v=>v.replace('{"version":1,','{"version":1,"version":1,')],
 ['escaped-equivalent plans key',v=>v.slice(0,-1)+',"\\u0070lans":{}}'],
 ['duplicate plan key inside plans (older entry erased)',v=>v.replace('"plans":{','"plans":{'+key+':{"created_at":1,"expires_at":2},')],
 ['escaped-equivalent plan key',v=>v.replace('"plans":{','"plans":{'+key.replace('audit','\\u0061udit')+':{"created_at":1,"expires_at":2},')],
 ['nested duplicate created_at',v=>v.replace('{"created_at":','{"created_at":0,"created_at":')],
 ['reordered fields',v=>JSON.stringify({plans:JSON.parse(v).plans,version:1})],
 ['pretty-printed',v=>JSON.stringify(JSON.parse(v),null,2)],
 ['trailing newline',v=>v+'\n'],
 ['BOM prefix',v=>'﻿'+v]])
 test(`SCH-03 ${label}: fail closed, bytes preserved, zero new plans`,t=>{
  const {d,f,valid}=claimed(t);const corrupt=mutate(valid);assert.notEqual(corrupt,valid);fs.writeFileSync(f,corrupt,{mode:0o600});
  for(let i=0;i<2;i++)assert.throws(()=>new PlanStore(d).claim(plan),/CORRUPT_SIMULATION_SNAPSHOT/);
  assert.equal(fs.readFileSync(f,'utf8'),corrupt);assert.equal(fs.existsSync(path.join(d,'lease.lock')),false);
 });
test('SCH-03 four processes racing on a duplicate-key ledger produce zero plans',async t=>{
 const {d,f,valid}=claimed(t);fs.writeFileSync(f,valid.slice(0,-1)+',"plans":{}}',{mode:0o600});
 const modulePath=path.resolve(__dirname,'../../agent-scheduler/lease.js');
 const code=`const {PlanStore}=require(${JSON.stringify(modulePath)});let r;try{r=new PlanStore(process.argv[1]).claim(${JSON.stringify(plan)});}catch(e){r={error:e.message};}console.log(JSON.stringify(r))`;
 const one=()=>new Promise((resolve,reject)=>{const env={...process.env};delete env.NODE_TEST_CONTEXT;const c=spawn(process.execPath,['-e',code,d],{env});let out='';c.stdout.on('data',b=>out+=b);c.on('error',reject);c.on('close',n=>n===0?resolve(JSON.parse(out)):reject(Error('child '+n)));});
 const results=await Promise.all([one(),one(),one(),one()]);
 assert.equal(results.filter(r=>r.would_dispatch).length,0,JSON.stringify(results));
 assert.ok(results.every(r=>r.error==='CORRUPT_SIMULATION_SNAPSHOT'||/LOCK/.test(r.warning||'')));
});
test('SCH-03 POSITIVE normal ledger: distinct plans accumulate canonically, restarts never re-plan',t=>{
 const d=area(t),f=path.join(d,'plans.json');
 assert.equal(new PlanStore(d).claim(plan).would_dispatch,true);
 assert.equal(new PlanStore(d).claim({...plan,sha:'4'.repeat(40)}).would_dispatch,true);
 const raw=fs.readFileSync(f,'utf8');assert.equal(raw,JSON.stringify(JSON.parse(raw)));assert.equal(Object.keys(JSON.parse(raw).plans).length,2);
 for(const p of [plan,{...plan,sha:'4'.repeat(40)}])for(let i=0;i<2;i++){const r=new PlanStore(d).claim(p);assert.equal(r.would_dispatch,false);assert.equal(r.warning,'DUPLICATE_EVENT');}
 assert.equal(fs.readFileSync(f,'utf8'),raw,'duplicates never rewrite the ledger');
});

// ================= Planner protocol migration (synthetic positive, documented) =================
test('Planner migration: free-form decision blocks; full structured re-issue for 5 roles + E4/E5 restores the positive',()=>{
 const freeform=later({...grant({}),body:'[PLANNER_DECISION_V1] 第N轮：进度说明（自由格式，无闭合块）'},1);
 blocked(run(s=>{s.issues[10].comments.push(freeform);}),/AUTHORIZATION/);
 blocked(run(s=>{s.issues[10].comments.push(freeform,later(grant({authorized_role:'codex',issue:15,branch:'codex',approved:true,candidate_sha:F.sha(1)}),2));}),/NO_PLANNER_AUTHORIZATION_17/);
 ready(run(s=>{
  s.issues[10].comments.push(freeform);let m=2;
  for(const [role,issue,branch,sha] of [['codex',15,'codex',F.sha(1)],['claude',17,'claude',F.sha(2)],['integrator',10,'integration',F.sha(3)],['audit',2,'integration',F.sha(3)],['qa',4,'qa-test',F.sha(3)]])s.issues[10].comments.push(later(grant({authorized_role:role,issue,branch,approved:true,candidate_sha:sha}),m++));
  s.issues[10].comments.push(later(grant({human_trials_approved:true,candidate_sha:F.sha(3)}),m++));
 }));
});
