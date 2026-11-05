'use strict';
/* Live browser + actual V2 HTTP/SQLite workflow against a local mock model.
 * No paid API is used. File export is real DOCX bytes, not a mocked download.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { chromium } = require('playwright');
const H = require('../helpers');

(async () => {
  let app, browser, mcpServer;
  let calls = 0;
  const mockPrompts = [];
  const mock = http.createServer((req,res) => {
    let body=''; req.setEncoding('utf8');req.on('data',c=>body+=c);req.on('end',()=>{
      calls++;
      const payload=JSON.parse(body || '{}');
      mockPrompts.push((payload.messages || []).map(m=>m.content).join('\n'));
      const text='LOCAL MOCK '+payload.model+': 已完成有证据的模拟模型输出。 <img src=x onerror="window.__unsafe=1">';
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end('data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\ndata: '+JSON.stringify({choices:[],usage:{prompt_tokens:10,completion_tokens:20}})+'\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  try {
    const mockPort=mock.address().port;
    const mcpFx=await require('../fixtures/mcp-http-server.cjs')('ui-token');mcpServer=mcpFx.server;
    app=await H.boot({env:{LOCAL_MODEL_TARGETS:'127.0.0.1:'+mockPort+',127.0.0.1:'+mcpFx.port}});
    const base='http://localhost:'+app.port;
    const models=[];
    for(const name of ['writer','reviewer']) {
      const registered=await app.call('POST','/api/models',{providerId:'custom',protocol:'openai',baseUrl:'http://127.0.0.1:'+mockPort+'/v1',modelId:name,displayName:name,pricingMode:'local',apiKey:'local-mock-only'});
      assert.equal(registered.status,200,registered.text);
      const id=registered.json.connection?.connectionId || registered.json.model?.connectionId;
      assert.ok(id,'model connection ID');models.push(id);
      const probe=await app.call('POST','/api/models/'+id+'/test',{});
      assert.equal(probe.status,200,probe.text);assert.equal(probe.json.ok,true,probe.text);
    }
    // Chromium derives download filenames from the process locale; without UTF-8 it drops non-ASCII names.
    const options={headless:true,env:{...process.env,LANG:process.env.LANG || 'C.UTF-8'}};
    if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)options.executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    else if(fs.existsSync('/usr/bin/chromium'))options.executablePath='/usr/bin/chromium';
    browser=await chromium.launch(options);
    const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}});
    await context.addCookies([{name:'aij_session',value:app.cookie.split('=').slice(1).join('='),url:base}]);
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/workspace.html');
    await page.waitForSelector('#roles-editor select option[value="'+models[0]+'"]',{state:'attached'});
    assert.equal(await page.isChecked('#approve-paid'),false);
    await page.fill('#project-name','UI <script>window.__unsafe=1</script> 项目');
    await page.fill('#project-description','通过工作台创建项目并验证真实服务端调度、审核和文件导出。');
    await page.fill('#project-standards','每一步完成后提供文字成果\n审核后才算正式通过');
    await page.locator('#roles-editor select').nth(0).selectOption(models[0]);
    await page.locator('#roles-editor select').nth(1).selectOption(models[1]);
    await page.click('#save-project');
    await page.waitForFunction(()=>document.querySelector('#feedback').textContent.includes('已保存'));
    assert.ok(new URL(page.url()).searchParams.get('project'));
    assert.equal(await page.evaluate(()=>window.__unsafe),undefined);
    // Real externally generated Word file: upload, parse, preview as text.
    await page.setInputFiles('#material-input',require('path').join(__dirname,'..','fixtures','files','report.docx'));
    await page.click('#upload-materials');
    await page.waitForFunction(()=>document.querySelector('#materials-list').textContent.includes('已读取文字'));
    await page.click('#materials-list button:has-text("预览文字")');
    await page.waitForFunction(()=>document.querySelector('#material-preview').textContent.includes('季度复盘报告'));
    assert.equal(await page.locator('#material-preview *').count(),0,'file text rendered as text only');
    await page.click('#validate-project');
    await page.waitForFunction(()=>document.querySelector('#validation-text').textContent.includes('"ok": true'));
    const beforeRun=calls;
    await page.click('#start-run');
    await page.waitForFunction(()=>document.querySelector('#run-status').textContent==='等待审核',{timeout:15000});
    assert.ok(calls>=beforeRun+2,'both mock model roles really called');
    assert.match(await page.textContent('#run-steps'),/LOCAL MOCK/);
    assert.ok(mockPrompts.some(p=>p.includes('客户满意度 92%')),'uploaded file text reached a model role');
    assert.equal(await page.evaluate(()=>window.__unsafe),undefined,'model output rendered as text');
    assert.equal(await page.locator('#run-steps img').count(),0,'model HTML never inserted');
    assert.match(await page.textContent('#run-tokens'),/60/);
    await page.fill('#review-comment','浏览器验证：输出已检查，允许交付。');
    await page.click('#approve-run');
    await page.waitForFunction(()=>document.querySelector('#run-status').textContent==='审核通过');
    const downloading=page.waitForEvent('download');
    await page.selectOption('#export-format','docx');await page.click('#export-run');
    const download=await downloading;
    assert.match(download.suggestedFilename(),/\.docx$/);
    const bytes=fs.readFileSync(await download.path());assert.equal(bytes.subarray(0,2).toString(),'PK');assert.ok(bytes.length>500);
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('#run-status').textContent==='审核通过');
    assert.equal(await page.isChecked('#approve-paid'),false,'paid approval never persisted');
    assert.match(await page.textContent('#run-artifacts'),/docx/i,'real exported file remains available after reload');
    // Wizard saves a conservative draft without assigning/pretending verified models.
    await page.goto(base+'/project-intake.html');
    await page.fill('#description','请制作一份科技主题的PPT演示稿，说明团队工作计划。');await page.click('#next');
    await page.locator('[data-template="ppt-production"]').click();
    await page.click('#next');await page.click('#next');await page.click('#next');await page.click('#next');
    await page.waitForSelector('[data-action="save-project"]');
    await page.waitForFunction(()=>document.querySelector('#tool-check table'));
    const toolCheck=await page.textContent('#tool-check');
    assert.match(toolCheck,/生成 PPT 演示稿.*可用/);assert.match(toolCheck,/图表制作.*可用/);
    await page.click('[data-action="save-project"]');
    await page.waitForURL(/workspace\.html\?project=/);
    await page.waitForSelector('#roles-editor .editor-row');
    assert.match(await page.textContent('#intake-note'),/立项草案/);
    assert.ok((await page.inputValue('#required-tools')).includes('pptx_generation'));
    assert.equal(await page.isChecked('#approve-paid'),false);
    // Capability center: live readiness and honest capability classes.
    await page.goto(base+'/capabilities.html');
    await page.waitForFunction(()=>document.querySelector('#checks').textContent.includes('AI 模型连接'));
    assert.match(await page.textContent('#checks'),/2 个连接测试通过/);
    assert.match(await page.textContent('#missing'),/必须配置（0）/);
    await page.click('#tab-caps');
    await page.waitForFunction(()=>document.querySelector('#caps').textContent.includes('生成 Word 文档'));
    const capsText=await page.textContent('#caps');
    assert.match(capsText,/内置工具/);assert.match(capsText,/尚未实现/);assert.match(capsText,/本身不是工具/);
    await page.click('#tab-mcp');
    await page.waitForFunction(()=>document.querySelector('#mcp-servers').textContent.includes('还没有接入'));
    await page.waitForFunction(()=>document.querySelector('#mcp-catalog').textContent.includes('时间与时区'));
    await page.fill('#add-id','remote');await page.fill('#add-name','远程测试');await page.fill('#add-url','http://127.0.0.1:'+mcpFx.port+'/mcp');await page.fill('#add-token','ui-token');
    await page.click('#add-server');
    await page.waitForFunction(()=>document.querySelector('#add-note').textContent.includes('连接成功'));
    assert.equal(await page.inputValue('#add-token'),'','token field cleared after saving');
    await page.waitForSelector('#mcp-try:not([hidden])');
    await page.selectOption('#try-tool','mcp:remote:sse_echo');await page.fill('#try-args','{"value":"界面调用"}');await page.click('#try-run');
    await page.waitForFunction(()=>document.querySelector('#try-result').textContent.includes('sse:界面调用'));
    await page.waitForFunction(()=>document.querySelector('#mcp-logs').textContent.includes('调用 mcp:remote:sse_echo'));
    assert.doesNotMatch(await page.content(),/ui-token/,'token never rendered back');
    if(process.env.UI_SHOTS)await page.screenshot({path:require('path').join(process.env.UI_SHOTS,'mcp.png'),fullPage:true});
    if(process.env.UI_SHOTS){await page.click('#tab-ready');await page.screenshot({path:require('path').join(process.env.UI_SHOTS,'capabilities.png'),fullPage:true});}
    assert.deepEqual(errors,[],'no JavaScript exceptions');
    console.log('PASS workspace E2E: live login/session, project save/validate, two local MOCK model calls, XSS-safe output, human review, real DOCX export/persistence, real DOCX upload+parse+role handoff, conservative wizard draft handoff. No paid API used.');
  } finally {
    if(browser)await browser.close();
    if(app)await app.stop();
    if(mcpServer)mcpServer.close();
    await new Promise(resolve=>mock.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
