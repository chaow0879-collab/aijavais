'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {GitHubState,LiveGitHubState,REF,FILE,blobHash}=require('../../tools/auto-handoff-r46/github-state'),S=require('../../tools/auto-handoff-r46/state'),C=require('../../tools/auto-handoff-r46/contract');
const {fixture}=require('./fixtures.cjs'),{reconcile}=require('../../tools/auto-handoff-r46/reconcile');
function remote(){
 const calls=[],sha=n=>n.toString(16).padStart(40,'0'),commits={},trees={},blobs={};let ref=sha(1),seq=10;
 const text=C.canonical(S.empty()),b=blobHash(text);commits[ref]={tree:{sha:sha(2)}};trees[sha(2)]={tree:[{path:FILE,mode:'100644',type:'blob',sha:b}]};blobs[b]={encoding:'base64',content:Buffer.from(text).toString('base64')};
 let fault=null;
 const api=async(method,route,body)=>{
  calls.push({method,route,body});
  if(fault==='deny')return {status:403};
  if(method==='GET'){if(route==='/git/ref/'+REF)return {status:200,data:{object:{sha:ref}}};const [,,,key]=route.split('/'),kind=route.split('/')[2];return {status:200,data:({commits,trees,blobs})[kind]?.[key]};}
  if(route==='/git/blobs'){const id=blobHash(Buffer.from(body.content,'base64').toString('utf8'));blobs[id]={encoding:body.encoding,content:body.content};return {status:201,data:{sha:id}};}
  const id=sha(++seq);
  if(route==='/git/trees'){trees[id]={tree:body.tree};return {status:201,data:{sha:id}};}
  if(route==='/git/commits'){commits[id]={parents:body.parents,tree:{sha:body.tree}};return {status:201,data:{sha:id}};}
  if(route==='/git/refs/'+REF){assert.equal(body.force,false);if(commits[body.sha].parents[0]!==ref)return {status:422};ref=body.sha;if(fault==='lost-ack'){fault=null;throw Error('PRIVATE_FIXTURE');}return {status:200,data:{object:{sha:ref}}};}
  throw Error('fixture unknown route');
 };
 return {backend:new GitHubState(api),api,calls,trees,blobs,commits,ref:()=>ref,fault:x=>fault=x};
}
test('GitHub FF-only protocol persists claimed marker/outcome with public-safe metadata',async()=>{const f=fixture(),r=remote();f.backend=r.backend;assert.equal((await reconcile(f.input())).state,'SUCCEEDED');const stored=await r.backend.read();assert.ok(S.valid(stored.document));assert.ok(r.calls.filter(c=>c.method==='PATCH').every(c=>c.body.force===false&&c.route==='/git/refs/'+REF));assert.doesNotMatch(JSON.stringify(stored.document),/fixture context|PRIVATE_KEY|Bearer|SECRET/);});
test('GitHub sibling commits race: only one claimant and one Node Stub execution',async()=>{const f=fixture(),r=remote();f.backend=r.backend;const rs=await Promise.all([reconcile(f.input()),reconcile(f.input())]);assert.equal(rs.filter(x=>x.state==='SUCCEEDED').length,1);assert.equal(f.runner.calls,1);});
test('GitHub lost ACK is not a write retry or a second model dispatch',async()=>{const f=fixture(),r=remote();r.fault('lost-ack');f.backend=r.backend;assert.equal((await reconcile(f.input())).state,'BLOCKED');assert.equal(f.runner.calls,0);assert.equal((await reconcile(f.input())).reason,'DUPLICATE_NO_REPLAY');assert.equal(r.calls.filter(c=>c.method==='PATCH').length,1);});
for(const status of [403,404,429,500])test('GitHub '+status+' never initializes a missing ref or dispatches',async()=>{const f=fixture();let count=0;f.backend=new GitHubState(async()=>{count++;return {status};});const r=await reconcile(f.input());assert.equal(r.state,'BLOCKED');assert.equal(f.runner.calls,0);assert.equal(count,1);if(status===429)assert.equal(r.retry_after_ms,600000);});
test('GitHub malformed tree, wrong blob hash and duplicate JSON keys fail closed',async()=>{for(const fault of ['tree','hash','duplicate']){const r=remote(),commit=r.commits[r.ref()];if(fault==='tree')r.trees[commit.tree.sha].tree.push({...r.trees[commit.tree.sha].tree[0]});else{const item=r.trees[commit.tree.sha].tree[0],raw=fault==='hash'?'{}':C.canonical(S.empty()).replace('"jobs":{}','"jobs":{},"jobs":{}');const b=fault==='hash'?item.sha:blobHash(raw);item.sha=b;r.blobs[b]={encoding:'base64',content:Buffer.from(raw).toString('base64')};}await assert.rejects(r.backend.read());}});
test('real GitHub transport stays compiled OFF, no token read or network call',()=>{const fetch=global.fetch;let n=0;try{global.fetch=()=>{n++;};assert.throws(()=>new LiveGitHubState('SYNTHETIC_VALUE'),/DISABLED/);assert.equal(n,0);}finally{global.fetch=fetch;}});
test('GitHub invalid scope cannot cause arbitrary REST request',async()=>{const r=remote();await assert.rejects(r.backend.call('DELETE','/git/refs/heads/main'));await assert.rejects(r.backend.call('PATCH','/git/refs/'+REF,{force:true}));assert.equal(r.calls.length,0);});
test('remote read timeout is bounded and never automatically retried',async()=>{let calls=0;const b=new GitHubState(async()=>{calls++;return new Promise(()=>{});},20);await assert.rejects(b.read(),/REMOTE_TIMEOUT/);assert.equal(calls,1);});
