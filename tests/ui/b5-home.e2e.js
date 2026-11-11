'use strict';
/* B5-1 / B5-2 / B5-F1 in real Chromium against the real server + SQLite and a LOCAL MOCK model (no paid API).
 *  - 5-second test: after login, without scrolling or clicking, the first screen shows "＋ 新建任务" and "正在运行 N 个"
 *  - two running tasks: switch between them (top-bar menu, previous/next on the progress page); left list opens progress
 *  - read-only display session at / only sees the screen: no top bar, no task plaintext
 *  - admin page: no 运行 button, entry to new task; panel: same top bar + "看哪个任务"; phone width usable
 *  - B5-2: only deepseek-v4-pro + qwen3.8-max -> RMB confirmation directly, never "管理中心 → 编辑单价" */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const H = require('../helpers');

const SHOTS = process.env.UI_SHOTS || null;
const results = [];
const ok = name => { results.push(name); console.log('PASS', name); };
(async () => {
  let hold = true; const held = [];
  const mock = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const j = JSON.parse(body || '{}');
      const send = () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: j.max_tokens <= 32 ? '好' : '本地模型写出的成果文字，内容足够长。' } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n'); };
      if (hold && j.max_tokens > 32) held.push(send); else send();
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mp = mock.address().port;
  const app = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mp } });
  const base = 'http://localhost:' + app.port;
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'b5-' + name + '.png'), fullPage: false }); } };
  const adminCtx = async (viewport = { width: 1280, height: 800 }) => {
    const ctx = await browser.newContext({ viewport }); const ck = H.cookies.get(app.port).split('=');
    await ctx.addCookies([{ name: ck[0], value: ck.slice(1).join('='), domain: 'localhost', path: '/' }]); return ctx;
  };
  try {
    /* ---- B5-F2 P0: clicking 我的任务 on every page shows my tasks (also with zero tasks) ---- */
    const PAGES = ['/workspace.html', '/workspace.html?new=1', '/panel.html', '/admin.html', '/capabilities.html', '/project-intake.html'];
    const homeEverywhere = async (page, expect, extra = []) => {
      for (const u of [...PAGES, ...extra]) {
        await page.goto(base + u); await page.waitForSelector('#aij-home');
        await page.click('#aij-home');
        await page.waitForURL(base + '/workspace.html');
        await page.waitForSelector('#home:not([hidden])');
        assert.equal(await page.isHidden('#simple'), true, u + ': the new-task form is not what 我的任务 shows');
        await page.waitForSelector(expect);
        assert.ok(await page.isVisible(expect), u + ' -> ' + expect);
      }
    };
    const zp = await (await adminCtx()).newPage();
    await homeEverywhere(zp, '#home-empty-new');
    assert.match(await zp.innerText('#home-empty'), /还没有任务/);
    ok('我的任务 from every page with zero tasks shows my tasks (empty state + big ＋ 新建任务), not the new-task form');

    /* ---- two running tasks (held by the local mock) + one finished draft-free task ---- */
    const add = await app.call('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mp}/v1`, modelId: 'local-writer', displayName: '本地写手', pricingMode: 'local', capabilities: ['writing', 'reasoning'] });
    assert.equal(add.status, 200, add.text); const id = add.json.connection.connectionId;
    assert.equal((await app.call('POST', '/api/models/' + id + '/test', {})).json.ok, true);
    const mk = name => ({ name, description: name, roles: [{ roleId: 'w', name: '写手', duty: '写', standard: '可读', connectionId: id }], steps: [{ stepId: 's1', roleId: 'w', title: '写出初稿', prompt: '写' }, { stepId: 's2', roleId: 'w', title: '审核并定稿', prompt: '写' }] });
    const runs = [];
    for (const name of ['咖啡店促销方案', '任职资格体系']) {
      const p = (await app.call('POST', '/api/v2/projects', mk(name))).json.project;
      const r = await app.call('POST', '/api/v2/projects/' + p.projectId + '/runs', { maxTokens: 20000, maxOutputTokens: 100, maxCost: 0, allowedTools: [] });
      assert.equal(r.status, 202, r.text); runs.push({ projectId: p.projectId, runId: r.json.run.runId, name });
    }
    await app.call('POST', '/api/v2/projects', mk('还没开始的草稿'));

    /* ---- 5-second test: real login, no scroll, no click ---- */
    const fresh = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const lp = await fresh.newPage();
    await lp.goto(base + '/'); // not logged in -> login page
    await lp.waitForSelector('#loginForm:not(.hidden)');
    await lp.fill('#pw', H.TEST_PASSWORD);
    const t0 = Date.now(); await lp.click('#loginBtn');
    await lp.waitForURL(/\/workspace\.html/);
    await lp.waitForFunction(() => /正在运行 2 个/.test(document.querySelector('#home-sum')?.textContent || '') && document.querySelector('#aij-new'), null, { timeout: 5000 });
    const ms = Date.now() - t0;
    const inView = sel => lp.$eval(sel, n => { const r = n.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight; });
    assert.ok(await inView('#aij-new'), '＋ 新建任务 in the first screen'); assert.ok(await inView('#home-sum'), '正在运行 N 个 in the first screen');
    assert.equal(await lp.evaluate(() => scrollY), 0);
    assert.match(await lp.innerText('#home-sum'), /^正在运行 2 个（最多同时 3 个）· 等你审核 0 个 · 已完成 0 个/);
    assert.match(await lp.innerText('#aij-running'), /运行中 2/);
    assert.ok(ms < 5000, 'within 5 s: ' + ms);
    await shot(lp, '1-home');
    ok('5-second test: login lands on my tasks; ＋ 新建任务 and 正在运行 2 个 visible without scroll/click (' + ms + ' ms)');
    // groups and cards
    const cards = await lp.$$eval('#home-groups .tcard', a => a.map(x => [x.querySelector('strong').textContent, x.className, x.getAttribute('href')]));
    assert.equal(cards.filter(c => c[1].includes('running')).length, 2); assert.ok(cards.some(c => c[0] === '还没开始的草稿' && c[1].includes('draft') && c[2].includes('project=')));
    for (const r of runs) assert.ok(cards.some(c => c[2] === '/workspace.html?run=' + r.runId), r.name + ' card opens its progress page');
    assert.match(await lp.innerText('#home-groups'), /进行中（2）[\s\S]*第 1\/2 步 · 写手正在做[\s\S]*已花约 ¥0\.00/);
    ok('task center: grouped cards with step x/y, who is working, spent ¥, last update; draft group');

    /* ---- switch between the two running tasks ---- */
    await lp.click('#aij-running'); await lp.waitForSelector('#aij-running-menu:not([hidden])');
    assert.equal(await lp.locator('#aij-running-menu a').count(), 2);
    await lp.click(`#aij-running-menu a[data-run-id="${runs[0].runId}"]`);
    await lp.waitForURL(new RegExp('run=' + runs[0].runId));
    await lp.waitForSelector('#s-progress:not([hidden])'); await lp.waitForSelector('#s-next:not([hidden])');
    assert.ok(await lp.isVisible('#s-home')); assert.equal(await lp.getAttribute('#s-home', 'href'), '/workspace.html');
    assert.equal(await lp.isVisible('#project-form'), false, 'progress page, not the engineer configuration page');
    await lp.click('#s-next'); await lp.waitForURL(new RegExp('run=' + runs[1].runId)); await lp.waitForSelector('#s-progress:not([hidden])');
    await lp.waitForSelector('#s-prev:not([hidden])'); await lp.click('#s-prev'); await lp.waitForURL(new RegExp('run=' + runs[0].runId));
    await shot(lp, '2-progress-switch');
    ok('two running tasks: top-bar menu opens a progress page; previous/next switch between them; ← 返回我的任务');
    await homeEverywhere(lp, '#home-groups .tcard', ['/workspace.html?run=' + runs[0].runId, '/workspace.html?project=' + runs[1].projectId]);
    // the top bar refresh (every 5 s) updates in place: the 我的任务 link element survives a refresh
    await lp.goto(base + '/workspace.html?new=1'); await lp.waitForSelector('#aij-home');
    const before = await lp.$('#aij-home'); await lp.evaluate(() => window.AIJTopbar.refresh());
    assert.equal(await before.evaluate(n => n.isConnected), true, 'top bar is not rebuilt on refresh (clicks are not lost)');
    ok('我的任务 from every page with tasks shows the task cards; refresh never replaces the link under the pointer');
    // left list: plain status, click opens the progress page
    await lp.goto(base + '/workspace.html');
    await lp.waitForFunction(() => document.querySelectorAll('#projects .pstate').length >= 3);
    assert.match(await lp.innerText('#projects'), /进行中/); assert.match(await lp.innerText('#projects'), /草稿/);
    await lp.click(`#projects [data-project-id="${runs[1].projectId}"]`);
    await lp.waitForURL(new RegExp('run=' + runs[1].runId)); await lp.waitForSelector('#s-progress:not([hidden])');
    ok('left list shows plain status and opens the task progress page (not the configuration page)');

    /* ---- coming back after finishing: results to download are visible on my tasks ---- */
    // B5-F2 F: the home embeds a small live card fed by the same real event stream as the screen
    await lp.goto(base + '/workspace.html'); await lp.waitForSelector('#home-live');
    assert.equal(await lp.getAttribute('#home-live-open', 'href'), '/panel.html');
    await lp.waitForFunction(() => /事件|已连接|等待/.test(document.body.innerText)); await lp.waitForTimeout(500);
    hold = false; for (const f of held.splice(0)) f();
    await lp.waitForFunction(() => [...document.querySelectorAll('#home-live-list li')].some(li => /模型完成/.test(li.textContent)), null, { timeout: 15000 });
    assert.match(await lp.innerText('#home-live-list'), /本地写手/);
    ok('home live card shows real model events from the screen stream and links to the full screen');
    // B5-F2 G: ＋ 新建任务 sits on the right of the top bar in the bar's own style (outline, not a solid colour block)
    const g = await lp.evaluate(() => { const n = document.querySelector('#aij-new'), cs = getComputedStyle(n), r = n.getBoundingClientRect(), m = document.querySelector('#aij-models').getBoundingClientRect();
      return { right: r.left > m.right + 40, bg: cs.backgroundColor, border: cs.borderTopColor }; });
    assert.ok(g.right, 'right side of the bar'); assert.match(g.bg, /rgba\(79, 179, 255, 0\.1[0-9]*\)/, 'light tint, not a solid block: ' + g.bg); assert.match(g.border, /rgb\(79, 179, 255\)/);
    ok('top bar ＋ 新建任务: right side, outline style matching the bar');
    await lp.goto(base + '/workspace.html');
    await lp.waitForFunction(() => /正在运行 0 个/.test(document.querySelector('#home-sum')?.textContent || '') , null, { timeout: 15000 });
    assert.match(await lp.innerText('#home-groups'), /有成果可下载/);
    ok('coming back: my tasks (not a blank form) with "有成果可下载"');

    /* ---- panel: same top bar + "看哪个任务"; admin page: no 运行 button ---- */
    hold = true;
    const p3 = (await app.call('POST', '/api/v2/projects', mk('大屏上看的任务'))).json.project;
    const r3 = (await app.call('POST', '/api/v2/projects/' + p3.projectId + '/runs', { maxTokens: 20000, maxOutputTokens: 100, maxCost: 0, allowedTools: [] })).json.run;
    await lp.goto(base + '/panel.html');
    await lp.waitForSelector('#aij-topbar #aij-watch');
    assert.equal(await lp.$eval('#aij-watch', s => s.value), r3.runId, 'defaults to the latest running task');
    assert.match(await lp.innerText('#aij-watch-info'), /第 1\/2 步/);
    await shot(lp, '3-panel');
    await lp.goto(base + '/admin.html'); await lp.waitForSelector('#aij-new');
    assert.equal(await lp.locator('button', { hasText: /^运行$/ }).count(), 0); assert.equal(await lp.$('#runBtn'), null);
    ok('panel has the top bar and a "看哪个任务" picker; admin page has no 运行 button and links to new task');

    /* ---- read-only display session ---- */
    const link = (await app.call('POST', '/api/auth/display-link', { label: '会议室', hours: 1 })).json;
    const dctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const dp = await dctx.newPage();
    const refused = dp.waitForResponse(r => r.url().endsWith('/api/v2/tasks'));
    await dp.goto(base + link.path); await dp.waitForURL(base + '/');
    assert.equal((await refused).status(), 403, 'the top bar asked and was refused');
    await dp.evaluate(() => new Promise(r => setTimeout(r, 50)));
    assert.equal(await dp.$('#aij-topbar'), null, 'display session gets no top bar');
    const dtext = await dp.innerText('body');
    for (const n of ['咖啡店促销方案', '任职资格体系', '大屏上看的任务', '我的任务']) assert.ok(!dtext.includes(n), 'display screen shows no ' + n);
    ok('read-only display session at / sees only the screen: no top bar, no task plaintext');

    /* ---- phone width ---- */
    const phone = await (await adminCtx({ width: 390, height: 780 })).newPage();
    await phone.goto(base + '/workspace.html'); await phone.waitForSelector('#aij-new'); await phone.waitForSelector('#home:not([hidden])');
    assert.ok(await phone.isVisible('#aij-new') && await phone.isVisible('#aij-running') && await phone.isVisible('#home-sum'));
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal scroll at phone width');
    await shot(phone, '4-phone');
    ok('phone width: top bar, running badge and summary usable without horizontal scroll');
    hold = false; for (const f of held.splice(0)) f();

    /* ---- B5-2: only deepseek-v4-pro + qwen3.8-max (remote, never called here) -> RMB confirmation directly ---- */
    const b = await app.call('POST', '/api/models/batch', { providerId: 'deepseek', apiKey: 'sk-B5-TEST-ONLY-0000', models: [{ modelId: 'deepseek-v4-pro', capabilities: ['writing', 'reasoning', 'chinese'] }] });
    assert.equal(b.status, 200, b.text);
    const q = await app.call('POST', '/api/models/batch', { providerId: 'dashscope', apiKey: 'sk-B5-TEST-ONLY-1111', models: [{ modelId: 'qwen3.8-max', capabilities: ['writing', 'reasoning', 'chinese'] }] });
    assert.equal(q.status, 200, q.text);
    assert.equal((await app.call('DELETE', '/api/models/' + id + '?force=1')).status < 500, true);
    const listed = (await app.call('GET', '/api/models')).json.models;
    if (listed.some(m => m.connectionId === id)) await app.call('PUT', '/api/models/' + id, { enabled: false });
    const page = await (await adminCtx()).newPage();
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-go');
    await page.fill('#s-goal', '起草一个任职资格体系的PPT，5页'); await page.check('input[name=s-output][value=ppt]');
    await page.click('#s-go');
    await page.waitForSelector('#s-confirm[open]');
    const dlg = await page.innerText('#s-confirm');
    assert.match(dlg, /预计花费约 ¥\d+\.\d{2}，最多不超过 ¥\d+\.\d{2}/); assert.doesNotMatch(dlg, /管理中心|编辑单价|单价|美元|USD/);
    assert.equal(await page.isVisible('#s-error'), false);
    assert.doesNotMatch(await page.innerText('body'), /管理中心 → 模型 → 编辑|价格未知/);
    await shot(page, '5-confirm');
    await page.click('#s-confirm-cancel');
    ok('B5-2: deepseek-v4-pro + qwen3.8-max plan directly to a RMB confirmation; no "管理中心 → 编辑单价" on the page');
    /* ---- B5-F2: optional RMB budget ---- */
    assert.match(await page.innerText('#s-budget-auto'), /^自动：约 ¥\d+\.\d{2}（建议金额）$/);
    const suggested = Number((await page.innerText('#s-budget-auto')).match(/¥(\d+\.\d{2})/)[1]);
    await page.fill('#s-budget-cny', String(Math.max(0.1, suggested / 4).toFixed(2)));
    await page.click('#s-go'); await page.waitForSelector('#s-budget-warn:not([hidden])');
    assert.match(await page.innerText('#s-budget-warn'), /预算可能不够，做到一半会停下/);
    assert.equal(await page.isVisible('#s-confirm[open]'), false, 'no confirmation before the user decides');
    await page.click('#s-budget-suggest');
    assert.equal(Number(await page.inputValue('#s-budget-cny')), suggested, '改成建议金额 fills the suggested amount');
    await page.fill('#s-budget-cny', String(Math.max(0.1, suggested / 4).toFixed(2)));
    await page.click('#s-go'); await page.waitForSelector('#s-budget-warn:not([hidden])');
    await page.click('#s-budget-keep'); await page.waitForSelector('#s-confirm[open]');
    const cdlg = await page.innerText('#s-confirm');
    assert.match(cdlg, /上限按你填的金额：¥\d+\.\d{2}（比建议金额低，可能做到一半会停下）/); assert.doesNotMatch(cdlg, /USD|美元|Token/i);
    await page.click('#s-confirm-cancel');
    await page.fill('#s-budget-cny', '2'); await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]');
    assert.match(await page.innerText('#s-confirm'), /最多不超过 ¥2\.00[\s\S]*上限按你填的金额：¥2\.00。/);
    await shot(page, '6-budget');
    await page.click('#s-confirm-cancel');
    ok('B5-F2 budget: auto shows the suggested ¥; too low -> plain warning with 改成建议金额 / 就用这个金额; the user amount becomes the cap');
    console.log('\nB5 BROWSER CHECKS PASSED:', results.length);
  } finally {
    hold = false; for (const f of held.splice(0)) { try { f(); } catch { /* closed */ } }
    await browser.close(); await app.stop(); mock.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
