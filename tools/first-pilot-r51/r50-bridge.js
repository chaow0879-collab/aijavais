'use strict';
// R50 owns intake/identity/approvals/signing. This is composition into R51's
// single constrained entry, not another broker, identity verifier or scheduler.
const fs=require('node:fs'),crypto=require('node:crypto');
const E=require('./entry'),O=require('./official-port'),A=require('./admission'),R49=require('../first-handoff-r49/control'),C=require('../auto-handoff-r46/contract'),P=require('../agent-pilot-r45/contract');
const {verifyDelivery}=require('../trusted-trigger-r50/intake'),{verifyOidc}=require('../trusted-trigger-r50/oidc'),{tickRecord}=require('../trusted-trigger-r50/pipeline'),{Broker,TestSigner,verifyApproval}=require('../trusted-trigger-r50/broker');
const {isMinted}=require('../trusted-trigger-r50/identity');
const blocked=reason=>({...O.blocked(),reason});
async function handleTrusted(input={}){
 if(input.mode!=='fake')return O.blocked();
 try{
  const {base,broker,kind}=input,now=input.now??Date.now();
  if(!(broker instanceof Broker)||!(broker.signer instanceof TestSigner)||broker.signer.test!==true)return blocked('BLOCKED_TRUSTED_SIGNATURE_BROKER');
  const bound={};for(const k of ['candidate_sha','config','envelope','authorization','snapshot','policy','refs','admission'])bound[k]=E.publicClone(base[k]);for(const k of ['backend','sourceRepo','stateDir','fakeExecutable'])bound[k]=base[k];bound.now=now;
  const approval=E.publicClone(input.approval),a=approval,e=bound.envelope;
  if(a?.task_id!==e.task_id||a.issue!==e.issue||a.source_sha!==e.source_sha||a.role!==(e.role==='integrator'?'developer':e.role))return blocked('BLOCKED_APPROVAL_TASK_BINDING');
  const keyId=k=>crypto.createPublicKey(k).export({type:'spki',format:'der'}).toString('hex');
  const signerIdentity=keyId(broker.signer.publicPem),otherKeys=[...Object.values(bound.config.trusted_keys||{}).flatMap(x=>Object.values(x)),...Object.values(broker.policy.approver_keys||{})];
  if(otherKeys.some(k=>keyId(k)===signerIdentity))return blocked('KEY_ROLE_CONFLICT');
  A.validate(bound.admission,bound);
  const r50Policy=E.publicClone(broker.policy),policyHash=C.digest(r50Policy),approvalHash=C.digest(approval);
  const originalHashes=Object.fromEntries(['config','snapshot','policy','admission','authorization'].map(k=>[k,C.digest(bound[k])]));
  let record;
  if(kind==='event')record=verifyDelivery(input.delivery,{secret:input.webhookSecret,r46config:bound.config,policy:r50Policy,store:broker.store,now});
  else if(kind==='verified-event'){
   // R50's loopback receiver has already consumed the delivery nonce. Accept
   // only its in-process identity, never a deserialized lookalike or re-check
   // that would incorrectly consume the same delivery a second time.
   if(!isMinted(input.record)||input.record.kind!=='github_webhook')return blocked('UNTRUSTED_TRIGGER');record=input.record;
  }
  else if(kind==='tick'){
   if(input.jwks?.synthetic!==true)return blocked('BLOCKED_IDENTITY_PROVIDER');
   const identity=verifyOidc(input.oidcToken,{jwks:input.jwks,policy:r50Policy,now});record=tickRecord(identity,now,bound.config);
  }else return blocked('UNTRUSTED_TRIGGER');
  if(!record)return blocked('UNTRUSTED_TRIGGER');bound.trigger=record.trigger;
  const prepared=R49.prepare(bound),caller=kind==='tick'?record.identity:record;
  const {signed,receipt}=broker.sign({caller,approval,prepared:{...prepared,task_id:e.task_id},now});
  if(receipt.test_signer!==true||receipt.candidate_sha!==bound.candidate_sha||receipt.work_key!==C.pilotWorkKey(e)||receipt.envelope_digest!==P.envelopeDigest(signed))return blocked('BLOCKED_BROKER_RECEIPT');
  const authorityCheck=async at=>{
   if(broker.store.revoked(a.approval_id)||process.env.AIJ_R50_KILL==='1'||input.killFile&&fs.existsSync(input.killFile))return false;
   if(C.digest(E.publicClone(broker.policy))!==policyHash||C.digest(E.publicClone(input.approval))!==approvalHash)return false;
   for(const k of Object.keys(originalHashes))if(C.digest(E.publicClone(base[k]))!==originalHashes[k])return false;
   verifyApproval(approval,r50Policy,at);
   // R57 may only add a privilege-reducing parent-review check. The existing
   // entry bounds/awaits it at spawn and during the owned process watch.
   if(input.authorityCheck&&await input.authorityCheck(at)!==true)return false;
   return true;
  };
  const r=await E.runPilot({...bound,mode:'fake',signed,signal:input.signal,authorityCheck});
  broker.store.audit('r51_result',{candidate_sha:bound.candidate_sha,work_key:receipt.work_key,state:r.state,stop_reason:r.stop_reason||null},now);
  return {...r,r50:{trigger:kind,approval_id:a.approval_id,work_key:receipt.work_key,broker_key_id:receipt.broker_key_id,test_signer:true},real_webhook:'NOT_INSTALLED'};
 }catch{return blocked('BLOCKED_R50_IDENTITY_APPROVAL_OR_SOURCE');}
}
module.exports={handleTrusted};
