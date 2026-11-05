// Browser-only independent acceptance. Native Chromium; local MODEL MOCK; no paid API.
'use strict';
const assert=require('node:assert/strict');
const http=require('node:http'), fs=require('node:fs'),path=require('node:path');
const crypto=require('node:crypto');
const { chromium }=require('playwright');
const H=require('../helpers');
const OUT=process.env.PRODUCT_UI_OUT||require('node:os').tmpdir();
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function draft(){
 return {goal:'跨行业未知任务：建立可审核的团队与阶段交付',roles:[
 {roleId:'planner',name:'研究策划',duty:'理解目标与数据',boundary:'不批准执行和费用',standard:'资料缺失须声明',requiredCapabilities:['writing']},
 {roleId:'reviewer',name:'独立复核',duty:'审核结论及证据',boundary:'不能代替用户验收',standard:'有明确审核清单',requiredCapabilities:['writing']}],
 steps:[{stepId:'plan',roleId:'planner',title:'明确需求',prompt:'说明缺失数据',deliverable:'需求表',quality:'有待确认项',handoff:'previous'},
 {stepId:'review',roleId:'reviewer',title:'独立审核',prompt:'检查上一岗位实际结果',deliverable:'审核意见',quality:'问题逐项列明',handoff:'all'}],
 deliverables:['方案DOCX','验收清单'],acceptance:['用户审批后才可执行'],tools:['web_search'],skills:[],
 humanDecisions:['用户确认预算和缺失事实']};
}
(async()=>{
 let app,browser,server,calls=0;const errors=[];
 const d=draft();
 server=http.createServer((req,res)=>{let str='';req.on('data',x=>str+=x);req.on('end',()=>{
  const payload=JSON.parse(str),isDraft=payload.messages.at(-1).content.startsWith('Design a team');
  if(isDraft)calls++;
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end('data: '+JSON.stringify({choices:[{delta:{content:isDraft?JSON.stringify(d):'MOCK result'}]})+
    '\n\ndata: '+JSON.stringify({choices:[],usage:{prompt_tokens:40,completion_tokens:60}})+'\n\ndata: [DONE]\n\n');
 });});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const port=server.address().port;
  app=await H.boot({env:{LOCAL_MODEL_TARGETS:'127.0.0.1:'+port}});
  const add=await app.call('POST','/api/models',{providerId:'ollama',modelId:'ACCEPTANCE-MOCK',displayName:'独立产品验收MOCK',
   baseUrl:'http://127.0.0.1:'+port+'/v1',pricingMode:'paid_api',capabilities:['writing','reasoning']});
  assert.equal(add.status,200,add.text);
  const id=add.json.connection.connectionId;
  assert.equal((await app.call('POST','/api/models/'+id+'/test',{})).json.ok,true);
  const opts={headless:true};
  if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)opts.executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  browser=await chromium.launch(opts);
  const base='http://localhost:'+app.port;
  const context=await browser.newContext({viewport:{width:1360,height:900},acceptDownloads:true});
  await context.addCookies([{name:'aij_session',value:app.cookie.split('=').slice(1).join('='),url:base}]);
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/project-intake.html');
  await page.fill('#description','请研究一家20人的创业公司是否开第二个办公点，尚未提供地区、租金和预算，请先提出待确认信息。');
  await page.click('#next');await page.click('#ai-draft-open');
  await page.selectOption('#ai-model',id);await page.fill('#ai-max-cost','1');await page.fill('#ai-input-rate','2');await page.fill('#ai-output-rate','4');
  assert.equal(await page.isChecked('#ai-consent'),false);
  assert.equal(await page.isEnabled('#ai-generate'),false);
  assert.equal(calls,0);
  await page.click('#ai-estimate');await page.waitForFunction(()=>document.querySelector('#ai-estimate-text').textContent.includes('当前上限可覆盖'));
  assert.equal(calls,0,'quote must not invoke paid-looking model');
  await page.check('#ai-consent');await page.click('#ai-generate');await page.waitForSelector('.ai-role-name');
  assert.equal(calls,1);
  assert.equal((await app.call('GET','/api/v2/projects')).json.projects.length,0,'AI generation never auto saves');
  assert.match(await page.textContent('#ai-tool-permissions'),/未授予任何权限/);
  assert.equal(await page.isChecked('#ai-save-confirm'),false);
  await page.fill('#ai-project-name','人工确认的第二办公点决策研究');
  await page.fill('#ai-role-planner','企业场地成本分析师');
  await page.click('#ai-add-step');await page.locator('.ai-step-title').last().fill('人工追加成本复核');
  await page.fill('#ai-human-decisions','用户确认地区与租金\n用户确认是否开始执行');
  assert.equal(await page.isChecked('#ai-save-confirm'),false);
  await page.check('#ai-save-confirm');
  fs.mkdirSync(OUT,{recursive:true});
  const before=path.join(OUT,'independent-before-save.png');
  await page.screenshot({path:before,fullPage:true});
  await page.click('#ai-save');await page.waitForURL(/workspace\.html\?project=/);
  const pid=new URL(page.url()).searchParams.get('project');
  const p=(await app.call('GET','/api/v2/projects/'+pid)).json;
  assert.equal(p.project.name,'人工确认的第二办公点决策研究');
  assert.equal(p.project.roles.find(x=>x.roleId==='planner').name,'企业场地成本分析师');
  assert.ok(p.project.steps.some(x=>x.title==='人工追加成本复核'));
  assert.deepEqual(p.runs,[]);
  assert.equal((await page.locator('[data-project-tool]:checked').count()),0);
  await page.screenshot({path:path.join(OUT,'independent-workspace.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  const evidence={candidate:'58c52f0084997f669eea763edc7b58e11d3ef4f4',mode:'LOCAL MODEL MOCK',calls,
   projectId:pid,roleCount:p.project.roles.length,stepCount:p.project.steps.length,
   runs:p.runs.length,browser:'Chromium',screenshots:[before,'independent-workspace.png'],
   screenshotSha256:sha(fs.readFileSync(before)),jsErrors:errors};
  fs.writeFileSync(path.join(OUT,'independent-browser.json'),JSON.stringify(evidence,null,2));
  console.log('PRODUCT_INDEPENDENT_BROWSER_PASS '+JSON.stringify(evidence));
 }finally{if(browser)await browser.close();if(app)await app.stop();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error('PRODUCT_INDEPENDENT_BROWSER_FAIL',e);process.exitCode=1;});
