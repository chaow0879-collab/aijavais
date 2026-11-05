// Independent fault-injection acceptance against frozen V2 business modules.
// Synthetic model adapter; real disposable SQLite; no actual provider request.
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ProjectStore}=require('../lib/project-store');
const {IntakeDraftService,MAX_SLOTS}=require('../lib/intake-draft');
const SAMPLE=()=>({goal:'为跨领域项目制定计划',roles:[{roleId:'author',name:'执行员',duty:'撰写初稿',boundary:'不批准费用',standard:'准确',requiredCapabilities:[]},
 {roleId:'qa',name:'审核员',duty:'审核并返工',boundary:'不能替用户验收',standard:'有证据',requiredCapabilities:[]}],
 steps:[{stepId:'a',roleId:'author',title:'初稿',prompt:'写方案',deliverable:'初稿',quality:'完整',handoff:'previous'},
 {stepId:'b',roleId:'qa',title:'审核',prompt:'看初稿',deliverable:'审核意见',quality:'准确',handoff:'all'}],
 deliverables:['初稿','审阅意见'],acceptance:['人工审批'],tools:[],skills:[],humanDecisions:['确认成本']});
function build(t,modelCall){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'independent-fault-'));
 const c={connectionId:'paid-test',modelId:'NO-NETWORK-MOCK',protocol:'openai',
  baseUrl:'https://invalid.test/v1',pricingMode:'paid_api',enabled:true,ready:true,status:'available',updatedAt:1};
 const models={policy:{},get:()=>c,list:()=>[c],status:()=>c.status,key:()=>'',runtime:()=>({model:c.modelId})};
 let store,service,calls=0;const audit=[];
 const start=()=>{store=new ProjectStore({dir});service=new IntakeDraftService({store,models,
    timeoutMs:5000,abortGraceMs:25,closeGraceMs:30,
    audit:(name,data)=>{audit.push({name,data});return true;},
    callModel:(...args)=>{calls++;return modelCall(...args);}});};
 start();
 const input=id=>({requestId:id,connectionId:'paid-test',description:'对复杂的跨行业任务提出角色和审核方案。',approvePaid:true,
  price:{inputPerMillion:2,outputPerMillion:4,currency:'USD'},maxTokens:32000,maxOutputTokens:2048,maxCost:1});
 t.after(async()=>{await service.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {input,get calls(){return calls;},get store(){return store;},get service(){return service;},audit,async restart(){await service.close();store.close();start();}};
}
const success=()=>({text:JSON.stringify(SAMPLE()),tokens:30,inTokens:20,outTokens:10,estimated:false,usageComplete:true});
test('F01 paid model preapproval and Token cap never dispatch synthetic external adapter',async t=>{
 const f=build(t,async()=>success());
 assert.throws(()=>f.service.generate({...f.input('unapproved'),approvePaid:false}),e=>e.code==='paid_approval_required');
 assert.throws(()=>f.service.generate({...f.input('over'),maxTokens:1}),e=>e.code==='token_budget_exceeded');
 assert.throws(()=>f.service.generate({...f.input('bad-price'),price:{inputPerMillion:0,outputPerMillion:0}}),e=>e.code==='price_required');
 assert.equal(f.calls,0);assert.equal(f.store.listSystemUsage().length,0);
 t.diagnostic('F01 negative dispatch=0; ledgerRows=0');
});
test('F02 settlement failure presents HTTP202 unknown cost and persists non-replayable ID',async t=>{
 const f=build(t,async()=>success());const backup=f.store.settleSystemUsage.bind(f.store);
 f.store.settleSystemUsage=()=>{throw Error('synthetic disk full');};
 const r=await f.service.generate(f.input('settle-qa'));
 assert.equal(r.status,202);assert.equal(r.body.code,'usage_unsettled');assert.equal(r.body.financiallyComplete,false);
 assert.equal(r.body.usage.cost,null);assert.equal(r.body.usageRecorded,false);assert.equal(f.calls,1);
 f.store.settleSystemUsage=backup;
 await f.restart();
 assert.throws(()=>f.service.generate(f.input('settle-qa')),e=>e.code==='duplicate_request');
 const a=f.store.listSystemUsage();
 assert.equal(a.length,1);assert.equal(a[0].cost,null);assert.ok(a[0].reservedCost>0);
 assert.equal(f.calls,1);
 t.diagnostic('F02 status202, unknown=null, duplicate refused after restart, calls=1');
});
test('F03 provider ignores AbortSignal: capacity limited to 3; unknown ongoing cost shown',async t=>{
 const pending=[];const f=build(t,()=>new Promise(resolve=>pending.push(resolve)));
 assert.equal(MAX_SLOTS,3);
 const p=['a','b','c'].map(id=>f.service.generate(f.input('ignore-'+id)));
 for(let i=0;i<100&&pending.length<3;i++)await new Promise(r=>setTimeout(r,2));
 assert.equal(pending.length,3);
 for(const id of ['a','b','c'])assert.equal(f.service.cancel('admin','ignore-'+id),true);
 const response=await Promise.all(p);
 for(const r of response){assert.equal(r.status,409);assert.equal(r.body.billingStatus,'dispatch_outstanding');assert.equal(r.body.usage.cost,null);
  assert.equal(r.body.providerMayStillBill,true);assert.equal(r.body.financiallyComplete,false);}
 assert.throws(()=>f.service.generate(f.input('fourth')),e=>e.code==='draft_busy'&&e.status===429);
 assert.equal(f.calls,3);assert.ok(f.service.stats().activeSlots<=3);
 for(const release of pending)release(success());
 await new Promise(r=>setTimeout(r,70));
 assert.equal(f.service.stats().activeSlots,0);
 t.diagnostic('F03 underlying calls=3, 4th refused, unknown charges until late settlement');
});
