'use strict';
/* QA-B8 (ProductQA, independent of tests/ui/b8-split.e2e.js): front/back split seen through an ordinary person's eyes.
 * Real server.js + SQLite + real Chromium + LOCAL MOCK model. E3. No paid calls. Observations are recorded, judgement is in the report. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const H = require('../helpers');

const OUT = process.env.QA_OUT || path.join(__dirname, 'out-b8');
fs.mkdirSync(OUT, { recursive: true });
const PASSW = 'xiaowang-pass-2026';
const rows = []; const shots = [];
const rec = (id, ok, note) => { rows.push({ id, ok, note }); console.log((ok === null ? 'NOTE ' : ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + String(note).slice(0, 520)); };
const clean = t => String(t).replace(/\s+/g, ' ').trim();
const BRAND = ['AIJAVAIS', 'Word', 'Excel', 'PPT', 'HALOFLUX'];
const eng = t => { let x = String(t); for (const w of BRAND) x = x.split(w).join(' '); return [...new Set(x.match(/[A-Za-z][A-Za-z_]{2,}/g) || [])]; };
const TECH = /Token|token|USD|美元|\$|API|JSON|provider|capability|null|undefined|模型设置|管理中心|能力中心|智能立项|高级设置|管理后台|价格|单价|密钥|Key\b/;
let page;
const shot = async (n, p) => { await (p || page).screenshot({ path: path.join(OUT, n + '.png') }); shots.push(n + '.png'); };
const vis = async (s, p) => { try { return await (p || page).locator(s).first().isVisible(); } catch { return false; } };
const body = async p => clean(await (p || page).evaluate(() => document.body.innerText));

const jsonDeck = JSON.stringify({ slides: [{ layout: 'cover', title: '周末促销方案', subtitle: '小店' }, { layout: 'bullets', title: '为什么做', bullets: ['客流集中', '新客多'] }, { layout: 'cards', title: '三个动作', cards: [{ title: '半价', text: '第二杯' }, { title: '集章', text: '送小食' }, { title: '拼单', text: '减三元' }] }, { layout: 'summary', title: '总结', bullets: ['小成本', '好执行'] }] });

(async () => {
  let pptMode = false; const chats = [];
  const mock = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/models$/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'local-writer' }, { id: 'priced-writer' }] })); }
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const j = JSON.parse(b || '{}'); const real = j.max_tokens > 32; if (real) chats.push(j.model);
      const review = /审核上一步/.test(JSON.stringify(j.messages || ''));
      const text = !real ? '好' : review && pptMode ? jsonDeck : '周末促销方案：一、活动主题；二、优惠内容；三、宣传渠道；四、预算与分工。内容完整，可以直接使用。';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 400, completion_tokens: 600 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mp = mock.address().port;
  const app = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mp }, login: false });
  const base = 'http://localhost:' + app.port;
  const browser = await chromium.launch({ headless: true, env: { ...process.env, LANG: 'C.UTF-8' } });
  try {
    /* ---------- admin: first visit, setup, models ---------- */
    const ac = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, acceptDownloads: true }); const ap = await ac.newPage(); page = ap;
    await ap.goto(base + '/login.html'); await ap.waitForTimeout(700); await shot('00-front-login-before-setup');
    rec('登录页（首次部署、尚未设置管理员）', null, '可见：' + clean(await ap.evaluate(() => [...document.querySelectorAll('form:not(.hidden), h1, h2, p')].filter(e => e.offsetParent).map(e => e.innerText).join(' | '))).slice(0, 300));
    await ap.goto(base + '/admin.html'); await ap.waitForURL(/admin-login/); await ap.waitForSelector('#setupForm:not(.hidden)');
    await shot('01-admin-login-setup'); rec('后台登录页（首次设置）', null, '文字：' + (await body(ap)).slice(0, 300) + ' | 英文词：' + eng(await body(ap)).join(','));
    const code = /([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(fs.readFileSync(path.join(app.dir, 'setup-code.txt'), 'utf8'))[1];
    await ap.fill('#code', code); await ap.fill('#np', H.TEST_PASSWORD); await ap.fill('#np2', H.TEST_PASSWORD); await ap.click('#setupBtn'); await ap.waitForURL(/\/admin\.html/);
    const cookie = 'aij_session=' + (await ac.cookies()).find(c => c.name === 'aij_session').value; H.cookies.set(app.port, cookie);
    const api = (m, u, b) => app.call(m, u, b);
    const mk = async (extra) => (await api('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mp}/v1`, ...extra })).json.connection.connectionId;
    const localId = await mk({ modelId: 'local-writer', displayName: '本地写手', pricingMode: 'local', capabilities: ['writing', 'reasoning', 'chinese', 'data_analysis'] });
    await api('POST', '/api/models/' + localId + '/test', {});
    const paidId = await mk({ modelId: 'priced-writer', displayName: '收费写手', pricingMode: 'paid_api', capabilities: ['writing', 'reasoning', 'chinese', 'data_analysis'], price: { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 1 } });
    await api('POST', '/api/models/' + paidId + '/test', { approvePaid: true });

    /* ---------- 1. admin creates users ---------- */
    await ap.goto(base + '/admin.html'); await ap.waitForSelector('#nav-users'); await ap.click('#nav-users'); await ap.waitForSelector('#pane-users.on');
    rec('1 管理员“使用者”页（空）', null, clean(await ap.locator('#pane-users').innerText()).slice(0, 360)); await shot('02-admin-users-empty');
    const tryAdd = async (name, pw, cap) => { await ap.fill('#uName', name); await ap.fill('#uPw', pw); await ap.fill('#uCap', cap); await ap.click('#uAdd'); await ap.waitForTimeout(800); return clean(await ap.locator('#uRes').innerText()); };
    rec('1 密码太短时的提示', null, await tryAdd('xiaowang', 'short', '5'));
    rec('1 用户名太短时的提示', null, await tryAdd('a', PASSW, '5'));
    rec('1 月上限填负数时的提示', null, await tryAdd('xiaowang', PASSW, '-3'));
    rec('1 月上限留空时的提示', null, await tryAdd('xiaowang', PASSW, ''));
    rec('1 正常新增 xiaowang（月上限 ¥5）', /已新增/.test(await tryAdd('xiaowang', PASSW, '5')), '已新增');
    rec('1 重名新增时的提示（大小写不同）', null, await tryAdd('XiaoWang', PASSW, '5'));
    await tryAdd('xiaoli', PASSW, '0.02');
    await shot('03-admin-users-list'); rec('1 使用者列表', null, clean(await ap.locator('#uBody').innerText()).slice(0, 360));

    /* ---------- 2. user login & front pages ---------- */
    const uc = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, acceptDownloads: true }); const up = await uc.newPage(); page = up;
    await up.goto(base + '/workspace.html'); await up.waitForURL(/login\.html/); await up.waitForTimeout(600); await shot('04-front-login');
    const ltxt = await body(up); rec('2 使用者登录页', null, ltxt.slice(0, 300) + ' | 英文词：' + eng(ltxt).join(',') + ' | 含后台字样：' + /后台|管理/.test(ltxt));
    await up.fill('#un', 'xiaowang'); await up.fill('#upw', 'wrong-password-1'); await up.click('#userBtn'); await up.waitForTimeout(900);
    rec('2 密码错时的提示', null, clean(await up.locator('#msg').innerText())); await shot('05-front-login-wrong');
    await up.fill('#upw', PASSW); await up.click('#userBtn'); await up.waitForURL(/workspace\.html/); await up.waitForTimeout(1500);
    const entries = await up.$$eval('#aij-topbar a, #aij-topbar button', ns => ns.map(n => n.textContent.trim())); rec('2 使用者顶栏入口', JSON.stringify(entries) === JSON.stringify(['我的任务', '＋ 新建任务', '实时大屏', '退出']), JSON.stringify(entries));
    const scanPage = async (label, p) => { const t = await body(p); const tech = [...new Set(t.match(new RegExp(TECH.source, 'g')) || [])]; rec('2 前台页面扫描：' + label, eng(t).length === 0 && tech.length === 0, `英文词=${eng(t).join(',') || '无'} 技术/后台字样=${tech.join(',') || '无'}`); };
    await shot('06-user-home'); await scanPage('首页(无任务)', up);
    rec('2 使用者首页(无模型可用时)文案', null, (await body(up)).slice(0, 260));
    await up.goto(base + '/workspace.html?new=1'); await up.waitForSelector('#s-goal'); await shot('07-user-new'); await scanPage('新建任务', up);
    rec('2 新建页是否出现预算/价格/模型选择类控件', null, '预算输入框=' + await vis('#s-budget-cny', up) + ' 高级设置=' + await vis('#s-advanced', up) + ' 换一个=' + await vis('#s-swap button', up));

    /* ---------- 3. user runs a task (free local mock) ---------- */
    await api('POST', '/api/models/' + paidId + '/disable', {});
    const startUser = async (goal, out) => { await up.goto(base + '/workspace.html?new=1'); await up.waitForSelector('#s-goal'); await up.fill('#s-goal', goal); if (out) await up.check('input[name=s-output][value=' + out + ']'); await up.click('#s-go'); await up.waitForTimeout(1500); };
    await startUser('给社区咖啡店写一份周末促销方案');
    const dlg = (await vis('#s-confirm[open]', up)) ? clean(await up.innerText('#s-confirm')) : '（没弹确认框）错误：' + clean(await up.locator('#s-error').innerText().catch(() => ''));
    rec('3 使用者确认框（免费本地模型）', null, dlg); await shot('08-user-confirm');
    if (await vis('#s-confirm[open]', up)) { await up.click('#s-confirm-ok'); await up.waitForSelector('#s-result:not([hidden]), #s-stop:not([hidden]), #s-run-error:not([hidden])', { timeout: 40000 }); await up.waitForTimeout(800); }
    await shot('09-user-result'); await scanPage('进度/成果页', up); rec('3 进度页内容', null, (await body(up)).slice(0, 380));

    /* ---------- 4. direct access to back-end addresses ---------- */
    for (const u of ['/admin.html', '/capabilities.html', '/project-intake.html', '/admin-login.html', '/api/models', '/api/v2/users', '/api/settings', '/api/v2/usage/system/exceptions']) {
      const r = await up.goto(base + u); await up.waitForTimeout(500); const t = await body(up);
      const raw = /^[\[{]/.test(t) || /"error"/.test(t);
      rec('4 使用者直接打开 ' + u, null, `HTTP ${r.status()} | 页面文字：${t.slice(0, 160)} | 裸JSON=${raw} | 英文词=${eng(t).slice(0, 6).join(',') || '无'}`);
      if (u === '/admin.html' || u === '/api/models') await shot('10-direct-' + u.replace(/[^a-z]/g, ''));
    }
    /* ---------- 5a. user deleting a project that already ran ---------- */
    await up.goto(base + '/workspace.html'); await up.waitForTimeout(1200);
    const del = await up.evaluate(async () => { const t = (await (await fetch('/api/v2/tasks')).json()).tasks[0]; const r = await fetch('/api/v2/projects/' + t.projectId, { method: 'DELETE', headers: { 'content-type': 'application/json' } }); return { status: r.status, text: (await r.text()).slice(0, 300) }; });
    rec('5 使用者删除已运行项目（直接调用）', null, JSON.stringify(del));
    const delUi = await up.evaluate(() => [...document.querySelectorAll('button,a')].filter(e => e.offsetParent && /删除/.test(e.textContent)).map(e => e.textContent.trim()));
    rec('5 前台界面上有没有“删除项目”入口', null, JSON.stringify(delUi) + '（空数组=前台根本没有这个入口）');

    /* ---------- 6. monthly cap: xiaoli (¥0.02) ---------- */
    await api('POST', '/api/models/' + localId + '/disable', {}); await api('POST', '/api/models/' + paidId + '/enable', {});
    const lc = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, acceptDownloads: true }); const lp = await lc.newPage(); page = lp;
    await lp.goto(base + '/login.html'); await lp.fill('#un', 'xiaoli'); await lp.fill('#upw', PASSW); await lp.click('#userBtn'); await lp.waitForURL(/workspace\.html/); await lp.waitForTimeout(1200);
    await lp.goto(base + '/workspace.html?new=1'); await lp.waitForSelector('#s-goal'); await lp.fill('#s-goal', '写一份会员招募文案'); await lp.click('#s-go'); await lp.waitForTimeout(1800);
    const lowTxt = (await vis('#s-confirm[open]', lp)) ? '确认框：' + clean(await lp.innerText('#s-confirm')) : '提示：' + clean(await lp.locator('#s-error').innerText().catch(() => '')) + ' | 预算提示：' + clean(await lp.locator('#s-budget-warn').innerText().catch(() => ''));
    rec('6 月上限只有 ¥0.02、这次要花更多：开始时的提示', null, lowTxt); await shot('11-cap-too-low', lp);
    const lowAll = await body(lp); rec('6 该提示是否含技术/美元字样、是否吓人', !TECH.test(lowAll) && eng(lowAll).length === 0, '英文词=' + eng(lowAll).join(',') + ' 技术字样=' + (lowAll.match(TECH) || []).join(','));
    /* admin raises xiaoli's cap through the UI, observe feedback; user then runs */
    page = ap; await ap.goto(base + '/admin.html'); await ap.click('#nav-users'); await ap.waitForSelector('#uBody tr[data-user]');
    await ap.locator('#uBody tr', { hasText: 'xiaoli' }).locator('[data-u-act=cap]').click(); await ap.waitForSelector('#uCapNew'); await ap.fill('#uCapNew', '0.3'); await ap.click('#uCapSave'); await ap.waitForTimeout(900);
    rec('5 管理员改上限后的反馈', null, 'toast=' + clean(await ap.locator('#toast').innerText().catch(() => '')) + ' | 列表：' + clean(await ap.locator('#uBody tr', { hasText: 'xiaoli' }).innerText())); await shot('12-admin-cap-changed');
    page = lp; await lp.goto(base + '/workspace.html?new=1'); await lp.waitForSelector('#s-goal'); await lp.fill('#s-goal', '写一份会员招募文案'); await lp.click('#s-go'); await lp.waitForSelector('#s-confirm[open]', { timeout: 8000 }).catch(() => {});
    rec('6 上限提高后确认框的额度行', null, (await vis('#s-confirm[open]', lp)) ? clean(await lp.innerText('#s-confirm')) : '没弹确认框：' + clean(await lp.locator('#s-error').innerText().catch(() => ''))); await shot('13-confirm-with-quota', lp);
    if (await vis('#s-confirm[open]', lp)) { await lp.click('#s-confirm-ok'); await lp.waitForSelector('#s-result:not([hidden]), #s-stop:not([hidden]), #s-run-error:not([hidden])', { timeout: 40000 }); await lp.waitForTimeout(800); }
    rec('6 跑完后进度页', null, (await body(lp)).slice(0, 420)); await shot('14-paid-result', lp);
    /* use up the quota: lower cap to what was spent, then rework and start again */
    const spent = (await api('GET', '/api/v2/users')).json.users.find(u => u.username === 'xiaoli').month; rec('6 xiaoli 本月已花', null, JSON.stringify(spent));
    await api('POST', '/api/v2/users/' + (await api('GET', '/api/v2/users')).json.users.find(u => u.username === 'xiaoli').userId, { monthlyCapCny: Math.max(0.01, spent.spentCny) });
    if (await vis('#s-rework', lp)) { await lp.click('#s-rework'); await lp.fill('#s-rework-text', '再精炼一些'); await lp.click('#s-rework-go'); await lp.waitForTimeout(1500);
      rec('6 额度已用完时点返工的提示', null, (await vis('#s-confirm[open]', lp)) ? '确认框：' + clean(await lp.innerText('#s-confirm')) : '提示：' + clean(await lp.locator('#s-error, #s-run-error').first().innerText().catch(() => '')) + ' | 整页：' + (await body(lp)).slice(-260)); await shot('15-rework-quota', lp); }
    await lp.goto(base + '/workspace.html?new=1'); await lp.waitForSelector('#s-goal'); await lp.fill('#s-goal', '再写一份'); await lp.click('#s-go'); await lp.waitForTimeout(1500);
    const used = clean(await lp.locator('#s-error').innerText().catch(() => '')); rec('6 本月额度用完后新建任务的提示', null, used + ' | 确认框=' + await vis('#s-confirm[open]', lp)); await shot('16-quota-used-up', lp);
    rec('6 用完提示是否人话、不吓人（含“请联系管理员”、无英文/技术词）', /额度/.test(used) && /管理员/.test(used) && eng(used).length === 0 && !TECH.test(used), used);

    /* ---------- 7. admin: disable / reset password / session effects ---------- */
    page = ap; await ap.goto(base + '/admin.html'); await ap.click('#nav-users'); await ap.waitForSelector('#uBody tr[data-user]');
    ap.on('dialog', async d => { rec('5 停用时的确认框文字', null, d.message()); await d.accept(); });
    await ap.locator('#uBody tr', { hasText: 'xiaowang' }).locator('[data-u-act=toggle]').click(); await ap.waitForTimeout(1200);
    rec('5 管理员停用后的反馈', null, 'toast=' + clean(await ap.locator('#toast').innerText().catch(() => '')) + ' | 行：' + clean(await ap.locator('#uBody tr', { hasText: 'xiaowang' }).innerText())); await shot('17-admin-disabled');
    page = up; await up.goto(base + '/workspace.html'); await up.waitForTimeout(1500);
    rec('5 被停用的使用者下一次刷新看到什么', null, `地址=${up.url().replace(base, '')} | 文字=${(await body(up)).slice(0, 220)}`); await shot('18-disabled-user-sees', up);
    await up.goto(base + '/login.html'); await up.fill('#un', 'xiaowang'); await up.fill('#upw', PASSW); await up.click('#userBtn'); await up.waitForTimeout(1000);
    rec('5 被停用的使用者重新登录的提示', null, clean(await up.locator('#msg').innerText())); await shot('19-disabled-login', up);
    page = ap; await ap.locator('#uBody tr', { hasText: 'xiaowang' }).locator('[data-u-act=toggle]').click(); await ap.waitForTimeout(900);
    await ap.locator('#uBody tr', { hasText: 'xiaoli' }).locator('[data-u-act=pw]').click(); await ap.waitForSelector('#uPwNew'); await ap.fill('#uPwNew', 'brand-new-pass-77'); await ap.click('#uPwSave'); await ap.waitForTimeout(900);
    rec('5 管理员重置密码后的反馈', null, 'toast=' + clean(await ap.locator('#toast').innerText().catch(() => ''))); await shot('20-admin-pw-reset');
    page = lp; await lp.goto(base + '/workspace.html'); await lp.waitForTimeout(1500);
    rec('5 密码被重置后，该使用者原来的页面刷新看到', null, `地址=${lp.url().replace(base, '')} | 文字=${(await body(lp)).slice(0, 200)}`);

    /* ---------- 8. admin regression: 我的任务 / budget / PPT ---------- */
    await api('POST', '/api/models/' + localId + '/enable', {}); pptMode = true;
    page = ap; await ap.goto(base + '/workspace.html?new=1'); await ap.waitForSelector('#s-goal');
    rec('8 管理员顶栏入口', null, JSON.stringify(await ap.$$eval('#aij-topbar a, #aij-topbar button', ns => ns.map(n => n.textContent.trim()))));
    await ap.fill('#s-goal', '帮我做一份4页的店铺周末促销方案PPT'); await ap.check('input[name=s-output][value=ppt]'); await ap.fill('#s-budget-cny', '0.5'); await ap.click('#s-go'); await ap.waitForSelector('#s-confirm[open]', { timeout: 10000 });
    const ad = clean(await ap.innerText('#s-confirm')); rec('8 管理员确认框（预算 ¥0.5 + PPT）', /最多不超过 ¥0\.5/.test(ad), ad.slice(0, 240)); await ap.click('#s-confirm-ok');
    await ap.waitForSelector('#s-result:not([hidden]), #s-run-error:not([hidden])', { timeout: 40000 }); await ap.waitForTimeout(800);
    if (await vis('#s-download', ap)) { const [dl] = await Promise.all([ap.waitForEvent('download'), ap.click('#s-download')]); const f = path.join(OUT, 'admin.pptx'); await dl.saveAs(f); rec('8 管理员 PPT 下载', fs.statSync(f).size > 5000, dl.suggestedFilename() + ' ' + fs.statSync(f).size + ' 字节'); } else rec('8 管理员 PPT 下载', false, '无下载按钮：' + (await body(ap)).slice(-200));
    await ap.goto(base + '/workspace.html'); await ap.waitForTimeout(1500); rec('8 管理员“我的任务”', await vis('#home', ap), clean(await ap.locator('#home-sum').innerText().catch(() => ''))); await shot('21-admin-home');
    for (const u of ['/admin.html', '/capabilities.html', '/project-intake.html', '/panel.html']) { const r = await ap.goto(base + u); rec('8 管理员打开 ' + u, r.status() === 200, 'HTTP ' + r.status()); }

    /* ---------- 9. read-only screen & login pages ---------- */
    const anon = await browser.newContext({ viewport: { width: 1280, height: 860 } }); const anp = await anon.newPage(); page = anp;
    for (const u of ['/login.html', '/admin-login.html', '/panel.html', '/']) { const r = await anp.goto(base + u); await anp.waitForTimeout(700); rec('9 未登录打开 ' + u, null, `HTTP ${r.status()} → ${anp.url().replace(base, '')} | ${(await body(anp)).slice(0, 120)} | 英文词=${eng(await body(anp)).slice(0, 6).join(',') || '无'}`); }
    await shot('22-anon-login', anp);
  } catch (e) { rec('脚本异常', false, String(e && e.stack || e).slice(0, 700)); }
  finally { await browser.close(); await app.stop(); mock.close(); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ rows, shots, chats: chats.length }, null, 2)); console.log(`DONE rows=${rows.length} fail=${rows.filter(r => r.ok === false).length} mockCalls=${chats.length}`); }
})();
