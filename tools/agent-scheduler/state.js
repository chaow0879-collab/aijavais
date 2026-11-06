'use strict';
const crypto = require('node:crypto');
const SHA = /^[a-f0-9]{40}$/;
const roles = {codex:['Codex-Developer','Codex'],claude:['Claude','Claude Code'],integrator:['Integrator'],audit:['CodeAudit','Codex-CodeAudit'],qa:['ProductQA','Codex-ProductQA']};
const AUTHOR_ROLES = ['codex','claude','integrator'];
// Floors that configuration can extend but never lower (AUD-26-SCH-05).
const MIN_REQUIRED_JOBS = ['tests','browser','container'];
const MIN_QA_JOBS = ['HTTP','Chromium'];
// Explicit negative decisions always win over an older approval (AUD-26-SCH-02).
const NEGATIVE = new Set(['BLOCKED','REJECTED','REVOKED','WITHDRAWN','CANCELLED','FAILED','FAIL','REJECT']);
function parse(body, tag) {
  if(typeof body!=='string'||body.split('['+tag+']').length!==2||body.split('[/'+tag+']').length!==2) return null;
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
const hasTag=(body,tag)=>typeof body==='string'&&body.includes('['+tag+']');
const stringList=x=>Array.isArray(x)&&x.length>0&&x.every(v=>typeof v==='string'&&v.length>0&&v.length<200)&&new Set(x).size===x.length;
function policyProblem(config) {
  if(!config||typeof config!=='object'||!Number.isFinite(config.max_snapshot_age_ms)||config.max_snapshot_age_ms<=0)return 'INVALID_POLICY';
  if(!stringList(config.required_jobs)||!MIN_REQUIRED_JOBS.every(j=>config.required_jobs.includes(j)))return 'INVALID_POLICY';
  if(config.qa_required_jobs!==undefined&&(!stringList(config.qa_required_jobs)||!MIN_QA_JOBS.every(j=>config.qa_required_jobs.includes(j))))return 'INVALID_QA_POLICY';
  const actors=config.trustedActors;
  if(actors!==undefined&&(actors===null||typeof actors!=='object'||Array.isArray(actors)))return 'INVALID_POLICY';
  for(const v of Object.values(actors||{}))if(!Array.isArray(v)||!v.every(a=>typeof a==='string'&&a.length>0))return 'INVALID_POLICY';
  const authors=AUTHOR_ROLES.flatMap(role=>actors?.[role]||[]);
  if((actors?.audit||[]).some(a=>authors.includes(a)))return 'AUDITOR_AUTHOR_CONFLICT';
  if((actors?.qa||[]).some(a=>authors.includes(a)))return 'QA_AUTHOR_CONFLICT';
  if((actors?.integrator||[]).length>1)return 'NO_UNIQUE_INTEGRATOR';
  return null;
}
// Chronological order: created_at, then numeric comment id, then source order (stable sort).
function ordered(list) {
  const keyed=list.map((c,i)=>({c,i,t:Date.parse(c?.created_at),id:Number.isSafeInteger(c?.id)?c.id:null}));
  if(keyed.some(k=>!Number.isFinite(k.t)))return null;
  return keyed.sort((a,b)=>a.t-b.t||(a.id!==null&&b.id!==null?a.id-b.id:0)||a.i-b.i).map(k=>k.c);
}
function evaluate(snapshot, config, now=Date.now()) {
  const out={run_id:crypto.randomUUID(),checked_at:new Date(now).toISOString(),source_refs:[],observed_shas:{},evidence:[],missing_gates:[],blockers:[],suggested_next_action:'人工检查缺失证据',authorized_scope:'readonly_simulation',would_dispatch:[],actual_dispatch:false,state:'BLOCKED'};
  const stop=(gate,state='BLOCKED')=>{out.missing_gates.push(gate);out.blockers.push(gate);out.state=state;return out;};
  const problem=policyProblem(config);if(problem)return stop(problem);
  if(!snapshot || snapshot.complete!==true || !Number.isFinite(snapshot.checked_at) || now-snapshot.checked_at>config.max_snapshot_age_ms || snapshot.checked_at>now+30000) return stop('UNKNOWN_INCOMPLETE_OR_STALE_SOURCE');
  if(!Array.isArray(snapshot.runs)||!snapshot.issues||!snapshot.refs)return stop('UNKNOWN_SOURCE_FIELDS');
  const qaJobs=config.qa_required_jobs||MIN_QA_JOBS;
  out.source_refs=Object.keys(snapshot.issues).map(id=>'https://github.com/chaow0879-collab/aijavais/issues/'+id);
  out.observed_shas.remote_refs={};
  for(const branch of ['feat/codex-v2-p2-followups','feat/claude-v2-industry-delivery-batch','test/codex-v2-productqa-gaps'])if(SHA.test(snapshot.refs[branch]||''))out.observed_shas.remote_refs[branch]=snapshot.refs[branch];
  const byIssue={};
  for(const [id,issue] of Object.entries(snapshot.issues)){const list=ordered(Array.isArray(issue?.comments)?issue.comments:[]);if(!list)return stop('UNKNOWN_COMMENT_ORDER');byIssue[id]=list;}
  const comments=ordered(Object.values(byIssue).flat());if(!comments)return stop('UNKNOWN_COMMENT_ORDER');
  const trusted=(c,role)=>Array.isArray(config.trustedActors?.[role])&&config.trustedActors[role].includes(c.user?.login)&&['OWNER','MEMBER','COLLABORATOR'].includes(c.author_association);
  // Every trusted report block of the role counts, in order. A block that cannot be
  // parsed, or that names no recognised role, is kept as ambiguous (r=null) so that a
  // newer unreadable veto can never fall back to an older approval (AUD-26-SCH-01).
  const reports=(issue,role)=>{
    const list=[];
    for(const c of byIssue[issue]||[]){
      if(!trusted(c,role)||!hasTag(c.body,'AGENT_REPORT_V1'))continue;
      const r=parse(c.body,'AGENT_REPORT_V1');
      if(r&&roles[role].includes(r.role))list.push({c,r});
      else if(r&&Object.keys(roles).some(o=>o!==role&&roles[o].includes(r.role)&&trusted(c,o)))continue;
      else list.push({c,r:null});
    }
    return list;
  };
  const latest=(issue,role)=>reports(issue,role).at(-1);
  const decisions=comments.filter(c=>trusted(c,'planner')&&hasTag(c.body,'PLANNER_DECISION_V1')).map(c=>({c,g:parse(c.body,'PLANNER_DECISION_V1')}));
  // The newest applicable Planner decision decides. An unreadable newer decision means
  // human review; an older approval can never outvote a newer revocation (AUD-26-SCH-02).
  const decide=(applies,approves)=>{
    for(let i=decisions.length-1;i>=0;i--){const g=decisions[i].g;if(!g)return 'AMBIGUOUS_PLANNER_DECISION';if(!applies(g))continue;return approves(g)?null:'PLANNER_REVOKED_OR_NOT_APPROVED';}
    return 'NO_PLANNER_DECISION';
  };
  const unbound=g=>!Object.hasOwn(g,'candidate_sha')&&!Object.hasOwn(g,'base_sha');
  const authorization=(r,role,issue)=>{
    const baseAllowed=!['audit','qa'].includes(role);
    const bound=g=>(SHA.test(g.candidate_sha||'')&&g.candidate_sha===r.head_sha)||(baseAllowed&&SHA.test(g.base_sha||'')&&g.base_sha===r.base_sha);
    return decide(
      g=>g.authorized_role===role&&String(g.issue)===String(issue)&&(g.branch===undefined||g.branch===r.branch)&&(unbound(g)||g.candidate_sha===r.head_sha||(baseAllowed&&Object.hasOwn(g,'base_sha')&&g.base_sha===r.base_sha)),
      g=>g.approved===true&&!NEGATIVE.has(g.status)&&g.branch===r.branch&&bound(g));
  };
  const note=(x)=>{out.source_refs.push(x.c.html_url);out.evidence.push({status:x.r.status,role:x.r.role,sha:x.r.head_sha||x.r.reviewed_sha||null});};
  for(const role of Object.keys(roles))for(const issue of Object.keys(byIssue))for(const {r} of reports(issue,role)) {
    if(r&&((['P0','P1'].includes(r.severity)&&r.status!=='RESOLVED')||r.unknown_cost===true)){out.blockers.push('HUMAN_REVIEW_REQUIRED');return stop('OPEN_SECURITY_OR_UNKNOWN_COST');}
  }
  // For one SHA, each workflow that carries a required job is judged only by its newest
  // run/attempt; an older green run never hides a newer failure, cancellation or
  // in-progress run (AUD-26-SCH-03). Workflows with no required job are ignored.
  function ci(sha,required) {
    const seen=new Set(),groups=new Map();
    for(const run of snapshot.runs){
      if(!run||run.head_sha!==sha)continue;const k=JSON.stringify(run);if(seen.has(k))continue;seen.add(k);
      const key=String(run.workflow_id??run.path??run.name??'(unidentified-workflow)');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(run);
    }
    const order=run=>[Number.isSafeInteger(run.id)?run.id:null,Number.isSafeInteger(run.run_attempt)?run.run_attempt:1];
    const jobOk=(run,name)=>Array.isArray(run.jobs)&&run.jobs.some(j=>j?.name===name&&j.status==='completed'&&j.conclusion==='success'&&Array.isArray(j.steps)&&j.steps.length>0&&j.steps.every(s=>s?.status==='completed'&&s.conclusion==='success'));
    let satisfied=false;
    for(const group of groups.values()){
      if(!group.some(run=>Array.isArray(run.jobs)&&run.jobs.some(j=>required.includes(j?.name))))continue;
      let newest=group[0];
      if(group.length>1){
        if(group.some(run=>order(run)[0]===null))return false;
        const sorted=[...group].sort((a,b)=>order(a)[0]-order(b)[0]||order(a)[1]-order(b)[1]);
        newest=sorted.at(-1);const prev=sorted.at(-2);
        if(order(prev)[0]===order(newest)[0]&&order(prev)[1]===order(newest)[1])return false;
      }
      if(newest.status!=='completed'||newest.conclusion!=='success'||!Array.isArray(newest.jobs))return false;
      if(newest.jobs.some(j=>required.includes(j?.name)&&!jobOk(newest,j.name)))return false;
      if(required.every(name=>jobOk(newest,name)))satisfied=true;
    }
    return satisfied;
  }
  const authorLogins=new Set();
  for(const [issue,role,count] of [[15,'codex',3],[17,'claude',4]]) {
    const x=latest(issue,role);if(!x)return stop('NO_AUTHENTICATED_REPORT_'+issue);
    if(!x.r)return stop('AMBIGUOUS_LATEST_REPORT_'+issue);note(x);authorLogins.add(x.c.user.login);
    const r=x.r;out.observed_shas[issue]=r.head_sha||null;
    if(['BLOCKED','REJECTED'].includes(r.status))return stop('WORK_PACKAGE_'+r.status);
    if(r.status!=='READY_FOR_REVIEW')return stop('WORK_PACKAGE_NOT_FINAL_'+issue,['READY','CLAIMED','RUNNING'].includes(r.status)?r.status:'BLOCKED');
    if(authorization(r,role,issue))return stop('NO_PLANNER_AUTHORIZATION_'+issue);
    if(r.head_sha===r.base_sha||!SHA.test(r.head_sha||'')||snapshot.refs[r.branch]!==r.head_sha)return stop('SHA_REF_MISMATCH_'+issue);
    if(!Array.isArray(r.completed_milestones)||!Array.from({length:count},(_,i)=>'M'+(i+1)).every(m=>r.completed_milestones.includes(m)))return stop('INCOMPLETE_MILESTONES_'+issue);
    if(!ci(r.head_sha,config.required_jobs))return stop('CI_NOT_VERIFIED_'+issue,'READY_FOR_REVIEW');
    out.evidence.push({state:'CI_VERIFIED',issue,sha:r.head_sha});
  }
  out.state='INTEGRATION_READY';
  const integration=latest(10,'integrator');
  if(!integration)return stop('AUTHORIZED_INTEGRATION_CANDIDATE_REQUIRED','INTEGRATION_READY');
  if(!integration.r)return stop('AMBIGUOUS_LATEST_REPORT_10');
  note(integration);authorLogins.add(integration.c.user.login);const r=integration.r;
  if(authorization(r,'integrator',10)||r.status!=='READY_FOR_REVIEW'||!SHA.test(r.head_sha||'')||snapshot.refs[r.branch]!==r.head_sha||!Array.isArray(r.parent_shas)||![out.observed_shas[15],out.observed_shas[17]].every(s=>r.parent_shas.includes(s))||!ci(r.head_sha,config.required_jobs))return stop('INTEGRATION_NOT_VERIFIED');
  out.observed_shas.integration=r.head_sha;out.state='AUDITING';
  // Final audit: explicit status contract first; an old verdict never overrides it (AUD-26-SCH-01).
  const audit=latest(2,'audit');
  if(!audit)return stop('FINAL_AUDIT_REQUIRED','AUDITING');
  if(!audit.r)return stop('AMBIGUOUS_LATEST_AUDIT_REPORT');
  note(audit);const a=audit.r;
  if(a.status==='REJECTED'||a.verdict==='REJECT')return stop('AUDIT_REJECTED','REJECTED');
  if(a.status==='BLOCKED')return stop('AUDIT_BLOCKED','BLOCKED');
  if(a.status===undefined)return stop('AUDIT_STATUS_MISSING','BLOCKED');
  if(a.status!=='READY_FOR_REVIEW')return stop('AUDIT_NOT_FINAL','AUDITING');
  if(!['ACCEPT','ACCEPT_WITH_FOLLOWUP'].includes(a.verdict))return stop('AUDIT_VERDICT_NOT_ACCEPT','BLOCKED');
  if(authorLogins.has(audit.c.user.login))return stop('AUDITOR_AUTHOR_CONFLICT');
  if(a.review_phase!=='FINAL'||!SHA.test(a.reviewed_sha||'')||a.reviewed_sha!==r.head_sha||(a.head_sha!==undefined&&a.head_sha!==a.reviewed_sha)||authorization({...a,head_sha:a.reviewed_sha},'audit',2))return stop('AUDIT_SHA_OR_PHASE_MISMATCH','AUDITING');
  out.evidence.push({state:'AUDIT_ACCEPTED',sha:r.head_sha});
  // Product QA: same explicit contract; QA must be independent of every author (AUD-26-SCH-05).
  const qa=latest(4,'qa');if(!qa)return stop('NEW_SHA_PRODUCT_QA_REQUIRED','PRODUCT_QA');
  if(!qa.r)return stop('AMBIGUOUS_LATEST_QA_REPORT');
  note(qa);const q=qa.r;
  if(q.status==='REJECTED'||q.verdict==='REJECT')return stop('QA_REJECTED','REJECTED');
  if(q.status==='BLOCKED')return stop('QA_BLOCKED','BLOCKED');
  if(q.status===undefined)return stop('QA_STATUS_MISSING','BLOCKED');
  if(q.status!=='READY_FOR_REVIEW')return stop('QA_NOT_FINAL','PRODUCT_QA');
  if(q.verdict!=='PASS')return stop('QA_VERDICT_NOT_PASS','BLOCKED');
  if(authorLogins.has(qa.c.user.login))return stop('QA_AUTHOR_CONFLICT');
  if(authorization({...q,head_sha:q.reviewed_sha},'qa',4)||!SHA.test(q.reviewed_sha||'')||q.reviewed_sha!==r.head_sha||q.t2_complete!==true||!SHA.test(q.test_head_sha||'')||snapshot.refs[q.branch]!==q.test_head_sha||q.ci_sha!==q.test_head_sha||!ci(q.test_head_sha,qaJobs))return stop('QA_SHA_CI_OR_T2_INCOMPLETE','PRODUCT_QA');
  if(q.e4!=='PASS'||q.e5!=='PASS')return stop('E4_E5_REQUIRE_HUMAN_AUTHORIZATION_AND_EVIDENCE','PRODUCT_QA');
  const trials=decide(g=>Object.hasOwn(g,'human_trials_approved')&&(!Object.hasOwn(g,'candidate_sha')||g.candidate_sha===r.head_sha),g=>g.human_trials_approved===true&&g.candidate_sha===r.head_sha&&!NEGATIVE.has(g.status));
  if(trials)return stop('E4_E5_REQUIRE_HUMAN_AUTHORIZATION_AND_EVIDENCE','PRODUCT_QA');
  out.state='READY_FOR_HUMAN_GATE';out.suggested_next_action='仅供人工发布门禁核查；不代表已授权上线';return out;
}
function summarize(report) {return `状态：${report.state}；缺失门禁：${report.missing_gates.join('、')||'无'}；实际派工：否；范围：只读模拟。`;}
module.exports={evaluate,parse,summarize,SHA,MIN_REQUIRED_JOBS,MIN_QA_JOBS};
