'use strict';
// Additional execution constraints, not a signer or a replacement Gate. The
// existing operator manifest must bind these bytes before R49 verifies it.
const C=require('../auto-handoff-r46/contract');
const SCHEMA='aijavais.first-pilot.admission/v1';
const fail=code=>{throw Object.assign(Error(code),{code});};
function validate(a,input){
 const e=input.envelope,now=input.now;
 if(!C.keys(a,'schema evidence repo issue task_id source_sha branch work_key dispatch_id issued_at expires_at budget auth tools isolation stop_monitor_ms')||a.schema!==SCHEMA||a.evidence!=='E3_FAKE')fail('BLOCKED_ADMISSION_SCOPE');
 if(a.repo!==e.repo||a.issue!==e.issue||a.task_id!==e.task_id||a.source_sha!==e.source_sha||a.source_sha!==input.candidate_sha||a.branch!==e.branch||a.work_key!==C.pilotWorkKey(e)||a.dispatch_id!==e.dispatch_id)fail('BLOCKED_ADMISSION_BINDING');
 if(!Number.isSafeInteger(now)||!Number.isSafeInteger(a.issued_at)||!Number.isSafeInteger(a.expires_at)||a.issued_at>now||a.issued_at<now-30000||a.expires_at<=now||a.expires_at>e.expires_at||a.expires_at-a.issued_at>300000)fail('BLOCKED_ADMISSION_EXPIRY');
 if(!C.keys(a.budget,'currency cap_usd max_tokens runtime_ms enforcement')||a.budget.currency!=='USD'||a.budget.enforcement!=='SYNTHETIC_FAKE_ONLY'||a.budget.cap_usd!==e.limits.max_cost||a.budget.max_tokens!==e.limits.tokens||a.budget.runtime_ms!==e.limits.runtime_ms)fail('BLOCKED_BUDGET_BINDING');
 if(!C.keys(a.auth,'kind context_ref')||a.auth.kind!=='SYNTHETIC_FAKE_ONLY'||typeof a.auth.context_ref!=='string'||!/^fixture:[a-z0-9._-]{1,80}$/.test(a.auth.context_ref))fail('BLOCKED_OFFICIAL_CREDENTIAL');
 if(C.canonical(a.tools)!==C.canonical(['Read','Glob','Grep'])||a.isolation!=='nonproduction_readonly'||!Number.isSafeInteger(a.stop_monitor_ms)||a.stop_monitor_ms<20||a.stop_monitor_ms>1000)fail('BLOCKED_READONLY_OR_STOP');
 if(input.authorization?.manifest?.r51_admission_digest!==C.digest(a))fail('BLOCKED_ADMISSION_SIGNATURE_BINDING');
 return a;
}
// The documented CLI flag, a timeout or a caller's assertion is not a verified
// provider-side billing boundary. No provider allowance is configured here.
function costFeasibility(){return {state:'BLOCKED',reason:'BLOCKED_UNENFORCEABLE_COST_CAP',provider_hard_cap:'NOT_VERIFIED',cli_flag:'CLIENT_CONTROL_NOT_BILLING_ATTESTATION',known_vendor_cost:null};}
module.exports={SCHEMA,validate,costFeasibility};
