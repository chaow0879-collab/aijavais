'use strict';
const crypto=require('node:crypto');
const {digest,keys,reject}=require('./contract');
const verified=new WeakSet();
function mark(t){Object.freeze(t);verified.add(t);return t;}
function webhook({body,signature,delivery,event,secret},c,now){
 if(typeof body!=='string'||Buffer.byteLength(body)>65536||typeof secret!=='string'||secret.length<32||!/^sha256=[a-f0-9]{64}$/.test(signature||'')||!/^[-A-Za-z0-9_]{1,100}$/.test(delivery||'')||!['issue_comment','issues','workflow_run'].includes(event))reject('UNTRUSTED_EVENT');
 const expected='sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex');if(!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))reject('UNTRUSTED_EVENT');
 let p;try{p=JSON.parse(body);}catch{reject('EVENT_JSON');}
 if(p.repository?.full_name!==c.repo||p.repository?.id!==c.repository_id||p.repository?.fork===true||!c.allowed_senders.includes(p.sender?.login))reject('EVENT_SCOPE');
 if(event==='workflow_run'){
  const r=p.workflow_run;if(p.action!=='completed'||r?.conclusion!=='success'||r.head_repository?.full_name!==c.repo||r.head_repository?.fork===true||['pull_request','pull_request_target'].includes(r.event)||r.head_sha!==c.source_sha||!c.trusted_event_branches.includes(r.head_branch))reject('UNTRUSTED_WORKFLOW_SOURCE');
 }else if(!c.allowed_issues.includes(p.issue?.number)||p.issue?.pull_request||!['OWNER','MEMBER','COLLABORATOR'].includes(p.comment?.author_association||p.issue?.author_association)||!['created','edited','opened','reopened'].includes(p.action))reject('EVENT_SCOPE');
 // Comment bodies are never prompts or approvals and are never retained.
 return mark({kind:'event',id:digest([event,delivery]),at:now,repo:c.repo});
}
function tick(now,c){if(!Number.isSafeInteger(now)||now<0)reject('INVALID_CLOCK');return mark({kind:'tick',id:digest(['tick',Math.floor(now/c.tick_ms)]),at:now,repo:c.repo});}
function check(t,c,now){if(!verified.has(t)||t.repo!==c.repo||!Number.isSafeInteger(t.at)||Math.abs(t.at-now)>c.clock_skew_ms)reject('UNTRUSTED_OR_STALE_TRIGGER');}
module.exports={webhook,tick,check};
