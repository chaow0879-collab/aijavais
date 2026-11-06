'use strict';
const crypto = require('node:crypto');
const SHA = /^[a-f0-9]{40}$/;
const roles = {codex:['Codex-Developer','Codex'],claude:['Claude','Claude Code'],integrator:['Integrator'],audit:['CodeAudit','Codex-CodeAudit'],qa:['ProductQA','Codex-ProductQA']};
function parse(body, tag) {
  if(typeof body!=='string') return null;
  const match=body.match(new RegExp('\\['+tag+'\\]([\\s\\S]*?)\\[/'+tag+'\\]'));
  if(!match) return null;
  const out={};
  for(const line of match[1].split('\n')) {
    const m=line.match(/^([a-z][a-z0-9_]*):\s*(.*)$/);if(!m)continue;
    if(Object.hasOwn(out,m[1]))return null;
    try {out[m[1]]=/^[\[{]|^(true|false)$/.test(m[2])?JSON.parse(m[2]):m[2];}catch{return null;}
  }
  return out;
}
function evaluate(snapshot, config, now=Date.now()) {
  const out={run_id:crypto.randomUUID(),checked_at:new Date(now).toISOString(),source_refs:[],observed_shas:{},evidence:[],missing_gates:[],blockers:[],suggested_next_action:'人工检查缺失证据',authorized_scope:'readonly_simulation',would_dispatch:[],actual_dispatch:false,state:'BLOCKED'};
  const stop=(gate,state='BLOCKED')=>{out.missing_gates.push(gate);out.blockers.push(gate);out.state=state;return out;};
  if(!config||!Number.isFinite(config.max_snapshot_age_ms)||config.max_snapshot_age_ms<=0||!Array.isArray(config.required_jobs)||!['tests','browser','container'].every(j=>config.required_jobs.includes(j)))return stop('INVALID_POLICY');
  const auditActors=config.trustedActors?.audit||[];
  if(['codex','claude','integrator'].some(role=>(config.trustedActors?.[role]||[]).some(actor=>auditActors.includes(actor))))return stop('AUDITOR_AUTHOR_CONFLICT');
  if(!snapshot || snapshot.complete!==true || !Number.isFinite(snapshot.checked_at) || now-snapshot.checked_at>config.max_snapshot_age_ms || snapshot.checked_at>now+30000) return stop('UNKNOWN_INCOMPLETE_OR_STALE_SOURCE');
  if(!Array.isArray(snapshot.runs)||!snapshot.issues||!snapshot.refs)return stop('UNKNOWN_SOURCE_FIELDS');
  const comments=Object.values(snapshot.issues).flatMap(i=>Array.isArray(i.comments)?i.comments:[]);
  const trusted=(c,role)=>Array.isArray(config.trustedActors?.[role])&&config.trustedActors[role].includes(c.user?.login)&&['OWNER','MEMBER','COLLABORATOR'].includes(c.author_association);
  const records=(issue,role)=> (snapshot.issues[issue]?.comments||[]).filter(c=>trusted(c,role)).map(c=>({c,r:parse(c.body,'AGENT_REPORT_V1')})).filter(x=>x.r&&roles[role].includes(x.r.role));
  const latest=(issue,role)=> records(issue,role).at(-1);
  const grants=comments.filter(c=>trusted(c,'planner')).map(c=>parse(c.body,'PLANNER_DECISION_V1')).filter(Boolean);
  const authorized=(r,role,issue)=>grants.some(g=>g.authorized_role===role&&String(g.issue)===String(issue)&&g.branch===r.branch&&g.approved===true&&((SHA.test(g.candidate_sha||'')&&g.candidate_sha===r.head_sha)||(SHA.test(g.base_sha||'')&&g.base_sha===r.base_sha)));
  const note=(x)=>{out.source_refs.push(x.c.html_url);out.evidence.push({status:x.r.status,role:x.r.role,sha:x.r.head_sha||x.r.reviewed_sha||null});};
  for(const role of Object.keys(roles))for(const issue of Object.keys(snapshot.issues))for(const {r} of records(issue,role)) {
    if((['P0','P1'].includes(r.severity)&&r.status!=='RESOLVED')||r.unknown_cost===true){out.blockers.push('HUMAN_REVIEW_REQUIRED');return stop('OPEN_SECURITY_OR_UNKNOWN_COST');}
  }
  function ci(sha) {
    return snapshot.runs.some(run=>run.head_sha===sha&&run.status==='completed'&&run.conclusion==='success'&&Array.isArray(run.jobs)&&config.required_jobs.every(name=>run.jobs.some(j=>j.name===name&&j.status==='completed'&&j.conclusion==='success'&&Array.isArray(j.steps)&&j.steps.length>0&&j.steps.every(s=>s.status==='completed'&&s.conclusion==='success'))));
  }
  for(const [issue,role,count] of [[15,'codex',3],[17,'claude',4]]) {
    const x=latest(issue,role);if(!x)return stop('NO_AUTHENTICATED_REPORT_'+issue);note(x);
    const r=x.r;out.observed_shas[issue]=r.head_sha||null;
    if(['BLOCKED','REJECTED'].includes(r.status))return stop('WORK_PACKAGE_'+r.status);
    if(r.status!=='READY_FOR_REVIEW')return stop('WORK_PACKAGE_NOT_FINAL_'+issue,['READY','CLAIMED','RUNNING'].includes(r.status)?r.status:'BLOCKED');
    if(!authorized(r,role,issue))return stop('NO_PLANNER_AUTHORIZATION_'+issue);
    if(r.head_sha===r.base_sha||!SHA.test(r.head_sha||'')||snapshot.refs[r.branch]!==r.head_sha)return stop('SHA_REF_MISMATCH_'+issue);
    if(!Array.isArray(r.completed_milestones)||!Array.from({length:count},(_,i)=>'M'+(i+1)).every(m=>r.completed_milestones.includes(m)))return stop('INCOMPLETE_MILESTONES_'+issue);
    if(!ci(r.head_sha))return stop('CI_NOT_VERIFIED_'+issue,'READY_FOR_REVIEW');
    out.evidence.push({state:'CI_VERIFIED',issue,sha:r.head_sha});
  }
  out.state='INTEGRATION_READY';
  const integration=latest(10,'integrator');
  if(!integration)return stop('AUTHORIZED_INTEGRATION_CANDIDATE_REQUIRED','INTEGRATION_READY');
  note(integration);const r=integration.r;
  if(!authorized(r,'integrator',10)||r.status!=='READY_FOR_REVIEW'||!SHA.test(r.head_sha||'')||snapshot.refs[r.branch]!==r.head_sha||!Array.isArray(r.parent_shas)||![out.observed_shas[15],out.observed_shas[17]].every(s=>r.parent_shas.includes(s))||!ci(r.head_sha))return stop('INTEGRATION_NOT_VERIFIED');
  out.observed_shas.integration=r.head_sha;out.state='AUDITING';
  const audit=latest(2,'audit');
  if(!audit)return stop('FINAL_AUDIT_REQUIRED','AUDITING');note(audit);
  if(audit.r.verdict==='REJECT')return stop('AUDIT_REJECTED','REJECTED');
  if(!authorized({...audit.r,head_sha:audit.r.reviewed_sha},'audit',2)||audit.r.status==='PRE_AUDIT_PREPARED'||audit.r.review_phase!=='FINAL'||audit.r.reviewed_sha!==r.head_sha||!['ACCEPT','ACCEPT_WITH_FOLLOWUP'].includes(audit.r.verdict))return stop('AUDIT_SHA_OR_PHASE_MISMATCH','AUDITING');
  out.evidence.push({state:'AUDIT_ACCEPTED',sha:r.head_sha});
  const qa=latest(4,'qa');if(!qa)return stop('NEW_SHA_PRODUCT_QA_REQUIRED','PRODUCT_QA');note(qa);
  if(!authorized({...qa.r,head_sha:qa.r.reviewed_sha},'qa',4)||qa.r.reviewed_sha!==r.head_sha||qa.r.verdict!=='PASS'||qa.r.t2_complete!==true||qa.r.ci_sha!==r.head_sha||!ci(r.head_sha))return stop('QA_SHA_CI_OR_T2_INCOMPLETE','PRODUCT_QA');
  if(qa.r.e4!=='PASS'||qa.r.e5!=='PASS'||!grants.some(g=>g.human_trials_approved===true&&g.candidate_sha===r.head_sha))return stop('E4_E5_REQUIRE_HUMAN_AUTHORIZATION_AND_EVIDENCE','PRODUCT_QA');
  out.state='READY_FOR_HUMAN_GATE';out.suggested_next_action='仅供人工发布门禁核查；不代表已授权上线';return out;
}
function summarize(report) {return `状态：${report.state}；缺失门禁：${report.missing_gates.join('、')||'无'}；实际派工：否；范围：只读模拟。`;}
module.exports={evaluate,parse,summarize,SHA};
