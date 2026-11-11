'use strict';
// Same FF-only, single-parent CAS protocol as R43 GitHubRefProtocol, with a
// separate versioned handoff document: V2's jobs schema cannot store envelopes
// and outcomes atomically. No changes to the original V2 protocol/engine.
const crypto=require('node:crypto');
const {canonical,digest,SHA,reject,REPO}=require('./contract'),{valid}=require('./state');
const REF='heads/feat/r46-handoff-state',FILE='handoffs.json';
const blobHash=text=>crypto.createHash('sha1').update('blob '+Buffer.byteLength(text)+'\0').update(text).digest('hex');
class GitHubState{
 constructor(transport,timeoutMs=10000){if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)reject('REMOTE_TIMEOUT_LIMIT');this.transport=transport;this.timeoutMs=timeoutMs;}
 async call(method,route,body){
  const allowed=method==='GET'&&(route==='/git/ref/'+REF||/^\/git\/(commits|trees|blobs)\/[a-f0-9]{40}$/.test(route))||method==='POST'&&['/git/blobs','/git/trees','/git/commits'].includes(route)||method==='PATCH'&&route==='/git/refs/'+REF&&body?.force===false;
  if(!allowed)reject('GITHUB_ROUTE_DENIED');
  let timer;const r=await Promise.race([Promise.resolve().then(()=>this.transport(method,route,body)),new Promise((_,no)=>{timer=setTimeout(()=>no(Object.assign(Error('REMOTE_TIMEOUT'),{code:'REMOTE_TIMEOUT'})),this.timeoutMs);})]).finally(()=>clearTimeout(timer));if(!r||![200,201].includes(r.status)){const e=Error('REMOTE_STATUS');e.status=r?.status;throw e;}return r.data;
 }
 async read(){
  const ref=await this.call('GET','/git/ref/'+REF),sha=ref?.object?.sha;if(!SHA.test(sha||''))reject('REMOTE_REF_UNKNOWN');
  const commit=await this.call('GET','/git/commits/'+sha);if(!SHA.test(commit?.tree?.sha||''))reject('REMOTE_TREE_UNKNOWN');
  const tree=await this.call('GET','/git/trees/'+commit.tree.sha);
  if(tree.truncated===true||!Array.isArray(tree.tree)||tree.tree.length!==1)reject('REMOTE_TREE_UNKNOWN');
  const item=tree.tree[0];if(item.path!==FILE||item.type!=='blob'||item.mode!=='100644'||!SHA.test(item.sha))reject('REMOTE_BLOB_UNKNOWN');
  const blob=await this.call('GET','/git/blobs/'+item.sha);if(blob.encoding!=='base64'||typeof blob.content!=='string'||blob.content.length>710000)reject('REMOTE_BLOB_UNKNOWN');
  const text=Buffer.from(blob.content,'base64').toString('utf8');if(blobHash(text)!==item.sha)reject('REMOTE_BLOB_HASH');
  let d;try{d=JSON.parse(text);}catch{reject('REMOTE_DOCUMENT_INVALID');}if(!valid(d)||canonical(d)!==text)reject('REMOTE_DOCUMENT_INVALID');return {version:sha,document:d};
 }
 async compareAndSwap(version,d){
  if(!SHA.test(version||'')||!valid(d))reject('REMOTE_DOCUMENT_INVALID');
  const commit=await this.call('GET','/git/commits/'+version),text=canonical(d);
  const blob=await this.call('POST','/git/blobs',{content:Buffer.from(text).toString('base64'),encoding:'base64'});if(blob.sha!==blobHash(text))reject('REMOTE_BLOB_HASH');
  const tree=await this.call('POST','/git/trees',{base_tree:commit.tree.sha,tree:[{path:FILE,mode:'100644',type:'blob',sha:blob.sha}]});if(!SHA.test(tree.sha||''))reject('REMOTE_TREE_UNKNOWN');
  const next=await this.call('POST','/git/commits',{message:'R46 handoff '+digest(d),tree:tree.sha,parents:[version]});if(!SHA.test(next.sha||''))reject('REMOTE_COMMIT_UNKNOWN');
  try{const ack=await this.call('PATCH','/git/refs/'+REF,{sha:next.sha,force:false});if(ack.object?.sha!==next.sha)reject('REMOTE_ACK_UNKNOWN');return {committed:true};}catch(e){if([409,422].includes(e.status))return {committed:false};throw e;}
 }
}
const LIVE_TRANSPORT_ENABLED=false;
class LiveGitHubState extends GitHubState{
 constructor(token){
  if(!LIVE_TRANSPORT_ENABLED)reject('R46_LIVE_TRANSPORT_DISABLED');
  if(typeof token!=='string'||!token)reject('CONTROL_PLANE_CREDENTIALS_REQUIRED');
  super(async(method,route,body)=>{
   // call() enforces fixed route/branch and FF-only mutation before this transport.
   const r=await fetch('https://api.github.com/repos/'+REPO+route,{method,headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json','content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
   let bytes=0,parts=[];for await(const chunk of r.body){bytes+=chunk.length;if(bytes>1048576)reject('REMOTE_RESPONSE_LIMIT');parts.push(Buffer.from(chunk));}
   return {status:r.status,data:JSON.parse(Buffer.concat(parts).toString('utf8'))};
  });
 }
}
module.exports={GitHubState,LiveGitHubState,REF,FILE,blobHash};
