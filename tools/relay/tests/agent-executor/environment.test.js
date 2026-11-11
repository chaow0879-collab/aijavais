const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const E=require('../../agent-executor/environment'),{plan}=require('../../agent-executor/rehearsal');
test('version parser returns only a numeric version, never raw secret-bearing output',()=>{assert.equal(E.parseVersion('codex-cli 0.166.0\nPRIVATE-KEY'),'0.166.0');assert.equal(E.parseVersion('PRIVATE-KEY'),null);});
test('PATH discovery never executes the located client',t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'probe-test-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));fs.writeFileSync(path.join(d,'codex'),'#!/bin/sh\nexit 88\n',{mode:0o700});assert.equal(E.find('codex',{PATH:d}),path.join(d,'codex'));assert.equal(E.find('claude',{PATH:d}),null);assert.throws(()=>E.find('shell'),/UNKNOWN_CLIENT/);});
test('valid version is never authentication or permission to launch',()=>{const r=E.readiness({clients:{codex:{status:'VERSION_ONLY_VERIFIED',version:'0.166.0'}}});assert.equal(r.state,'BLOCKED');assert.ok(r.clients.codex.blockers.includes('BLOCKED_CREDENTIALS'));assert.equal(r.actual_dispatch,false);});
test('old rejected Gate remains blocked even if all other readiness booleans claim ready',()=>{assert.ok(E.readiness({fixedGateSha:'6363e8d10595a566a1ba266cb70017711cc806be',v1AuditAccepted:true,v2AuditAccepted:true,identityVerified:true,nativeLimitsVerified:true,operatorWindowApproved:true}).blockers.includes('WAIT_AUDITED_GATE'));});
test('public PR environment remains untrusted, without inspecting credential values',()=>{const r=E.contextHealth({GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'chaow0879-collab/aijavais',GITHUB_EVENT_NAME:'pull_request'});assert.equal(r.untrusted_event,true);assert.equal(r.secrets_checked,false);});
const request={kind:'codex',branch:'feat/codex-v2-autoexec-v2-stub',sha:'a'.repeat(40),context:'Read-only bounded fixture'};
test('one-shot rehearsal plan is not an execution approval',()=>{const p=plan(request);assert.equal(p.allowed_runs,1);assert.equal(p.sandbox,'read-only');assert.equal(p.actual_dispatch,false);assert.equal(p.authorization,'NOT_GRANTED_BY_PLAN');});
for(const override of [{branch:'main'},{timeout_ms:30001},{max_tokens:513},{max_model_spend:2},{kind:'shell'}])test('unsafe rehearsal option rejected '+Object.keys(override)[0],()=>assert.throws(()=>plan({...request,...override}),/INVALID_REHEARSAL/));
test('missing client cannot be hidden by other readiness checks',()=>{const r=E.readiness({fixedGateSha:'b'.repeat(40),v1AuditAccepted:true,v2AuditAccepted:true,identityVerified:true,nativeLimitsVerified:true,operatorWindowApproved:true});assert.equal(r.state,'BLOCKED');assert.ok(r.clients.claude.blockers.includes('CLIENT_VERSION_UNVERIFIED'));});
for(const override of [{branch:'feat/'},{branch:'feat/.hidden'},{branch:'feat/a.lock'},{branch:'feat/name.'},{branch:'feat/a//b'},{context:'   '},{context:'界'.repeat(3000)}])test('malformed rehearsal data rejected '+JSON.stringify(Object.keys(override)),()=>assert.throws(()=>plan({...request,...override}),/INVALID_REHEARSAL/));
const {execFileSync}=require('node:child_process'),entry=path.resolve(__dirname,'../../agent-executor/runner-entry.js');
function fakeProbe(t,script){
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'fixed-version-fixture-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));
 fs.writeFileSync(path.join(d,'codex'),'#!'+process.execPath+'\n'+script,{mode:0o700});
 // Runner receives synthetic sentinels; probe child must not inherit them. Never real credentials.
 return JSON.parse(execFileSync(process.execPath,[entry,'--probe'],{encoding:'utf8',env:{PATH:d,LANG:'C.UTF-8',OPENAI_API_KEY:'SYNTHETIC_PROBE_SENTINEL',ANTHROPIC_API_KEY:'SYNTHETIC_PROBE_SENTINEL'},timeout:10000}));
}
test('version subprocess uses only fixed argument and never exposes raw output or environment secrets',t=>{
 const r=fakeProbe(t,"if(process.argv.slice(2).join(' ')!=='--version')process.exit(9);if(process.env.OPENAI_API_KEY||process.env.ANTHROPIC_API_KEY)process.exit(8);console.log('fixture-cli 1.2.3 PRIVATE_FIXTURE_SENTINEL');");
 assert.equal(r.clients.codex.version,'1.2.3');assert.equal(r.clients.codex.status,'VERSION_ONLY_VERIFIED');assert.equal(r.clients.codex.authenticated,'NOT_VERIFIED');assert.equal(r.clients.claude.status,'CLIENT_NOT_INSTALLED');assert.doesNotMatch(JSON.stringify(r),/PRIVATE_FIXTURE_SENTINEL/);assert.equal(r.actual_dispatch,false);
});
test('failed version subprocess is not a verified installed client',t=>{
 const r=fakeProbe(t,"console.error('PRIVATE_FIXTURE_SENTINEL');process.exit(7);");assert.equal(r.clients.codex.status,'VERSION_PROBE_FAILED');assert.ok(r.clients.codex.blockers.includes('CLIENT_VERSION_UNVERIFIED'));assert.doesNotMatch(JSON.stringify(r),/PRIVATE_FIXTURE_SENTINEL/);
});
test('ambiguous runner modes fail closed before launching any process',async()=>{const {main}=require('../../agent-executor/runner-entry');for(const args of [['--probe','--stub'],['--plan'],['--stub','extra'],['--anything']])await assert.rejects(main(args),/INVALID_RUNNER_ARGUMENTS/);});
test('plan JSON failures have accurate safe errors and do not masquerade as a gate error',async t=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'plan-input-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));const input=path.join(d,'input.json');fs.writeFileSync(input,'PRIVATE_FIXTURE_SENTINEL');const {main}=require('../../agent-executor/runner-entry');await assert.rejects(main(['--plan',input]),/INVALID_PLAN_INPUT/);
 try{execFileSync(process.execPath,[entry,'--plan',input],{encoding:'utf8',stdio:['ignore','pipe','pipe']});assert.fail('must exit nonzero');}catch(e){const r=JSON.parse(e.stdout);assert.equal(e.status,2);assert.equal(r.reason,'INVALID_PLAN_INPUT');assert.equal(r.actual_agent_launches,0);assert.doesNotMatch(e.stdout,/PRIVATE_FIXTURE_SENTINEL/);}
});
test('valid plan can be created and inspected without calling a model',async t=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'plan-input-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));const input=path.join(d,'input.json');fs.writeFileSync(input,JSON.stringify(request));const {main}=require('../../agent-executor/runner-entry');assert.deepEqual(await main(['--plan',input]),plan(request));
});
