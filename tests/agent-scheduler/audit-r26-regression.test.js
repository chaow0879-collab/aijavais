'use strict';
// Regression for the independent CodeAudit REJECT of 6363e8d (#2 comment 6675848987):
// AUD-26-SCH-01..05. The first block reproduces the auditor's offline probes verbatim
// (same mutations, same fixtures); every one of them must now stay out of
// READY_FOR_HUMAN_GATE. Offline only: no --live, no GitHub, no Agent, no dispatch.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {evaluate}=require('../../tools/agent-scheduler/state');
const {PlanStore}=require('../../tools/agent-scheduler/lease');
const {main}=require('../../tools/agent-scheduler/cli');
const F=require('./fixtures.cjs');
const edit=(s,issue,field,value)=>{
 const c=s.issues[issue].comments[0];
 const line=field+': '+(typeof value==='string'?value:JSON.stringify(value));
 c.body=c.body.replace(new RegExp('^'+field+':.*$','m'),line);
};
const drop=(s,issue,field)=>{s.issues[issue].comments[0].body=s.issues[issue].comments[0].body.replace(new RegExp('^'+field+':.*\\n','m'),'');};
const run=(mutate,config=F.config)=>{const s=F.positive();mutate(s);return evaluate(s,config);};
const blocked=(r,gate)=>{
 assert.notEqual(r.state,'READY_FOR_HUMAN_GATE',JSON.stringify(r.missing_gates));
 assert.equal(r.actual_dispatch,false);assert.deepEqual(r.would_dispatch,[]);assert.ok(r.missing_gates.length>0);
 assert.ok(!r.evidence.some(e=>e.state==='AUDIT_ACCEPTED')||!/^AUDIT|AMBIGUOUS_LATEST_AUDIT/.test(r.missing_gates[0]),'no AUDIT_ACCEPTED when the audit gate failed');
 if(gate)assert.match(r.missing_gates[0],gate);
};
const grant=(fields)=>F.comment('planner',fields,'PLANNER_DECISION_V1');
const ciRun=(sha,id,conclusion='success',extra={})=>({id,workflow_id:7,head_sha:sha,status:conclusion===null?'in_progress':'completed',conclusion,created_at:new Date(Date.UTC(2026,10,6,0,0,id)).toISOString(),...extra,
 jobs:['tests','browser','container'].map(name=>({name,status:conclusion===null?'in_progress':'completed',conclusion:conclusion==='success'?'success':conclusion,steps:[{name:'security',status:'completed',conclusion:conclusion==='success'?'success':(conclusion||'success')}]}))});

test('positive control still reaches only the human gate (never dispatches)',()=>{
 const r=evaluate(F.positive(),F.config);assert.equal(r.state,'READY_FOR_HUMAN_GATE');assert.equal(r.actual_dispatch,false);assert.deepEqual(r.would_dispatch,[]);assert.deepEqual(r.missing_gates,[]);
});

// ---- Auditor probes, verbatim (audit-probes.cjs) ----
test('AUDITOR probe audit_status_BLOCKED',()=>blocked(run(s=>edit(s,2,'status','BLOCKED')),/AUDIT_BLOCKED/));
test('AUDITOR probe audit_status_REJECTED_with_old_verdict',()=>{const r=run(s=>edit(s,2,'status','REJECTED'));blocked(r,/AUDIT_REJECTED/);assert.equal(r.state,'REJECTED');});
test('AUDITOR probe qa_status_BLOCKED',()=>blocked(run(s=>edit(s,4,'status','BLOCKED')),/QA_BLOCKED/));
test('AUDITOR probe qa_status_REJECTED_with_old_verdict',()=>{const r=run(s=>edit(s,4,'status','REJECTED'));blocked(r,/QA_REJECTED/);assert.equal(r.state,'REJECTED');});
test('AUDITOR probe audit_missing_status',()=>blocked(run(s=>{s.issues[2].comments[0].body=s.issues[2].comments[0].body.replace(/^status:.*\n/m,'');}),/AUDIT_STATUS_MISSING/));
test('AUDITOR probe latest_planner_revokes_integration',()=>blocked(run(s=>s.issues[10].comments.push(F.comment('planner',{
 authorized_role:'integrator',issue:10,branch:'integration',candidate_sha:F.sha(3),approved:false,status:'REJECTED'
},'PLANNER_DECISION_V1'))),/INTEGRATION_NOT_VERIFIED/));
test('AUDITOR probe latest_planner_revokes_human_trials',()=>blocked(run(s=>s.issues[10].comments.push(F.comment('planner',{
 human_trials_approved:false,candidate_sha:F.sha(3),status:'REJECTED'
},'PLANNER_DECISION_V1'))),/E4_E5/));
test('AUDITOR probe same_workflow_newer_CI_in_progress',()=>blocked(run(s=>{
 Object.assign(s.runs[0],{id:100,workflow_id:7,created_at:'2026-11-06T01:00:00Z'});
 s.runs.unshift({...structuredClone(s.runs[0]),id:101,status:'in_progress',conclusion:null,created_at:'2026-11-06T02:00:00Z'});
}),/CI_NOT_VERIFIED_15/));
test('AUDITOR probe same_workflow_newer_CI_failed',()=>blocked(run(s=>{
 Object.assign(s.runs[0],{id:100,workflow_id:7,created_at:'2026-11-06T01:00:00Z'});
 const newer=structuredClone(s.runs[0]);Object.assign(newer,{id:101,status:'completed',conclusion:'failure',created_at:'2026-11-06T02:00:00Z'});
 newer.jobs[0].conclusion='failure';s.runs.unshift(newer);
}),/CI_NOT_VERIFIED_15/));
test('AUDITOR probe developer_also_QA_identity',()=>blocked(run(s=>{s.issues[4].comments[0].user.login='codex';},
 {...F.config,trustedActors:{...F.config.trustedActors,qa:['codex']}}),/QA_AUTHOR_CONFLICT/));
test('AUDITOR probe QA_policy_omits_Chromium',()=>blocked(run(s=>{s.runs[3].jobs[1].status='completed';s.runs[3].jobs[1].conclusion='skipped';},
 {...F.config,qa_required_jobs:['HTTP']}),/INVALID_QA_POLICY/));
test('AUDITOR probe corrupt_array_plans_snapshot',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'audit-r26-lease-'));
 try {
  const raw=JSON.stringify({version:1,plans:[]});
  fs.writeFileSync(path.join(dir,'plans.json'),raw,{mode:0o600});
  const plan={issue:2,role:'audit',phase:'audit',sha:F.sha(3)};
  assert.throws(()=>new PlanStore(dir).claim(plan),/CORRUPT_SIMULATION_SNAPSHOT/);
  assert.throws(()=>new PlanStore(dir).claim(plan),/CORRUPT_SIMULATION_SNAPSHOT/);
  assert.equal(fs.readFileSync(path.join(dir,'plans.json'),'utf8'),raw,'corrupt state is preserved for human review, not rewritten');
  assert.equal(fs.existsSync(path.join(dir,'lease.lock')),false,'lock released after fail-closed');
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

// ---- SCH-01 extended: status contract for final audit and QA ----
for(const [issue,label] of [[2,'audit'],[4,'QA']]){
 for(const status of ['BLOCKED','REJECTED','CLAIMED','PRE_AUDIT_PREPARED','UNKNOWN','blocked','ready_for_review','true'])
  test(`SCH-01 ${label} status=${status} with old positive verdict never advances`,()=>blocked(run(s=>edit(s,issue,'status',status))));
 test(`SCH-01 ${label} status missing never advances`,()=>blocked(run(s=>drop(s,issue,'status'))));
 test(`SCH-01 ${label} verdict missing never advances`,()=>blocked(run(s=>drop(s,issue,'verdict'))));
 test(`SCH-01 ${label} role missing is ambiguous, not ignored`,()=>blocked(run(s=>drop(s,issue,'role')),/AMBIGUOUS/));
 test(`SCH-01 ${label} duplicate status field in newer report blocks (no fallback to older ACCEPT/PASS)`,()=>blocked(run(s=>{
  const old=s.issues[issue].comments[0];const dup=structuredClone(old);
  dup.body=dup.body.replace('status: READY_FOR_REVIEW','status: READY_FOR_REVIEW\nstatus: BLOCKED');s.issues[issue].comments.push(dup);
 }),/AMBIGUOUS/));
 test(`SCH-01 ${label} newer explicit BLOCKED report after an older approval wins`,()=>blocked(run(s=>{
  const newer=structuredClone(s.issues[issue].comments[0]);newer.body=newer.body.replace('status: READY_FOR_REVIEW','status: BLOCKED');s.issues[issue].comments.push(newer);
 })));
 test(`SCH-01 ${label} newer unparseable report (two blocks) blocks`,()=>blocked(run(s=>{
  const b=s.issues[issue].comments[0].body;s.issues[issue].comments.push({...structuredClone(s.issues[issue].comments[0]),body:b+'\n'+b});
 }),/AMBIGUOUS/));
 test(`SCH-01 ${label} untrusted malicious ACCEPT/PASS after a real BLOCKED is ignored`,()=>blocked(run(s=>{
  edit(s,issue,'status','BLOCKED');const fake=structuredClone(s.issues[issue].comments[0]);fake.user.login='attacker';fake.body=fake.body.replace('status: BLOCKED','status: READY_FOR_REVIEW');s.issues[issue].comments.push(fake);
 })));
 test(`SCH-01 ${label} comment order follows created_at, not array position`,()=>blocked(run(s=>{
  const veto=structuredClone(s.issues[issue].comments[0]);veto.body=veto.body.replace('status: READY_FOR_REVIEW','status: BLOCKED');veto.created_at='2026-11-07T00:00:00Z';s.issues[issue].comments.unshift(veto);
 })));
}
test('SCH-01 audit verdict REJECT with READY_FOR_REVIEW status is REJECTED',()=>{const r=run(s=>edit(s,2,'verdict','REJECT'));blocked(r,/AUDIT_REJECTED/);assert.equal(r.state,'REJECTED');});
test('SCH-01 audit status/SHA conflict (head_sha differs from reviewed_sha) blocks',()=>blocked(run(s=>{s.issues[2].comments[0].body=s.issues[2].comments[0].body.replace('[/AGENT_REPORT_V1]','head_sha: '+F.sha(9)+'\n[/AGENT_REPORT_V1]');})));
test('SCH-01 QA verdict FAIL/BLOCKED blocks',()=>{for(const v of ['FAIL','BLOCKED','ACCEPT'])blocked(run(s=>edit(s,4,'verdict',v)));});
test('SCH-01 unparseable comment timestamp is UNKNOWN',()=>blocked(run(s=>{s.issues[2].comments[0].created_at='not-a-date';}),/UNKNOWN_COMMENT_ORDER/));
test('SCH-01 explicit ACCEPT_WITH_FOLLOWUP + READY_FOR_REVIEW still advances',()=>{const r=run(s=>edit(s,2,'verdict','ACCEPT_WITH_FOLLOWUP'));assert.equal(r.state,'READY_FOR_HUMAN_GATE');});

// ---- SCH-02 extended: newest applicable Planner decision wins ----
const revoke=(fields)=>s=>s.issues[10].comments.push(grant({approved:false,status:'REVOKED',...fields}));
for(const [role,issue,branch,sha] of [['codex',15,'codex',F.sha(1)],['claude',17,'claude',F.sha(2)],['integrator',10,'integration',F.sha(3)],['audit',2,'integration',F.sha(3)],['qa',4,'qa-test',F.sha(3)]]){
 test(`SCH-02 later revocation of ${role} candidate blocks`,()=>blocked(run(revoke({authorized_role:role,issue,branch,candidate_sha:sha}))));
 test(`SCH-02 later blanket revocation of ${role} (no SHA, no branch) blocks`,()=>blocked(run(revoke({authorized_role:role,issue}))));
 test(`SCH-02 approved:true carrying REJECTED status for ${role} is not an approval`,()=>blocked(run(s=>s.issues[10].comments.push(grant({authorized_role:role,issue,branch,approved:true,status:'REJECTED',candidate_sha:sha})))));
}
test('SCH-02 revoke then explicit re-authorization advances again',()=>{
 const r=run(s=>{revoke({authorized_role:'integrator',issue:10,branch:'integration',candidate_sha:F.sha(3)})(s);s.issues[10].comments.push(grant({authorized_role:'integrator',issue:10,branch:'integration',approved:true,candidate_sha:F.sha(3)}));});
 assert.equal(r.state,'READY_FOR_HUMAN_GATE');
});
test('SCH-02 revocation of a different candidate/role/issue does not leak across scopes',()=>{
 for(const fields of [{authorized_role:'integrator',issue:10,branch:'integration',candidate_sha:F.sha(8)},{authorized_role:'codex',issue:10,branch:'integration'},{authorized_role:'integrator',issue:99,branch:'integration'},{authorized_role:'integrator',issue:10,branch:'other'}])
  assert.equal(run(revoke(fields)).state,'READY_FOR_HUMAN_GATE',JSON.stringify(fields));
});
test('SCH-02 a grant for one role/issue never authorizes another',()=>blocked(run(s=>{
 for(const c of s.issues[10].comments)if(c.body.includes('authorized_role: claude'))c.body=c.body.replace('authorized_role: claude','authorized_role: codex');
}),/NO_PLANNER_AUTHORIZATION_17/));
test('SCH-02 old base-only grant cannot re-open a revoked candidate',()=>blocked(run(s=>{
 s.issues[15].comments[0].body=s.issues[15].comments[0].body;revoke({authorized_role:'codex',issue:15,branch:'codex',candidate_sha:F.sha(1)})(s);
 s.issues[10].comments.unshift({...grant({authorized_role:'codex',issue:15,branch:'codex',approved:true,base_sha:F.BASE}),created_at:'2026-11-05T00:00:00Z'});
}),/NO_PLANNER_AUTHORIZATION_15/));
test('SCH-02 newer ambiguous Planner decision requires human review',()=>blocked(run(s=>{const g=grant({authorized_role:'codex',issue:15,branch:'codex',approved:true,candidate_sha:F.sha(1)});s.issues[10].comments.push({...g,body:g.body+'\n'+g.body});}),/AUTHORIZATION|AMBIGUOUS/));
test('SCH-02 E4/E5 blanket revocation (no candidate) and cross-candidate grant',()=>{
 blocked(run(s=>s.issues[10].comments.push(grant({human_trials_approved:false,status:'REVOKED'}))),/E4_E5/);
 blocked(run(s=>{for(const c of s.issues[10].comments)if(c.body.includes('human_trials_approved'))c.body=c.body.replace(F.sha(3),F.sha(8));}),/E4_E5/);
 assert.equal(run(s=>s.issues[10].comments.push(grant({human_trials_approved:false,candidate_sha:F.sha(8)}))).state,'READY_FOR_HUMAN_GATE','revocation for another candidate does not apply');
});

// ---- SCH-03 extended: newest run per workflow decides ----
const withRuns=(sha,runs)=>s=>{s.runs=s.runs.filter(r=>r.head_sha!==sha);s.runs.push(...runs);};
for(const [label,conclusion] of [['failed','failure'],['cancelled','cancelled'],['in progress',null],['timed out','timed_out']])
 test(`SCH-03 newer ${label} run hides no older green (integration SHA)`,()=>blocked(run(withRuns(F.sha(3),[ciRun(F.sha(3),100),ciRun(F.sha(3),101,conclusion)])),/INTEGRATION_NOT_VERIFIED/));
test('SCH-03 newer green after older red passes; rerun attempt 2 success over attempt 1 failure passes',()=>{
 assert.equal(run(withRuns(F.sha(3),[ciRun(F.sha(3),100,'failure'),ciRun(F.sha(3),101)])).state,'READY_FOR_HUMAN_GATE');
 assert.equal(run(withRuns(F.sha(3),[ciRun(F.sha(3),100,'failure',{run_attempt:1}),ciRun(F.sha(3),100,'success',{run_attempt:2})])).state,'READY_FOR_HUMAN_GATE');
});
test('SCH-03 rerun attempt 2 failure over attempt 1 success blocks',()=>blocked(run(withRuns(F.sha(3),[ciRun(F.sha(3),100,'success',{run_attempt:1}),ciRun(F.sha(3),100,'failure',{run_attempt:2})]))));
test('SCH-03 runs of one workflow without orderable ids are ambiguous',()=>blocked(run(withRuns(F.sha(3),[{...ciRun(F.sha(3),1),id:undefined,created_at:'a'},{...ciRun(F.sha(3),2,'failure'),id:undefined}]))));
test('SCH-03 a different required workflow failing on the same SHA blocks; an unrelated optional workflow does not',()=>{
 blocked(run(withRuns(F.sha(3),[ciRun(F.sha(3),100),ciRun(F.sha(3),101,'failure',{workflow_id:8})])));
 const optional={id:102,workflow_id:9,head_sha:F.sha(3),status:'completed',conclusion:'failure',jobs:[{name:'lint',status:'completed',conclusion:'failure',steps:[{status:'completed',conclusion:'failure'}]}]};
 assert.equal(run(withRuns(F.sha(3),[ciRun(F.sha(3),100),optional])).state,'READY_FOR_HUMAN_GATE');
});
test('SCH-03 QA test SHA: newer Chromium failure hides no older green',()=>blocked(run(s=>{
 Object.assign(s.runs[3],{id:200,workflow_id:5});const newer=structuredClone(s.runs[3]);Object.assign(newer,{id:201,conclusion:'failure'});newer.jobs[1].conclusion='failure';s.runs.push(newer);
}),/QA_SHA_CI/));

// ---- SCH-04 extended: corrupt ledgers, restart and races ----
function area(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'scheduler-r26-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
const plan={issue:2,role:'audit',phase:'audit',sha:F.sha(3)};
for(const [label,raw] of [['null plans','{"version":1,"plans":null}'],['top-level array','[]'],['top-level null','null'],['primitive','7'],['string plans','{"version":1,"plans":"x"}'],['wrong version','{"version":2,"plans":{}}'],['extra field','{"version":1,"plans":{},"x":1}'],['malformed key','{"version":1,"plans":{"bad":{"created_at":1,"expires_at":2}}}'],['entry missing expiry','{"version":1,"plans":{"[2,\\"audit\\",\\"audit\\",\\"'+F.sha(3)+'\\"]":{"created_at":1}}}'],['entry array','{"version":1,"plans":{"[2,\\"audit\\",\\"audit\\",\\"'+F.sha(3)+'\\"]":[]}}'],['non-finite time','{"version":1,"plans":{"[2,\\"audit\\",\\"audit\\",\\"'+F.sha(3)+'\\"]":{"created_at":"1","expires_at":2}}}'],['__proto__ key','{"version":1,"plans":{"__proto__":{"created_at":1,"expires_at":2}}}'],['truncated JSON','{"version":1,"pl'],['empty file','']])
 test(`SCH-04 corrupt ledger (${label}) fails closed without rewrite`,t=>{
  const d=area(t);fs.writeFileSync(path.join(d,'plans.json'),raw,{mode:0o600});
  assert.throws(()=>new PlanStore(d).claim(plan),/CORRUPT_SIMULATION_SNAPSHOT/);assert.equal(fs.readFileSync(path.join(d,'plans.json'),'utf8'),raw);
 });
test('SCH-04 symlinked ledger fails closed',t=>{const d=area(t),target=path.join(d,'real.json');fs.writeFileSync(target,'{"version":1,"plans":{}}');fs.symlinkSync(target,path.join(d,'plans.json'));assert.throws(()=>new PlanStore(d).claim(plan),/CORRUPT/);});
test('SCH-04 valid ledger survives restart: second instance never re-plans',t=>{
 const d=area(t);assert.equal(new PlanStore(d).claim(plan).would_dispatch,true);
 const persisted=JSON.parse(fs.readFileSync(path.join(d,'plans.json'),'utf8'));assert.equal(Object.keys(persisted.plans).length,1);
 for(let i=0;i<3;i++)assert.equal(new PlanStore(d).claim(plan).would_dispatch,false);
});
test('SCH-04 four processes racing on a corrupt ledger produce zero plans',async t=>{
 const d=area(t),modulePath=path.resolve(__dirname,'../../tools/agent-scheduler/lease.js');fs.writeFileSync(path.join(d,'plans.json'),'{"version":1,"plans":[]}',{mode:0o600});
 const code=`const {PlanStore}=require(${JSON.stringify(modulePath)});let r;try{r=new PlanStore(process.argv[1]).claim({issue:2,role:'audit',phase:'audit',sha:'${F.sha(3)}'});}catch(e){r={error:e.message};}console.log(JSON.stringify(r))`;
 const one=()=>new Promise((resolve,reject)=>{const env={...process.env};delete env.NODE_TEST_CONTEXT;const c=spawn(process.execPath,['-e',code,d],{env});let out='';c.stdout.on('data',b=>out+=b);c.on('error',reject);c.on('close',n=>n===0?resolve(JSON.parse(out)):reject(Error('child '+n)));});
 const results=await Promise.all([one(),one(),one(),one()]);
 assert.equal(results.filter(r=>r.would_dispatch).length,0);assert.ok(results.every(r=>r.error==='CORRUPT_SIMULATION_SNAPSHOT'||/LOCK/.test(r.warning||'')),JSON.stringify(results));
});
test('SCH-04 CLI with corrupt state dir reports BLOCKED, never would_dispatch',async t=>{
 const d=area(t),s=F.positive();s.issues[10].comments=s.issues[10].comments.filter(c=>c.user.login!=='integrator');
 fs.writeFileSync(path.join(d,'plans.json'),'{"version":1,"plans":[]}',{mode:0o600});
 const fixture=path.join(d,'fixture.json'),policy=path.join(d,'config.json');fs.writeFileSync(fixture,JSON.stringify(s));fs.writeFileSync(policy,JSON.stringify(F.config));
 await assert.rejects(main(['--once','--fixture',fixture,'--config',policy,'--simulate-plan','--state-dir',d]),/CORRUPT/);
});

// ---- SCH-05 extended: QA independence and non-lowerable floors ----
test('SCH-05 QA identity may not overlap any author role (config)',()=>{
 for(const role of ['codex','claude','integrator'])blocked(evaluate(F.positive(),{...F.config,trustedActors:{...F.config.trustedActors,qa:[...F.config.trustedActors.qa,F.config.trustedActors[role][0]]}}),/QA_AUTHOR_CONFLICT/);
});
test('SCH-05 QA report published by the integration author is rejected even if the maps were edited',()=>{
 const cfg={...F.config,trustedActors:{...F.config.trustedActors,qa:['qa','shared'],integrator:['integrator']}};
 const r=run(s=>{s.issues[4].comments[0].user.login='shared';},cfg);assert.equal(r.state,'READY_FOR_HUMAN_GATE','distinct accounts are fine');
 blocked(run(s=>{s.issues[4].comments[0].user.login='integrator';},{...cfg,trustedActors:{...cfg.trustedActors,qa:['qa','integrator']}}),/QA_AUTHOR_CONFLICT/);
});
test('SCH-05 QA policy floors: HTTP-only, Chromium-only, empty, wrong types, duplicates, aliases fail closed; supersets allowed',()=>{
 for(const jobs of [['HTTP'],['Chromium'],[],'HTTP,Chromium',[1,2],['HTTP','HTTP'],['http','chromium'],null])blocked(evaluate(F.positive(),{...F.config,qa_required_jobs:jobs}),/INVALID_QA_POLICY/);
 assert.equal(evaluate(F.positive(),{...F.config,qa_required_jobs:undefined}).state,'READY_FOR_HUMAN_GATE','absent → default HTTP+Chromium');
 const s=F.positive();s.runs[3].jobs.push({name:'Accessibility',status:'completed',conclusion:'success',steps:[{status:'completed',conclusion:'success'}]});
 assert.equal(evaluate(s,{...F.config,qa_required_jobs:['HTTP','Chromium','Accessibility']}).state,'READY_FOR_HUMAN_GATE');
});
test('SCH-05 required_jobs floor and trustedActors schema fail closed',()=>{
 for(const jobs of [['tests','browser'],['tests','browser','container','tests'],[1]])blocked(evaluate(F.positive(),{...F.config,required_jobs:jobs}),/INVALID_POLICY/);
 for(const actors of [[],null,{qa:'qa'},{qa:[1]},{qa:['']}])blocked(evaluate(F.positive(),{...F.config,trustedActors:actors}),/INVALID_POLICY/);
});
test('SCH-05 CLI --config cannot lower the QA floor',async t=>{
 const d=area(t),fixture=path.join(d,'fixture.json'),policy=path.join(d,'config.json');fs.writeFileSync(fixture,JSON.stringify(F.positive()));fs.writeFileSync(policy,JSON.stringify({...F.config,qa_required_jobs:['HTTP']}));
 const r=await main(['--once','--fixture',fixture,'--config',policy]);assert.equal(r.state,'BLOCKED');assert.deepEqual(r.missing_gates,['INVALID_QA_POLICY']);assert.equal(r.actual_dispatch,false);
});
