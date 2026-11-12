'use strict';
/* B8 前后台分离 in real Chromium against the real server + SQLite and a LOCAL MOCK model (no paid API, no real money).
 *  admin: back-end login page says 这是管理后台 → 使用者 page: add a user, set a monthly cap, disable, reset password
 *  user:  front login → only 我的任务 / ＋ 新建任务 / 实时大屏 / 退出, no back-end entry anywhere → creates a task end to end
 *         → back-end pages answer 403 → cap used up → plain "本月额度已用完，请联系管理员", no task created
 *  two users never see each other's tasks */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const H = require('../helpers');

const SHOTS = process.env.UI_SHOTS || null;
const results = [];
const ok = name => { results.push(name); console.log('PASS', name); };
const PASS = 'user-password-123';
(async () => {
  let hold = false; const held = [];
  const mock = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const j = JSON.parse(body || '{}');
      const reply = j.max_tokens <= 32 ? '好' : '周末促销方案：一、活动主题；二、优惠内容；三、宣传渠道；四、预算与分工。内容完整，可以直接使用。';
      const send = () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n'); };
      if (hold && j.max_tokens > 32 && !JSON.stringify(j.messages || '').includes('你是任务助理')) held.push(send); else send(); // B9b: the pre-start clarification is not held // AUD-C159-01 case keeps a rework round running
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mp = mock.address().port;
  const app = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mp }, login: false });
  const base = 'http://localhost:' + app.port;
  const browser = await chromium.launch({ headless: true, env: { ...process.env, LANG: process.env.LANG || 'C.UTF-8' }, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'b8-' + name + '.png'), fullPage: false }); } };
  const visibleBackendLinks = page => page.evaluate(() => [...document.querySelectorAll('a,button')].filter(n => n.offsetParent !== null || getComputedStyle(n).position === 'fixed')
    .filter(n => /admin|capabilities|project-intake/.test(n.getAttribute('href') || '') || /模型设置|管理中心|能力中心|智能立项|高级设置|管理后台/.test(n.textContent)).map(n => n.textContent.trim() || n.getAttribute('href')));
  /* QA-B8-01: a user never reads back-end words anywhere on the page (footer, empty list, errors) */
  const BACKEND_WORDS = /管理中心|智能立项|能力中心|密钥|模型设置|管理后台|高级设置/;
  const backendWords = async page => (await page.innerText('body')).match(new RegExp(BACKEND_WORDS.source, 'g')) || [];
  try {
    /* ---------------- admin: separate back-end login ---------------- */
    const ac = await browser.newContext({ viewport: { width: 1280, height: 860 } }), ap = await ac.newPage();
    await ap.goto(base + '/admin.html');
    await ap.waitForURL(/\/admin-login\.html\?next=/);
    await ap.waitForSelector('#setupForm:not(.hidden)');
    assert.match(await ap.innerText('#admin-tag'), /这是管理后台/);
    const code = /([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(fs.readFileSync(path.join(app.dir, 'setup-code.txt'), 'utf8'))[1];
    await ap.fill('#code', code); await ap.fill('#np', H.TEST_PASSWORD); await ap.fill('#np2', H.TEST_PASSWORD); await ap.click('#setupBtn');
    await ap.waitForURL(/\/admin\.html/);
    ok('admin: back-end pages go to the separate admin login, which says 这是管理后台');
    const adminCookie = (await ac.cookies()).find(c => c.name === 'aij_session');
    H.cookies.set(app.port, 'aij_session=' + adminCookie.value);
    const add = await app.call('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mp}/v1`, modelId: 'local-writer', displayName: '本地写手', pricingMode: 'local', capabilities: ['writing', 'reasoning'] });
    assert.equal(add.status, 200, add.text); const localId = add.json.connection.connectionId;
    assert.equal((await app.call('POST', '/api/models/' + localId + '/test', {})).json.ok, true);
    const paid = await app.call('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mp}/v1`, modelId: 'priced-writer', displayName: '收费写手', pricingMode: 'paid_api', capabilities: ['writing', 'reasoning'], price: { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 1 } });
    const paidId = paid.json.connection.connectionId;
    assert.equal((await app.call('POST', '/api/models/' + paidId + '/test', { approvePaid: true })).json.ok, true);
    await app.call('POST', '/api/models/' + paidId + '/disable', {});

    /* admin 使用者 page */
    await ap.reload(); await ap.click('#nav-users');
    await ap.waitForSelector('#pane-users.on');
    // QA-B8-03: a blank monthly cap is refused with a plain sentence, never silently ¥0
    await ap.fill('#uName', 'kongbai'); await ap.fill('#uPw', PASS); await ap.fill('#uCap', ''); await ap.click('#uAdd');
    await ap.waitForFunction(() => /请填每月上限（元）。填 0 表示这个人不能用收费模型。/.test(document.querySelector('#uRes').textContent));
    assert.equal((await app.call('GET', '/api/v2/users')).json.users.length, 0, 'nothing created');
    assert.equal((await app.call('POST', '/api/v2/users', { username: 'kongbai', password: PASS, monthlyCapCny: '' })).json.code, 'cap_required', 'the server refuses a blank cap too');
    for (const [name, cap] of [['xiaowang', '5'], ['xiaoli', '5']]) {
      await ap.fill('#uName', name); await ap.fill('#uPw', PASS); await ap.fill('#uCap', cap); await ap.click('#uAdd');
      await ap.waitForFunction(n => [...document.querySelectorAll('#uBody tr')].some(r => r.cells[0].textContent === n), name);
    }
    const row = ap.locator('#uBody tr', { hasText: 'xiaowang' });
    assert.match(await row.innerText(), /正常[\s\S]*¥5\.00[\s\S]*¥0\.00[\s\S]*¥5\.00/);
    await shot(ap, '1-admin-users');
    ok('admin 使用者 page: add users with a monthly ¥ cap; list shows status, cap, this month spent and remaining');

    /* ---------------- user: front login, only four entries ---------------- */
    const uc = await browser.newContext({ viewport: { width: 1280, height: 860 } }), up = await uc.newPage();
    await up.goto(base + '/workspace.html');
    await up.waitForURL(/\/login\.html\?next=/);
    assert.ok(await up.isVisible('#un'), 'front login asks for a username');
    await up.fill('#un', 'xiaowang'); await up.fill('#upw', 'wrong-password-1'); await up.click('#userBtn');
    await up.waitForFunction(() => /用户名或密码不正确/.test(document.querySelector('#msg').textContent));
    await up.fill('#upw', PASS); await up.click('#userBtn');
    await up.waitForURL(/\/workspace\.html/);
    await up.waitForSelector('#aij-topbar[data-role=user]');
    await up.waitForFunction(() => document.body.dataset.role === 'user');
    const entries = await up.$$eval('#aij-topbar a, #aij-topbar button', ns => ns.map(n => n.textContent.trim()));
    assert.deepEqual(entries, ['我的任务', '＋ 新建任务', '实时大屏', '退出']);
    await up.waitForSelector('#home:not([hidden])');
    assert.deepEqual(await visibleBackendLinks(up), [], 'no back-end entry on the task center');
    assert.deepEqual(await backendWords(up), [], 'QA-B8-01: no back-end words on the task center');
    await shot(up, '2-user-home');
    ok('user: front login with username; top bar only 我的任务 / ＋ 新建任务 / 实时大屏 / 退出; no back-end entry');

    /* user creates a task end to end (free local mock) */
    await up.click('#aij-new'); await up.waitForSelector('#s-go');
    assert.deepEqual(await visibleBackendLinks(up), [], 'no back-end entry on the new-task form');
    assert.deepEqual(await backendWords(up), [], 'QA-B8-01: no back-end words on the new-task form');
    await up.fill('#s-goal', '给社区咖啡店写一份周末促销方案');
    await up.click('#s-go');
    await up.waitForSelector('#s-confirm[open]');
    assert.match(await up.innerText('#s-confirm'), /你本月额度还剩 ¥5\.00（每月上限 ¥5\.00，由管理员设置）/);
    assert.doesNotMatch(await up.innerText('#s-confirm'), /只重做/, 'QA-B8-02: no rework sentence when confirming a new task');
    const MODEL_NAMES = /local-writer|priced-writer|本地写手|收费写手|Ollama|本地模型 ·/;
    assert.doesNotMatch(await up.innerText('#s-confirm'), MODEL_NAMES, 'P3-1: the confirmation names roles, not models');
    assert.match(await up.innerText('#s-confirm'), /团队：起草员（[^）]+）｜审核员（/);
    await up.click('#s-confirm-ok');
    await up.waitForSelector('#s-result:not([hidden])', { timeout: 30000 });
    assert.deepEqual(await visibleBackendLinks(up), [], 'no back-end entry on the progress page');
    assert.deepEqual(await backendWords(up), [], 'QA-B8-01: no back-end words on the progress page');
    assert.doesNotMatch(await up.innerText('body'), MODEL_NAMES, 'P3-1: no model names on the user\'s progress page');
    await shot(up, '3-user-result');
    ok('user: new task → RMB confirmation (with remaining monthly quota) → result, all in the front end');

    /* back-end pages answer 403; the live screen has no 管理中心 entry */
    for (const u of ['/admin.html', '/capabilities.html', '/project-intake.html']) {
      const r = await up.goto(base + u); assert.equal(r.status(), 403, u);
    }
    // QA-B8 P3-2: the 403 page is readable and leads back to my tasks
    assert.match(await up.innerText('h1'), /这是管理后台，使用者账号不能访问/);
    await up.click('#back'); await up.waitForURL(/\/workspace\.html/); await up.waitForSelector('#aij-topbar[data-role=user]');
    await up.goto(base + '/panel.html');
    await up.waitForSelector('#aij-topbar[data-role=user]');
    await up.waitForFunction(() => document.body.dataset.role === 'user');
    assert.equal(await up.isVisible('a.ov.adm'), false, 'live screen: 管理中心 hidden for a user');
    assert.deepEqual(await up.$$eval('#aij-topbar a, #aij-topbar button', ns => ns.map(n => n.textContent.trim())), ['我的任务', '＋ 新建任务', '实时大屏', '退出']);
    ok('user: /admin.html, /capabilities.html, /project-intake.html answer 403; live screen has the same four entries and no 管理中心');

    /* another user never sees this task */
    const lc = await browser.newContext({ viewport: { width: 1280, height: 860 } }), lp = await lc.newPage();
    await lp.goto(base + '/login.html'); await lp.fill('#un', 'xiaoli'); await lp.fill('#upw', PASS); await lp.click('#userBtn');
    await lp.waitForURL(/\/workspace\.html/); await lp.waitForSelector('#home-empty:not([hidden])');
    await lp.waitForFunction(() => /还没有任务/.test(document.querySelector('#projects')?.textContent || ''));
    assert.deepEqual(await backendWords(lp), [], 'QA-B8-01: empty task list does not point to 智能立项');
    assert.doesNotMatch(await lp.innerText('body'), /咖啡店/);
    ok('two users: the second user sees an empty task list, not the first user\'s task');

    /* AUD-C159-01: a paid run created (and billed) last month, reworked now, counts in this month:
     * the new-task confirmation shows the remaining quota reduced by the rework round's approved ceiling */
    await app.call('POST', '/api/models/' + localId + '/disable', {}); await app.call('POST', '/api/models/' + paidId + '/enable', {});
    await up.goto(base + '/workspace.html?new=1'); await up.waitForSelector('#s-go');
    await up.fill('#s-goal', '写一份会员招募文案'); await up.click('#s-go');
    await up.waitForSelector('#s-confirm[open]'); await up.click('#s-confirm-ok');
    await up.waitForSelector('#s-result:not([hidden])', { timeout: 30000 });
    const oldRun = (await app.call('GET', '/api/v2/tasks')).json.tasks.find(x => x.name === '写一份会员招募文案').runId;
    const lastMonth = require('../../lib/users').monthStart(Date.now()) - 10 * 86400e3;
    const db = new DatabaseSync(path.join(app.dir, 'projects.sqlite')); db.exec('PRAGMA busy_timeout=5000');
    db.prepare("UPDATE runs SET created_at=?, doc=json_set(doc,'$.createdAt',?) WHERE id=?").run(lastMonth, lastMonth, oldRun);
    db.prepare("UPDATE usage_ledger SET created_at=?, doc=json_set(doc,'$.createdAt',?) WHERE run_id=?").run(lastMonth, lastMonth, oldRun);
    // B9b: the task's pre-start clarification (system_usage, purpose clarify) happened together with it
    db.prepare("UPDATE system_usage SET created_at=?, doc=json_set(doc,'$.createdAt',?) WHERE json_extract(doc,'$.purpose')='clarify'").run(lastMonth, lastMonth);
    db.close();
    const wangSpent = async () => (await app.call('GET', '/api/v2/users')).json.users.find(u => u.username === 'xiaowang').month.spentCny;
    assert.equal(await wangSpent(), 0, 'last month\'s billing is not this month\'s');
    hold = true;
    await up.click('#s-rework'); await up.fill('#s-rework-text', '再精炼一些，突出会员福利'); await up.click('#s-rework-go');
    await up.waitForSelector('#s-confirm[open]');
    assert.match(await up.innerText('#s-confirm'), /你本月额度还剩 ¥5\.00/);
    assert.match(await up.innerText('#s-confirm'), /只重做“审核并定稿”这一步/, 'the rework confirmation keeps its own sentence');
    await up.click('#s-confirm-ok');
    let reworkRun;
    for (let i = 0; i < 100; i++) { reworkRun = (await app.call('GET', '/api/v2/runs/' + oldRun)).json.run; if (reworkRun.round === 2 && reworkRun.executionActive) break; await new Promise(r => setTimeout(r, 50)); }
    assert.equal(reworkRun.round, 2);
    const ceiling = Math.ceil(reworkRun.approval.maxCost * 7.5 * 100 - 1e-6) / 100, spentNow = await wangSpent();
    assert.ok(ceiling > 0); assert.equal(spentNow, ceiling, 'the running rework round counts its whole approved ceiling this month');
    await up.goto(base + '/workspace.html?new=1'); await up.waitForSelector('#s-go');
    await up.fill('#s-goal', '再写一份新品试吃活动方案'); await up.click('#s-go');
    await up.waitForSelector('#s-confirm[open], #s-error:not([hidden])');
    const left = (5 - ceiling).toFixed(2);
    assert.match(await up.isVisible('#s-confirm[open]') ? await up.innerText('#s-confirm') : await up.innerText('#s-error'), new RegExp('¥' + left.replace('.', '\\.')));
    await shot(up, '4a-user-rework-quota');
    if (await up.isVisible('#s-confirm[open]')) await up.click('#s-confirm-cancel');
    hold = false; held.splice(0).forEach(f => f());
    for (let i = 0; i < 100; i++) { const r = (await app.call('GET', '/api/v2/runs/' + oldRun)).json.run; if (!r.executionActive && r.status !== 'running') break; await new Promise(r2 => setTimeout(r2, 50)); }
    ok('AUD-C159-01: reworking last month\'s run counts this month; the new-task page shows ¥' + left + ' left, not ¥5.00');

    /* cap used up: only the priced model is available, cap set to the amount already spent (¥0) */
    await app.call('POST', '/api/models/' + localId + '/disable', {}); await app.call('POST', '/api/models/' + paidId + '/enable', {});
    const users = (await app.call('GET', '/api/v2/users')).json.users, wang = users.find(u => u.username === 'xiaowang');
    // QA-B8 P3-5: only ¥0.02 left -> said before any confirmation (no dialog that promises "最多 ¥0.10" first)
    await app.call('POST', '/api/v2/users/' + wang.userId, { monthlyCapCny: Math.round(wang.month.spentCny * 100 + 2) / 100 });
    const before = (await app.call('GET', '/api/v2/projects')).json.projects.length;
    await up.goto(base + '/workspace.html?new=1'); await up.waitForSelector('#s-go');
    await up.fill('#s-goal', '写一份会员日活动方案'); await up.click('#s-go');
    await up.waitForSelector('#s-error:not([hidden])');
    assert.match(await up.innerText('#s-error'), /^本月额度只剩 ¥0\.02，这次最多要花 ¥\d+\.\d{2}。请把预算改到 ¥0\.02 以内，或联系管理员/);
    assert.equal(await up.isVisible('#s-confirm[open]'), false, 'P3-5: no confirmation dialog when the quota cannot cover it');
    assert.equal((await app.call('GET', '/api/v2/projects')).json.projects.length, before, 'no task was created');
    await app.call('POST', '/api/v2/users/' + wang.userId, { monthlyCapCny: 0 });
    await up.goto(base + '/workspace.html?new=1'); await up.waitForSelector('#s-go');
    await up.fill('#s-goal', '再写一份会员日活动方案'); await up.click('#s-go');
    await up.waitForSelector('#s-error:not([hidden])');
    assert.match(await up.innerText('#s-error'), /本月额度已用完，请联系管理员/);
    assert.equal(await up.isVisible('#s-confirm[open]'), false);
    assert.equal((await app.call('GET', '/api/v2/projects')).json.projects.length, before, 'no task was created');
    await shot(up, '4-user-quota');
    ok('cap used up: plain 本月额度已用完，请联系管理员, no task created');

    /* admin: disable → the user is logged out at once; reset password works */
    await ap.click('#nav-users'); await ap.reload(); await ap.click('#nav-users');
    ap.once('dialog', d => d.accept());
    await ap.locator('#uBody tr', { hasText: 'xiaoli' }).locator('button[data-u-act=toggle]').click();
    await ap.waitForFunction(() => [...document.querySelectorAll('#uBody tr')].some(r => /xiaoli/.test(r.textContent) && /已停用/.test(r.textContent)));
    await lp.reload(); await lp.waitForURL(/\/login\.html/);
    await lp.waitForFunction(() => /登录已失效：可能是登录时间到了，或者管理员停用了这个账号、重置了密码/.test(document.querySelector('#msg').textContent)); // QA-B8 P3-4
    await ap.locator('#uBody tr', { hasText: 'xiaowang' }).locator('button[data-u-act=pw]').click();
    await ap.fill('#uPwNew', 'brand-new-password-9'); await ap.click('#uPwSave');
    await ap.waitForFunction(() => !document.querySelector('#modal').classList.contains('on') && /密码已重置/.test(document.querySelector('#toast').textContent));
    await up.goto(base + '/workspace.html'); await up.waitForURL(/\/login\.html/);
    await up.fill('#un', 'xiaowang'); await up.fill('#upw', 'brand-new-password-9'); await up.click('#userBtn'); await up.waitForURL(/\/workspace\.html/);
    ok('admin: disabling logs the user out at once; reset password ends old sessions and the new password works');

    /* user logout from the top bar; admin can still use the front end with the admin top bar */
    await up.waitForSelector('#aij-logout'); await up.click('#aij-logout'); await up.waitForURL(/\/login\.html/);
    await ap.goto(base + '/workspace.html'); await ap.waitForSelector('#aij-models');
    assert.equal(await ap.isVisible('#aij-models'), true, 'admin top bar keeps 模型设置');
    ok('user 退出 returns to the front login; the administrator can still enter the front end');
  } finally {
    await browser.close(); await app.stop(); mock.close();
  }
  console.log(`\nB8 前后台分离 e2e: ${results.length} checks passed`);
  if (results.length !== 10) { console.error('expected 10 checks'); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
