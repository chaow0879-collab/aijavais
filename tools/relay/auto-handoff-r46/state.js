'use strict';
const {digest,canonical,keys,HASH,SHA,reject,plain,safeRef,safeRunId}=require('./contract');
const STATES=['CLAIMED','DISPATCHING','SUCCEEDED','FAILED','STOPPED','UNKNOWN','BLOCKED'];
function seal(d){const x={...d};delete x.checksum;return {...x,checksum:digest(x)};}
function empty(){return seal({schema:1,clock:0,halted:false,jobs:{},audit:[]});}
function valid(d){
 if(!keys(d,'schema clock halted jobs audit checksum')||d.schema!==1||!Number.isSafeInteger(d.clock)||d.clock<0||typeof d.halted!=='boolean'||!plain(d.jobs)||!Array.isArray(d.audit)||Object.keys(d.jobs).length>256||d.audit.length>4096||Buffer.byteLength(canonical(d))>524288)return false;
 const copy={...d};delete copy.checksum;if(d.checksum!==digest(copy))return false;
 for(const [key,j] of Object.entries(d.jobs))if(!HASH.test(key)||!keys(j,'envelope_hash task_hash work_hash dispatch_id source_sha role phase state owner_hash claimed_at heartbeat lease_until reservation day outcome reason trigger_hash')||![j.envelope_hash,j.task_hash,j.work_hash,j.dispatch_id,j.owner_hash,j.trigger_hash].every(x=>HASH.test(x))||!SHA.test(j.source_sha)||!['integrator','audit','qa'].includes(j.role)||!['integration','audit','qa'].includes(j.phase)||!STATES.includes(j.state)||![j.claimed_at,j.heartbeat,j.lease_until].every(x=>Number.isSafeInteger(x)&&x>=0)||j.heartbeat<j.claimed_at||j.lease_until<j.claimed_at||!Number.isFinite(j.reservation)||j.reservation<0||!/^\d{4}-\d{2}-\d{2}$/.test(j.day)||!(j.reason===null||/^[A-Z0-9_]{1,100}$/.test(j.reason))||!(j.outcome===null||keys(j.outcome,'state fixed_sha exit_code cost_known cost log_ref ci_ref report_ref run_id evidence')) )return false;
 const ids=new Set(),works=new Set();
 for(const [key,j] of Object.entries(d.jobs)){
  if(ids.has(j.task_hash)||works.has(j.work_hash)||j.dispatch_id!==digest(['dispatch',key])||({integrator:'integration',audit:'audit',qa:'qa'}[j.role]!==j.phase))return false;ids.add(j.task_hash);works.add(j.work_hash);
  const o=j.outcome;
  if(o&&(!['SUCCESS','FAILED','STOPPED','UNKNOWN'].includes(o.state)||!SHA.test(o.fixed_sha)||o.fixed_sha!==j.source_sha||!(o.exit_code===null||Number.isSafeInteger(o.exit_code)&&o.exit_code>=0&&o.exit_code<=255)||typeof o.cost_known!=='boolean'||(o.cost_known?(!Number.isFinite(o.cost)||o.cost<0||o.cost>j.reservation):o.cost!==null)||![o.log_ref,o.ci_ref,o.report_ref].every(safeRef)||!safeRunId(o.run_id)||o.evidence!=='E2_E3_FAKE'))return false;
  if(j.state==='SUCCEEDED'&&(!o||o.state!=='SUCCESS'||o.exit_code!==0||!o.cost_known))return false;
 }
 let previous=null,previousAt=0;for(const event of d.audit){if(!keys(event,'at type key previous hash')||!Number.isSafeInteger(event.at)||event.at<previousAt||event.at>d.clock||!STATES.includes(event.type)&&event.type!=='HALTED'||event.key!==null&&!HASH.test(event.key)||event.previous!==previous)return false;const e={...event};delete e.hash;if(event.hash!==digest(e))return false;previous=event.hash;previousAt=event.at;}
 for(const [key,j] of Object.entries(d.jobs))if(d.audit.filter(e=>e.key===key).at(-1)?.type!==j.state)return false;
 return true;
}
function log(d,type,key,now){const e={at:now,type,key,previous:d.audit.at(-1)?.hash||null};d.audit.push({...e,hash:digest(e)});}
class Ledger{
 constructor(backend,config){this.backend=backend;this.config=config;}
 async read(now){const r=await this.backend.read();if(!r||typeof r.version!=='string'||!valid(r.document))reject('REMOTE_STATE_CORRUPT');if(now<r.document.clock-this.config.clock_skew_ms)reject('CLOCK_SKEW');return r;}
 async change(now,fn){const r=await this.read(now),d=JSON.parse(JSON.stringify(r.document)),at=Math.max(now,d.clock);const result=fn(d,at);if(result?.unchanged)return result;d.clock=at;if(Object.keys(d.jobs).length>this.config.max_tasks||d.audit.length>this.config.max_audit)reject('LEDGER_CAPACITY');const next=seal(d);if(!valid(next))reject('REMOTE_STATE_CORRUPT');const ack=await this.backend.compareAndSwap(r.version,next);if(ack?.committed!==true)reject('CAS_UNKNOWN_OR_CONFLICT');return result;}
}
module.exports={Ledger,empty,valid,seal,log,STATES};
