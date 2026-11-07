'use strict';
// Synthetic keys and reviews are confined to this test fixture. They cannot
// authorize live code; never export private keys into reports or child env.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const H=require('../agent-pilot-r45/helpers.cjs'),F=require('../auto-handoff-r46/fixtures.cjs');
const C=require('../../tools/auto-handoff-r46/contract'),P=require('../../tools/agent-pilot-r45/contract'),B=require('../../tools/first-handoff-r49/control');
function setup(t,mode='success',options={}) {
 const f=F.fixture({kind:'claude',...options}),dir=H.tmp(t,'r49-fixture-');
 f.candidate_sha=H.HEAD;f.config.source_sha=H.HEAD;f.config.max_cost=.1;f.config.max_daily_cost=.5;
 f.config.allowed_issues=[32];f.config.allowed_branches=['integrate/codex-r49-first-real-handoff'];f.config.trusted_event_branches=[...f.config.allowed_branches];f.envelope.issue=32;f.envelope.branch=f.config.allowed_branches[0];
 f.envelope.source_sha=H.HEAD;f.envelope.limits.max_cost=.1;f.envelope.limits.runtime_ms=options.runtime||3000;
 Object.assign(f.snapshot,JSON.parse(JSON.stringify(f.snapshot).replaceAll(C.SOURCE,H.HEAD)));
 f.snapshot.refs[f.envelope.branch]=H.HEAD;
 f.sourceRepo=H.ROOT;f.stateDir=path.join(dir,'pilot');
 f.refs={log_ref:'https://github.com/'+C.REPO+'/actions/runs/1',ci_ref:'https://github.com/'+C.REPO+'/actions/runs/1',report_ref:'https://github.com/'+C.REPO+'/issues/32#issuecomment-1'};
 f.cli=H.fakeCli(dir,mode);f.fakeExecutable=f.cli.file;
 const keys=crypto.generateKeyPairSync('ed25519');
 f.policy=H.policy({allowed_issues:[32],pinned_gate_sha:H.HEAD,trusted_keys:{'r49-fixture':{pem:keys.publicKey.export({type:'spki',format:'pem'}),roles:['dispatcher']}}});
 f.input=(extra={})=>({simulate:true,...f,trigger:require('../../tools/auto-handoff-r46/triggers').tick(f.now,f.config),...extra});
 f.sign=()=>{
  const e=f.envelope,c=f.config;e.idempotency_key=C.identity(e);e.dispatch_id=C.digest(['dispatch',e.idempotency_key]);
  const manifest={control_operation:f.operation||'RECONCILE',repo:C.REPO,issue:e.issue,allowed_issues:c.allowed_issues,branch:e.branch,allowed_branches:c.allowed_branches,sha:e.source_sha,fixed_gate_sha:'d54b29e11716a01f0812b3e8576982b9f5b9b234',isolation:'ephemeral_github_hosted',credentials_verified:true,cli_version_verified:true,native_token_cap_verified:true,native_spend_cap_verified:true,role_scope_verified:true,state_ref_protection_verified:true,fake_only:true,evidence:'E2_E3_FAKE',envelope_digest:C.digest(e),source_digest:C.digest(f.snapshot),gate_digest:require('../../tools/agent-executor/policy').gateDigest(require('../../tools/agent-scheduler/state').evaluate(f.snapshot,c.gate_config,f.now))};
  const proofs={};for(const [role,pair] of Object.entries(f.pairs)){const payload={role,manifest_digest:C.digest(manifest),expires_at:f.now+3600000,verdict:'ACCEPT',approved:true};proofs[role]={key_id:'fixture',payload,signature:crypto.sign(null,Buffer.from(C.canonical(payload)),pair.privateKey).toString('base64')};}f.authorization={manifest,proofs};return f;
 };
 f.signPilot=(extra={})=>{f.sign();const prepared=B.prepare(f.input(extra));f.signed={...prepared.unsigned_envelope,signature:{alg:'ed25519',key_id:'r49-fixture',value:crypto.sign(null,Buffer.from(P.canonical(prepared.unsigned_envelope)),keys.privateKey).toString('base64')}};return f;};
 return f.signPilot();
}
function evidence(f,r) {
 const dest=process.env.R49_EVIDENCE_DIR;if(!dest)return;
 const key=P.dedupeKey(f.signed),receipt=JSON.parse(fs.readFileSync(path.join(f.stateDir,'outcome-'+key+'.json'),'utf8'));
 const log=fs.readFileSync(path.join(f.stateDir,receipt.evidence.log_file));
 if(crypto.createHash('sha256').update(log).digest('hex')!==receipt.evidence.log_sha256)throw Error('LOCAL_LOG_HASH_MISMATCH');
 fs.mkdirSync(dest,{recursive:true});fs.writeFileSync(path.join(dest,'cross-runner-e3.json'),JSON.stringify({head_sha:H.HEAD,evidence:'E3_FAKE_CLI',synthetic_reviews_and_signature:true,state:r.state,source_sha:r.outcome.fixed_sha,fake_process_launches:f.cli.launches(),actual_agent_launches:0,model_cost:'NOT_VERIFIED',fake_meter_usd:receipt.cost.usd,process:receipt.process,log_sha256:receipt.evidence.log_sha256,real_github_state_write:false,schedule:'NOT_ENABLED'},null,2)+'\n',{flag:'wx',mode:0o600});
}
module.exports={setup,evidence};
