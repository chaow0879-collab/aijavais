'use strict';
/* 管理界面端到端走查（需要 Playwright + Chromium）：npm run test:ui。截图写到 UI_SHOTS 目录（默认系统临时目录）。 */
const { chromium } = require('playwright');
const http = require('http'), net = require('net'), fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const OUT = process.env.UI_SHOTS || require('os').tmpdir();
const REPO = require('path').join(__dirname, '..', '..');
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const mock = http.createServer((req, res) => {
    let b = ''; req.setEncoding('utf8'); req.on('data', c => b += c); req.on('end', () => {
      if (req.method === 'GET' && req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'writer-model' }, { id: 'review-model' }] })); }
      const j = JSON.parse(b || '{}');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      setTimeout(() => { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: j.model + '：这是模拟输出。' } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`); res.end(); }, 300);
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mp = mock.address().port, port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-ui-'));
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', AIJ_DATA_DIR: dir, LOCAL_MODEL_TARGETS: '127.0.0.1:' + mp };
  delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY;
  const child = spawn(process.execPath, [path.join(REPO, 'server.js')], { env, stdio: 'ignore' });
  await sleep(800);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : fs.existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}) });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  const httpErrors = [];
  page.on('response', r => { if (r.status() >= 400) httpErrors.push({ path: new URL(r.url()).pathname, status: r.status() }); });
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('dialog', d => d.accept());
  const base = `http://localhost:${port}`;
  // 登录：未登录访问管理中心会跳到登录页；首次使用用服务器写出的设置码设置密码
  await page.goto(base + '/admin.html');
  await page.waitForURL(/login\.html/);
  await page.waitForSelector('#setupForm:not(.hidden)');
  await page.screenshot({ path: path.join(OUT, '0-login-setup.png') });
  const setupCode = /([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(fs.readFileSync(path.join(dir, 'setup-code.txt'), 'utf8'))[1];
  await page.fill('#code', setupCode); await page.fill('#np', 'ui-test-password-1'); await page.fill('#np2', 'ui-test-password-1');
  await page.click('#setupBtn');
  await page.waitForURL(/admin\.html/);
  await page.waitForSelector('#wProv option', { state: 'attached' });
  await page.screenshot({ path: path.join(OUT, '1-models-empty.png'), fullPage: true });

  // 添加两个模型：自定义接口（高级设置）
  async function addModel(name, model, pricing, caps) {
    await page.selectOption('#wProv', 'custom');
    await page.fill('#wBase', `http://127.0.0.1:${mp}/v1`);
    await page.fill('#wKey', 'test-key-123456');
    await page.click('#wDiscover');
    await page.waitForSelector('#wModelSel:not(.hidden)');
    await page.selectOption('#wModelSel', model);
    await page.click('#wTest');
    await page.waitForFunction(() => /连接正常|失败|无效/.test(document.querySelector('#wTestRes').textContent));
    const testRes = await page.textContent('#wTestRes');
    await page.fill('#wName', name);
    await page.selectOption('#wPricing', pricing);
    for (const c of caps) await page.check(`#wCaps input[value="${c}"]`);
    await page.click('#wSave');
    await page.waitForFunction(n => document.querySelector('#mList').textContent.includes(n), name);
    return testRes;
  }
  const t1 = await addModel('写作模型', 'writer-model', 'free_tier', ['writing', 'chinese']);
  const t2 = await addModel('审校模型', 'review-model', 'paid_api', ['reasoning', 'writing', 'chinese']);
  await page.screenshot({ path: path.join(OUT, '2-models-added.png'), fullPage: true });

  // 团队
  await page.click('#nav [data-pane=teams]');
  await page.selectOption('#tTpl', 'word-document');
  await page.fill('#tName', '公文小组');
  const roles = await page.$$('#tRoles .role');
  const ids = await page.evaluate(() => MODELS.map(m => m.connectionId));
  await roles[0].$eval('[data-f=primary]', (el, v) => { el.value = v; }, ids[0]);
  await page.click('#tRoles [data-rec=editor]');
  await page.waitForSelector('#modal.on');
  await page.screenshot({ path: path.join(OUT, '3-recommend.png') });
  await page.click('[data-pick="' + ids[1] + '"]');
  await page.click('#tCreate');
  await page.waitForFunction(() => document.querySelector('#teamList').textContent.includes('公文小组'));
  await page.screenshot({ path: path.join(OUT, '4-teams.png'), fullPage: true });

  // 运行（付费岗位 → 确认对话框自动接受）
  await page.click('#teamList [data-act=run]');
  await page.fill('#task', '起草一份新员工入职引导通知');
  await page.click('#runBtn');
  await page.waitForFunction(() => /完成|任务中断/.test(document.querySelector('#runOut').textContent), null, { timeout: 15000 });
  await page.screenshot({ path: path.join(OUT, '5-run.png'), fullPage: true });

  // 删除被引用的模型：影响预览
  await page.click('#nav [data-pane=models]');
  await page.click(`#mList [data-id="${ids[1]}"] [data-act=del]`);
  await page.waitForSelector('#modal.on');
  await page.screenshot({ path: path.join(OUT, '6-delete-impact.png') });
  await page.selectOption('#dRep', ids[0]);
  await page.click('#dGo');
  await page.waitForFunction(id => !document.querySelector(`#mList [data-id="${id}"]`), ids[1]);
  // 状态页
  await page.click('#nav [data-pane=live]');
  await sleep(2500);
  await page.screenshot({ path: path.join(OUT, '7-live.png') });
  await page.click('#nav [data-pane=ingest]');
  await page.fill('#igName', 'office-pc');
  await page.click('#igCreate');
  await page.waitForSelector('#igNew:not(.hidden)');
  await page.screenshot({ path: path.join(OUT, '8-ingest.png'), fullPage: true });
  // 手机宽度
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#nav [data-pane=models]');
  await page.screenshot({ path: path.join(OUT, '9-mobile.png'), fullPage: false });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  const team = await page.evaluate(async () => (await (await fetch('/api/teams')).json()).teams[0]);
  const result = { t1, t2, errors: errors.filter(e => !/402/.test(e)), httpErrors, overflow, editorAfterDelete: team.roles.find(r => r.roleId === 'editor').primaryConnectionId === ids[0] };
  console.log(JSON.stringify(result, null, 1));
  const ok = /连接正常/.test(t1) && /连接正常/.test(t2) && !result.errors.length && !overflow && result.editorAfterDelete;
  console.log(ok ? 'UI 走查通过' : 'UI 走查失败');
  process.exitCode = ok ? 0 : 1;
  await browser.close(); child.kill(); mock.close(); fs.rmSync(dir, { recursive: true, force: true });
})().catch(e => { console.error('FAIL', e); process.exit(1); });
