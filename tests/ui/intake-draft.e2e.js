'use strict';
// Real Chromium/HTTP/SQLite flow; only the model provider is a local MOCK.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const H = require('../helpers');
const sample = require('../fixtures/ai-draft.cjs');
async function realLifecycleBodies(){
  const os=require('node:os');const {ProjectStore}=require('../../lib/project-store');const {IntakeDraftService}=require('../../lib/intake-draft');
  const {controlledProvider}=require('../fixtures/lifecycle-provider.cjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aij-ui-lifecycle-')),store=new ProjectStore({dir}),P=controlledProvider({mode:'ignore'});
  const c={connectionId:'m',modelId:'MOCK-UI',protocol:'openai',baseUrl:'https://mock.invalid/v1',enabled:true,ready:true,status:'available',pricingMode:'paid_api',updatedAt:1};
  const models={policy:{localTargets:new Set()},get:()=>c,status:()=>'available',list:()=>[c],key:()=>'',runtime:()=>({})};
  const svc=new IntakeDraftService({store,models,tools:{list:()=>[]},skills:{get:()=>null},callModel:P.callModel,abortGraceMs:10,closeGraceMs:10});
  const input=id=>({description:'界面验证非合作取消后的费用状态。',connectionId:'m',approvePaid:true,maxTokens:32000,maxCost:1,price:{inputPerMillion:2,outputPerMillion:4},requestId:id});
  const ops=['u1','u2','u3'].map(id=>svc.generate(input(id),{ownerId:'ui'}));await P.until(()=>P.metrics.started===3);
  svc.cancel('ui','u1');const outstanding=(await ops[0]).body;let busy;
  try{svc.generate(input('u4'),{ownerId:'ui'});}catch(e){busy={error:e.message,code:e.code,ok:false,fallback:'manual'};}
  for(const x of P.pending())x.resolve();await Promise.all(ops);await svc.close();store.close();fs.rmSync(dir,{recursive:true,force:true});
  assert.equal(outstanding.billingStatus,'dispatch_outstanding');assert.equal(busy.code,'draft_busy');
  return {outstanding,busy};
}
(async () => {
  let app, browser, mode='valid', calls=0;
  const mock=http.createServer((req,res)=>{
    let body='';req.on('data',c=>body+=c);req.on('end',()=>{
      const data=JSON.parse(body), isDraft=data.messages.at(-1).content.startsWith('Design a team');
      if(isDraft)calls++;
      res.writeHead(200,{'content-type':'text/event-stream'});
      if(isDraft&&mode==='hang'){res.write(': waiting\n\n');return;}
      // Make the real server's settlement fail: the reserved ledger row is changed in the test database before the reply arrives.
      if(isDraft&&mode==='unsettled'){const db=new (require('node:sqlite').DatabaseSync)(require('node:path').join(app.dir,'projects.sqlite'));db.exec("UPDATE system_usage SET doc=json_set(doc,'$.status','changed_by_e2e') WHERE json_extract(doc,'$.kind')='intake_draft' AND json_extract(doc,'$.status')='reserved'");db.close();}
      const draft=sample();draft.roles[0].name='<img src=x onerror="window.__draftUnsafe=1">';
      const content=!isDraft?'好':mode==='invalid'?'MOCK invalid JSON':JSON.stringify(draft);
      res.end('data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\ndata: '+JSON.stringify({choices:[],usage:{prompt_tokens:10,completion_tokens:20}})+'\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  try{
    const port=mock.address().port;
    app=await H.boot({env:{LOCAL_MODEL_TARGETS:'127.0.0.1:'+port}});
    const added=await app.call('POST','/api/models',{providerId:'ollama',modelId:'MOCK-UI-draft',displayName:'团队草案测试模型',baseUrl:'http://127.0.0.1:'+port+'/v1',pricingMode:'paid_api',capabilities:['reasoning','writing']});
    const id=added.json.connection.connectionId;
    assert.equal((await app.call('POST','/api/models/'+id+'/test',{})).json.ok,true);
    const options={headless:true};
    if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)options.executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    else if(fs.existsSync('/usr/bin/chromium'))options.executablePath='/usr/bin/chromium';
    browser=await chromium.launch(options);
    const base='http://localhost:'+app.port;
    const context=await browser.newContext({viewport:{width:1360,height:950}});
    await context.addCookies([{name:'aij_session',value:app.cookie.split('=').slice(1).join('='),url:base}]);
    const page=await context.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    async function open(){
      await page.goto(base+'/project-intake.html');await page.fill('#description','为一个新型跨领域公益协作项目设计动态团队和交付流程。');await page.click('#next');
      assert.ok(await page.locator('[data-template]').count(),'original rule templates remain');
      await page.click('#ai-draft-open');await page.selectOption('#ai-model',id);
      await page.fill('#ai-max-cost','1');await page.fill('#ai-input-rate','2');await page.fill('#ai-output-rate','4');
    }
    async function quote(){await page.click('#ai-estimate');await page.waitForFunction(()=>document.querySelector('#ai-estimate-text').textContent.includes('当前上限可覆盖'));}
    await open();
    assert.equal(await page.isChecked('#ai-consent'),false);assert.equal(await page.isEnabled('#ai-generate'),false);assert.equal(calls,0);
    await page.fill('#ai-max-tokens','1');await page.click('#ai-estimate');
    await page.waitForFunction(()=>document.querySelector('#ai-estimate-text').textContent.includes('当前上限不足'));
    await page.check('#ai-consent');assert.equal(await page.isEnabled('#ai-generate'),false);assert.equal(calls,0);
    await page.fill('#ai-max-tokens','32000');assert.equal(await page.isChecked('#ai-consent'),false);
    await quote();assert.equal(calls,0,'estimation sends no model request');
    await page.check('#ai-consent');await page.click('#ai-generate');await page.waitForSelector('#ai-roles .ai-role-name');
    assert.equal(calls,1);assert.equal(await page.isChecked('#ai-consent'),false,'one-time consent is cleared');
    assert.equal((await app.call('GET','/api/v2/projects')).json.projects.length,0,'no automatic save');
    assert.equal(await page.locator('#ai-roles img').count(),0);assert.equal(await page.evaluate(()=>window.__draftUnsafe),undefined);
    // #9 P2-03: a settled paid draft is an estimate from the user's rates, never presented as a vendor bill.
    const usageText=await page.textContent('#ai-usage');
    assert.match(usageText,/\$0\.0001 USD（按你填写的单价×厂商返回用量计算的估算，未与厂商账单核对）/);assert.match(usageText,/已记录账本/);
    // #9 P2-02: AI tool suggestions are shown as unverified/not granted, never as permissions.
    const perms=await page.textContent('#ai-tool-permissions');
    assert.match(perms,/未授予任何权限/);assert.match(perms,/builtin:text-stats［已注册可用·需逐次运行批准］/);assert.match(perms,/不会授权工具、不会开始执行/);
    await page.locator('.ai-role-name').first().fill('人工修订的方案负责人');
    await page.click('#ai-add-role');assert.equal(await page.locator('.ai-role-name').count(),3);
    await page.getByRole('button',{name:'删除岗位及关联步骤',exact:true}).last().click();assert.equal(await page.locator('.ai-role-name').count(),2);
    await page.click('#ai-add-step');assert.equal(await page.locator('.ai-step-title').count(),3);
    await page.getByRole('button',{name:'删除步骤',exact:true}).last().click();assert.equal(await page.locator('.ai-step-title').count(),2);
    await page.click('#ai-add-step');await page.locator('.ai-step-title').last().fill('人工追加的成果复核');
    await page.selectOption('#ai-model-planner',id);await page.selectOption('#ai-model-reviewer',id);
    await page.fill('#ai-human-decisions','用户确认项目范围\n用户最终验收');
    await page.check('#ai-save-confirm');await page.fill('#ai-project-name','人工确认后的通用项目');
    assert.equal(await page.isChecked('#ai-save-confirm'),false,'editing invalidates prior save confirmation');
    await page.check('#ai-save-confirm');
    if(process.env.UI_SHOTS){fs.mkdirSync(process.env.UI_SHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.UI_SHOTS,'ai-draft-edited.png'),fullPage:true});}
    await page.click('#ai-save');await page.waitForURL(/workspace\.html\?project=/);
    const projects=(await app.call('GET','/api/v2/projects')).json.projects;assert.equal(projects.length,1);
    const saved=(await app.call('GET','/api/v2/projects/'+projects[0].projectId)).json;
    assert.equal(saved.project.name,'人工确认后的通用项目');assert.equal(saved.project.roles[0].name,'人工修订的方案负责人');assert.equal(saved.project.steps.length,3);
    // #9 P2-04: workspace model labels follow the CURRENT state, not the historical probe.
    const label=async()=>page.locator('select option[value="'+id+'"]').first().textContent();
    await page.waitForSelector('select option[value="'+id+'"]',{state:'attached'});
    assert.match(await label(),/连接已测试且当前可用/);
    assert.equal((await app.call('POST','/api/models/'+id+'/disable',{})).status,200);
    await page.reload();await page.waitForSelector('select option[value="'+id+'"]',{state:'attached'});
    assert.match(await label(),/已停用（历史测试不代表可用）/);assert.doesNotMatch(await label(),/连接已测试/);
    assert.equal((await app.call('POST','/api/models/'+id+'/enable',{})).status,200);
    assert.equal((await app.call('POST','/api/models/'+id+'/test',{})).json.ok,true);
    assert.deepEqual(saved.runs,[]);assert.equal(calls,1);assert.deepEqual(saved.project.planning.humanDecisions,['用户确认项目范围','用户最终验收']);
    mode='hang';await open();await quote();await page.check('#ai-consent');await page.click('#ai-generate');
    for(let i=0;i<100&&calls<2;i++)await H.sleep(5);assert.equal(calls,2);
    await page.click('#ai-cancel');
    await page.waitForFunction(()=>/取消|cancel/i.test(document.querySelector('#ai-message').textContent),null,{timeout:5000}).catch(async error=>{
      console.error('Cancel diagnostic:',await page.textContent('#ai-message'),(await app.call('GET','/api/v2/usage/system')).json.usage.filter(x=>x.kind==='intake_draft').map(x=>({status:x.status,errorCode:x.errorCode})),errors);
      throw error;
    });
    for(let i=0;i<100;i++){
      const rows=(await app.call('GET','/api/v2/usage/system')).json.usage.filter(x=>x.kind==='intake_draft');
      if(rows.some(x=>x.errorCode==='cancelled'))break;await H.sleep(10);
    }
    const cancelled=(await app.call('GET','/api/v2/usage/system')).json.usage.find(x=>x.errorCode==='cancelled');assert.ok(cancelled);assert.equal(cancelled.cost,null);
    // #7: non-cooperative provider outstanding after cancel, and the 429 refusal. The production adapter
    // is cooperative (pinnedFetch destroys the stream on abort), so these response bodies are produced by
    // the real IntakeDraftService in-process with a signal-ignoring local MOCK, then served to the real page.
    const bodies=await realLifecycleBodies();
    for(const [status,body,expect] of [[409,bodies.outstanding,/供应商调用尚未确认结束.*费用未知（不是0）.*请勿为此重新生成/],[429,bodies.busy,/已有3个草案模型调用仍在进行.*未发送请求、未产生费用/]]){
      await page.route('**/api/v2/intake/ai-draft',route=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)}));
      const before=calls;await open();await quote();await page.check('#ai-consent');await page.click('#ai-generate');
      await page.waitForFunction(re=>new RegExp(re).test(document.querySelector('#ai-message').textContent),expect.source);
      if(status===409){const usage=await page.textContent('#ai-usage');assert.match(usage,/费用：未知，不能视为零/);assert.match(usage,/供应商调用尚未结束/);assert.ok((await page.textContent('#ai-message')).includes(body.ledgerId));}
      assert.equal(calls,before,'served body; no model request');assert.equal((await app.call('GET','/api/v2/projects')).json.projects.length,1,'nothing saved');
      await page.unroute('**/api/v2/intake/ai-draft');
    }
    if(process.env.UI_SHOTS)await page.screenshot({path:path.join(process.env.UI_SHOTS,'ai-draft-outstanding.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    mode='invalid';await open();await quote();await page.check('#ai-consent');await page.click('#ai-generate');
    await page.waitForFunction(()=>document.querySelector('#ai-message').textContent.includes('回退手工'));
    assert.equal(await page.locator('.ai-role-name').count(),1,'invalid JSON offers a manual fallback');
    assert.equal((await app.call('GET','/api/v2/projects')).json.projects.length,1,'failed generation never creates a project');
    assert.equal(calls,3);assert.deepEqual(errors,[]);
    // #5-F: ledger settlement failure through real HTTP + Chromium (local MOCK model priced as paid, test database).
    mode='unsettled';await open();await quote();await page.check('#ai-consent');
    const draftResp=page.waitForResponse(r=>r.url().endsWith('/api/v2/intake/ai-draft')&&r.request().method()==='POST');
    await page.click('#ai-generate');const rr=await draftResp;
    assert.equal(rr.status(),202,'unsettled draft is not HTTP 200');const rb=await rr.json();
    assert.equal(rb.ok,false);assert.equal(rb.code,'usage_unsettled');assert.equal(rb.requestSent,true);assert.equal(rb.usage.cost,null,'dispatched remote cost unknown');
    await page.waitForSelector('#ai-roles .ai-role-name');assert.ok(await page.locator('.ai-role-name').count()>=1,'draft still viewable and editable');
    await page.waitForFunction(()=>document.querySelector('#ai-message').textContent.includes('人工核对'));
    assert.match(await page.textContent('#ai-usage'),/费用未知，需要人工核对/);assert.doesNotMatch(await page.textContent('#ai-usage'),/\$0 USD/);
    await H.sleep(500);assert.equal(calls,4,'no automatic second model call');
    const after=(await app.call('GET','/api/v2/projects')).json.projects;
    assert.equal(after.length,1,'not auto-saved');for(const p of after)assert.deepEqual((await app.call('GET','/api/v2/projects/'+p.projectId)).json.runs,[],'nothing auto-started');
    assert.equal(await page.isChecked('#ai-save-confirm'),false,'saving still requires explicit confirmation');assert.deepEqual(errors,[]);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'mobile form does not overflow');
    // #6+#8: replay the actual browser request ID after settlement failed. The
    // durable key must block another Mock dispatch, and the admin sees only a
    // read-only accounting warning (never a reconciliation or retry button).
    const duplicate=await page.evaluate(async input=>{
      const res=await fetch('/api/v2/intake/ai-draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
      return {status:res.status,body:await res.json()};
    },rr.request().postDataJSON());
    assert.equal(duplicate.status,409);assert.equal(duplicate.body.code,'duplicate_request');assert.equal(duplicate.body.requestState,'dispatching');
    assert.equal(calls,4,'duplicate request never redispatches after failed settlement');
    const exceptions=(await app.call('GET','/api/v2/usage/system/exceptions')).json;
    assert.equal(exceptions.readOnly,true);assert.ok(exceptions.exceptions.some(x=>x.requestId===rb.requestId&&x.cost===null));
    await page.setViewportSize({width:1360,height:950});await page.goto(base+'/capabilities.html');
    await page.waitForSelector('#system-usage-warning:not([hidden])');
    const warning=await page.textContent('#system-usage-warning');
    assert.ok(warning.includes(rb.requestId));assert.match(warning,/费用未知|预留上界/);assert.match(warning,/\d{4}-\d{2}-\d{2}T.*Z/);
    assert.match(warning,/不等于厂商账单|非厂商账单/);assert.equal(await page.locator('#system-usage-warning button').count(),0);
    assert.equal(calls,4,'viewing exceptions never dispatches');assert.deepEqual(errors,[]);
    console.log('PASS AI draft E2E: original templates, explicit single-call consent, no-call estimates, budget limits, actual local MOCK requests, editable/add/remove roles and steps, XSS-safe rendering, confirmed save without run, cancellation/unknown fees and invalid-JSON manual fallback. No paid API or tools executed.');
    console.log('PASS durable ledger E2E: HTTP202 unsettled draft, HTTP409 same-ID retry, Mock draft dispatches=4 (increment on retry/read=0), admin readonly exceptions with UTC/unknown fees/reservation bounds.');
  }finally{
    if(browser)await browser.close();if(app)await app.stop();mock.closeAllConnections();await new Promise(r=>mock.close(r));
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
