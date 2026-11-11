'use strict';
const {reject}=require('./policy');
// No process, network, SDK import, shell or arbitrary callbacks. Scripts are data.
const members=new WeakSet();
class FakeAdapter{
 constructor(kind,backend,script=[]){
  if(!['claude','codex'].includes(kind)||!['cli','sdk','cloud_approved'].includes(backend)||!Array.isArray(script)||script.length>256)reject('INVALID_FAKE_ADAPTER');
  this.kind=kind;this.backend=backend;
  this.script=Object.freeze(script.map(step=>{if(!step||!['progress','result','fail','stop'].includes(step.type))reject('INVALID_FAKE_SCRIPT');for(const k of ['elapsed','tokens','spend'])if(step[k]!==undefined&&(!Number.isFinite(step[k])||step[k]<0))reject('INVALID_FAKE_USAGE');if(!Number.isSafeInteger(step.tokens||0)||!Number.isSafeInteger(step.elapsed||0))reject('INVALID_FAKE_USAGE');return Object.freeze({type:step.type,elapsed:step.elapsed||0,tokens:step.tokens||0,spend:step.spend||0});}));members.add(this);Object.freeze(this);
 }
 *events(){yield* this.script;}
}
Object.freeze(FakeAdapter.prototype);
const isFake=a=>members.has(a);
function realDispatch(){reject('REAL_EXECUTION_DISABLED');}
function readOnlyRetry(statuses,maxRetries=1){let calls=0;for(const code of statuses.slice(0,Math.min(maxRetries,1)+1)){calls++;if(code===200)return {calls,ok:true,actual_dispatch:false};}return {calls,ok:false,actual_dispatch:false};}
module.exports={FakeAdapter,isFake,realDispatch,readOnlyRetry};
