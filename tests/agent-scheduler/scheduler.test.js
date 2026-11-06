const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {evaluate,parse}=require('../../tools/agent-scheduler/state'),{collect,githubGet}=require('../../tools/agent-scheduler/github'),{PlanStore,dispatchAgent}=require('../../tools/agent-scheduler/lease'),{main}=require('../../tools/agent-scheduler/cli');
const F=require('./fixtures.cjs');
const edit=(s,issue,field,value)=>{const c=s.issues[issue].comments[0];c.body=c.body.replace(new RegExp('^'+field+':.*$','m'),field+': '+(typeof value==='string'?value:JSON.stringify(value)));};
const cases=[
 ['T01 peer RUNNING',s=>edit(s,17,'status','RUNNING')],
 ['T02 CI in progress',s=>s.runs[0].status='in_progress'],
 ['T03 wrong ref',s=>s.refs.codex=F.sha(9)],
 ['T04 short SHA',s=>edit(s,15,'head_sha','abc')],
 ['T05 skipped security step',s=>s.runs[0].jobs[0].steps[0].conclusion='skipped'],
 ['T06 PASS prose',s=>s.issues[15].comments[0].body='PASS everything'],
 ['T07 preparation is not audit',s=>edit(s,2,'status','PRE_AUDIT_PREPARED')],
 ['T08 old audit SHA',s=>edit(s,2,'reviewed_sha',F.BASE)],
 ['T09 old QA SHA',s=>edit(s,4,'reviewed_sha',F.BASE)],
 ['T10 T2 incomplete',s=>edit(s,4,'t2_complete',false)],
 ['T11 E4/E5 plan only',s=>edit(s,4,'e4','PLAN_ONLY')],
 ['T12 P1 independent report',s=>s.issues[2].comments.push(F.comment('audit',{role:'CodeAudit',status:'OPEN',severity:'P1'}))],
 ['T13 incomplete source',s=>s.complete=false],
 ['T17 HTTP success Chromium fail',s=>{s.runs[2].conclusion='failure';s.runs[2].jobs[1].conclusion='failure';}],
 ['untrusted report author',s=>s.issues[15].comments[0].user.login='attacker'],
 ['missing milestone',s=>edit(s,15,'completed_milestones',['M1'])],
 ['no integration candidate',s=>s.issues[10].comments=s.issues[10].comments.filter(c=>c.user.login!=='integrator')],
 ['stale snapshot',s=>s.checked_at=0],
 ['unknown charges',s=>s.issues[2].comments.push(F.comment('audit',{role:'CodeAudit',unknown_cost:true}))]
];
for(const [name,mutate] of cases)test(name,()=>{const s=F.positive();mutate(s);const r=evaluate(s,F.config);assert.notEqual(r.state,'READY_FOR_HUMAN_GATE');assert.equal(r.actual_dispatch,false);assert.ok(r.missing_gates.length);});
test('complete strictly authorized evidence reaches human gate only',()=>{const r=evaluate(F.positive(),F.config);assert.equal(r.state,'READY_FOR_HUMAN_GATE');assert.equal(r.actual_dispatch,false);assert.deepEqual(r.would_dispatch,[]);});
test('T18 cancelled timers stay disabled and Agent interface throws',async()=>{assert.equal((await main([])).state,'DISABLED');assert.equal(require('../../tools/agent-scheduler/config.json').enabled,false);assert.throws(dispatchAgent,/DISABLED/);});
test('known round24 facts never accepted',()=>{const r=evaluate(F.knownFacts(),F.config);assert.notEqual(r.state,'READY_FOR_HUMAN_GATE');});
test('T13 GitHub 403/429/timeout malformed or incomplete pagination fail closed',async()=>{
 for(const status of [403,429,'timeout']) {const s=await collect(async()=>{throw Error(String(status));});assert.equal(s.complete,false);assert.equal(evaluate(s,F.config).state,'BLOCKED');}
 const s=await collect(async route=>{const n=Number(route.match(/issues\/(\d+)$/)?.[1]);if(n)return{data:{number:n,body:'issue'}};return{data:[],next:true};});assert.equal(s.complete,false);
 assert.throws(()=>githubGet('repos/evil/repo/issues/1'),/REJECTED/);
});
function area(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'scheduler-test-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
test('T14 duplicate events and restart cannot enlarge simulation',t=>{const d=area(t),plan={issue:15,role:'codex',phase:'ready',sha:F.sha(1)};assert.equal(new PlanStore(d).claim(plan).would_dispatch,true);assert.equal(new PlanStore(d).claim(plan).would_dispatch,false);});
test('T15 expired leases and stale locks require human review without reissue',t=>{const d=area(t),store=new PlanStore(d,10),p={issue:15,role:'codex',phase:'ready',sha:F.sha(1)};store.claim(p,1);assert.match(store.claim(p,99).warning,/EXPIRED/);fs.writeFileSync(store.lock,'x');fs.utimesSync(store.lock,0,0);assert.match(store.claim({...p,sha:F.sha(2)},99999).warning,/STALE/);});
test('T16 separate process races produce only one plan',async t=>{
 const d=area(t),modulePath=path.resolve(__dirname,'../../tools/agent-scheduler/lease.js');
 const code=`const {PlanStore}=require(${JSON.stringify(modulePath)});console.log(JSON.stringify(new PlanStore(process.argv[1]).claim({issue:15,role:'codex',phase:'ready',sha:'${F.sha(1)}'})))`;
 const run=()=>new Promise((resolve,reject)=>{const env={...process.env};delete env.NODE_TEST_CONTEXT;const c=spawn(process.execPath,['-e',code,d],{env});let out='';c.stdout.on('data',b=>out+=b);c.on('error',reject);c.on('exit',n=>n===0?resolve(JSON.parse(out)):reject(Error('child failed')));});
 const results=await Promise.all([run(),run(),run(),run()]);assert.equal(results.filter(r=>r.would_dispatch).length,1);assert.ok(results.every(r=>r.actual_dispatch===false));
});
test('duplicate fields, identity conflicts and missing policy fail closed',()=>{assert.equal(parse('[AGENT_REPORT_V1]\nstatus: A\nstatus: B\n[/AGENT_REPORT_V1]','AGENT_REPORT_V1'),null);assert.equal(evaluate(F.positive(),{...F.config,required_jobs:[]}).state,'BLOCKED');assert.equal(evaluate(F.positive(),{...F.config,trustedActors:{...F.config.trustedActors,audit:['codex']}}).state,'BLOCKED');});
test('collector completes read-only paginated source with exact run jobs',async()=>{
 const routes=[];
 const snapshot=await collect(async route=>{
  routes.push(route);
  const issue=route.match(/issues\/(\d+)$/);if(issue)return{data:{number:Number(issue[1]),body:'fixture'}};
  if(route.includes('/comments?'))return{data:[],next:false};
  if(route.includes('/matching-refs/'))return{data:[{ref:'refs/heads/fixture',object:{sha:F.sha(1)}}],next:false};
  if(route.includes('/pulls?'))return{data:[],next:false};
  if(route.includes('/jobs?'))return{data:{total_count:1,jobs:[{name:'tests',status:'completed',conclusion:'success',steps:[]}]},next:false};
  return{data:{total_count:1,workflow_runs:[{id:123,head_sha:F.sha(1),status:'completed'}]},next:false};
 });
 assert.equal(snapshot.complete,true);assert.equal(snapshot.runs[0].jobs.length,1);assert.ok(routes.every(p=>p.startsWith('repos/chaow0879-collab/aijavais/')));
});
test('pagination total count mismatch is UNKNOWN',async()=>{
 const s=await collect(async route=>{const m=route.match(/issues\/(\d+)$/);if(m)return{data:{number:Number(m[1]),body:'fixture'}};if(route.includes('comments')||route.includes('pulls')||route.includes('matching-refs'))return{data:[],next:false};return{data:{total_count:2,workflow_runs:[]},next:false};});
 assert.equal(s.complete,false);
});
test('T14 repeated comments and workflow events produce no additional would_dispatch across CLI restarts',async t=>{
 const d=area(t),s=F.positive();s.issues[10].comments=s.issues[10].comments.filter(c=>c.user.login!=='integrator');
 const fixture=path.join(d,'fixture.json'),policy=path.join(d,'config.json');fs.writeFileSync(fixture,JSON.stringify(s));fs.writeFileSync(policy,JSON.stringify(F.config));
 const args=['--once','--fixture',fixture,'--config',policy,'--simulate-plan','--state-dir',d];
 const a=await main(args);assert.equal(a.would_dispatch.length,1);
 s.issues[15].comments.push(s.issues[15].comments[0]);s.runs.push(s.runs[0]);fs.writeFileSync(fixture,JSON.stringify(s));
 const b=await main(args);assert.equal(b.would_dispatch.length,0);assert.equal(b.actual_dispatch,false);
});
test('Planner grants with no bound SHA cannot authorize integration',()=>{
 const s=F.positive();for(const c of s.issues[10].comments)if(c.user.login==='planner')c.body=c.body.replace(/^candidate_sha:.*\n/gm,'');
 const r=evaluate(s,F.config);assert.equal(r.state,'BLOCKED');assert.match(r.missing_gates[0],/AUTHORIZATION/);
});
test('integration role has exactly one designated identity',()=>{
 const config={...F.config,trustedActors:{...F.config.trustedActors,integrator:['first','second']}};
 assert.equal(evaluate(F.positive(),config).missing_gates[0],'NO_UNIQUE_INTEGRATOR');
});
test('ambiguous repeated report blocks rejected',()=>{const body=F.comment('codex',{role:'Codex',status:'READY'}).body;assert.equal(parse(body+'\n'+body,'AGENT_REPORT_V1'),null);});
test('preparation base-only authorization cannot authorize final audit',()=>{
 const s=F.positive();edit(s,2,'base_sha',F.BASE);s.issues[2].comments[0].body+='\n';
 // Add base to report and replace exact candidate grant with preparation-only base.
 s.issues[2].comments[0].body=s.issues[2].comments[0].body.replace('[/AGENT_REPORT_V1]','base_sha: '+F.BASE+'\n[/AGENT_REPORT_V1]');
 const g=s.issues[10].comments.find(c=>c.body.includes('authorized_role: audit'));g.body=g.body.replace(/^candidate_sha:.*$/m,'base_sha: '+F.BASE);
 assert.notEqual(evaluate(s,F.config).state,'READY_FOR_HUMAN_GATE');
});
