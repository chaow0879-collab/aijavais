'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const REPO='chaow0879-collab/aijavais';
const FLAGS=['AIJAVAIS_AUTOMATION_ENABLED','AIJAVAIS_DISPATCH_ENABLED','AIJAVAIS_CLAUDE_EXEC_ENABLED','AIJAVAIS_CODEX_EXEC_ENABLED','AIJAVAIS_PRODUCTION_ACTIONS_ENABLED'];
const BACKENDS=['cli','sdk','cloud_approved'];
const canonical=x=>JSON.stringify(x===null||typeof x!=='object'?x:Array.isArray(x)?x.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(x).sort().map(k=>[k,JSON.parse(canonical(x[k]))])));
const digest=x=>crypto.createHash('sha256').update(canonical(x)).digest('hex');
function reject(code){const e=new Error(code);e.code=code;throw e;}
function disabled(policy,env=process.env){
 if(!policy||FLAGS.some(k=>policy[k]!==false||(env[k]!==undefined&&!['false','0',''].includes(String(env[k]).toLowerCase())))||policy.dry_run!==true||policy.stage!=='DRY_RUN'||policy.cron_enabled!==false||policy.webhook_enabled!==false)reject('REAL_EXECUTION_DISABLED');
 if(!BACKENDS.includes(policy.CODEX_EXEC_BACKEND)||!BACKENDS.includes(policy.CLAUDE_EXEC_BACKEND))reject('UNKNOWN_BACKEND');
}
function gateDigest(gate){return digest({state:gate.state,source_refs:gate.source_refs,observed_shas:gate.observed_shas,evidence:gate.evidence,missing_gates:gate.missing_gates,blockers:gate.blockers,authorized_scope:gate.authorized_scope});}
function verify(request,approval,policy,gate,now){
 disabled(policy);
 const p=approval?.payload;
 try{if(!p||!policy.approver_public_keys?.[approval.key_id]||!crypto.verify(null,Buffer.from(canonical(p)),policy.approver_public_keys[approval.key_id],Buffer.from(approval.signature,'base64')))reject('BLOCKED_APPROVAL');}catch{reject('BLOCKED_APPROVAL');}
 if(p.fake_only!==true||p.approved_scope!=='fake_simulation'||!Number.isSafeInteger(p.expires_at)||p.expires_at<=now)reject('EXPIRED_OR_INVALID_SCOPE');
 for(const k of ['repo','issue','role','phase','sha','branch','approval_version','kind','context_digest'])if(p[k]!==request[k])reject('APPROVAL_BINDING_MISMATCH');
 if(request.repo!==REPO||!Number.isSafeInteger(request.issue)||!policy.allowed_issues.includes(request.issue)||!p.allowed_issues?.includes(request.issue))reject('REPOSITORY_OR_ISSUE_DENIED');
 if(request.branch==='main'||!policy.allowed_branches.includes(request.branch)||!p.allowed_branches?.includes(request.branch)||request.observed_ref!==request.sha||request.fast_forward!==true||request.clean_workspace!==true||!/^[a-f0-9]{40}$/.test(request.sha||''))reject('BRANCH_OR_REF_DENIED');
 if(!['claude','codex'].includes(request.kind)||!['integrator','audit','qa'].includes(request.role)||!p.permitted_roles?.includes(request.role))reject('ROLE_DENIED');
 if(!p.identity||!policy.allowed_identities.includes(p.identity.actor))reject('BLOCKED_CREDENTIALS');
 if(!request.context||typeof request.context.context_pack!=='string'||typeof request.context.task!=='string'||canonical(request.context).length>16000||digest(request.context)!==request.context_digest)reject('CONTEXT_CHANGED');
 if(p.gate_digest!==gateDigest(gate)||gate.actual_dispatch!==false||gate.authorized_scope!=='readonly_simulation')reject('GATE_CHANGED');
 const target={INTEGRATION_READY:['integrator','integration'],AUDITING:['audit','audit'],PRODUCT_QA:['qa','qa']}[gate.state];
 if(!target||target[0]!==request.role||target[1]!==request.phase)reject('HUMAN_REVIEW_REQUIRED');
 if(!['AUTHORIZED_INTEGRATION_CANDIDATE_REQUIRED','FINAL_AUDIT_REQUIRED','NEW_SHA_PRODUCT_QA_REQUIRED'].every(k=>!gate.missing_gates.includes(k)||k===({INTEGRATION_READY:'AUTHORIZED_INTEGRATION_CANDIDATE_REQUIRED',AUDITING:'FINAL_AUDIT_REQUIRED',PRODUCT_QA:'NEW_SHA_PRODUCT_QA_REQUIRED'}[gate.state])))reject('INCOMPLETE_GATE');
 // These are hypothetical Fake meters, never vendor billing or real quotas.
 for(const k of ['max_job_runtime','max_tokens','max_model_spend','max_daily_model_spend'])if(!Number.isFinite(p[k])||p[k]<0||!Number.isFinite(policy[k])||p[k]>policy[k])reject('LIMITS_REQUIRED');
 if(p.max_job_runtime<1||!Number.isSafeInteger(p.max_tokens)||p.max_tokens<1||p.max_retries!==1||!request.approval_version)reject('LIMITS_REQUIRED');
 return p;
}
function inventory(policy){
 const exists=name=>(process.env.PATH||'').split(path.delimiter).some(dir=>{try{const file=path.join(dir,name);return fs.statSync(file).isFile()&&(fs.accessSync(file,fs.constants.X_OK)===undefined);}catch{return false;}});
 return {stage:'DRY_RUN',actual_dispatch:false,claude:{backend:policy.CLAUDE_EXEC_BACKEND,cli_on_path:exists('claude'),credentials:'BLOCKED_CREDENTIALS',plan_cost_terms:'NOT_VERIFIED'},codex:{backend:policy.CODEX_EXEC_BACKEND,cli_on_path:exists('codex'),credentials:'BLOCKED_CREDENTIALS',plan_cost_terms:'NOT_VERIFIED'},v1_audit:'NOT_VERIFIED',runner:'NOT_CONFIGURED',model_spend:null};
}
function previewEnablement(from,to,checks={}){
 const stages=['DRY_RUN','ARMED_READ_ONLY','AUTHORIZED_DISPATCH','AUDITED_RUNNING'];
 return {would_transition:stages.indexOf(to)===stages.indexOf(from)+1&&stages.includes(from)&&checks.v1_audit===true&&checks.v2_audit===true&&checks.user_authorized===true,actual_stage:'DRY_RUN',actual_dispatch:false};
}
module.exports={REPO,FLAGS,canonical,digest,reject,disabled,verify,gateDigest,inventory,previewEnablement};
