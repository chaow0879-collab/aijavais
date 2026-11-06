'use strict';
const {evaluate}=require('../agent-scheduler/state');
const {verifyReadiness}=require('../agent-executor/cli-runner');
const {disabled,gateDigest}=require('../agent-executor/policy');
const {digest,reject,keys}=require('./contract');
function policy(c){
 disabled(require('../agent-executor/config.json'));
 if(!c||['enabled','real_dispatch','cron_enabled','webhook_enabled'].some(k=>c[k]!==false)||process.env.AIJAVAIS_R46_ENABLED&& !['0','false'].includes(process.env.AIJAVAIS_R46_ENABLED)||c.tick_ms!==600000||!Number.isSafeInteger(c.clock_skew_ms)||c.clock_skew_ms<0||c.clock_skew_ms>30000||!Number.isSafeInteger(c.lease_ms)||c.lease_ms<=c.max_runtime_ms||c.lease_ms>180000||c.max_runtime_ms>30000||c.max_runtime_ms<1||c.max_tokens>512||c.max_tokens<1||!Number.isFinite(c.max_cost)||c.max_cost<0||!Number.isFinite(c.max_daily_cost)||c.max_daily_cost<c.max_cost||!Number.isSafeInteger(c.max_tasks)||c.max_tasks<1||c.max_tasks>256||!Number.isSafeInteger(c.max_audit)||c.max_audit<1||c.max_audit>4096||!Number.isSafeInteger(c.max_runtime_ms)||!Number.isSafeInteger(c.max_tokens)||c.max_cost>1||c.max_daily_cost>3)reject('R46_DISABLED_OR_INVALID_POLICY');
}
function verify(e,authorization,snapshot,c,now,operation='RECONCILE'){
 if(authorization?.manifest?.control_operation!==operation)reject('GATE_OPERATION_BINDING');
 const g=evaluate(snapshot,c.gate_config,now),m=authorization?.manifest;
 if(!m||m.fake_only!==true||m.evidence!=='E2_E3_FAKE'||m.envelope_digest!==digest(e)||m.source_digest!==digest(snapshot)||m.gate_digest!==gateDigest(g)||m.repo!==e.repo||m.issue!==e.issue||m.branch!==e.branch||m.sha!==e.source_sha||m.fixed_gate_sha!=='d54b29e11716a01f0812b3e8576982b9f5b9b234'||!Array.isArray(m.allowed_issues)||!Array.isArray(m.allowed_branches)||m.allowed_issues.join()!==c.allowed_issues.join()||m.allowed_branches.join()!==c.allowed_branches.join())reject('SIGNED_SOURCE_BINDING');
 for(const role of ['v1_audit','v2_audit','operator'])if(!Number.isSafeInteger(authorization.proofs?.[role]?.payload?.expires_at)||authorization.proofs[role].payload.expires_at<=now)reject('APPROVAL_EXPIRED');
 verifyReadiness(m,authorization.proofs,c.trusted_keys);
 if(g.observed_shas.integration!==e.source_sha||g.actual_dispatch!==false||!(g.state==='READY_FOR_HUMAN_GATE'||g.state==='PRODUCT_QA'&&g.missing_gates.length===1&&g.missing_gates[0]==='E4_E5_REQUIRE_HUMAN_AUTHORIZATION_AND_EVIDENCE')||!g.evidence.some(x=>x.state==='AUDIT_ACCEPTED'&&x.sha===e.source_sha)||!Object.values(e.audit_refs).every(ref=>g.source_refs.includes(ref)))reject('INDEPENDENT_GATES_NOT_ACCEPTED');
 const comments=Object.values(snapshot.issues).flatMap(i=>i.comments||[]),aa=comments.filter(x=>x.html_url===e.audit_refs.audit),qq=comments.filter(x=>x.html_url===e.audit_refs.qa);
 if(aa.length!==1||qq.length!==1)reject('SIGNED_SOURCE_BINDING');
 const a=aa[0],q=qq[0];
 if(!a?.user?.login||!q?.user?.login||a.user.login===q.user.login)reject('INDEPENDENT_IDENTITIES_REQUIRED');
 return g;
}
module.exports={policy,verify};
