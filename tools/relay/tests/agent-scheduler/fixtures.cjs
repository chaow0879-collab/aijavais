const BASE='58c52f0084997f669eea763edc7b58e11d3ef4f4';
const sha=n=>String(n).repeat(40);
const config={...require('../../agent-scheduler/config.json'),trustedActors:{planner:['planner'],codex:['codex'],claude:['claude'],integrator:['integrator'],audit:['audit'],qa:['qa']}};
function comment(role,fields,tag='AGENT_REPORT_V1') {return {user:{login:role},author_association:'OWNER',created_at:'2026-11-06T00:00:00Z',html_url:'https://github.com/fixture/'+role,body:`[${tag}]\n`+Object.entries(fields).map(([k,v])=>k+': '+(typeof v==='string'?v:JSON.stringify(v))).join('\n')+`\n[/${tag}]`};}
function positive(now=Date.now()) {
 const s={complete:true,checked_at:now,issues:Object.fromEntries([2,4,10,12,15,16,17,18].map(n=>[n,{comments:[]}])),refs:{codex:sha(1),claude:sha(2),integration:sha(3),'qa-test':sha(4)},runs:[],pulls:[]};
 const grant=(role,issue,branch,head)=>s.issues[10].comments.push(comment('planner',{authorized_role:role,issue,branch,approved:true,candidate_sha:head},'PLANNER_DECISION_V1'));
 for(const [id,role,n,count] of [[15,'codex',1,3],[17,'claude',2,4]]){s.issues[id].comments.push(comment(role,{role:role==='codex'?'Codex-Developer':'Claude',status:'READY_FOR_REVIEW',head_sha:sha(n),base_sha:BASE,branch:role,completed_milestones:Array.from({length:count},(_,i)=>'M'+(i+1))}));grant(role,id,role,sha(n));}
 s.issues[10].comments.push(comment('integrator',{role:'Integrator',status:'READY_FOR_REVIEW',head_sha:sha(3),branch:'integration',parent_shas:[sha(1),sha(2)]}));grant('integrator',10,'integration',sha(3));
 s.issues[2].comments.push(comment('audit',{role:'CodeAudit',status:'READY_FOR_REVIEW',verdict:'ACCEPT',review_phase:'FINAL',reviewed_sha:sha(3),branch:'integration'}));grant('audit',2,'integration',sha(3));
 s.issues[4].comments.push(comment('qa',{role:'ProductQA',status:'READY_FOR_REVIEW',verdict:'PASS',reviewed_sha:sha(3),ci_sha:sha(4),test_head_sha:sha(4),branch:'qa-test',t2_complete:true,e4:'PASS',e5:'PASS'}));grant('qa',4,'qa-test',sha(3));
 s.issues[10].comments.push(comment('planner',{human_trials_approved:true,candidate_sha:sha(3)},'PLANNER_DECISION_V1'));
 for(const n of [1,2,3])s.runs.push({head_sha:sha(n),status:'completed',conclusion:'success',jobs:['tests','browser','container'].map(name=>({name,status:'completed',conclusion:'success',steps:[{name:'security',status:'completed',conclusion:'success'}]}))});
 s.runs.push({head_sha:sha(4),status:'completed',conclusion:'success',jobs:['HTTP','Chromium'].map(name=>({name,status:'completed',conclusion:'success',steps:[{status:'completed',conclusion:'success'}]}))});
 return s;
}
function knownFacts(){const s=positive();s.issues[2].comments=[comment('audit',{role:'CodeAudit',status:'PRE_AUDIT_PREPARED'})];s.refs.codex=BASE;s.refs.claude=BASE;s.issues[4].comments=[comment('qa',{role:'ProductQA',status:'BLOCKED',reviewed_sha:BASE,head_sha:'c1db3590a3b91a7651d6c276b079b0aea53376c6',risk:'QA-GAPS-UX-01'})];s.runs.push({id:42146837614,head_sha:'c1db3590a3b91a7651d6c276b079b0aea53376c6',status:'completed',conclusion:'failure',jobs:[{name:'HTTP',conclusion:'success'},{name:'Chromium',conclusion:'failure'}]});return s;}
module.exports={BASE,sha,config,positive,knownFacts,comment};
