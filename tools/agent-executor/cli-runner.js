'use strict';
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {reject,canonical,digest,REPO}=require('./policy');
const LIVE_BUILD_ENABLED=false; // Future audited source revision, never a config/env bypass.
function redact(text,secrets=[]){
 let out=String(text);for(const secret of secrets.filter(v=>typeof v==='string'&&v.length))out=out.split(secret).join('[REDACTED]');
 return out.replace(/Bearer\s+[^\s]+/gi,'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]+/g,'[REDACTED]');
}
function buildCommand(kind,limits,role='developer'){
 if(!['claude','codex'].includes(kind)||!Number.isSafeInteger(limits.max_tokens)||limits.max_tokens<1||!Number.isFinite(limits.max_model_spend)||limits.max_model_spend<0)reject('INVALID_COMMAND_LIMITS');
 return kind==='codex'?{executable:'codex',args:['--ask-for-approval','never','exec','--json','--sandbox',role==='audit'?'read-only':'workspace-write','-'],token_cap:'PROVIDER_ENFORCEMENT_REQUIRED',spend_cap:'PROVIDER_ENFORCEMENT_REQUIRED'}:
 {executable:'claude',args:['-p','--output-format','stream-json','--verbose','--max-turns','1','--max-budget-usd',String(limits.max_model_spend),'--permission-mode',role==='audit'?'plan':'default',...(role==='audit'?['--allowedTools','Read,Glob,Grep']:[])],token_cap:'PROVIDER_ENFORCEMENT_REQUIRED',spend_cap:'CLI_VERSION_VERIFICATION_REQUIRED'};
}
function verifyReadiness(request,proofs,trustedKeys){
 if(!request||!proofs||!trustedKeys)reject('BLOCKED_READINESS');
 if(request.repo!==REPO||!Number.isSafeInteger(request.issue)||!request.allowed_issues?.includes(request.issue)||!/^(?:feat|fix|test|integrate)\/[A-Za-z0-9_./-]+$/.test(request.branch||'')||request.branch.includes('..')||!request.allowed_branches?.includes(request.branch)||request.production===true)reject('LIVE_SCOPE_DENIED');
 const identities=new Set();
 for(const role of ['v1_audit','v2_audit','operator']){
  const p=proofs[role];try{if(!p||!trustedKeys[role]?.[p.key_id]||!crypto.verify(null,Buffer.from(canonical(p.payload)),trustedKeys[role][p.key_id],Buffer.from(p.signature,'base64')))reject('BLOCKED_READINESS');}catch{reject('BLOCKED_READINESS');}
  const identity=crypto.createPublicKey(trustedKeys[role][p.key_id]).export({type:'spki',format:'der'}).toString('base64');if(identities.has(identity))reject('READINESS_IDENTITY_CONFLICT');identities.add(identity);
  if(p.payload.manifest_digest!==digest(request)||p.payload.role!==role||!Number.isSafeInteger(p.payload.expires_at)||p.payload.expires_at<=Date.now())reject('BLOCKED_READINESS');
 }
 if(!/^[a-f0-9]{40}$/.test(request.fixed_gate_sha||'')||request.fixed_gate_sha==='6363e8d10595a566a1ba266cb70017711cc806be'||proofs.v1_audit.payload.verdict!=='ACCEPT'||proofs.v2_audit.payload.verdict!=='ACCEPT'||proofs.operator.payload.approved!==true)reject('BLOCKED_GATE_OR_AUDIT');
 if(request.isolation!=='ephemeral_github_hosted'||request.credentials_verified!==true||request.cli_version_verified!==true||request.native_token_cap_verified!==true||request.native_spend_cap_verified!==true||request.role_scope_verified!==true||request.state_ref_protection_verified!==true)reject('BLOCKED_CREDENTIALS_OR_LIMIT_ENFORCEMENT');
 return true;
}
// Only these two internal call sites can reach process supervision: the fixed
// repository-owned Node Stub, or the unreachable live path below.
function supervise(executable,args,input,options,label){
 const {cwd,timeoutMs=1000,maxOutputBytes=8192,maxTokens=10000,maxSpend=0,secrets=[],signal}=options;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>1048576)reject('INVALID_PROCESS_LIMITS');
 if(label==='live'&&!options.isolation)reject('BLOCKED_OS_WRITE_ISOLATION');
 return new Promise(resolve=>{
  let child,stdout=[],stderr=[],bytes=0,reason=null,finished=false,meterBuffer='';const started=Date.now();
  const env={PATH:process.env.PATH||'',LANG:'C.UTF-8',TMPDIR:process.env.TMPDIR||'/tmp'};
  if(label==='live'){for(const [key,value] of Object.entries(options.credentialEnv||{})){if(!['OPENAI_API_KEY','ANTHROPIC_API_KEY','CODEX_HOME','CLAUDE_CONFIG_DIR'].includes(key)||typeof value!=='string'||value.length>16384)reject('CREDENTIAL_ENV_DENIED');env[key]=value;}}
  let command;
  try{command=options.isolation?require('./workspace-isolation').command(options.isolation,executable,args):{executable,args,cwd,env,stdio:['pipe','pipe','pipe']};child=spawn(command.executable,command.args,{cwd:command.cwd,env:command.env,stdio:command.stdio,shell:false});}catch{resolve({state:'BLOCKED',reason:'BLOCKED_OS_WRITE_ISOLATION',actual_dispatch:false});return;}finally{command?.close?.();}
  let hardKill;
  const terminate=why=>{if(finished)return;reason=reason||why;child.kill('SIGTERM');if(!hardKill)hardKill=setTimeout(()=>{if(!finished)child.kill('SIGKILL');},100);};
  const watchdog=setTimeout(()=>terminate('TIMEOUT'),timeoutMs);
  const abort=()=>terminate('STOPPED');
  if(signal){if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});}
  const capture=(list,chunk)=>{bytes+=chunk.length;if(bytes>maxOutputBytes){stdout=[];stderr=[];terminate('OUTPUT_LIMIT');return;}if(!reason)list.push(chunk);if(list===stdout){meterBuffer+=chunk.toString('utf8');const lines=meterBuffer.split('\n');meterBuffer=lines.pop();for(const line of lines)try{const e=JSON.parse(line);if(e.type==='usage'&&(!Number.isSafeInteger(e.tokens)||e.tokens<0||!Number.isFinite(e.spend)||e.spend<0||e.tokens>maxTokens||e.spend>maxSpend))terminate('USAGE_LIMIT');}catch{/* no commands from output */}}};
  child.stdout.on('data',c=>capture(stdout,c));child.stderr.on('data',c=>capture(stderr,c));
  child.on('error',()=>{reason='SPAWN_FAILED';});
  child.stdin.on('error',()=>{});child.stdin.end(input);
  child.on('close',(exitCode,exitSignal)=>{
   finished=true;clearTimeout(watchdog);clearTimeout(hardKill);signal?.removeEventListener('abort',abort);
   let out=Buffer.concat(stdout).toString('utf8'),err=Buffer.concat(stderr).toString('utf8');
   for(const line of out.split('\n'))try{const e=JSON.parse(line);if(e.type==='usage'&&(!Number.isSafeInteger(e.tokens)||e.tokens<0||!Number.isFinite(e.spend)||e.spend<0||e.tokens>maxTokens||e.spend>maxSpend))reason='USAGE_LIMIT';}catch{/* Never interpret prose as commands or metering. */}
   const state=reason==='STOPPED'?'STOPPED':reason?'BLOCKED':exitCode===0?'SUCCESS':'FAILED';
   resolve({state,reason,exitCode,exitSignal,elapsed_ms:Date.now()-started,stdout:reason||label==='live'?'':redact(out,secrets),stderr:reason||label==='live'?'':redact(err,secrets),raw_output_persisted:false,mode:label,actual_dispatch:label==='stub'?false:true,actual_agent_launches:label==='stub'?0:1});
  });
 });
}
function runStub(scenario,options={}){
 const allowed=['success','hang','fail','secret','output-limit','usage','filesystem-probe'];
 if(!allowed.includes(scenario?.mode))reject('INVALID_STUB_SCENARIO');
 if(scenario.mode==='filesystem-probe'&&!options.isolation)reject('BLOCKED_OS_WRITE_ISOLATION');
 return supervise(process.execPath,[path.join(__dirname,'stub-program.cjs')],JSON.stringify(scenario),{...options,secrets:[...(options.secrets||[]),scenario.secret].filter(Boolean)},'stub');
}
async function runLive(request,proofs,keys,options){
 if(!LIVE_BUILD_ENABLED)reject('LIVE_BUILD_DISABLED');
 verifyReadiness(request,proofs,keys);
 if(!require('./workspace').isolationStatus().available)reject('BLOCKED_OS_WRITE_ISOLATION');
 const {RemoteJobs,LiveGithubRefTransport}=require('./remote-state');
 const remote=new RemoteJobs(new LiveGithubRefTransport(options.controlPlaneToken));
 const claim=await remote.claim(request);if(claim.state!=='CLAIMED')return {state:'BLOCKED',reason:'REMOTE_CLAIM_REQUIRED',actual_dispatch:false};
 if((await remote.update(claim.key,'RUNNING')).state!=='RUNNING')return {state:'BLOCKED',reason:'REMOTE_RUNNING_ACK_REQUIRED',actual_dispatch:false};
 const workspace=require('./workspace');
 const isolated=workspace.prepare(request.source,request.branch,request.sha,{role:request.role});
 try {
  const command=buildCommand(request.kind,request.limits,request.role);
  const isolation=workspace.isolation(isolated,request.role,request.allowed_paths);
  const result=await supervise(command.executable,command.args,request.context,{...options,isolation,cwd:isolated.dir,timeoutMs:request.limits.max_job_runtime,maxTokens:request.limits.max_tokens,maxSpend:request.limits.max_model_spend},'live');
  workspace.verifyChanges(isolated,request.role,request.allowed_paths);
  const final=['SUCCESS','FAILED','STOPPED'].includes(result.state)?result.state:'UNKNOWN';
  if((await remote.update(claim.key,final)).state!==final){result.state='HUMAN_REVIEW_REQUIRED';result.reason='REMOTE_SETTLEMENT_UNKNOWN';}
  if(result.state==='SUCCESS')workspace.cleanup(isolated);else result.evidence_retained=true;
  return result;
 }catch{await remote.update(claim.key,'UNKNOWN');reject('LIVE_EXECUTION_REQUIRES_HUMAN_REVIEW');}
}
// Fixed OS self-test stays in the existing process-capable supervisor; the
// policy/plan module has no process or network capability of its own.
function probeWriteIsolation(){
 const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'r55-os-proof-'));fs.mkdirSync(path.join(root,'tests'));fs.writeFileSync(path.join(root,'protected'),'safe');
 try{const command=require('./workspace-isolation').selfTestCommand(root);if(!command)return {available:false,reason:'BLOCKED_OS_WRITE_ISOLATION',mechanism:'bubblewrap',detail:'MISSING_BINARY'};
  const r=spawnSync(command.executable,command.args,{encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin',HOME:'/tmp/home',TMPDIR:'/tmp/private-tmp',LANG:'C.UTF-8'}}),verified=r.status===0&&fs.readFileSync(path.join(root,'protected'),'utf8')==='safe'&&fs.existsSync(path.join(root,'tests/allowed'));
  return {available:verified,reason:verified?null:'BLOCKED_OS_WRITE_ISOLATION',mechanism:'bubblewrap_user_pid_network_mount_namespaces',detail:verified?'WRITE_DENIAL_AND_ALLOWED_WRITE_PROBED':'NAMESPACE_OR_READONLY_MOUNT_UNAVAILABLE'};
 }catch{return {available:false,reason:'BLOCKED_OS_WRITE_ISOLATION',mechanism:'bubblewrap',detail:'PROBE_FAILED'};}finally{fs.rmSync(root,{recursive:true,force:true});}
}
module.exports={redact,buildCommand,verifyReadiness,runStub,runLive,probeWriteIsolation};
