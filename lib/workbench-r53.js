'use strict';
// R52's frozen protocol, built exclusively from durable server facts.
const C=require('../public/haloflux-workbench-r52/contract');
const names={task_created:'task_created',run_started:'approved',model_dispatched:'agent_started',model_output_started:'work_started',tool_completed:'tool_used',skill_completed:'tool_used',handoff:'handoff',step_done:'completed',peer_review:'peer_review',review_required:'delivered',run_approved:'accepted',rework_started:'rework_requested',run_cancelled:'cancelled',run_failed:'failed',run_interrupted:'interrupted',file_generated:'delivered',usage_recorded:'cost_reported'};
function snapshot(store,run,{after=0,limit=1000}={}){
 const cursor=after===null||after===''?0:Number(after),max=limit===null||limit===''?1000:Number(limit);
 if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(max)||max<1||max>5000)throw new (require('./project-store').ProjectError)('Invalid event cursor/limit','invalid_cursor',400);
 const history=[];let rawAfter=0;for(;;){const page=store.getEvents(run.runId,{after:rawAfter,limit:5000});history.push(...page);if(history.length>50000)throw new (require('./project-store').ProjectError)('Event history exceeds bounded projection','event_limit',409);if(page.length<5000)break;rawAfter=page.at(-1).seq;}
 const evidence=run.projectSnapshot?.planning?.workflowSchema?'E3_FAKE':'SERVER_RECORDED';
 if(cursor>history.length)throw new (require('./project-store').ProjectError)('Cursor belongs to another or newer history','cursor_conflict',409);
 const work='r53:'+run.runId,events=history.map((e,i)=>{
  let type=names[e.eventType]||'r53.'+e.eventType;if(e.eventType==='step_done'&&e.status!=='done')type='failed';
  return {schema:C.EVENT_SCHEMA,event_id:e.eventId||run.runId+':'+e.seq,source_event_id:e.eventId||run.runId+':'+e.seq,work_id:work,task_id:run.runId,seq:i+1,parent_event_id:e.parentId||null,type,actor:e.actor||'system',round:e.round||1,message_id:e.messageId||null,role_id:e.fromRoleId||e.roleId||null,to_role_id:e.toRoleId||null,step_id:e.stepId||null,artifact_id:e.artifactId||null,at:e.createdAt,source:'R53_SQLITE_APPEND_ONLY',source_sha:e.sourceSha||null,evidence,cost:e.ledgerId?{usd:null,status:'unknown',ledger_id:e.ledgerId}:null,detail:'适配器事实，供应商/专业质量未验证；'+e.eventType};
 });
 for(const event of events)if(!C.validateEvent(event).ok)throw Error('Invalid server workbench event');
 const artifacts=store.listArtifacts(run.runId).map(a=>({schema:C.ARTIFACT_SCHEMA,artifact_id:a.artifactId,work_id:work,filename:a.filename,mime:a.mime,bytes:a.bytes,sha256:a.sha256,round:a.round||null,format:a.format||a.filename.split('.').at(-1),download_url:`/api/v2/runs/${run.runId}/artifacts/${a.artifactId}/download`,origin:'server_artifact',producer:a.producer,evidence,status:a.round&&a.round<run.round?'superseded':'produced',professional_quality:'NOT_VERIFIED',source_artifact_id:a.sourceArtifactId||null,source_sha256:a.sourceSha256||null}));
 return {schema:'aijavais.workbench.snapshot/v1',work_id:work,run_id:run.runId,project_id:run.projectId,round:run.round,status:run.status,events:events.filter(e=>e.seq>cursor).slice(0,max),cursor:events.filter(e=>e.seq>cursor).slice(0,max).at(-1)?.seq||cursor,artifacts,evidence,provider_cost:null,professional_quality:'NOT_VERIFIED'};
}
module.exports={snapshot};
