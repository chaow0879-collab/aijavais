'use strict';
// AUD-41-COMPAT-01: synthetic reports only; never GitHub writes or Agent dispatch.
const test=require('node:test'),assert=require('node:assert/strict');
const F=require('./fixtures.cjs'),{evaluate}=require('../../agent-scheduler/state');
const INDEPENDENT='Independent-CodeAudit';
function audit(s){return s.issues[2].comments[0];}
function field(c,name,value){c.body=c.body.replace(new RegExp('^'+name+':.*$','m'),name+': '+value);}
function fixture(role=INDEPENDENT){const s=F.positive();field(audit(s),'role',role);return s;}
function result(s,config=F.config){const r=evaluate(s,config);assert.equal(r.actual_dispatch,false);assert.deepEqual(r.would_dispatch,[]);return r;}
function deny(s,gate,config){const r=result(s,config);assert.notEqual(r.state,'READY_FOR_HUMAN_GATE');assert.ok(r.missing_gates.some(x=>gate.test(x)),JSON.stringify(r));return r;}
function later(s,fields){const c=structuredClone(audit(s));c.created_at='2026-11-06T00:01:00Z';for(const [name,value] of Object.entries(fields))field(c,name,value);s.issues[2].comments.push(c);return c;}
for(const role of ['CodeAudit','Codex-CodeAudit',INDEPENDENT])for(const verdict of ['ACCEPT','ACCEPT_WITH_FOLLOWUP'])test('R42 exact audit alias '+role+' / '+verdict+' reaches human gate only',()=>{const s=fixture(role);field(audit(s),'verdict',verdict);assert.equal(result(s).state,'READY_FOR_HUMAN_GATE');});
for(const role of ['Independent-CodeAudit-admin','independent-codeaudit','Independent CodeAudit','CodeAudit-unknown','Integrator','["Independent-CodeAudit"]'])test('R42 unknown or contradictory role is not an audit alias: '+role,()=>deny(fixture(role),/AMBIGUOUS_LATEST_AUDIT_REPORT/));
for(const login of ['attacker','codex','audit-lookalike'])test('R42 machine role does not authenticate GitHub author '+login,()=>{const s=fixture();audit(s).user.login=login;deny(s,/FINAL_AUDIT_REQUIRED/);});
for(const association of ['CONTRIBUTOR','NONE',undefined])test('R42 machine role does not bypass association '+association,()=>{const s=fixture();audit(s).author_association=association;deny(s,/FINAL_AUDIT_REQUIRED/);});
for(const status of ['BLOCKED','REJECTED'])test('R42 latest '+status+' with ACCEPT cannot fall back to older valid audit',()=>{const s=fixture('CodeAudit');later(s,{role:INDEPENDENT,status});deny(s,status==='BLOCKED'?/AUDIT_BLOCKED/:/AUDIT_REJECTED/);});
test('R42 newer REJECT overrides older alias ACCEPT even if source array is out of chronological order',()=>{const s=fixture();later(s,{verdict:'REJECT'});s.issues[2].comments.reverse();deny(s,/AUDIT_REJECTED/);});
test('R42 newer legacy-role BLOCKED overrides older independent-role ACCEPT',()=>{const s=fixture();later(s,{role:'Codex-CodeAudit',status:'BLOCKED'});deny(s,/AUDIT_BLOCKED/);});
test('R42 unknown latest role cannot revive older ACCEPT',()=>{const s=fixture('CodeAudit');later(s,{role:'Unknown-CodeAudit'});deny(s,/AMBIGUOUS_LATEST_AUDIT_REPORT/);});
test('R42 forged latest REJECT is ignored rather than becoming an authenticated veto',()=>{const s=fixture();later(s,{verdict:'REJECT'}).user.login='attacker';assert.equal(result(s).state,'READY_FOR_HUMAN_GATE');});
for(const [name,value] of [['reviewed_sha',F.sha(9)],['reviewed_sha','not-a-sha'],['branch','other-branch'],['review_phase','PRE_AUDIT'],['verdict','PASS'],['verdict','UNKNOWN'],['status','RUNNING']])test('R42 alias retains exact audit contract: '+name+'='+value,()=>{const s=fixture();field(audit(s),name,value);deny(s,/AUDIT_SHA_OR_PHASE_MISMATCH|AUDIT_VERDICT_NOT_ACCEPT|AUDIT_NOT_FINAL/);});
test('R42 contradictory head and reviewed SHA denied',()=>{const s=fixture();audit(s).body=audit(s).body.replace('[/AGENT_REPORT_V1]','head_sha: '+F.sha(9)+'\n[/AGENT_REPORT_V1]');deny(s,/AUDIT_SHA_OR_PHASE_MISMATCH/);});
test('R42 missing final status denied',()=>{const s=fixture();audit(s).body=audit(s).body.replace(/^status:.*\n/m,'');deny(s,/AUDIT_STATUS_MISSING/);});
test('R42 duplicate contradictory role fields are ambiguous even with valid alias',()=>{const s=fixture();audit(s).body=audit(s).body.replace('[/AGENT_REPORT_V1]','role: CodeAudit\n[/AGENT_REPORT_V1]');deny(s,/AMBIGUOUS_LATEST_AUDIT_REPORT/);});
test('R42 removing exact Planner grant cannot be repaired by audit role alias',()=>{const s=fixture();s.issues[10].comments=s.issues[10].comments.filter(c=>!c.body.includes('authorized_role: audit'));deny(s,/AUDIT_SHA_OR_PHASE_MISMATCH/);});
test('R42 wrong-candidate Planner grant sharing a base cannot authorize new audit alias',()=>{const s=fixture();for(const c of s.issues[10].comments.filter(c=>c.body.includes('authorized_role: audit')))field(c,'candidate_sha',F.sha(9));deny(s,/AUDIT_SHA_OR_PHASE_MISMATCH/);});
test('R42 alias does not relax auditor/author identity independence',()=>{const s=fixture();deny(s,/AUDITOR_AUTHOR_CONFLICT/,{...F.config,trustedActors:{...F.config.trustedActors,audit:['codex']}});});
test('R42 alias still exposes unresolved P1 instead of bypassing global gate',()=>{const s=fixture();audit(s).body=audit(s).body.replace('[/AGENT_REPORT_V1]','severity: P1\n[/AGENT_REPORT_V1]');deny(s,/OPEN_SECURITY_OR_UNKNOWN_COST/);});
for(const role of ['audit','审计岗位'])test('R42 legacy writer JSON ledger remains deduplicated and append-compatible: '+role,t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{PlanStore}=require('../../agent-scheduler/lease');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r42-legacy-ledger-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const plans=[{issue:2,role,phase:'audit',sha:F.sha(3)},{issue:4,role:'qa',phase:'qa',sha:F.sha(4)}];
 const key=p=>JSON.stringify([p.issue,p.role,p.phase,p.sha]);
 // Exact JSON.stringify format of the original V1 writer, not hand-pretty-printed JSON.
 const raw=JSON.stringify({version:1,plans:Object.fromEntries(plans.map(p=>[key(p),{created_at:100,expires_at:200}]))}),file=path.join(dir,'plans.json');fs.writeFileSync(file,raw,{mode:0o600});
 for(const p of plans){const r=new PlanStore(dir).claim(p,300);assert.equal(r.actual_dispatch,false);assert.equal(r.would_dispatch,false);assert.equal(r.warning,'EXPIRED_LEASE_HUMAN_REVIEW_REQUIRED');assert.equal(fs.readFileSync(file,'utf8'),raw);}
 const third={issue:10,role:'integrator',phase:'integration',sha:F.sha(5)},added=new PlanStore(dir).claim(third,300);assert.equal(added.actual_dispatch,false);assert.equal(added.would_dispatch,true);
 const stored=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual(Object.keys(stored.plans),[...plans.map(key),key(third)]);for(const p of plans)assert.deepEqual(stored.plans[key(p)],{created_at:100,expires_at:200});assert.equal(JSON.stringify(stored),fs.readFileSync(file,'utf8'));
});
