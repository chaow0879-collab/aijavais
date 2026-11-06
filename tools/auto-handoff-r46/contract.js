'use strict';
const {digest,canonical,REPO,reject}=require('../agent-executor/policy');
const SOURCE='ab3e07979f67924e795426737e26c5c4d84b8501',SHA=/^[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
function keys(x,names){return plain(x)&&Object.keys(x).sort().join()===names.split(' ').sort().join();}
const safeRef=x=>typeof x==='string'&&new RegExp('^https://github.com/'+REPO+'/(?:actions/runs/[1-9][0-9]*|issues/[1-9][0-9]*#issuecomment-[1-9][0-9]*)$').test(x);
const pilotWorkKey=e=>digest([e.repo,e.issue,e.role==='integrator'?'developer':e.role,e.phase,e.source_sha,e.source_sha,e.kind,'readonly-repo-summary']);
const safeRunId=x=>typeof x==='string'&&(/^FAKE_[a-f0-9]{20}$/.test(x)||/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x));
function identity(e){return digest([e.repo,e.issue,e.task_id,e.source_sha,e.role,e.phase]);}
function validateEnvelope(e,c,now){
 if(!keys(e,'schema repo task_id source_sha issue branch kind role phase context_digest limits audit_refs expires_at after idempotency_key dispatch_id')||e.schema!==1||e.repo!==REPO||e.repo!==c.repo||c.source_sha!==SOURCE||e.source_sha!==c.source_sha||!SHA.test(e.source_sha)||!c.allowed_issues.includes(e.issue)||!Number.isSafeInteger(e.issue)||!c.allowed_branches.includes(e.branch)||e.branch==='main'||!['codex','claude'].includes(e.kind)||!({integrator:'integration',audit:'audit',qa:'qa'}[e.role]===e.phase)||!/^[-A-Za-z0-9_.]{1,80}$/.test(e.task_id)||!HASH.test(e.context_digest))reject('ENVELOPE_SCOPE');
 if(!keys(e.limits,'runtime_ms tokens max_cost')||!Number.isSafeInteger(e.limits.runtime_ms)||e.limits.runtime_ms<1||e.limits.runtime_ms>c.max_runtime_ms||!Number.isSafeInteger(e.limits.tokens)||e.limits.tokens<1||e.limits.tokens>c.max_tokens||!Number.isFinite(e.limits.max_cost)||e.limits.max_cost<0||e.limits.max_cost>c.max_cost)reject('ENVELOPE_LIMITS');
 if(!keys(e.audit_refs,'audit qa')||!safeRef(e.audit_refs.audit)||!safeRef(e.audit_refs.qa)||!e.audit_refs.audit.includes('/issues/2#')||!e.audit_refs.qa.includes('/issues/4#'))reject('GATE_REFS');
 if(!Number.isSafeInteger(e.expires_at)||e.expires_at<=now||e.expires_at-now>3600000||e.after!==null&&!HASH.test(e.after)||e.after===e.idempotency_key)reject('ENVELOPE_EXPIRY_OR_PARENT');
 if(e.idempotency_key!==identity(e)||e.dispatch_id!==digest(['dispatch',e.idempotency_key]))reject('ENVELOPE_IDENTITY');
 return e;
}
function outcome(o,e){
 if(!keys(o,'schema dispatch_id idempotency_key run_id source_sha fixed_sha state exit_code cost_known cost log_ref ci_ref report_ref retry evidence actual_agent_launches')||o.schema!==1||o.dispatch_id!==e.dispatch_id||o.idempotency_key!==e.idempotency_key||o.source_sha!==e.source_sha||o.fixed_sha!==e.source_sha||!safeRunId(o.run_id)||!['SUCCESS','FAILED','STOPPED','UNKNOWN'].includes(o.state)||!(o.exit_code===null||Number.isSafeInteger(o.exit_code)&&o.exit_code>=0&&o.exit_code<=255)||typeof o.cost_known!=='boolean'||(o.cost_known?(!Number.isFinite(o.cost)||o.cost<0||o.cost>e.limits.max_cost):o.cost!==null)||![o.log_ref,o.ci_ref,o.report_ref].every(safeRef)||o.retry!=='NEVER'||o.evidence!=='E2_E3_FAKE'||o.actual_agent_launches!==0||o.state==='SUCCESS'&&o.exit_code!==0)reject('RUNNER_OUTCOME_INVALID');
 return o;
}
function taskHash(e){return digest([e.repo,e.issue,e.task_id]);}
module.exports={pilotWorkKey,safeRunId,REPO,SOURCE,SHA,HASH,plain,keys,safeRef,identity,validateEnvelope,outcome,taskHash,digest,canonical,reject};
