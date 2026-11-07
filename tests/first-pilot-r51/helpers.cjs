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
module.exports={setup,admission};
