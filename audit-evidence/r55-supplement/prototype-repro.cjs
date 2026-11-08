'use strict';
// Independent local-data probe. No fetch, model, credentials or business writes.
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const root=path.resolve(process.env.REVIEWED_ROOT),C=require(root+'/public/haloflux-workbench-r52/contract'),J=require(root+'/public/haloflux-workbench-r52/projector');
const SHA='8e9584149cccac02fa0b5c39a68c1983ec60170e';
function event(role,id){return {schema:C.EVENT_SCHEMA,event_id:id,work_id:'independent-prototype',seq:1,type:'agent_started',role_id:role,at:Date.now(),evidence:'FIXTURE',source:'AUDITOR_LOCAL_JSON_NOT_REAL_PROVIDER'};}
const normal=J.createProjector({mode:'REPLAY'});normal.ingest([event('ordinary-role','normal')]);const state=normal.state();assert.equal(state.roles['ordinary-role'].state,'started');
const before=Object.getOwnPropertyDescriptors(Object.prototype),bad=event('__proto__','reserved-id'),projection=J.createProjector({mode:'REPLAY'});
const accepted=C.validateEvent(bad).ok,ingest=projection.ingest([bad]);let error=null;
try{projection.state();}catch(e){error={name:e.name,message:e.message};}
const polluted=Object.getOwnPropertyNames(Object.prototype).filter(k=>!Object.hasOwn(before,k));
const result={reviewed_sha:SHA,normal_role:'PASS',input_validated:accepted,ingest,projection_error:error,object_prototype_added_keys:polluted,plain_object_state:({}).state||null,verdict:error||polluted.length?'FAIL':'PASS',actual_agent_launches:0,real_model_calls:0};
for(const key of Object.getOwnPropertyNames(Object.prototype))if(!Object.hasOwn(before,key))delete Object.prototype[key];
console.log(JSON.stringify(result,null,2));if(process.env.AUDIT_OUT)fs.writeFileSync(process.env.AUDIT_OUT,JSON.stringify(result,null,2));
if(error||polluted.length)process.exitCode=1;
