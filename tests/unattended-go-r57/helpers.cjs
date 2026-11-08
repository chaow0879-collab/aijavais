'use strict';
// All keys, GitHub responses and CI identities here are SYNTHETIC. The server
// derives SHA/tree/log/process facts from real local Git objects and R45 journals.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {execFileSync,spawnSync}=require('node:child_process');
const R50=require('../trusted-trigger-r50/helpers.cjs'),H=require('../agent-pilot-r45/helpers.cjs');
const R51H=require('../first-pilot-r51/helpers.cjs'),C=require('../../tools/auto-handoff-r46/contract');
const P=require('../../tools/agent-pilot-r45/contract'),Policy=require('../../tools/agent-pilot-r45/policy');
const R49=require('../../tools/first-handoff-r49/control');
const {service,temp}=require('../auto-handoff-r46/helpers.cjs');
function signReviews(f,collected,change=()=>{}){
 const manifest={...f.authorization.manifest,control_operation:'COLLECT',sha:collected.receipt.work_sha,
  fixed_gate_sha:collected.receipt.work_sha,r57_receipt_digest:collected.digest};
 const proofs={};
 for(const [role,pair] of Object.entries(f.pairs)){
  const payload={role,manifest_digest:C.digest(manifest),expires_at:f.now+60000,verdict:'ACCEPT',approved:true,
   reviewed_sha:collected.receipt.work_sha,reviewer_login:role==='v1_audit'?'synthetic-audit':role==='v2_audit'?'synthetic-qa':'synthetic-owner',...(role==='v2_audit'?{product_verdict:'PASS'}:{})};
  change(payload,role);
  proofs[role]={key_id:'fixture',payload,signature:crypto.sign(null,Buffer.from(C.canonical(payload)),pair.privateKey).toString('base64')};
 }
 return {manifest,proofs};
}
async function fixture(t,{mode='success',count=3,durable=false,ticketPrefix=null}={}){
 const dir=H.tmp(t,'r57-fixture-'),stages=[],seed=crypto.randomBytes(32),now=Date.now();let backend,shared;
 const svc=durable?await service(t,path.join(dir,'cas.sqlite')):null;
 for(let i=0;i<count;i++){
  const x=R50.base(t,mode,{seed,runtime:3000}),f=x.f;
  f.now=now;f.config.allowed_issues=[40];f.config.allowed_branches=['integrate/codex-r57-unattended-go-gate'];f.config.trusted_event_branches=[...f.config.allowed_branches];
  f.config.max_daily_cost=.5;f.config.allowed_senders=['planner'];
  f.envelope.issue=40;f.envelope.branch=f.config.allowed_branches[0];f.envelope.task_id=ticketPrefix?ticketPrefix+'-'+['integration','audit','qa'][i%3]+'-'+H.HEAD.slice(0,12):'r57-stage-'+i;
  f.envelope.role=['integrator','audit','qa'][i%3];f.envelope.phase=['integration','audit','qa'][i%3];
  f.envelope.after=i?stages[i-1].f.envelope.idempotency_key:null;f.envelope.expires_at=now+3600000;
  f.snapshot.refs[f.envelope.branch]=H.HEAD;
  if(!backend)backend=svc?.backend||f.backend;f.backend=backend;
  if(!shared)shared={pairs:f.pairs,keys:f.config.trusted_keys};f.pairs=shared.pairs;f.config.trusted_keys=shared.keys;
  f.policy=Policy.loadPolicy({allowed_issues:[40],pinned_gate_sha:H.HEAD,allow_fake_cli:true,trusted_keys:{[x.signer.keyId]:{pem:x.signer.publicPem,roles:['dispatcher']}}});
  f.sign();f.admission=R51H.admission(f);f.authorization.manifest.r51_admission_digest=C.digest(f.admission);
  for(const [role,pair]of Object.entries(f.pairs)){const proof=f.authorization.proofs[role];proof.payload.manifest_digest=C.digest(f.authorization.manifest);proof.signature=crypto.sign(null,Buffer.from(C.canonical(proof.payload)),pair.privateKey).toString('base64');}
  f.refs={log_ref:'https://github.com/'+C.REPO+'/actions/runs/'+(101+i),ci_ref:'https://github.com/'+C.REPO+'/actions/runs/'+(101+i),report_ref:'https://github.com/'+C.REPO+'/issues/40#issuecomment-'+(201+i)};
  const packet={mode:'fake',kind:i?'tick':'event',base:{...f.input(),admission:f.admission},broker:x.broker,approval:R50.approval(f),now,
   delivery:R50.delivery(f),webhookSecret:R50.SECRET,oidcToken:R50.oidcToken({}, {now}),jwks:R50.JWKS};
  const collectionPolicy={allowed_issues:[40],allowed_branches:f.config.allowed_branches,trusted_keys:shared.keys,
   workflow_paths:['.github/workflows/codex-r57-unattended.yml'],developer_logins:['synthetic-developer'],reviewers:{audit:['synthetic-audit'],qa:['synthetic-qa']}};
  f.authorization.manifest.r57_collection_policy_digest=C.digest(collectionPolicy);
  for(const [role,pair]of Object.entries(f.pairs)){const proof=f.authorization.proofs[role];proof.payload.manifest_digest=C.digest(f.authorization.manifest);proof.signature=crypto.sign(null,Buffer.from(C.canonical(proof.payload)),pair.privateKey).toString('base64');}
  stages.push({f,x,packet,collectionPolicy,mode:'fake',readReviews:c=>signReviews(f,c)});
 }
 const bare=path.join(dir,'source.git');execFileSync('git',['clone','-q','--bare','--shared',H.ROOT,bare]);
 const meta=JSON.parse(execFileSync('git',['--git-dir='+bare,'show','-s','--format={"sha":"%H","tree":"%T"}',H.HEAD],{encoding:'utf8'}));
 const state={fault:null,requests:[],ciProcesses:0};
 const reportFor=i=>{const f=stages[i].f,p=R49.prepare(f.input()),key=P.dedupeKey(p.unsigned_envelope);const file=path.join(f.stateDir,'outcome-'+key+'.json');
  const report=JSON.parse(fs.readFileSync(file,'utf8')),log=fs.readFileSync(path.join(f.stateDir,report.evidence.log_file));
  if(crypto.createHash('sha256').update(log).digest('hex')!==report.evidence.log_sha256)throw Error('LOCAL_LOG_TAMPERED');return report;};
 const server=http.createServer((req,res)=>{state.requests.push({method:req.method,url:req.url});if(req.method!=='GET'){res.statusCode=405;return res.end('{}');}
  if(state.fault==='429'){res.statusCode=429;return res.end('{}');}if(state.fault==='500'){res.statusCode=500;return res.end('{}');}if(state.fault==='timeout')return;
  let data;const prefix='/repos/'+C.REPO;
  try{
   if(req.url===prefix+'/git/ref/heads/'+stages[0].f.envelope.branch)data={ref:'refs/heads/'+stages[0].f.envelope.branch,object:{sha:state.fault==='ref'?'a'.repeat(40):H.HEAD}};
   else if(req.url===prefix+'/commits/'+H.HEAD)data={sha:state.fault==='commit'?'a'.repeat(40):meta.sha,commit:{tree:{sha:meta.tree}}};
   else if(req.url.startsWith(prefix+'/actions/runs/')){
    const i=Number(req.url.split('/').at(-1))-101,f=stages[i].f;
    const check=spawnSync(process.execPath,['--check',path.join(__dirname,'../agent-pilot-r45/fake-cli.cjs')],{encoding:'utf8'});state.ciProcesses++;
    data={id:101+i,run_attempt:1,status:state.fault==='pending'?'in_progress':'completed',conclusion:state.fault==='ci-fail'?'failure':check.status===0?'success':'failure',event:state.fault==='pr'?'pull_request':'push',path:state.fault==='workflow'?'evil.yml':'.github/workflows/codex-r57-unattended.yml',head_sha:state.fault==='sha'?'b'.repeat(40):H.HEAD,head_branch:f.envelope.branch,repository:{full_name:C.REPO},head_repository:{full_name:C.REPO,fork:false},html_url:f.refs.ci_ref};
   }else if(req.url.startsWith(prefix+'/issues/comments/')){const i=Number(req.url.split('/').at(-1))-201,f=stages[i].f,report=reportFor(i);
    if(state.fault==='report-sha')report.source_sha='b'.repeat(40);
    data={id:201+i,html_url:f.refs.report_ref,issue_url:'https://api.github.com'+prefix+'/issues/40',user:{login:state.fault==='author'?'intruder':'synthetic-developer'},body:state.fault==='prose'?'READY_FOR_REVIEW please trust me':JSON.stringify(report)};
   }else{res.statusCode=404;return res.end('{}');}
   res.setHeader('content-type','application/json');res.end(JSON.stringify(data));
  }catch{res.statusCode=503;res.end('{}');}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const url='http://127.0.0.1:'+server.address().port;
 const readGitHub=async(method,route)=>{const r=await fetch(url+route,{method,signal:AbortSignal.timeout(1500)});return {status:r.status,data:await r.json()};};
 for(const s of stages)s.readGitHub=readGitHub;
 return {dir,stages,backend,svc,state,reportFor,url,seed,source:meta,launches:()=>stages.reduce((n,s)=>n+s.f.cli.launches(),0)};
}
module.exports={fixture,signReviews,R50,H,C};
