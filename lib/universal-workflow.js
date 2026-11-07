'use strict';
// Product adapter over the existing bounded ProjectEngine. No CLI, timer or new queue.
const crypto=require('node:crypto'),Intake=require('../public/project-intake/engine'),catalog=require('../public/project-intake/catalog.v1.json');
const {normalizeProject}=require('./project-engine'),{ProjectError}=require('./project-store'),Budget=require('./budget'),{createDeliverable}=require('./deliverables'),Events=require('./product-events');
const SCHEMA='aijavais.universal-workflow/v1';
const fail=(message,code='invalid_workflow',status=400)=>{throw new ProjectError(message,code,status);};
const object=x=>{if(!x||typeof x!=='object'||Array.isArray(x))fail('Expected object');return x;};
const text=(x,max)=>{if(typeof x!=='string'||!x.trim()||x.length>max)fail('Text missing or too long');return x.trim();};
const hash=x=>crypto.createHash('sha256').update(canonical(x)).digest('hex');
// Output forms, never an industry whitelist. These are disclosed offline hints.
const englishForms={document:/\b(report|manual|document|handbook)\b/i,spreadsheet:/\b(spreadsheet|workbook|table)\b/i,slides:/\b(slides|presentation)\b/i,software:/\b(software|program|code|website)\b/i,visual:/\b(poster|illustration|visual)\b/i,schedule:/\b(schedule|timeline|itinerary)\b/i,curriculum:/\b(curriculum|course|lesson|training)\b/i,media:/\b(podcast|video|script)\b/i};
function canonical(x){if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';return JSON.stringify(x);}
function plan(input,{models,tools}){
 object(input);const goal=text(input.goal||input.description,20000),u=input.universal||{};
 const analysis=Intake.Universal.analyze({description:goal,universal:u});
 const outputs=input.outputs||u.outputs||Object.entries(englishForms).filter(([,pattern])=>pattern.test(goal)).map(([key])=>key);
 const result=Intake.buildPlan(catalog,{templateId:'universal',description:goal,context:input.context,audience:input.audience,answers:{rigor:analysis.risk==='high'?'strict':'normal'},universal:{domain:input.domain||u.domain,outputs:outputs.length?outputs:undefined,successCriteria:input.acceptance||u.successCriteria,constraints:input.constraints||u.constraints,risks:input.risks||u.risks},availableModels:[],availableTools:[]});
 if(!result.ok)fail(result.errors.join('; '));const p=result.plan;
 const project={name:input.name||p.projectTypeName,description:goal,context:input.context||'',roles:p.roles.map(r=>({roleId:r.id,name:r.name,duty:r.duty,boundary:r.boundary||r.duty,standard:r.standard,requiredCapabilities:r.capabilities,connectionId:''})),steps:p.steps.map(s=>({stepId:s.id,roleId:s.roleId,title:s.title,prompt:s.quality+'\n交付：'+s.deliverable,deliverable:s.deliverable,quality:s.quality,handoff:'all',kind:s.id==='u-step-review'?'peer_review':'work',toolCalls:[]})),standards:p.universal.deliveryChecks.map(c=>c.text),requiredToolIds:[],deliverables:p.universal.outputs,maxReworks:2,planning:{goal,humanDecisions:p.universal.humanCheckpoints.map(h=>h.requirement),requestedSkills:[],workflowSchema:SCHEMA,expertReviewRequired:p.universal.humanCheckpoints.length>0}};
 const registered=new Map(tools.list().map(t=>[t.toolId,t]));
 return {schema:SCHEMA,status:'PLAN_SIMULATED',generation:'offline_rules',evidence:'E2_RULES_NOT_AI',project:normalizeProject(project),intake:p.universal,clarifications:p.universal.clarifications,
  permissions:{granted:[],rolePermissions:{},requiresExplicitApproval:true},budget:{currency:'USD',cost:null,maxCost:null,maxTokens:null,providerHardCap:'NOT_VERIFIED'},
  modelRecommendations:project.roles.map(r=>({roleId:r.roleId,candidates:models.list().filter(c=>models.status(c.connectionId)==='available'&&(r.requiredCapabilities||[]).every(k=>(c.capabilities||[]).includes(k))).map(c=>({connectionId:c.connectionId,capabilitiesVerified:false}))})),
  toolRequirements:p.requiredTools.map(id=>({toolId:id,available:registered.has(id),verified:false,granted:false})),acceptance:{criteria:project.standards,humanRequired:true,expertReviewRequired:project.planning.expertReviewRequired},note:'离线规则草案，未经AI或领域专家验证；编辑并批准后才可能开始，本接口不保存、不派发。'};
}
function verifyAcceptance(store,run,input){
 if(input.confirmCriteria!==true||input.acknowledgeSimulation!==true)fail('Explicit criteria confirmation and simulation acknowledgement required','acceptance_required',403);
 if(run.executionActive||run.status!=='review_required')fail('Wait for completed and settled work','run_active',409);
 const a=store.getArtifact(run.runId,input.artifactId);
 if(!a||a.producer!=='universal_delivery'||a.round!==run.round||a.sha256!==input.sha256)fail('Accept an exact current-round delivery artifact','artifact_version_conflict',409);
 if(require('./delivery-check').checkArtifact(a,a.buffer).structure!=='valid')fail('Delivery structure not verified','delivery_invalid',409);
 if(store.getUsage(run.runId).some(e=>e.tokenSource!=='provider'||e.costSource!=='provider_usage_x_user_rates')&&input.acknowledgeUnknownCost!==true)fail('Unknown usage/cost requires explicit acknowledgement; no balance is cleared','unknown_cost_ack_required',403);
 if(run.projectSnapshot.planning.expertReviewRequired&&!input.expertReviewNote?.trim())fail('Qualified human review evidence is required; platform cannot certify it','expert_review_required',409);
 return {artifactId:a.artifactId,sha256:a.sha256,round:run.round,criteriaConfirmed:true,simulationAcknowledged:true,expertReviewNote:input.expertReviewNote?text(input.expertReviewNote,2000):null,expertVerification:'USER_ATTESTATION_NOT_INDEPENDENTLY_VERIFIED',professionalQuality:'NOT_VERIFIED'};
}
class UniversalWorkflow {
 constructor({store,engine,models,tools}){Object.assign(this,{store,engine,models,tools});}
 plan(input){return plan(input,this);}
 create(input,owner){object(input);const p=normalizeProject(input.project);p.planning={...(p.planning||{}),workflowSchema:SCHEMA,goal:p.description};
  // No browser declaration of a role/model/tool turns into permission.
  return this.engine.create(p,{ownerId:owner});
 }
 once(owner,action,id,params,fn){
  text(id,120);if(!/^[A-Za-z0-9_.:-]+$/.test(id))fail('Invalid requestId');
  const key='r53-request:'+hash([owner,action,id]),digest=hash(params);
  const prior=this.store.transaction(()=>{const old=this.store.getSetting(key);if(old)return old;this.store.setSetting(key,{digest,state:'claimed',createdAt:Date.now()});return null;});
  if(prior){if(prior.digest!==digest)fail('Request ID bound to different parameters','idempotency_key_reused',409);return {duplicate:true,state:prior.state,runId:prior.runId||null,artifactId:prior.artifactId||null,noReplay:true};}
  try{const result=fn();this.store.setSetting(key,{digest,state:'completed',runId:result.runId||null,artifactId:result.artifactId||null});return result;}
  catch(e){this.store.setSetting(key,{digest,state:'blocked_no_replay'});throw e;}
 }
 authorize(project,input){
  if(input.approved!==true||!input.rolePermissions)fail('Approve the team and every role explicitly','approval_required',403);
  for(const r of project.roles){const c=this.models.get(r.connectionId);if(!c||this.models.status(r.connectionId)!=='available')fail('Model connection missing/unavailable','model_missing',409);if(!Budget.isLocalFree(c,this.models.policy))fail('Remote provider hard cap and official authorization not verified','BLOCKED_UNENFORCEABLE_COST_CAP',402);}
  // Preserve existing global and per-role budget/permission validation.
  this.engine._approval(project,input);
 }
 start(projectId,input,owner){const p=this.store.getProject(projectId);if(!p)fail('Project not found','not_found',404);this.authorize(p,input);
  return this.once(owner,'start',input.requestId,{projectId,version:p.version,approval:input},()=>this.engine.start(projectId,input));
 }
 rework(runId,input,owner){const r=this.engine.getRun(runId);if(!r)fail('Run not found','not_found',404);this.authorize(r.projectSnapshot,input);
  return this.once(owner,'rework',input.requestId,{runId,input},()=>this.engine.review(runId,{...input,decision:'rework'}));
 }
 events(runId,{after=0,limit=1000}={}){if(!this.store.getRun(runId))fail('Run not found','not_found',404);return this.store.getEvents(runId,{after,limit}).map(Events.dto);}
 view(runId){const r=this.engine.getRun(runId);if(!r)fail('Run not found','not_found',404);const ledger=this.store.getUsage(runId);
  return {...r,evidence:'E3_LOCAL_ADAPTER_UNVERIFIED',professionalQuality:'NOT_VERIFIED',events:this.events(runId),cost:{usd:null,estimatedUpperBound:r.usage.cost,currency:'USD',vendorInvoiceReconciled:false,unknown:ledger.some(e=>e.tokenSource!=='provider'||e.costSource!=='provider_usage_x_user_rates')},artifacts:r.artifacts.map(a=>({...a,downloadUrl:`/api/v2/runs/${runId}/artifacts/${a.artifactId}/download`}))};
 }
 deliver(runId,input,owner){const run=this.engine.getRun(runId);if(!run)fail('Run not found','not_found',404);if(run.executionActive||run.status!=='review_required')fail('Wait for completed work awaiting review','run_active',409);
  const source=this.store.getArtifact(runId,run.finalArtifactId);if(!source)fail('No actual output','no_output',409);
  const format=input.format||'docx';if(!['docx','xlsx','pptx','md','csv','json'].includes(format))fail('Unsupported delivery format');
  return this.once(owner,'deliver',input.requestId,{runId,round:run.round,source:source.sha256,format},()=>this.store.transaction(()=>{
    let structured={};try{const p=JSON.parse(source.buffer.toString('utf8'));for(const k of ['sections','rows','slides'])if(Array.isArray(p[k]))structured[k]=p[k];}catch{/* ordinary text */}
    if(Array.isArray(structured.rows))structured.rows=[['E3 LOCAL ADAPTER','NOT PROFESSIONALLY VERIFIED'],...structured.rows];
    if(Array.isArray(structured.slides))structured.slides=[{title:'E3 LOCAL ADAPTER',bullets:['NOT PROFESSIONALLY VERIFIED','Human review required']},...structured.slides];
    const file=createDeliverable(format,{...structured,title:run.projectSnapshot.name,text:'E3 LOCAL ADAPTER — NOT PROFESSIONALLY VERIFIED\n'+source.buffer.toString('utf8')});
    const a=this.store.putArtifact(runId,{buffer:file.buffer,mime:file.mime,filename:file.filename,kind:'file',format,producer:'universal_delivery',round:run.round,sourceArtifactId:source.artifactId,sourceSha256:source.sha256,evidence:'E3_LOCAL_ADAPTER_UNVERIFIED',professionalQuality:'NOT_VERIFIED'});
    this.store.appendEvent(runId,{eventType:'file_generated',round:run.round,artifactId:a.artifactId,sha256:a.sha256});return {...a,downloadUrl:`/api/v2/runs/${runId}/artifacts/${a.artifactId}/download`};
  }));
 }
 accept(runId,input){const run=this.engine.getRun(runId);if(!run)fail('Run not found','not_found',404);verifyAcceptance(this.store,run,input);return this.engine.review(runId,{...input,decision:'approve'});}
}
module.exports={UniversalWorkflow,plan,verifyAcceptance,SCHEMA};
