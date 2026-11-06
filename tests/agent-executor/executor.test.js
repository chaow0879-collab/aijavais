'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawn,spawnSync}=require('node:child_process'),{once}=require('node:events');
const {demo}=require('../../tools/agent-executor/demo'),{Executor}=require('../../tools/agent-executor/engine'),{Store}=require('../../tools/agent-executor/store'),{FakeAdapter,realDispatch,readOnlyRetry}=require('../../tools/agent-executor/adapters'),P=require('../../tools/agent-executor/policy'),{main}=require('../../tools/agent-executor/cli');
function fixture(t,phase='integration',kind='claude'){
 const d=demo(phase,kind),dir=fs.mkdtempSync(path.join(os.tmpdir(),'executor-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir),engine=new Executor(d.policy,store);
 const f={...d,dir,store,engine};
 f.run=(script=[{type:'result',tokens:1,elapsed:1}])=>f.engine.run(f.request,f.approval,f.snapshot,new FakeAdapter(kind,f.policy[kind==='codex'?'CODEX_EXEC_BACKEND':'CLAUDE_EXEC_BACKEND'],script),f.now);
 return f;
}
for(const [phase,kind] of [['integration','claude'],['audit','codex'],['qa','codex']])test('Fake track '+phase+' reaches simulated success only',t=>{
 const f=fixture(t,phase,kind),r=f.run();assert.equal(r.state,'SUCCESS');assert.equal(r.actual_dispatch,false);assert.equal(r.actual_launches,0);assert.equal(r.model_spend,null);
 const s=f.store.snapshot();assert.deepEqual(s.audit.map(a=>a.type),['CLAIMED','RUNNING','HEARTBEAT','SUCCESS']);assert.equal(Object.values(s.jobs)[0].actual_cost,null);
});
for(const flag of P.FLAGS)test('real switch '+flag+' cannot be enabled',()=>{assert.throws(()=>new Executor({...require('../../tools/agent-executor/config.json'),[flag]:true},null),/DISABLED/);});
for(const key of ['cron_enabled','webhook_enabled'])test('no '+key+' registration',()=>{assert.throws(()=>new Executor({...require('../../tools/agent-executor/config.json'),[key]:true},null),/DISABLED/);});
test('environment switch also cannot override OFF',()=>{assert.throws(()=>P.disabled(require('../../tools/agent-executor/config.json'),{AIJAVAIS_DISPATCH_ENABLED:'true'}),/DISABLED/);});
const mutations=[
 ['unsigned approval',f=>f.approval.signature='invalid'],
 ['expired approval',f=>{f.payload.expires_at=f.now;f.approval=f.sign();}],
 ['changed issue body',f=>f.request.context.task='modified'],
 ['unapproved repo',f=>{f.request.repo='evil/repo';f.payload.repo=f.request.repo;f.approval=f.sign();}],
 ['unapproved issue',f=>{f.request.issue=999;f.payload.issue=999;f.approval=f.sign();}],
 ['main branch',f=>{f.request.branch='main';f.payload.branch='main';f.approval=f.sign();}],
 ['non fast forward',f=>f.request.fast_forward=false],
 ['dirty workspace',f=>f.request.clean_workspace=false],
 ['ref force changed',f=>f.snapshot.refs[f.request.branch]='4'.repeat(40)],
 ['unapproved identity',f=>{f.payload.identity.actor='other';f.approval=f.sign();}],
 ['missing limits',f=>{delete f.payload.max_tokens;f.approval=f.sign();}],
 ['unapproved role',f=>f.request.role='deploy'],
 ['unknown GitHub source',f=>f.snapshot.complete=false],
 ['GitHub delayed stale source',f=>f.snapshot.checked_at=0],
 ['CI rerun in progress',f=>f.snapshot.runs[0].status='in_progress'],
 ['CI failure',f=>f.snapshot.runs[0].conclusion='failure'],
 ['historical SHA',f=>f.request.sha='a'.repeat(40)],
 ['CLAIMED package not repeated',f=>f.snapshot.issues[15].comments[0].body=f.snapshot.issues[15].comments[0].body.replace('READY_FOR_REVIEW','CLAIMED')],
 ['RUNNING package not repeated',f=>f.snapshot.issues[15].comments[0].body=f.snapshot.issues[15].comments[0].body.replace('READY_FOR_REVIEW','RUNNING')]
];
for(const [name,mutate] of mutations)test(name+' blocks without Fake launch',t=>{const f=fixture(t);mutate(f);const r=f.run();assert.equal(r.state,'BLOCKED');assert.deepEqual(r.would_launch,[]);assert.equal(r.actual_dispatch,false);assert.equal(Object.keys(f.store.snapshot().jobs).length,0);});
test('duplicate event and CI rerun do not repeat across executor restart',t=>{
 const f=fixture(t);assert.equal(f.run().state,'SUCCESS');const e=new Executor(f.policy,new Store(f.dir));const r=e.run({...f.request,event_id:'another-event'},f.approval,f.snapshot,new FakeAdapter('claude','cli',[{type:'result'}]),f.now);
 assert.equal(r.reason,'DUPLICATE_JOB');assert.equal(r.would_launch.length,0);assert.equal(Object.keys(f.store.snapshot().jobs).length,1);
});
test('one role remains busy while unfinished Fake job held',t=>{
 const f=fixture(t);f.store.claim(f.request,f.payload,f.now);const another={...f.request,approval_version:'new'};assert.equal(f.store.claim(another,f.payload,f.now).blocked,'ROLE_BUSY');
});
for(const [name,event] of [['tokens',{tokens:101}],['runtime',{elapsed:101}],['money',{spend:1}]])test('hard Fake '+name+' cap prevents accepting over-limit event',t=>{
 const f=fixture(t),r=f.run([{type:'progress',...event},{type:'result'}]);assert.equal(r.state,'BLOCKED');assert.equal(r.reason,'FAKE_LIMIT_EXCEEDED');assert.equal(r.actual_dispatch,false);
 const j=Object.values(f.store.snapshot().jobs)[0];assert.ok(j.used_tokens<=100);assert.equal(j.actual_cost,null);
});
test('daily simulated reservation prevents concurrent overcommit',t=>{
 const f=fixture(t),limits={...f.payload,max_model_spend:2,max_daily_model_spend:2};f.store.claim(f.request,limits,f.now);
 assert.equal(f.store.claim({...f.request,role:'audit',approval_version:'other'},limits,f.now).blocked,'DAILY_BUDGET');
});
test('Fake fail persists evidence; no automatic code retry',t=>{const f=fixture(t);const r=f.run([{type:'fail'}]);assert.equal(r.state,'FAILED');assert.equal(f.run().reason,'DUPLICATE_JOB');assert.ok(f.store.snapshot().audit.some(e=>e.type==='FAILED'));});
test('Fake incomplete retains unknown and reservation until human review',t=>{const f=fixture(t),r=f.run([{type:'progress'}]);assert.equal(r.state,'HUMAN_REVIEW_REQUIRED');assert.equal(f.run().reason,'DUPLICATE_JOB');});
test('stop switch and scripted stop never kill real processes or launch new work',t=>{const f=fixture(t);assert.equal(f.run([{type:'stop'}]).state,'STOPPED');f.engine.stop();assert.equal(f.run().reason,'STOP_SWITCH');});
test('read-only retries bounded at one; execution adapter has no retry path',()=>{assert.deepEqual(readOnlyRetry([403,200,200],99),{calls:2,ok:true,actual_dispatch:false});assert.equal(readOnlyRetry([429,429,200]).calls,2);assert.throws(realDispatch,/DISABLED/);});
test('arbitrary adapters rejected without invoking injected callback',t=>{const f=fixture(t);let called=false;const r=f.engine.run(f.request,f.approval,f.snapshot,{events(){called=true;}},f.now);assert.equal(r.reason,'FAKE_ONLY');assert.equal(called,false);});
test('corrupt simulation snapshot fails closed with no Fake launch',t=>{const f=fixture(t);fs.writeFileSync(f.store.file,'corrupt',{mode:0o600});assert.deepEqual(f.run().would_launch,[]);});
test('stale transaction lock requires human review without deletion',t=>{const f=fixture(t);fs.writeFileSync(f.store.lock,'');fs.utimesSync(f.store.lock,0,0);const r=f.run();assert.equal(r.reason,'STALE_STORE_LOCK_HUMAN_REVIEW');assert.ok(fs.existsSync(f.store.lock));});
test('heartbeat expiry does not free potentially interrupted job or replay',t=>{const f=fixture(t);const first=f.store.claim(f.request,f.payload,f.now);f.store.transition(first.key,'RUNNING',f.now);const next=f.store.claim({...f.request,approval_version:'new'},f.payload,f.now+700000);assert.equal(next.blocked,'ROLE_BUSY');assert.equal(f.store.snapshot().jobs[first.key].state,'HUMAN_REVIEW_REQUIRED');});
test('default entry disabled; backend availability never asserts credentials',()=>{const r=main([]);assert.equal(r.state,'DISABLED');assert.equal(r.actual_dispatch,false);assert.equal(r.inventory.codex.credentials,'BLOCKED_CREDENTIALS');assert.equal(r.inventory.model_spend,null);});
test('enablement cannot skip stages or actually arm',()=>{assert.equal(P.previewEnablement('DRY_RUN','AUTHORIZED_DISPATCH',{v1_audit:true,v2_audit:true,user_authorized:true}).would_transition,false);const r=P.previewEnablement('DRY_RUN','ARMED_READ_ONLY',{v1_audit:true,v2_audit:true,user_authorized:true});assert.equal(r.would_transition,true);assert.equal(r.actual_stage,'DRY_RUN');});
test('sensitive context or simulated error text absent from outputs and audit',t=>{const f=fixture(t);f.request.context.task='PRIVATE-TOKEN';const r=f.run([{type:'fail',error:'PRIVATE-TOKEN'}]);assert.doesNotMatch(JSON.stringify({r,log:f.store.snapshot().audit}),/PRIVATE-TOKEN/);});
test('adapter backend modes are Stub-only',t=>{for(const backend of ['cli','sdk','cloud_approved']){const f=fixture(t);f.policy.CLAUDE_EXEC_BACKEND=backend;const r=new Executor(f.policy,f.store).run(f.request,f.approval,f.snapshot,new FakeAdapter('claude',backend,[{type:'result'}]),f.now);assert.equal(r.state,'SUCCESS');assert.equal(r.actual_dispatch,false);}});
test('no runtime process or network launch APIs in executor code',()=>{for(const file of fs.readdirSync(path.resolve(__dirname,'../../tools/agent-executor')).filter(f=>f.endsWith('.js'))){const text=fs.readFileSync(path.resolve(__dirname,'../../tools/agent-executor',file),'utf8');assert.doesNotMatch(text,/child_process|fetch\s*\(|https?\.request|setInterval\s*\(|setTimeout\s*\(|require\(['"](?:@anthropic|@openai)/);}});
test('four competing processes claim a job once without launching any Agent',async t=>{
 const f=fixture(t),worker=path.join(__dirname,'process-child.cjs');
 const run=()=>new Promise((resolve,reject)=>{const env={...process.env};delete env.NODE_TEST_CONTEXT;const c=spawn(process.execPath,[worker,'claim',f.dir],{env});let data='';c.stdout.on('data',b=>data+=b);c.on('error',reject);c.on('exit',n=>n===0?resolve(JSON.parse(data)):reject(Error('test child failed')));});
 const r=await Promise.all([run(),run(),run(),run()]);assert.equal(r.filter(x=>!x.blocked).length,1);assert.equal(Object.keys(f.store.snapshot().jobs).length,1);
});
test('SIGKILL of simulated RUNNING process recovers unknown, keeps reservation and rejects replay',async t=>{
 const f=fixture(t),env={...process.env};delete env.NODE_TEST_CONTEXT;
 const child=spawn(process.execPath,[path.join(__dirname,'process-child.cjs'),'crash',f.dir],{env});let data='';
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture timeout')),10000);child.stdout.on('data',b=>{data+=b;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data));}});child.on('error',reject);});
 const exit=once(child,'exit');child.kill('SIGKILL');await exit;
 f.store.transaction(s=>f.store.recover(s,Date.now()));const state=f.store.snapshot(),j=state.jobs[ready.key];
 assert.equal(j.state,'HUMAN_REVIEW_REQUIRED');assert.equal(j.actual_cost,null);assert.equal(j.reserved,2);
 const request={repo:P.REPO,issue:22,role:'audit',phase:'audit',sha:'1'.repeat(40),approval_version:'fake-1'};
 assert.equal(f.store.claim(request,{max_model_spend:2,max_daily_model_spend:10},Date.now()).blocked,'DUPLICATE_JOB');
 assert.equal(state.audit.filter(e=>e.type==='RECOVERED_UNKNOWN').length,1);
});
test('unexpected source comment edit remains denied even when gate summary unchanged',t=>{
 const f=fixture(t);f.snapshot.issues[22].comments.push({body:'changed task'});assert.equal(f.run().reason,'SOURCE_REVISION_CHANGED');
});
test('active formal audit is not launched again from AUDITING gate',t=>{
 const f=fixture(t,'audit','codex'),c={user:{login:'audit'},author_association:'OWNER',html_url:'https://github.com/FAKE/audit',body:'[AGENT_REPORT_V1]\nrole: CodeAudit\nstatus: RUNNING\nreviewed_sha: '+f.request.sha+'\n[/AGENT_REPORT_V1]'};
 f.snapshot.issues[2].comments.push(c);f.payload.source_digest=P.digest(f.snapshot);f.payload.gate_digest=P.gateDigest(require('../../tools/agent-scheduler/state').evaluate(f.snapshot,f.policy.gate_config,f.now));f.approval=f.sign();
 assert.equal(f.run().reason,'ROLE_ALREADY_RUNNING');
});
test('store failure before dispatch marker prevents Fake launch and preserves claim',t=>{
 const f=fixture(t),write=fs.writeFileSync;let calls=0;
 try{fs.writeFileSync=(...args)=>{if(++calls===2)throw Object.assign(Error('disk'),{code:'ENOSPC'});return write(...args);};const r=f.run();assert.equal(r.state,'HUMAN_REVIEW_REQUIRED');assert.deepEqual(r.would_launch,[]);}finally{fs.writeFileSync=write;}
 assert.equal(Object.values(f.store.snapshot().jobs)[0].state,'CLAIMED');
});
test('whole Fake integration→audit→QA track has three durable successes, zero actual launches',t=>{
 const f=fixture(t),results=[];
 for(const [phase,kind] of [['integration','claude'],['audit','codex'],['qa','codex']]){
  const d=demo(phase,kind,f.now),r=new Executor(d.policy,f.store).run(d.request,d.approval,d.snapshot,new FakeAdapter(kind,'cli',[{type:'result'}]),d.now);
  assert.equal(r.state,'SUCCESS');assert.equal(r.actual_dispatch,false);results.push(r);
 }
 assert.equal(Object.keys(f.store.snapshot().jobs).length,3);assert.equal(results.reduce((n,r)=>n+r.actual_launches,0),0);
});
test('new QA critical failure stops at human review even with a new signed Fake request',t=>{
 const f=fixture(t,'qa','codex');f.snapshot.issues[4].comments.push({user:{login:'qa'},author_association:'OWNER',html_url:'https://github.com/FAKE/qa',body:'[AGENT_REPORT_V1]\nrole: ProductQA\nstatus: READY_FOR_REVIEW\nreviewed_sha: '+f.request.sha+'\nverdict: FAIL\nt2_complete: false\n[/AGENT_REPORT_V1]'});
 f.payload.source_digest=P.digest(f.snapshot);f.payload.gate_digest=P.gateDigest(require('../../tools/agent-scheduler/state').evaluate(f.snapshot,f.policy.gate_config,f.now));f.approval=f.sign();
 const r=f.run();assert.equal(r.reason,'HUMAN_REVIEW_REQUIRED');assert.deepEqual(r.would_launch,[]);
});
test('unknown or uppercase enable flags cannot bypass OFF',()=>{for(const value of ['TRUE','yes','unexpected'])assert.throws(()=>P.disabled(require('../../tools/agent-executor/config.json'),{AIJAVAIS_DISPATCH_ENABLED:value}),/DISABLED/);});
test('malformed negative/fractional/nonfinite fake usage rejected',()=>{for(const tokens of [-1,0.5,Infinity])assert.throws(()=>new FakeAdapter('codex','cli',[{type:'result',tokens}]),/INVALID_FAKE_USAGE/);});
