'use strict';
const {REPO,digest,reject}=require('./policy');
// Build an auditable bounded proposal, never a model request or authorization.
function plan({kind='codex',branch,sha,timeout_ms=30000,max_tokens=128,max_model_spend=0,context}){
 if(!['codex','claude'].includes(kind)||typeof branch!=='string'||!/^(?:feat|test|fix)\/[A-Za-z0-9_./-]+$/.test(branch)||branch.includes('..')||branch.split('/').some(p=>!p||p.startsWith('.')||p.endsWith('.')||p.endsWith('.lock'))||!/^[a-f0-9]{40}$/.test(sha||'')||!Number.isSafeInteger(timeout_ms)||timeout_ms<1||timeout_ms>30000||!Number.isSafeInteger(max_tokens)||max_tokens<1||max_tokens>512||!Number.isFinite(max_model_spend)||max_model_spend<0||max_model_spend>1||typeof context!=='string'||!context.trim()||Buffer.byteLength(context,'utf8')>8000)reject('INVALID_REHEARSAL');
 return {schema:1,repo:REPO,kind,phase:'one_shot_read_only',allowed_runs:1,branch,sha,timeout_ms,max_tokens,max_model_spend,context_digest:digest(context),sandbox:'read-only',automatic_retry:false,background:false,schedule_enabled:false,actual_dispatch:false,authorization:'NOT_GRANTED_BY_PLAN',result_required:['invocation_count','exit_code','termination','sha_before_after','workspace_unchanged','usage_source','model_spend_or_null','authentication_evidence_redacted']};
}
module.exports={plan};
