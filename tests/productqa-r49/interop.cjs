'use strict';
// Independent R48 TestBroker/current R49 seam checks. Synthetic keys only.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const H=require('./harness.cjs'),F=require('./flow-fixture.cjs'),B=require('../../tools/first-handoff-r49/control'),P=require('../../tools/agent-pilot-r45/contract'),bridge=require('../../tools/agent-interop-r48/bridge');
const results=[];
(async()=>{for(const role of ['audit','qa']){
 const id='I01-r48-broker-current-r49-'+role,dir=fs.mkdtempSync(path.join(os.tmpdir(),'qa49-interop-'));let service,detail;
 try{
  const f=F.make(path.join(dir,'fixture'),'success',{role,phase:role});service=await F.service(path.join(dir,'cas.sqlite'));f.backend=service.backend;
  const prepared=B.prepare(f.input());assert.equal(bridge.toR45(prepared).status,'BLOCKED_TRUSTED_SIGNATURE_BROKER');
  const broker=new bridge.TestBroker({testOnly:true}),mapped=bridge.toR45(prepared,{broker,canonical:P.canonical});
  assert.equal(mapped.status,'SIGNED_BY_TEST_BROKER');f.signed=mapped.envelope;f.policy={...f.policy,trusted_keys:broker.trustEntry()};
  const r=await B.execute(f.input());assert.equal(r.state,'SUCCEEDED');assert.equal(r.actual_agent_launches,0);assert.equal(f.launches().length,1);
  const receipt=JSON.parse(fs.readFileSync(path.join(f.stateDir,'outcome-'+P.dedupeKey(f.signed)+'.json'),'utf8'));
  const normalization=bridge.toR46(receipt);assert.equal(normalization.status,'MAPPED');assert.equal(normalization.outcome.process.exit,0);
  assert.throws(()=>bridge.toR46({...receipt,agent_launch:{real_agent_launch:true,actual_agent_launches:1}}),/REAL_OUTCOME/);
  const bytes=fs.readFileSync(path.join(f.stateDir,receipt.evidence.log_file));assert.equal(H.hash(bytes),receipt.evidence.log_sha256);H.write(id+'/process.log',bytes);
  detail={report:r,receipt,normalization,process_invocations:f.launches(),actual_agent_launches:0,synthetic_keys:true};results.push({id,status:'PASS'});
 }catch(e){results.push({id,status:'FAIL',error:e.message,stack:e.stack});process.exitCode=1;}
 finally{if(service)await service.stop();if(fs.existsSync(path.join(dir,'cas.sqlite')))detail={...detail,sqlite:F.sqlite(path.join(dir,'cas.sqlite'))};H.write(id+'/evidence.json',{...results.at(-1),detail});fs.rmSync(dir,{recursive:true,force:true});}
 console.log('QA49_INTEROP '+JSON.stringify(results.at(-1)));if(process.exitCode)break;
}})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>{H.write('interop-results.json',{businessSha:H.BUSINESS_SHA,results,actual_agent_launches:0});H.manifest();console.log('QA49_INTEROP_SUMMARY '+JSON.stringify({cases:results.length,pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL').length}));});
