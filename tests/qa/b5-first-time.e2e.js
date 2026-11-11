'use strict';
/* QA-B5 first-time shop-owner baseline (ProductQA). Real server.js + SQLite + real Chromium + LOCAL MOCK model
 * (slow responses so two tasks overlap). E3 only; no paid calls. Observations are recorded, not asserted. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const H = require('../helpers');

const OUT = process.env.QA_OUT || path.join(__dirname, 'out-b5');
fs.mkdirSync(OUT, { recursive: true });
const LIST = ['deepseek-flash', 'qwen3.8-flash'];
const DELAY = +(process.env.QA_DELAY_MS || 9000);
const obs = []; const shots = [];
const note = (k, v) => { obs.push({ k, v }); console.log(k + ' :: ' + (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 700)); };
let page;
const shot = async n => { await page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true }); shots.push(n + '.png'); };
const body = async () => (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
const vis = async s => { try { return await page.locator(s).first().isVisible(); } catch { return false; } };
/* what a person sees right now: visible headings, visible primary buttons, sidebar entries */
const snapshot = () => page.evaluate(() => {
  const v = e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const q = s => [...document.querySelectorAll(s)].filter(v).map(e => e.innerText.trim().replace(/\s+/g, ' ')).filter(Boolean);
  return { headings: q('h1,h2,h3').slice(0, 8), buttons: q('button,a.newtask,nav a').slice(0, 20), sidebar: q('#projects > *').slice(0, 10), url: location.pathname + location.search };
});

(async () => {
  const chats = []; let active = 0, maxActive = 0;
  const mock = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/models$/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: LIST.map(id => ({ id })) })); }
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const j = JSON.parse(b || '{}'); chats.push(j.model);
      const slow = j.max_tokens > 32; active++; maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active--;
        const text = slow ? '【模拟回复】店铺促销方案\n一、时间：周六、周日\n二、优惠：第二杯半价\n三、宣传：社区群与店内海报' : '好';
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 300, completion_tokens: 400 } }) + '\n\ndata: [DONE]\n\n');
      }, slow ? DELAY : 0);
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mp = mock.address().port;
  const app = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mp } });
  const base = 'http://localhost:' + app.port;
  /* seed like an owner who already set things up (setup is not part of the measured journey): models + prices through the API */
  const add = await app.call('POST', '/api/models/connect-all', { providerId: 'custom', baseUrl: `http://127.0.0.1:${mp}/v1`, apiKey: 'mock-key-not-secret-0000' }).catch(() => null);
  let models = (await app.call('GET', '/api/models')).json.models || [];
  if (!models.length) {
    // fall back to the admin page's own add-all button in a scratch context
    const b0 = await chromium.launch({ headless: true });
    const c0 = await b0.newContext(); const ck = H.cookies.get(app.port).split('=');
    await c0.addCookies([{ name: ck[0], value: ck.slice(1).join('='), domain: 'localhost', path: '/' }]);
    const p0 = await c0.newPage(); await p0.goto(base + '/admin.html'); await p0.waitForSelector('#wProv option', { state: 'attached' });
    await p0.selectOption('#wProv', 'custom'); await p0.evaluate(() => { const d = document.querySelector('#wBase').closest('details'); if (d) d.open = true; });
    await p0.fill('#wBase', `http://127.0.0.1:${mp}/v1`); await p0.fill('#wKey', 'mock-key-not-secret-0000'); await p0.click('#wAddAll');
    await p0.waitForFunction(() => /已添加 \d+ 个/.test(document.querySelector('#wAllRes').textContent), null, { timeout: 20000 });
    await b0.close(); models = (await app.call('GET', '/api/models')).json.models;
  }
  for (const m of models) await app.call('PUT', '/api/models/' + m.connectionId, { price: { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 3 } });
  note('seed', `已接入 ${models.length} 个模型（脚本代为添加并填单价，不计入测量）`);

  const browser = await chromium.launch({ headless: true, env: { ...process.env, LANG: 'C.UTF-8' } });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, acceptDownloads: true });
    page = await ctx.newPage();
    /* ===== A. login -> find "新建任务" ===== */
    await page.goto(base + '/login.html'); await page.waitForSelector('#loginForm:not(.hidden)');
    await shot('A1-login');
    await page.fill('#pw', H.TEST_PASSWORD);
    const t0 = Date.now(); await page.click('#loginBtn');
    await page.waitForURL(u => !/login\.html/.test(u.pathname), { timeout: 15000 });
    await page.waitForLoadState('domcontentloaded');
    let tFind = null;
    for (let i = 0; i < 100 && tFind === null; i++) { if (await vis('#s-newtask') || await vis('text=新建任务')) tFind = Date.now() - t0; else await page.waitForTimeout(100); }
    note('A 登录后落点', page.url().replace(base, ''));
    note('A 从点“登录”到屏幕上出现“新建任务”', tFind === null ? '一直没出现（>10秒）' : `${tFind} ms；额外点击 0 次（登录本身 1 次）`);
    note('A 落地页所见', await snapshot());
    await shot('A2-after-login');
    const goalVisible = await vis('#s-goal');
    note('A 登录后无需点击就能直接打字（想做什么输入框可见）', goalVisible);

    /* ===== B. two tasks at once ===== */
    const startTask = async (goal, label) => {
      if (!(await vis('#s-goal'))) { await page.click('#s-newtask'); await page.waitForSelector('#s-goal', { state: 'visible' }); }
      await page.fill('#s-goal', goal); await page.click('#s-go');
      await page.waitForSelector('#s-confirm[open]', { timeout: 10000 }); await page.click('#s-confirm-ok');
      await page.waitForSelector('#s-progress:not([hidden])', { timeout: 10000 });
      note(label + ' 已开始', await snapshot());
    };
    await startTask('你想让 AI 帮你写一份店铺促销方案', 'B 任务1');
    await page.waitForTimeout(1500); await shot('B1-task1-running');
    note('B 任务1 运行中屏幕全文', (await body()).slice(0, 500));
    // can a newcomer find "新建" from the progress page?
    const newBtns = await page.locator('text=新建').allInnerTexts();
    note('B 进度页上写着“新建”的按钮', newBtns.map(s => s.trim()));
    await page.click('#s-newtask').catch(async () => { await page.click('#s-new'); });
    await page.waitForTimeout(800);
    await shot('B2-after-click-new');
    note('B 点“新建任务”之后看到', await snapshot());
    await startTask('第二个任务：写一份小店周年庆活动方案', 'B 任务2');
    await page.waitForTimeout(1500); await shot('B3-two-running');
    const t2 = await body();
    note('B 两个任务都在跑时，页面上能否看到“几个在跑”', { hasRunningCount: /\d+\s*个.{0,6}(在跑|运行|进行)|运行中|进行中|正在/.test(t2), sidebar: (await snapshot()).sidebar });
    note('B 同时在跑的模型请求峰值（假服务端计数）', maxActive);

    /* switch between tasks via the left list */
    const items = await page.locator('#projects > *').count();
    note('B 左侧项目条目数', items);
    if (items >= 2) {
      await page.locator('#projects > *').nth(items - 1).click(); await page.waitForTimeout(1200);
      await shot('B4-switched-to-first');
      note('B 点左侧较早的任务后看到', { snap: await snapshot(), hasProgress: await vis('#s-progress'), text: (await body()).slice(0, 260) });
      await page.locator('#projects > *').nth(0).click(); await page.waitForTimeout(1200);
      await shot('B5-switched-back');
      note('B 再点回最新任务后看到', { snap: await snapshot(), hasProgress: await vis('#s-progress') });
    }

    /* ===== C. leave and come back ===== */
    await page.goto(base + '/admin.html'); await page.waitForTimeout(800);
    await page.goto(base + '/workspace.html'); await page.waitForTimeout(1500);
    await shot('C1-back-from-admin');
    note('C 去管理中心再回工作台（点“项目工作台”/直接回来）后看到', { snap: await snapshot(), hasProgress: await vis('#s-progress'), blankForm: await vis('#s-goal') });
    const p2 = await ctx.newPage(); page = p2; await page.goto(base + '/'); await page.waitForTimeout(1500);
    await shot('C2-new-tab-root');
    note('C 关掉页面、重新打开网站首页后看到', { snap: await snapshot(), hasProgress: await vis('#s-progress'), blankForm: await vis('#s-goal') });
    await page.waitForTimeout(DELAY * 2 + 3000);
    await page.goto(base + '/workspace.html'); await page.waitForTimeout(1500); await shot('C3-later');
    note('C 任务跑完后回来看到', { snap: await snapshot(), hasProgress: await vis('#s-progress'), hasResult: await vis('#s-result'), text: (await body()).slice(0, 300) });
    note('页面最终英文词检查（登录后首页）', (await body()).match(/[A-Za-z][A-Za-z_]{2,}/g) || []);
  } catch (e) { note('脚本异常', String(e && e.stack || e).slice(0, 600)); }
  finally { await browser.close(); await app.stop(); mock.close(); fs.writeFileSync(path.join(OUT, 'observations.json'), JSON.stringify({ obs, shots, chats: chats.length }, null, 2)); console.log('DONE obs=' + obs.length + ' chats=' + chats.length); }
})();
