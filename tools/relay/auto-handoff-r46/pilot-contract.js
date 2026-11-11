'use strict';
// Serializer seam for frozen R45 0b95251133d47fd7c0b9280d3ddb5287c2628307.
// No R45 code import, credential access, signing or execution. The returned frame
// is UNSIGNED and explicitly Fake; a future approved dispatcher broker owns keys.
const {parse}=require('../agent-scheduler/state'),C=require('./contract'),G=require('./gates'),T=require('./triggers');
const envelopeSchema='aijavais.pilot.envelope/v1',outcomeSchema='aijavais.pilot.outcome/v1';
function prepare({envelope:e,authorization,snapshot,config,trigger,now=Date.now()}){
 G.policy(config);T.check(trigger,config,now);C.validateEnvelope(e,config,now);G.verify(e,authorization,snapshot,config,now);
 const comments=Object.values(snapshot.issues).flatMap(i=>i.comments||[]);
 const audit=parse(comments.find(c=>c.html_url===e.audit_refs.audit).body,'AGENT_REPORT_V1'),qa=parse(comments.find(c=>c.html_url===e.audit_refs.qa).body,'AGENT_REPORT_V1');
 const frame={schema:envelopeSchema,repo:e.repo,issue:e.issue,role:e.role==='integrator'?'developer':e.role,phase:e.phase,dispatch_id:e.dispatch_id,trigger:{kind:trigger.kind==='tick'?'fallback_tick':'github_event',event_id:trigger.id},source:{branch:e.branch,sha:e.source_sha},gate:{gate_sha:e.source_sha,audit:{verdict:audit.verdict,reviewed_sha:audit.reviewed_sha,ref:e.audit_refs.audit},qa:{verdict:qa.verdict,reviewed_sha:qa.reviewed_sha,ref:e.audit_refs.qa},open_p0_p1:0},task:{cli:e.kind,mode:'readonly',template:'readonly-repo-summary',max_runtime_ms:e.limits.runtime_ms},cost:{billing:'capped',cap_usd:e.limits.max_cost},issued_at:new Date(now).toISOString(),expires_at:new Date(e.expires_at).toISOString()};
 return {seam:'R45_v1',evidence:'E2_E3_FAKE',unsigned_envelope:frame,envelope_digest:C.digest(frame),dedupe_key:C.pilotWorkKey(e),signature_status:'NOT_SIGNED',real_dispatch:false,actual_agent_launches:0};
}
function normalize(o,prepared,e,refs){
 const frame=prepared?.unsigned_envelope;
 if(!frame||prepared.evidence!=='E2_E3_FAKE'||prepared.signature_status!=='NOT_SIGNED'||prepared.envelope_digest!==C.digest(frame)||prepared.dedupe_key!==C.pilotWorkKey(e)||o?.schema!==outcomeSchema||o.dispatch_id!==e.dispatch_id||o.dedupe_key!==prepared.dedupe_key||o.envelope_digest!==prepared.envelope_digest||o.source_sha!==e.source_sha||o.gate_sha!==e.source_sha||!['never','manual_only','none'].includes(o.retry)||o.agent_launch?.real_agent_launch!==false||o.agent_launch?.actual_agent_launches!==0||!['E2','E3_FAKE','E3_FAKE_CLI'].includes(o.evidence?.level)||!C.safeRunId(o.run_id)||typeof o.cost?.known!=='boolean')C.reject('RUNNER_OUTCOME_INVALID');
 // Local log_file is never read or published. Refs must be supplied by a trusted
 // evidence publisher; shape validation is not proof those remote artifacts exist.
 if(!C.keys(refs,'log_ref ci_ref report_ref')||!Object.values(refs).every(C.safeRef))C.reject('RUNNER_OUTCOME_INVALID');
 const state=({SUCCESS:'SUCCESS',FAILED:'FAILED',TIMEOUT:'UNKNOWN',CANCELLED:'STOPPED',BLOCKED:'FAILED',REJECTED:'FAILED',HUMAN_REVIEW_REQUIRED:'UNKNOWN'}[o.state]);if(!state)C.reject('RUNNER_OUTCOME_INVALID');
 const result={schema:1,dispatch_id:e.dispatch_id,idempotency_key:e.idempotency_key,run_id:o.run_id,source_sha:e.source_sha,fixed_sha:e.source_sha,state,exit_code:o.process?.exit_code??o.process?.exit??null,cost_known:o.cost.known,cost:o.cost.known?o.cost.usd:null,...refs,retry:'NEVER',evidence:'E2_E3_FAKE',actual_agent_launches:0};
 return C.outcome(result,e);
}
module.exports={prepare,normalize,envelopeSchema,outcomeSchema};
