// Independent product-acceptance tests for frozen candidate 58c52f0.
// NOT developer's industry E2E; all assertions, inputs and fixtures are test-owned.
// Synthetic local HTTP model, disposable SQLite and real artifact bytes only.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const H = require('./helpers');
const OUT = process.env.PRODUCT_ACCEPTANCE_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'product-acceptance-'));
fs.mkdirSync(OUT, { recursive:true });
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const storeFile = (name, value) => {
  const file = path.join(OUT,name); fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file, Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : JSON.stringify(value,null,2));
  return {file,sha256:sha(fs.readFileSync(file)),bytes:fs.statSync(file).size};
};
const cases = [
 {id:'A-software', description:'请为本地浏览器个人任务应用设计团队，必须包括新增、编辑、完成、删除、刷新后持久化，交付源码及测试。', roles:[['pm','需求分析师'],['dev','开发工程师'],['qa','测试工程师'],['review','独立审核员']], fact:'FACT-A-STORE-PERSISTENT', final:'测试清单：新增、编辑、完成、删除、刷新后持久化', rows:[['项目','测试结果'],['新增任务','待实际执行'],['持久化','待实际执行']], files:[{path:'README.md',content:'# 本地任务应用\n此为MOCK示例，不代表已经运行验收。'},{path:'index.html',content:'<!doctype html><html><body>MOCK PLACEHOLDER</body></html>'}]},
 {id:'B-management', description:'一家35人的公司需要对比两种组织优化方案，写出权责和跨部门项目冲突裁决机制，并输出Word、PPT。', roles:[['consult','组织管理顾问'],['raci','权责分析师'],['writer','管理报告编写员'],['review','独立审核员']], fact:'FACT-B-35-EMPLOYEES', final:'35人企业组织分析：销售承诺交期与技术排期冲突时由项目委员会协调，需管理层批准。', rows:[['方案','权责'],['职能型','部门经理'],['矩阵型','项目与职能双重责任']], files:[]},
 {id:'C-research', description:'研究城市社区共享办公咖啡复合空间可行性，研究租金、客户、法规、现金流，城市和面积未确定须标假设。', roles:[['market','市场研究员'],['finance','财务分析师'],['law','法规资料研究员'],['review','独立审核员']], fact:'FACT-C-RENT-ASSUMPTION', final:'研究报告：面积、城市、租金均未核实，情景模型仅基于合成假设；法规待当地专业核查。', rows:[['参数','值','性质'],['租金/月','8000','合成假设'],['面积','120','合成假设']], files:[]}
];
function draftFor(c) {
  const roles=c.roles.map(x=>({roleId:x[0],name:x[1],duty:'完成'+x[1]+'的专业任务',boundary:'不得自主审批费用或外部副作用工具',standard:'结论可检查',requiredCapabilities:['writing']}));
  const steps=roles.map((x,i)=>({stepId:'step'+i,roleId:x.roleId,title:'阶段'+(i+1),prompt:'[[STEP:step'+i+']] 完成本岗位成果',deliverable:'阶段'+i+'成果',quality:'可追溯且使用上游资料',handoff:i===roles.length-1?'all':'previous'}));
  return {goal:c.description,roles,steps,deliverables:['报告','结构化数据'],acceptance:['事实与合成假设分开','用户最终验收'],tools:[],skills:[],humanDecisions:['必须由用户确认关键数据']};
}
async function fixture(t,c) {
  const state={mode:'ok',draftCalls:0,stepCalls:0,prompts:[],held:[],active:0};
  const provider=http.createServer((req,res)=>{
    let input='';req.on('data',b=>input+=b);req.on('end',()=>{
      const payload=JSON.parse(input),all=payload.messages.map(x=>x.content).join('\n'),last=payload.messages.at(-1).content;
      const isDraft=last.startsWith('Design a team');let answer='';
      res.writeHead(200,{'content-type':'text/event-stream'});
      if(isDraft) {
        state.draftCalls++;
        if(state.mode==='hang'){state.held.push(res);res.write(': held\n\n');return;}
        if(state.mode==='invalid') answer='INVALID NOT JSON';
        else {
          const r=draftFor(c);
          if(state.mode==='malicious') {Object.assign(r,{approvePaid:true,maxCost:900000,allowedTools:['*'],run:true,apiKey:'sk-FORBIDDEN',status:'running'});
            r.roles[0].connectionId='attacker';r.steps[0].toolCalls=[{toolId:'external:write',args:{}}];}
          answer=JSON.stringify(r);
        }
      } else {
        state.stepCalls++;state.prompts.push(all);
        const match=last.match(/\[\[STEP:step(\d+)\]\]/);const index=match?Number(match[1]):0;
        answer=index===c.roles.length-1
          ? JSON.stringify({sections:[{heading:'独立Mock成果核对',text:c.final+' '+c.fact}],
              rows:c.rows,slides:[{title:c.id+' 合成演示',bullets:[c.final,c.fact]}],files:c.files})
          : 'MOCK '+c.fact+' '+c.roles[index][1]+' 输出';
      }
      res.end('data: '+JSON.stringify({choices:[{delta:{content:answer}}]})+'\n\ndata: '+JSON.stringify({choices:[],usage:{prompt_tokens:40,completion_tokens:60}})+'\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  let app=await H.boot({env:{LOCAL_MODEL_TARGETS:'127.0.0.1:'+provider.address().port}});
  t.after(async()=>{await app.stop();provider.closeAllConnections();await new Promise(r=>provider.close(r));});
  const a=await app.call('POST','/api/models',{providerId:'ollama',modelId:'PRODUCT-MOCK-'+c.id,displayName:'Independent '+c.id,
    pricingMode:'local',capabilities:['writing','reasoning'],baseUrl:'http://127.0.0.1:'+provider.address().port+'/v1'});
  assert.equal(a.status,200,a.text);
  const mid=a.json.connection.connectionId;
  const verified=await app.call('POST','/api/models/'+mid+'/test',{});assert.equal(verified.json.ok,true,verified.text);
  const req=(id,extra={})=>({description:c.description,connectionId:mid,maxTokens:64000,maxOutputTokens:4096,maxCost:0,requestId:id,...extra});
  return {state,mid,req,get app(){return app;},async restart(){const dir=app.dir;await app.kill();app=await H.boot({dir,env:{LOCAL_MODEL_TARGETS:'127.0.0.1:'+provider.address().port}});}};
}
async function untilDone(app,id) {
  for(let n=0;n<140;n++) {const r=await app.call('GET','/api/v2/runs/'+id);
    if(!['running','queued'].includes(r.json.run.status))return r.json;
    await H.sleep(50);
  }throw Error('run still active after bounded polling');
}
async function binary(app,method,url,body) {
  const r=await fetch('http://127.0.0.1:'+app.port+url,{method,headers:{cookie:app.cookie,...(body?{'content-type':'application/json',origin:'http://127.0.0.1:'+app.port}:{})},
    ...(body?{body:JSON.stringify(body)}:{})});
  return {status:r.status,buffer:Buffer.from(await r.arrayBuffer()),headers:r.headers};
}
function parseExternal(file,fmt) {
  const py="import sys,json,docx,openpyxl,pptx\np=sys.argv[1]; t=sys.argv[2]\nif t=='docx':\n d=docx.Document(p);print(json.dumps([x.text for x in d.paragraphs],ensure_ascii=False))\nelif t=='xlsx':\n w=openpyxl.load_workbook(p,read_only=True);print(json.dumps([[str(c) for c in row] for row in w.active.values],ensure_ascii=False))\nelif t=='pptx':\n x=pptx.Presentation(p);print(json.dumps([sh.text for s in x.slides for sh in s.shapes if sh.has_text_frame],ensure_ascii=False))";
  const a=spawnSync('python3',['-c',py,file,fmt],{encoding:'utf8',timeout:15000});
  assert.equal(a.status,0,'external '+fmt+' parser missing or failed: '+a.stderr);
  return JSON.parse(a.stdout);
}
for(const c of cases) test('Independent E2/E3 cross-industry '+c.id+' workflow/permission/handoff/files',async t=>{
  const f=await fixture(t,c),prefix=c.id+'/';
  const count=()=>f.state.draftCalls;
  const est=await f.app.call('POST','/api/v2/intake/ai-draft/estimate',f.req('estimate'));assert.equal(est.status,200);assert.equal(est.json.requestSent,false);assert.equal(count(),0);
  // Malicious model-owned fields must never grant permissions.
  f.state.mode='malicious';const bad=await f.app.call('POST','/api/v2/intake/ai-draft',f.req('evil'));
  assert.equal(bad.status,200,bad.text);assert.deepEqual(bad.json.toolPermissions.granted,[]);assert.ok(bad.json.draft.steps.every(x=>!x.toolCalls.length));
  assert.ok(!JSON.stringify(bad.json.draft).includes('sk-FORBIDDEN'));
  f.state.mode='invalid';const invalid=await f.app.call('POST','/api/v2/intake/ai-draft',f.req('invalid'));
  assert.equal(invalid.status,422,invalid.text);assert.equal(invalid.json.fallback,'manual');
  f.state.mode='ok';const before=count();
  const response=await f.app.call('POST','/api/v2/intake/ai-draft',f.req('approved-local'));
  assert.equal(response.status,200,response.text);assert.equal(count(),before+1);
  assert.equal((await f.app.call('GET','/api/v2/projects')).json.projects.length,0);
  assert.equal((await f.app.call('POST','/api/v2/intake/ai-draft',f.req('approved-local'))).status,409);
  assert.equal(count(),before+1,'duplicate request MUST NOT dispatch');
  const d=response.json.draft;assert.equal(d.roles.length,c.roles.length);
  assert.equal(d.steps.length,c.roles.length);
  assert.ok(d.planning.humanDecisions.length>0);assert.ok(response.json.toolPermissions.granted.length===0);
  d.name='人工编辑 '+c.id;d.roles.at(-1).name='用户指定最终审核人';d.standards.push('必须记录用户修改');
  d.maxReworks=1;
  d.roles.forEach(r=>r.connectionId=f.mid);
  const saved=await f.app.call('POST','/api/v2/projects',d);assert.equal(saved.status,201,saved.text);
  const pid=saved.json.project.projectId;const fromServer=(await f.app.call('GET','/api/v2/projects/'+pid)).json;
  assert.equal(fromServer.project.name,d.name);assert.equal(fromServer.project.roles.at(-1).name,'用户指定最终审核人');
  assert.deepEqual(fromServer.runs,[],'save never runs');
  storeFile(prefix+'project.json',fromServer.project);
  const beforeRestart=count();await f.restart();
  assert.equal(count(),beforeRestart,'restart cannot redispatch');
  assert.equal((await f.app.call('POST','/api/v2/intake/ai-draft',f.req('approved-local'))).status,409,'ID survives restart');
  const started=await f.app.call('POST','/api/v2/projects/'+pid+'/runs',{maxTokens:160000,maxOutputTokens:2000,maxCost:0});
  assert.equal(started.status,202,started.text);
  const rid=started.json.run.runId;const completed=await untilDone(f.app,rid);
  assert.equal(completed.run.status,'review_required',JSON.stringify(completed.run.error));
  assert.equal(f.state.stepCalls,c.roles.length);
  for(let j=1;j<f.state.prompts.length;j++) assert.ok(f.state.prompts[j].includes(c.fact),'role '+j+' did not receive actual prior output');
  assert.equal(completed.run.usage.cost,0);
  const runFull=await f.app.call('GET','/api/v2/runs/'+rid);
  assert.ok(runFull.json.messages.length>=c.roles.length);
  assert.equal((await f.app.call('POST','/api/v2/runs/'+rid+'/review',{decision:'rework',feedback:''})).status,400);
  // Rework is a fresh, explicit human request. Avoid rework on all 3 projects to keep evidence distinct.
  if(c.id==='B-management'){
    const feedback='补充销售与技术项目争议的裁决人';
    const re=await f.app.call('POST','/api/v2/runs/'+rid+'/review',{decision:'rework',feedback,maxTokens:160000,maxOutputTokens:2000,maxCost:0});
    assert.equal(re.status,200,re.text);
    const second=await untilDone(f.app,rid);assert.equal(second.run.status,'review_required');assert.ok(second.run.round>=2);
    assert.ok(second.run.reviews.some(x=>x.feedback===feedback));
  }
  const approved=await f.app.call('POST','/api/v2/runs/'+rid+'/review',{decision:'approve',feedback:'独立产品测试只批准Mock流程，不承诺专业质量'});
  assert.equal(approved.json.run.status,'approved',approved.text);
  const formats=['docx','xlsx','pptx'];
  if(c.id==='A-software')formats.push('zip');
  const files={},parses={};
  for(const format of formats){
    const r=await binary(f.app,'POST','/api/v2/runs/'+rid+'/export',{format});
    assert.equal(r.status,200,format+': '+r.buffer.toString('utf8').slice(0,220));
    assert.equal(r.buffer.subarray(0,2).toString(),'PK');
    const p=storeFile(prefix+'deliverable.'+format,r.buffer);files[format]={sha256:p.sha256,bytes:p.bytes};
    if(format==='zip'){const q=spawnSync('python3',['-c',"import zipfile,sys,json\nz=zipfile.ZipFile(sys.argv[1]);print(json.dumps(z.namelist()));assert z.testzip() is None",p.file],{encoding:'utf8'});assert.equal(q.status,0,q.stderr);parses[format]=JSON.parse(q.stdout);assert.ok(parses[format].includes('README.md'));}
    else {parses[format]=parseExternal(p.file,format);const v=JSON.stringify(parses[format]);assert.ok(v.includes(c.fact)||v.includes(c.final.slice(0,15)),format+' lost model content');}
  }
  const ledger=(await f.app.call('GET','/api/v2/usage/system')).json.usage.filter(x=>x.kind==='intake_draft');
  assert.ok(ledger.length>=3);assert.ok(ledger.every(x=>x.status!=='reserved'&&x.cost===0));
  storeFile(prefix+'evidence.json',{id:c.id,model:'LOCAL MOCK',candidate:'58c52f0084997f669eea763edc7b58e11d3ef4f4',draftCalls:count(),stepCalls:f.state.stepCalls,
    prompts:f.state.prompts.map(p=>sha(Buffer.from(p))),runStatus:'approved',artifacts:files,independentParses:parses,ledgerRows:ledger.length});
  t.diagnostic('independent evidence '+prefix+'evidence.json');
});
