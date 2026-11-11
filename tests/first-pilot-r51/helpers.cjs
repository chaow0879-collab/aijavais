'use strict';
const crypto=require('node:crypto'),H=require('../first-handoff-r49/helpers.cjs'),C=require('../../tools/auto-handoff-r46/contract'),A=require('../../tools/first-pilot-r51/admission'),P=require('../../tools/agent-pilot-r45/policy');
function admission(f){const e=f.envelope;return {schema:A.SCHEMA,evidence:'E3_FAKE',repo:e.repo,issue:e.issue,task_id:e.task_id,source_sha:e.source_sha,branch:e.branch,work_key:C.pilotWorkKey(e),dispatch_id:e.dispatch_id,issued_at:f.now,expires_at:f.now+60000,budget:{currency:'USD',cap_usd:e.limits.max_cost,max_tokens:e.limits.tokens,runtime_ms:e.limits.runtime_ms,enforcement:'SYNTHETIC_FAKE_ONLY'},auth:{kind:'SYNTHETIC_FAKE_ONLY',context_ref:'fixture:no-official-credential'},tools:['Read','Glob','Grep'],isolation:'nonproduction_readonly',stop_monitor_ms:50};}
function setup(t,mode='success',options={}){
 const f=H.setup(t,mode,options);f.config.allowed_issues=[34];f.config.allowed_branches=['integrate/codex-r51-first-pilot-readiness'];f.config.trusted_event_branches=[...f.config.allowed_branches];f.envelope.issue=34;f.envelope.branch=f.config.allowed_branches[0];f.snapshot.refs[f.envelope.branch]=f.candidate_sha;
 f.policy=P.loadPolicy({allowed_issues:[34],pinned_gate_sha:f.candidate_sha,allow_fake_cli:true,trusted_keys:f.policy.trusted_keys});
 const prior=f.sign;prior();f.admission=admission(f);
 f.sign=()=>{prior();const m=f.authorization.manifest;m.r51_admission_digest=C.digest(f.admission);for(const [role,pair] of Object.entries(f.pairs)){const p=f.authorization.proofs[role];p.payload.manifest_digest=C.digest(m);p.signature=crypto.sign(null,Buffer.from(C.canonical(p.payload)),pair.privateKey).toString('base64');}return f;};
 const input=f.input;f.input=(extra={})=>({...input(),mode:'fake',admission:f.admission,...extra});
 f.refresh=()=>{prior();f.admission=admission(f);f.signPilot();return f;};
 return f.signPilot();
}
function evidence(f,r){
 const dest=process.env.R51_EVIDENCE_DIR;if(!dest)return;
 const fs=require('node:fs'),path=require('node:path'),key=require('../../tools/agent-pilot-r45/contract').dedupeKey(f.signed);
 const receipt=JSON.parse(fs.readFileSync(path.join(f.stateDir,'outcome-'+key+'.json'),'utf8')),log=fs.readFileSync(path.join(f.stateDir,receipt.evidence.log_file));
 if(crypto.createHash('sha256').update(log).digest('hex')!==receipt.evidence.log_sha256)throw Error('R51_EVIDENCE_HASH_MISMATCH');
 fs.mkdirSync(dest,{recursive:true});fs.writeFileSync(path.join(dest,'r51-fake-sanitized.log'),log,{flag:'wx',mode:0o600});
 fs.writeFileSync(path.join(dest,'r51-e3-receipt.json'),JSON.stringify({schema:'aijavais.r51.e3-evidence/v1',head_sha:f.candidate_sha,entry:'first-pilot-r51/entry.runPilot',state:r.state,process:receipt.process,log_sha256:receipt.evidence.log_sha256,fake_process_launches:f.cli.launches(),synthetic_identity_and_reviews:true,fake_meter:receipt.cost,provider_cost:null,provider_hard_cap:'NOT_VERIFIED',actual_agent_launches:0,real_github_state_writes:0,cron:'NOT_ENABLED'},null,2)+'\n',{flag:'wx',mode:0o600});
}
module.exports={setup,admission,evidence};
