'use strict';
const {digest,REPO,reject}=require('./policy');
const LIVE_REMOTE_BUILD_ENABLED=false;
const BRANCH='heads/feat/agent-executor-state-v2';
function valid(doc){
 if(doc?.schema!==1||Object.keys(doc).some(k=>!['schema','jobs'].includes(k))||!doc.jobs||Array.isArray(doc.jobs))return false;
 const allowed=['role','issue','sha','state','claimed_at','actual_cost','owner_hash','day','max_spend','heartbeat'];
 return Object.entries(doc.jobs).every(([k,j])=>/^[a-f0-9]{64}$/.test(k)&&j&&Object.keys(j).every(f=>allowed.includes(f))&&['integrator','audit','qa'].includes(j.role)&&Number.isSafeInteger(j.issue)&&/^[a-f0-9]{40}$/.test(j.sha||'')&&['CLAIMED','RUNNING','UNKNOWN','SUCCESS','FAILED','STOPPED'].includes(j.state)&&j.actual_cost===null&&/^[a-f0-9]{64}$/.test(j.owner_hash||'')&&/^\d{4}-\d{2}-\d{2}$/.test(j.day||'')&&Number.isFinite(j.max_spend)&&j.max_spend>=0&&Number.isSafeInteger(j.heartbeat)&&Number.isSafeInteger(j.claimed_at));
}
// REST protocol is transport-injected for offline tests. No real transport is
// constructible in this source revision. A protected FF-only state ref is vital.
class GitHubRefProtocol{
 #transport;
 constructor(transport){this.#transport=transport;}
 async #call(method,route,body){const r=await this.#transport(method,route,body);if(!r||r.status!==200&&r.status!==201){const e=Error('REMOTE_STATUS');e.status=r?.status;throw e;}return r.data;}
 async read(){
  const ref=await this.#call('GET','/git/ref/'+BRANCH);const sha=ref.object?.sha;if(!/^[a-f0-9]{40}$/.test(sha||''))reject('REMOTE_REF_UNKNOWN');
  const commit=await this.#call('GET','/git/commits/'+sha);const tree=await this.#call('GET','/git/trees/'+commit.tree?.sha);
  if(tree.truncated===true||!Array.isArray(tree.tree))reject('REMOTE_TREE_UNKNOWN');
  const item=tree.tree.find(x=>x.path==='jobs.json');if(item?.type!=='blob'||item.mode!=='100644')reject('REMOTE_DOCUMENT_UNKNOWN');
  const blob=await this.#call('GET','/git/blobs/'+item.sha);if(blob.encoding!=='base64'||typeof blob.content!=='string'||blob.content.length>5500000)reject('REMOTE_DOCUMENT_UNKNOWN');
  const doc=JSON.parse(Buffer.from(blob.content,'base64').toString('utf8'));if(!valid(doc))reject('REMOTE_DOCUMENT_UNKNOWN');return {version:sha,document:doc};
 }
 async compareAndSwap(version,doc){
  if(!/^[a-f0-9]{40}$/.test(version||'')||!valid(doc))reject('REMOTE_DOCUMENT_UNKNOWN');
  const text=JSON.stringify(doc);if(Buffer.byteLength(text)>4*1024*1024)reject('REMOTE_DOCUMENT_LIMIT');
  const commit=await this.#call('GET','/git/commits/'+version);
  const blob=await this.#call('POST','/git/blobs',{content:Buffer.from(text).toString('base64'),encoding:'base64'});
  const tree=await this.#call('POST','/git/trees',{base_tree:commit.tree.sha,tree:[{path:'jobs.json',mode:'100644',type:'blob',sha:blob.sha}]});
  const next=await this.#call('POST','/git/commits',{message:'executor state '+digest(doc),tree:tree.sha,parents:[version]});
  try{await this.#call('PATCH','/git/refs/'+BRANCH,{sha:next.sha,force:false});return {committed:true};}catch(e){if([409,422].includes(e.status))return {committed:false};throw e;}
 }
}
class LiveGithubRefTransport extends GitHubRefProtocol{
 constructor(token){
  if(!LIVE_REMOTE_BUILD_ENABLED)reject('LIVE_GITHUB_STATE_TRANSPORT_DISABLED');
  if(typeof token!=='string'||!token)reject('BLOCKED_CONTROL_PLANE_CREDENTIALS');
  super(async(method,route,body)=>{
   const allowed=method==='GET'&&(route==='/git/ref/'+BRANCH||/^\/git\/(commits|trees|blobs)\/[a-f0-9]{40}$/.test(route))||method==='POST'&&['/git/blobs','/git/trees','/git/commits'].includes(route)||method==='PATCH'&&route==='/git/refs/'+BRANCH&&body?.force===false;
   if(!allowed)reject('REMOTE_ROUTE_DENIED');
   const response=await fetch('https://api.github.com/repos/'+REPO+route,{method,headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json','content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
   return {status:response.status,data:await response.json()};
  });
 }
}
module.exports={GitHubRefProtocol,LiveGithubRefTransport,valid,BRANCH};
