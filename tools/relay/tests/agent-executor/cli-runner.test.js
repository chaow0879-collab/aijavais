'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const LIVE_SCOPE={repo:'chaow0879-collab/aijavais',issue:22,allowed_issues:[22],branch:'feat/test',allowed_branches:['feat/test']};
const R=require('../../agent-executor/cli-runner'),W=require('../../agent-executor/workspace'),{digest,canonical}=require('../../agent-executor/policy');
const temp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'runner-test-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
test('real implementation stays closed even with forged enablement data',async()=>{await assert.rejects(R.runLive({enabled:true},{approved:true},{},{}),/LIVE_BUILD_DISABLED/);});
for(const kind of ['codex','claude'])test('build '+kind+' command without shell or sandbox bypass',()=>{const c=R.buildCommand(kind,{max_tokens:100,max_model_spend:1});assert.equal(c.executable,kind);assert.ok(c.args.includes(kind==='codex'?'exec':'-p'));assert.ok(!c.args.some(a=>/dangerously|bypass/.test(a)));});
test('unknown engine and missing limit rejected',()=>{assert.throws(()=>R.buildCommand('shell',{}));assert.throws(()=>R.buildCommand('codex',{max_tokens:-1,max_model_spend:1}));});
test('Stub child success and exit code preserved; actual Agent launches=0',async t=>{const r=await R.runStub({mode:'success'},{cwd:temp(t)});assert.equal(r.state,'SUCCESS');assert.equal(r.exitCode,0);assert.equal(r.actual_dispatch,false);assert.equal(r.actual_agent_launches,0);});
test('Stub failure preserves exit code safely',async t=>{const r=await R.runStub({mode:'fail'},{cwd:temp(t)});assert.equal(r.state,'FAILED');assert.equal(r.exitCode,3);});
test('bounded Stub watchdog terminates and reaps hung process',async t=>{const r=await R.runStub({mode:'hang'},{cwd:temp(t),timeoutMs:60});assert.equal(r.state,'BLOCKED');assert.equal(r.reason,'TIMEOUT');assert.ok(r.elapsed_ms<2000);assert.ok(r.exitSignal);});
test('explicit stop aborts only the owned Stub',async t=>{const controller=new AbortController();const p=R.runStub({mode:'hang'},{cwd:temp(t),signal:controller.signal,timeoutMs:1000});controller.abort();const r=await p;assert.equal(r.state,'STOPPED');assert.equal(r.actual_dispatch,false);});
test('stdout/stderr secrets redacted with raw output never persisted',async t=>{const secret='PRIVATE_STUB_TOKEN';const r=await R.runStub({mode:'secret',secret},{cwd:temp(t),secrets:[secret]});assert.doesNotMatch(JSON.stringify(r),/PRIVATE_STUB_TOKEN/);assert.match(r.stdout,/REDACTED/);assert.equal(r.raw_output_persisted,false);});
test('output overflow discards raw buffers and terminates child',async t=>{const r=await R.runStub({mode:'output-limit'},{cwd:temp(t),maxOutputBytes:200});assert.equal(r.reason,'OUTPUT_LIMIT');assert.equal(r.stdout,'');assert.equal(r.stderr,'');});
for(const [tokens,spend] of [[101,0],[1,1],[-1,0]])test('reported Stub usage bound '+tokens+'/'+spend+' fails closed',async t=>{const r=await R.runStub({mode:'usage',tokens,spend},{cwd:temp(t),maxTokens:100,maxSpend:0});assert.equal(r.reason,'USAGE_LIMIT');});
test('invalid process bounds cannot create child',()=>{assert.throws(()=>R.runStub({mode:'success'},{timeoutMs:0}),/INVALID_PROCESS_LIMITS/);assert.throws(()=>R.runStub({mode:'anything'}),/INVALID_STUB/);});
test('credential/capability proofs require three signatures and matching manifest',()=>{assert.throws(()=>R.verifyReadiness(LIVE_SCOPE, {},{}),/BLOCKED_READINESS/);});
function proofs(request){const keys={},signed={};for(const role of ['v1_audit','v2_audit','operator']){const pair=crypto.generateKeyPairSync('ed25519');keys[role]={fixture:pair.publicKey.export({type:'spki',format:'pem'})};const payload={role,manifest_digest:digest(request),expires_at:Date.now()+10000,verdict:'ACCEPT',approved:true};signed[role]={key_id:'fixture',payload,signature:crypto.sign(null,Buffer.from(canonical(payload)),pair.privateKey).toString('base64')};}return {keys,signed};}
test('known rejected V1 SHA blocked even with synthetic valid signatures',()=>{const r={...LIVE_SCOPE,fixed_gate_sha:'6363e8d10595a566a1ba266cb70017711cc806be'},p=proofs(r);assert.throws(()=>R.verifyReadiness(r,p.signed,p.keys),/BLOCKED_GATE/);});
test('unverified CLI credentials/native spend caps cannot be assumed usable',()=>{const r={...LIVE_SCOPE,fixed_gate_sha:'a'.repeat(40)},p=proofs(r);assert.throws(()=>R.verifyReadiness(r,p.signed,p.keys),/CREDENTIALS_OR_LIMIT/);});
test('source workspace is a clean exact SHA clone; cleanup cannot delete arbitrary paths',t=>{
 const source=temp(t);const git=(args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:source,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(['init']);fs.writeFileSync(path.join(source,'test.txt'),'fixture');git(['add','.']);git(['commit','-m','fixture']);const sha=git(['rev-parse','HEAD']);
 const workspace=W.prepare(source,'feat/isolated-stub',sha);assert.equal(W.health(workspace).sha,sha);assert.equal(W.health(workspace).clean,true);
 fs.writeFileSync(path.join(workspace.dir,'test.txt'),'changed');assert.equal(fs.readFileSync(path.join(source,'test.txt'),'utf8'),'fixture');assert.equal(W.health(workspace).clean,false);assert.throws(()=>W.verifyChanges(workspace,'audit',['test.txt']),/SCOPE/);assert.throws(()=>W.verifyChanges(workspace,'qa',['test.txt']),/SCOPE/);assert.equal(W.verifyChanges(workspace,'developer',['test.txt']),true);
 assert.throws(()=>W.cleanup({root:source}),/UNKNOWN_WORKSPACE/);W.cleanup(workspace);assert.equal(fs.existsSync(workspace.root),false);assert.equal(fs.existsSync(source),true);
 fs.writeFileSync(path.join(source,'test.txt'),'dirty');assert.throws(()=>W.prepare(source,'feat/another',sha),/SOURCE_NOT_PINNED_CLEAN/);assert.throws(()=>W.prepare(source,'main',sha),/INVALID_WORKSPACE/);
});
test('public PR workflows cannot expose model credentials or activate timers',()=>{
 const root=path.resolve(__dirname,'../../../../.github/workflows');const text=fs.readFileSync(path.join(root,'agent-executor-v2.yml'),'utf8');assert.doesNotMatch(text,/secrets\.|pull_request_target|schedule:|workflow_run:/);assert.match(text,/contents: read/);
});
test('three readiness signatures cannot be signed with one reused identity',()=>{
 const request={...LIVE_SCOPE,fixed_gate_sha:'a'.repeat(40)},pair=crypto.generateKeyPairSync('ed25519'),pem=pair.publicKey.export({type:'spki',format:'pem'}),keys={},signed={};
 for(const role of ['v1_audit','v2_audit','operator']){keys[role]={fixture:pem};const payload={role,manifest_digest:digest(request),expires_at:Date.now()+10000,verdict:'ACCEPT',approved:true};signed[role]={key_id:'fixture',payload,signature:crypto.sign(null,Buffer.from(canonical(payload)),pair.privateKey).toString('base64')};}
 assert.throws(()=>R.verifyReadiness(request,signed,keys),/IDENTITY_CONFLICT/);
});
test('event/schedule template is inert and guards public PR credential boundary',()=>{
 const template=path.resolve(__dirname,'../../agent-executor/templates/hosted-runner.yml.disabled');assert.ok(fs.existsSync(template));const s=fs.readFileSync(template,'utf8');assert.match(s,/head_repository.full_name == github.repository/);assert.match(s,/persist-credentials: false/);assert.doesNotMatch(s,/secrets\./);
});
