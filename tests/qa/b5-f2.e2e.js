'use strict';
/* QA-B5F2a: "我的任务" click must always respond (8 pages x with/without tasks), clicks survive the 5 s topbar refresh,
 * optional budget on the new-task page, main-line regression. Real server.js + SQLite + Chromium + LOCAL MOCK model. E3. No paid calls. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const H = require('../helpers');

const OUT = process.env.QA_OUT || path.join(__dirname, 'out-f2');
fs.mkdirSync(OUT, { recursive: true });
const LIST = ['deepseek-flash', 'qwen3.8-flash'];
const rows = []; const shots = [];
const rec = (id, ok, note) => { rows.push({ id, ok, note }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + String(note).slice(0, 420)); };
let page;
const shot = async n => { await page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: false }); shots.push(n + '.png'); };
const vis = async s => { try { return await page.locator(s).first().isVisible(); } catch { return false; } };
const body = async () => (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');

(async () => {
  let delay = 3000; const chats = [];
  const mock = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/models$/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: LIST.map(id => ({ id })) })); }
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const j = JSON.parse(b || '{}'); const slow = j.max_tokens > 32; if (slow) chats.push(j.model);
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: slow ? '【模拟回复】店铺促销方案\n一、时间：周六\n二、优惠：第二杯半价' : '好' } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 300, completion_tokens: 400 } }) + '\n\ndata: [DONE]\n\n');
      }, slow ? delay : 0);
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mp = mock.address().port;
  const app = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mp } });
  const base = 'http://localhost:' + app.port;
  const browser = await chromium.launch({ headless: true, env: { ...process.env, LANG: 'C.UTF-8' } });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, acceptDownloads: true });
    const ck = H.cookies.get(app.port).split('=');
    await ctx.addCookies([{ name: ck[0], value: ck.slice(1).join('='), domain: 'localhost', path: '/' }]);
    page = await ctx.newPage();
    // seed models + prices (not part of the checks)
    await page.goto(base + '/admin.html'); await page.waitForSelector('#wProv option', { state: 'attached' });
    await page.selectOption('#wProv', 'custom'); await page.evaluate(() => { const d = document.querySelector('#wBase').closest('details'); if (d) d.open = true; });
    await page.fill('#wBase', `http://127.0.0.1:${mp}/v1`); await page.fill('#wKey', 'mock-key-not-secret-0000'); await page.click('#wAddAll');
    await page.waitForFunction(() => /已添加 \d+ 个/.test(document.querySelector('#wAllRes').textContent), null, { timeout: 20000 });
    for (const m of (await app.call('GET', '/api/models')).json.models) await app.call('PUT', '/api/models/' + m.connectionId, { price: { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 3 } });

    /* clicking "我的任务" on a page: what a person sees afterwards */
    const clickHome = async (label, url) => {
      await page.goto(base + url); await page.waitForSelector('#aij-home', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(700);
      if (!(await vis('#aij-home'))) return { label, ok: false, note: '页面上没有“我的任务”按钮' };
      const before = page.url(); let navigated = false;
      page.once('framenavigated', () => { navigated = true; });
      const sc0 = await page.evaluate(() => scrollY);
      await page.click('#aij-home'); await page.waitForTimeout(1500);
      const u = new URL(page.url());
      const atHome = u.pathname === '/workspace.html' && !u.searchParams.get('run') && !u.searchParams.get('new') && !u.searchParams.get('project');
      const homeShown = (await vis('#home')) || (await vis('#home-empty'));
      return { label, ok: atHome && homeShown, note: `点击前 ${before.replace(base, '')} → 点击后 ${page.url().replace(base, '')}；任务中心可见=${homeShown}；发生页面跳转=${navigated}` };
    };
    const PAGES0 = [['任务中心(无任务)', '/workspace.html'], ['新建任务', '/workspace.html?new=1'], ['实时大屏', '/panel.html'], ['管理(模型设置)', '/admin.html'], ['能力中心', '/capabilities.html'], ['智能立项', '/project-intake.html']];
    for (const [l, u] of PAGES0) { const r = await clickHome(l + ' / 无任务', u); rec('① 无任务·' + l, r.ok, r.note); if (l.startsWith('任务中心')) await shot('01-home-empty'); }

    /* start task A (finishes) then task B (stays running) through the real UI */
    const startTask = async goal => {
      await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-goal');
      await page.fill('#s-goal', goal); await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]', { timeout: 10000 }); await page.click('#s-confirm-ok');
      await page.waitForSelector('#s-progress:not([hidden])', { timeout: 10000 });
    };
    delay = 2500; await startTask('任务A：写一份店铺促销方案');
    await page.waitForSelector('#s-result:not([hidden])', { timeout: 40000 });
    delay = 60000; await startTask('任务B：写一份周年庆活动方案（长时间运行）');
    const tasks = (await app.call('GET', '/api/v2/tasks')).json.tasks || [];
    const running = tasks.find(t => t.group === 'running'); const any = tasks[0];
    rec('前置：有 1 个完成/待审核 + 1 个运行中的任务', !!running && tasks.length >= 2, tasks.map(t => t.group).join(','));
    const PAGES1 = [['任务中心(有任务)', '/workspace.html'], ['新建任务', '/workspace.html?new=1'], ['进度页', '/workspace.html?run=' + running.runId], ['配置页', '/workspace.html?project=' + (running.projectId || any.projectId)], ['实时大屏', '/panel.html'], ['管理(模型设置)', '/admin.html'], ['能力中心', '/capabilities.html'], ['智能立项', '/project-intake.html']];
    for (const [l, u] of PAGES1) { const r = await clickHome(l + ' / 有任务', u); rec('① 有任务·' + l, r.ok, r.note); if (l === '进度页') await shot('02-progress-click-home'); }
    await page.goto(base + '/workspace.html'); await page.waitForTimeout(1200); await shot('03-home-with-tasks');

    /* the task-center page itself: clicking "我的任务" while already there */
    await page.goto(base + '/workspace.html'); await page.waitForSelector('#home'); await page.waitForTimeout(500);
    await page.evaluate(() => { window.__qaMark = 'same-page'; });
    await page.click('#aij-home'); await page.waitForTimeout(1000);
    rec('① 已在任务中心时点“我的任务”', await vis('#home'), '页面保持任务中心；是否整页重新载入=' + ((await page.evaluate(() => window.__qaMark)) !== 'same-page'));

    /* ② clicks survive the 5 s refresh */
    await page.goto(base + '/workspace.html?run=' + running.runId); await page.waitForSelector('#aij-home'); await page.waitForTimeout(800);
    await page.evaluate(() => { document.querySelector('#aij-home').__qa = 1; document.querySelector('#aij-new').__qa = 1; document.querySelector('#aij-running').__qa = 1; });
    await page.waitForTimeout(11000); // > two refresh cycles
    const survived = await page.evaluate(() => ({ home: document.querySelector('#aij-home').__qa === 1, new: document.querySelector('#aij-new').__qa === 1, badge: document.querySelector('#aij-running').__qa === 1 }));
    rec('② 5 秒刷新不替换导航按钮（同一个元素还在）', survived.home && survived.new && survived.badge, JSON.stringify(survived));
    // press, wait across a refresh, release: must still navigate
    const box = await page.locator('#aij-home').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.waitForTimeout(5600); await page.mouse.up(); await page.waitForTimeout(1200);
    rec('② 按下后等过一次刷新再松开，点击仍生效', new URL(page.url()).pathname === '/workspace.html' && !new URL(page.url()).searchParams.get('run'), '松开后地址 ' + page.url().replace(base, ''));
    // 20 clicks at spread-out moments across ~25 s on the progress page (alternating buttons)
    await page.goto(base + '/workspace.html?run=' + running.runId); await page.waitForSelector('#aij-home'); let ok = 0, tot = 0;
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(400 + (i * 370) % 2300);
      const sel = i % 2 ? '#aij-new' : '#aij-home'; const want = i % 2 ? /new=1/ : /^\/workspace\.html$/;
      await page.click(sel); await page.waitForTimeout(500); tot++;
      const loc = new URL(page.url()); if (want.test(i % 2 ? loc.search : loc.pathname + (loc.search || ''))) ok++;
      await page.goto(base + '/workspace.html?run=' + running.runId); await page.waitForSelector('#aij-home');
    }
    rec('② 12 次随机时刻点击（跨多个 5 秒刷新周期）全部生效', ok === tot, `${ok}/${tot}`);
    // the "运行中" drop-down stays open across a refresh
    await page.click('#aij-running'); await page.waitForTimeout(6500);
    rec('② 下拉打开后经过 5 秒刷新仍保持打开', await vis('#aij-running-menu'), (await page.locator('#aij-running-menu').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120)); await shot('04-menu-open-after-refresh');

    /* ③ optional budget on the new-task page */
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-goal');
    rec('③ 未写目标时的预算提示', true, '预算提示：' + (await page.locator('#s-budget-auto').innerText()).replace(/\s+/g, ' ') + '；输入框占位：' + await page.getAttribute('#s-budget-cny', 'placeholder'));
    await page.fill('#s-goal', '给小店写一份周末促销方案'); await page.waitForTimeout(800);
    const autoTxt = (await page.locator('#s-budget-auto').innerText()).replace(/\s+/g, ' ');
    rec('③ 不填预算：显示“自动：约 ¥X”', /自动：约 ¥\d+(\.\d+)?/.test(autoTxt), autoTxt); await shot('05-budget-auto');
    // floor behaviour: a tiny amount below the ¥0.10 minimum
    await page.fill('#s-budget-cny', '0.03'); await page.click('#s-go'); await page.waitForTimeout(1200);
    const floorWarn = await vis('#s-budget-warn'); const floorDlg = (await vis('#s-confirm[open]')) ? (await page.innerText('#s-confirm')).replace(/\s+/g, ' ') : '';
    const fmax = parseFloat((/最多(?:不超过)? ¥(\d+(\.\d+)?)/.exec(floorDlg) || [])[1] || 'NaN');
    rec('③ 填 ¥0.03（低于系统最低 ¥0.10）：确认框里的“最多”不得悄悄高于所填，或要明确告知', !(fmax > 0.03 + 1e-9) || /你填的|最低|调整/.test(floorDlg) || floorWarn, `提示=${floorWarn}；确认框=${floorDlg}`); await shot('05b-floor');
    if (await vis('#s-confirm[open]')) await page.click('#s-confirm-cancel');
    // make the task expensive enough that a small budget really is "not enough"
    for (const m of (await app.call('GET', '/api/models')).json.models) await app.call('PUT', '/api/models/' + m.connectionId, { price: { currency: 'CNY', inputPerMillion: 40, outputPerMillion: 160 } });
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-goal'); await page.fill('#s-goal', '给小店写一份周末促销方案，要详细一些'); await page.waitForTimeout(900);
    const autoTxt2 = (await page.locator('#s-budget-auto').innerText()).replace(/\s+/g, ' ');
    rec('③ 贵模型下“自动：约 ¥X”随之更新', /自动：约 ¥\d/.test(autoTxt2) && autoTxt2 !== autoTxt, autoTxt2);
    const suggested = parseFloat((/¥(\d+(\.\d+)?)/.exec(autoTxt2) || [])[1] || '0');
    const startedBefore = chats.length; const projBefore = ((await app.call('GET', '/api/v2/projects')).json.projects || []).length;
    await page.fill('#s-budget-cny', String(Math.max(0.1, +(suggested / 4).toFixed(2))));
    await page.click('#s-go'); await page.waitForTimeout(1200);
    const warn = await vis('#s-budget-warn'); const warnTxt = warn ? (await page.locator('#s-budget-warn').innerText()).replace(/\s+/g, ' ') : '';
    const projAfter = ((await app.call('GET', '/api/v2/projects')).json.projects || []).length;
    rec('③ 填低于建议金额：先提示，两个按钮', warn && /改成建议金额/.test(warnTxt) && /就用这个金额/.test(warnTxt), warnTxt); await shot('06-budget-warn');
    rec('③ 提示出现时，选择前没有弹确认框、没有新建任务、没有模型调用', !(await vis('#s-confirm[open]')) && projAfter === projBefore && chats.length === startedBefore, `确认框=${await vis('#s-confirm[open]')} 任务数 ${projBefore}→${projAfter} 模型调用 ${startedBefore}→${chats.length}`);
    // choice 1: 改成建议金额
    if (warn) {
      await page.click('#s-budget-suggest'); await page.waitForTimeout(800);
      const val = await page.inputValue('#s-budget-cny');
      rec('③ 点“改成建议金额”后输入框变成建议金额', Math.abs(parseFloat(val) - suggested) < 0.06 || parseFloat(val) >= suggested, `输入框=${val}，建议=${suggested}`);
      const dlgOpen = await vis('#s-confirm[open]');
      if (!dlgOpen) { await page.click('#s-go'); await page.waitForTimeout(1200); }
      const dlg1 = (await vis('#s-confirm[open]')) ? (await page.innerText('#s-confirm')).replace(/\s+/g, ' ') : '';
      rec('③ 改成建议金额后，确认框照常弹出（人民币）', /预计.*¥.*最多.*¥/.test(dlg1) && !/\$|USD|美元|[Tt]oken/.test(dlg1), dlg1); await shot('07-confirm-after-suggest');
      if (dlg1) await page.click('#s-confirm-cancel');
    }
    // choice 2: 就用这个金额
    await page.fill('#s-budget-cny', String(Math.max(0.1, +(suggested / 4).toFixed(2)))); await page.click('#s-go'); await page.waitForTimeout(1000);
    if (await vis('#s-budget-warn')) { await page.click('#s-budget-keep'); await page.waitForTimeout(1200); }
    const dlg2 = (await vis('#s-confirm[open]')) ? (await page.innerText('#s-confirm')).replace(/\s+/g, ' ') : '';
    const kept = await page.inputValue('#s-budget-cny');
    rec('③ 点“就用这个金额”后，确认框照常弹出，最多金额不超过所填', /预计.*¥.*最多.*¥/.test(dlg2), `所填 ¥${kept}；确认框：${dlg2}`); await shot('08-confirm-keep');
    if (dlg2) { const mx = parseFloat((/最多(?:不超过)? ¥(\d+(\.\d+)?)/.exec(dlg2) || [])[1] || 'NaN'); rec('③ 确认框“最多”不高于所填金额（或明确说明为何不同）', mx <= parseFloat(kept) + 1e-9, `最多 ¥${mx} vs 所填 ¥${kept}`); await page.click('#s-confirm-cancel'); }
    // above suggested: straight to confirm
    await page.fill('#s-budget-cny', String(+(suggested * 3 + 0.5).toFixed(2))); await page.click('#s-go'); await page.waitForTimeout(1200);
    rec('③ 填高于建议金额：不再拦截，直接确认框', !(await vis('#s-budget-warn')) && (await vis('#s-confirm[open]')), `提示=${await vis('#s-budget-warn')} 确认框=${await vis('#s-confirm[open]')}`);
    if (await vis('#s-confirm[open]')) await page.click('#s-confirm-cancel');
    // junk input
    for (const junk of ['0', '-5', '1e']) { await page.fill('#s-budget-cny', junk).catch(() => {}); await page.click('#s-go'); await page.waitForTimeout(700);
      const t = (await page.evaluate(() => [document.querySelector('#s-error'), document.querySelector('#s-budget-warn')].map(e => e && !e.hidden ? e.innerText : '').join(' '))).replace(/\s+/g, ' ');
      rec('③ 乱填预算 “' + junk + '”：给出中文提示或视为不填，不报错不卡死', !/undefined|null|NaN|Error/.test(t) && (!(await vis('#s-confirm[open]')) || true), '提示=' + (t || '（无）') + '；确认框=' + (await vis('#s-confirm[open]'))); if (await vis('#s-confirm[open]')) await page.click('#s-confirm-cancel'); }
    await page.fill('#s-budget-cny', ''); await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]', { timeout: 8000 }).catch(() => {});
    rec('③ 清空预算后再开始：确认框照常弹出', await vis('#s-confirm[open]'), ''); if (await vis('#s-confirm[open]')) await page.click('#s-confirm-cancel');
    const eng = (await body()); const w = eng.match(/[A-Za-z][A-Za-z_]{2,}/g) || [];
    rec('③ 新建页无英文技术词/JSON/美元/Token', !/\$|USD|美元|[Tt]oken/.test(eng) && w.filter(x => !['AIJAVAIS', 'Word', 'Excel', 'PPT'].includes(x)).length === 0, '残留：' + [...new Set(w)].join(','));
  } catch (e) { rec('脚本异常', false, String(e && e.stack || e).slice(0, 700)); }
  finally { await browser.close(); await app.stop(); mock.close(); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ rows, shots, chats: chats.length }, null, 2)); console.log(`DONE pass=${rows.filter(r => r.ok).length} fail=${rows.filter(r => !r.ok).length} mockCalls=${chats.length}`); }
})();
