const test=require('node:test'),assert=require('node:assert/strict');
const {GitHubRefProtocol,LiveGithubRefTransport,BRANCH}=require('../../agent-executor/github-ref-backend'),{RemoteJobs}=require('../../agent-executor/remote-state');
function remote(){
 const calls=[],sha=n=>n.toString(16).padStart(40,'0'),commits={},trees={},blobs={};let seq=3,ref=sha(1);
 commits[ref]={tree:{sha:sha(2)}};trees[sha(2)]={tree:[{path:'jobs.json',type:'blob',mode:'100644',sha:sha(3)}]};blobs[sha(3)]={encoding:'base64',content:Buffer.from(JSON.stringify({schema:1,jobs:{}})).toString('base64')};
 const api=async(method,route,body)=>{calls.push({method,route,body});
  if(method==='GET'){if(route==='/git/ref/'+BRANCH)return{status:200,data:{object:{sha:ref}}};const [, ,kind,key]=route.split('/');return{status:200,data:({commits,trees,blobs})[kind]?.[key]};}
  const key=sha(++seq);
  if(route==='/git/blobs'){blobs[key]={encoding:body.encoding,content:body.content};return{status:201,data:{sha:key}};}
  if(route==='/git/trees'){trees[key]={tree:body.tree};return{status:201,data:{sha:key}};}
  if(route==='/git/commits'){commits[key]={parents:body.parents,tree:{sha:body.tree}};return{status:201,data:{sha:key}};}
  if(route==='/git/refs/'+BRANCH){assert.equal(body.force,false);if(commits[body.sha].parents[0]!==ref)return{status:422};ref=body.sha;return{status:200,data:{}};}
  throw Error('unexpected route');
 };
 return {backend:new GitHubRefProtocol(api),api,calls};
}
const request={repo:'chaow0879-collab/aijavais',issue:22,role:'audit',phase:'audit',sha:'a'.repeat(40),approval_version:'fake'};
test('REST commit protocol persists only safe metadata on one dedicated ref',async()=>{const r=remote(),jobs=new RemoteJobs(r.backend);const c=await jobs.claim(request);assert.equal(c.state,'CLAIMED');assert.equal((await jobs.update(c.key,'RUNNING')).state,'RUNNING');assert.equal((await jobs.update(c.key,'SUCCESS')).state,'SUCCESS');const stored=await r.backend.read();assert.equal(stored.document.jobs[c.key].actual_cost,null);assert.ok(r.calls.filter(c=>c.method==='PATCH').every(c=>c.route.endsWith(BRANCH)&&c.body.force===false));});
test('REST sibling commit race fails CAS rather than force-overwriting',async()=>{const r=remote();const results=await Promise.all([new RemoteJobs(r.backend).claim(request),new RemoteJobs(r.backend).claim(request)]);assert.equal(results.filter(c=>c.state==='CLAIMED').length,1);});
test('REST 403/429 missing state never initializes or retries writes',async()=>{for(const status of [403,429,404]){let calls=0;const r=await new RemoteJobs(new GitHubRefProtocol(async()=>{calls++;return{status};})).claim(request);assert.equal(r.state,'BLOCKED');assert.equal(calls,1);}});
test('remote role owner token cannot be adopted by another runner',async()=>{const r=remote(),first=new RemoteJobs(r.backend),claimed=await first.claim(request);const result=await new RemoteJobs(r.backend).update(claimed.key,'RUNNING');assert.equal(result.reason,'REMOTE_OWNER_OR_STATE');});
test('remote daily cap keeps conservative job bounds after success',async()=>{const r=remote(),jobs=new RemoteJobs(r.backend),req={...request,limits:{max_model_spend:2,max_daily_model_spend:2}};const c=await jobs.claim(req);await jobs.update(c.key,'RUNNING');await jobs.update(c.key,'SUCCESS');assert.equal((await jobs.claim({...req,approval_version:'new'})).reason,'REMOTE_DAILY_BUDGET');});
test('real HTTP is not reached even when token string provided',()=>{let calls=0;const old=global.fetch;try{global.fetch=()=>{calls++;};assert.throws(()=>new LiveGithubRefTransport('FAKE_TOKEN'),/DISABLED/);assert.equal(calls,0);}finally{global.fetch=old;}});
