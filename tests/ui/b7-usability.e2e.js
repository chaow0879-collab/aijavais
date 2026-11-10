'use strict';
/* B7 usability walkthrough in real Chromium against the real server, SQLite and a LOCAL MOCK
 * OpenAI-compatible provider (no paid API, no Secrets). Covers #10 [TASK_LIST] v2.1–v2.3:
 *  B7a connect-and-add-all with filtered counts + refresh; B7b auto abilities; B7c platform labels;
 *  B7d login lands on "＋ 新建任务" with a first-use guide; B7e/B7g one-click to the progress view
 *  with no English technical words or raw JSON on screen; B7f gate errors in Chinese with one-click
 *  fixes (cost 0 at HEAD reproduced) and a fixable checklist instead of raw JSON. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const H = require('../helpers');

const SHOTS = process.env.UI_SHOTS || null;
const LIST = ['deepseek-flash', 'deepseek-v4-pro', 'qwen3.7-flash', 'qwen3.7-flash-2026-07-15', 'text-embedding-v4', 'qwen3-tts-flash', 'kimi/kimi-k3', 'qwen3.8-27b'];
const KEEP = ['deepseek-flash', 'deepseek-v4-pro', 'qwen3.7-flash'];
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
// Visible-text scan: after removing model IDs and a short allowlist, no ASCII word of 3+ letters may remain.
// Vendor brand names are proper nouns (QA-B7-02 ruling); the HALOFLUX line is the upstream licence attribution
// that must be preserved (CLAUDE.md), so it is allowed verbatim and nothing else from it.
const BRANDS = ['Based on HALOFLUX by Ryder191 (modified)', 'Anthropic', 'Claude', 'OpenAI', 'ChatGPT', 'Google', 'Gemini', 'Kimi', 'GLM', 'SiliconFlow', 'Ollama', 'DeepSeek', 'HALOFLUX'];
const ALLOW = ['AIJAVAIS', 'Word', 'Excel', 'PPT', ...BRANDS, ...LIST];
function englishLeft(text) {
  let t = String(text);
  for (const w of [...ALLOW].sort((a, b) => b.length - a.length)) t = t.split(w).join(' ');
  // the panel truncates model labels to 12 characters: a fragment of a known model name is still a model name
  const words = (t.match(/[A-Za-z][A-Za-z_]{2,}/g) || []).filter(w => !LIST.some(id => id.toLowerCase().startsWith(w.toLowerCase())));
  const json = /[{[]\s*"[^"]*"\s*:/.test(text);
  return { words: [...new Set(words)], json };
}

(async () => {
  const chats = [];
  const mock = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/models$/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: LIST.map(id => ({ id })) })); }
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const j = JSON.parse(body || '{}'); chats.push(j.model);
      const text = j.max_tokens <= 32 ? '好' : '周末促销方案\n一、时间：周六、周日\n二、优惠：第二杯半价\n三、宣传：社区群与店内海报';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 40 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mp = mock.address().port;
  const app = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mp } });
  const base = 'http://localhost:' + app.port;
  // Chromium derives download filenames from the process locale; without UTF-8 it drops non-ASCII names.
  const browser = await chromium.launch({ headless: true, env: { ...process.env, LANG: process.env.LANG || 'C.UTF-8' }, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'b7-' + name + '.png'), fullPage: true }); } };
  try {
    /* ---- B7d: a real login lands on the workspace with "＋ 新建任务" and the two-step guide ---- */
    const fresh = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const lp = await fresh.newPage();
    await lp.goto(base + '/login.html');
    await lp.waitForSelector('#loginForm:not(.hidden)');
    check('login page shows no English technical words', async () => { const r = englishLeft(await lp.innerText('body')); assert.deepEqual(r.words, [], 'login: ' + r.words); });
    for (const [n, f] of checks.splice(0)) await f().then(() => checks.push([n, null]));
    await lp.fill('#pw', H.TEST_PASSWORD); await lp.click('#loginBtn');
    await lp.waitForURL(/\/workspace\.html/);
    await lp.waitForSelector('#s-go');
    assert.ok(await lp.isVisible('#s-newtask'), '＋ 新建任务 is visible after login');
    await lp.waitForSelector('#ws-guide:not([hidden])');
    checks.push(['B7d login lands on workspace; ＋ 新建任务 + two-step guide when no model', null]);
    // B7g fallback: no model yet -> guidance, not an error dump
    await lp.fill('#s-goal', '写一份方案'); await lp.click('#s-go');
    await lp.waitForSelector('#s-error:not([hidden])');
    assert.match(await lp.innerText('#s-error'), /还没有可用的模型/); assert.ok(await lp.isVisible('#s-error a[href="/admin.html"]'));
    checks.push(['B7g no model: Chinese guidance with a link to add a model', null]);
    await shot(lp, '1-first-use');

    /* ---- B7a/B7b/B7c: connect-and-add-all, filtered counts, refresh ---- */
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const ck = H.cookies.get(app.port).split('=');
    await ctx.addCookies([{ name: ck[0], value: ck.slice(1).join('='), domain: 'localhost', path: '/' }]);
    const page = await ctx.newPage();
    await page.goto(base + '/admin.html');
    await page.waitForSelector('#wProv option', { state: 'attached' });
    assert.ok(await page.isVisible('#newTaskBtn'), 'admin has ＋ 新建任务'); assert.ok(await page.isVisible('#guide'), 'admin shows the first-use guide');
    await page.selectOption('#wProv', 'custom');
    await page.evaluate(() => { document.querySelector('#wBase').closest('details').open = true; });
    await page.fill('#wBase', `http://127.0.0.1:${mp}/v1`);
    await page.fill('#wKey', 'mock-key-not-secret-1234');
    await page.click('#wAddAll');
    await page.waitForFunction(() => /已添加 \d+ 个/.test(document.querySelector('#wAllRes').textContent));
    assert.match(await page.innerText('#wAllRes'), new RegExp(`已添加 ${KEEP.length} 个，已自动跳过 ${LIST.length - KEEP.length} 个`));
    const saved = (await app.call('GET', '/api/models')).json.models;
    assert.deepEqual(saved.map(m => m.modelId).sort(), [...KEEP].sort());
    assert.ok(saved.every(m => ['reasoning', 'writing', 'chinese', 'data_analysis'].every(c => m.capabilities.includes(c))), 'B7b default abilities');
    assert.ok(saved.find(m => m.modelId === 'deepseek-v4-pro').capabilities.includes('long_context'));
    assert.ok(saved.every(m => m.hasKey && m.platformLabel === '自定义 · ' + m.modelId));
    assert.ok((await page.innerText('#mList')).includes('自定义 · deepseek-flash'), 'B7c label in model list');
    checks.push([`B7a add-all: added ${KEEP.length}, skipped ${LIST.length - KEEP.length} (non-chat, snapshot, marketplace, size); B7b abilities; B7c labels`, null]);
    await page.click('#wRefresh');
    await page.waitForFunction(() => /以前已添加/.test(document.querySelector('#wAllRes').textContent));
    assert.match(await page.innerText('#wAllRes'), new RegExp(`已添加 0 个.*${KEEP.length} 个以前已添加`));
    checks.push(['B7a refresh reuses the saved key and adds only new models', null]);
    /* QA-B7-02: the add-model page and the edit dialog show plain Chinese (brands and model names aside) */
    await page.evaluate(() => { document.querySelector('#wBase').closest('details').open = false; }); // the test opened 高级 only to point at the MOCK
    assert.deepEqual(englishLeft(await page.innerText('body')).words, [], 'admin models page');
    await page.click('#mList button:has-text("编辑") >> nth=0'); await page.waitForSelector('#modal.on');
    const edit = await page.innerText('#modalBox');
    assert.deepEqual(englishLeft(edit).words, [], 'edit dialog'); assert.match(edit, /单价：每百万字约多少/); assert.doesNotMatch(edit, /Token|API|Key/);
    await page.click('#modal', { position: { x: 5, y: 5 } });
    checks.push(['QA-B7-02 admin add-model page and edit dialog: no English technical words; price shown per million characters', null]);
    await shot(page, '2-add-all');

    /* ---- prices: two models priced by the administrator, one left unknown (must be skipped, never called) ---- */
    const byModel = Object.fromEntries((await app.call('GET', '/api/models')).json.models.map(m => [m.modelId, m.connectionId]));
    for (const id of ['deepseek-flash', 'qwen3.7-flash']) assert.equal((await app.call('PUT', '/api/models/' + byModel[id], { price: { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 3 } })).status, 200);
    assert.equal((await app.call('PUT', '/api/models/' + byModel['deepseek-flash'], { price: { currency: 'EUR', inputPerMillion: 1, outputPerMillion: 3 } })).status, 400, 'invalid price rejected');

    /* ---- B7e/B7g: three answers -> one RMB-only confirmation -> progress view, plain Chinese only ---- */
    await page.goto(base + '/workspace.html');
    await page.waitForSelector('#s-go');
    assert.ok(await page.isHidden('#ws-guide'), 'guide hides once a model exists');
    assert.equal(await page.$('input[name=s-budget]'), null, 'simple mode has no budget, token or model options');
    await page.fill('#s-goal', '给社区咖啡店写一份周末促销方案');
    await page.check('input[name=s-output][value=word]');
    await page.fill('#s-deadline', '本周五前');
    await page.click('#s-preview');
    await page.waitForSelector('#s-plan:not([hidden])');
    const team1 = await page.innerText('#s-plan-team');
    assert.match(team1, /起草员 → 自定义 · deepseek-flash（便宜快速）｜审核员 → 自定义 · qwen3.7-flash（便宜快速）/);
    assert.match(await page.innerText('#s-plan-note'), /价格未知，按规定不调用，已换成其它模型：自定义 · deepseek-v4-pro/);
    await page.click('#s-swap button >> nth=0');
    assert.notEqual(await page.innerText('#s-plan-team'), team1, '换一个 changes the assignment');
    await page.click('#s-swap button >> nth=0');
    checks.push(['B7g preview: rule-based assignment in plain words; unknown-price model skipped and named; 换一个 works', null]);
    for (const sel of ['#simple']) { const r = englishLeft(await page.innerText(sel)); assert.deepEqual(r.words, [], 'simple form: ' + r.words); assert.equal(r.json, false); }
    await shot(page, '3-simple');
    await page.click('#s-go');
    await page.waitForSelector('#s-confirm[open]');
    const dlgText = await page.innerText('#s-confirm');
    assert.match(dlgText, /预计花费约 ¥\d+\.\d{2}，最多不超过 ¥\d+\.\d{2}，超过会自动停下。/);
    assert.doesNotMatch(dlgText, /\$|USD|美元|Token|token/, 'confirmation shows RMB only');
    assert.deepEqual(englishLeft(dlgText).words, []);
    checks.push(['B7e one confirmation in RMB only: 预计约 ¥X，最多不超过 ¥Y，超过会自动停下', null]);
    await shot(page, '3b-confirm');
    await page.click('#s-confirm-ok');
    await page.waitForSelector('#s-progress:not([hidden])');
    await page.waitForSelector('#s-result:not([hidden])', { timeout: 30000 });
    assert.match(await page.innerText('#s-team'), /团队：起草员 → .*｜审核员 → /);
    assert.match(await page.innerText('#s-steps'), /写出初稿 · 已完成[\s\S]*审核并定稿 · 已完成/);
    assert.match(await page.innerText('#s-final'), /周末促销方案/);
    const whole = englishLeft(await page.innerText('body'));
    assert.deepEqual(whole.words, [], 'progress page shows English words: ' + whole.words); assert.equal(whole.json, false, 'no raw JSON');
    checks.push(['B7g one click -> confirm -> progress view -> steps done; whole page has no English technical words or raw JSON', null]);
    const full0 = (await app.call('GET', '/api/v2/runs/' + (await page.evaluate(() => new URLSearchParams(location.search).get('run'))))).json.run;
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#s-download')]);
    const docx = fs.readFileSync(await dl.path());
    assert.equal(docx.subarray(0, 2).toString(), 'PK', 'real DOCX (zip)'); assert.match(dl.suggestedFilename(), /\.docx$/);
    /* QA-B7-01: rework stays in simple mode — plain feedback, a fresh RMB confirmation, review step only */
    const callsBefore = chats.length;
    await page.click('#s-rework'); await page.fill('#s-rework-text', '语气再活泼一些，加上会员日优惠');
    assert.deepEqual(englishLeft(await page.innerText('#s-progress')).words, []);
    await page.click('#s-rework-go');
    await page.waitForSelector('#s-confirm[open]');
    const rwText = await page.innerText('#s-confirm');
    assert.match(rwText, /确认修改[\s\S]*预计花费约 ¥\d+\.\d{2}，最多不超过 ¥\d+\.\d{2}，超过会自动停下。/); assert.doesNotMatch(rwText, /\$|USD|美元|Token/);
    assert.deepEqual(englishLeft(rwText).words, []);
    await shot(page, '4b-rework-confirm');
    await page.click('#s-confirm-ok');
    await page.waitForFunction(() => !document.querySelector('#s-result').hidden && /已完成，请查看成果/.test(document.querySelector('#s-state').textContent), null, { timeout: 30000 });
    assert.equal(chats.length - callsBefore, 1, 'rework reran only the review step: ' + JSON.stringify(chats.slice(callsBefore)));
    const rwRun = (await app.call('GET', '/api/v2/runs/' + (await page.evaluate(() => new URLSearchParams(location.search).get('run'))))).json.run;
    assert.equal(rwRun.round, 2); assert.equal(rwRun.reviews.at(-1).decision, 'rework'); assert.equal(rwRun.approval.approvePaid, true);
    assert.ok(rwRun.approval.maxCost > 0 && rwRun.approval.approvedAt > full0.approval.approvedAt, 'a new approval for the rework round');
    assert.deepEqual(englishLeft(await page.innerText('body')).words, []);
    checks.push(['QA-B7-01 rework in simple mode: plain feedback -> new RMB confirmation -> review step rerun, no expert form', null]);
    await page.click('#s-accept'); await page.waitForFunction(() => /已确认完成/.test(document.querySelector('#s-state').textContent));
    checks.push(['B7e chosen output (Word) downloads as a real DOCX; confirm completes the run', null]);
    const lastRun = async () => { const ps = (await app.call('GET', '/api/v2/projects')).json.projects; const pr = ps.sort((a, b) => b.createdAt - a.createdAt)[0]; const r = (await app.call('GET', '/api/v2/projects/' + pr.projectId)).json.runs[0]; return (await app.call('GET', '/api/v2/runs/' + r.runId)).json.run; };
    const full = await lastRun();
    assert.equal(full.approval.approvePaid, true); assert.ok(full.approval.maxCost > 0 && full.approval.maxCost <= 5 / 7.5, 'USD cap derived from the RMB maximum, within the ¥5 per-run cap');
    assert.ok(Object.values(full.approval.prices).every(p => Math.abs(p.inputPerMillion - 1 / 7.5) < 1e-9 && Math.abs(p.outputPerMillion - 3 / 7.5) < 1e-9), 'RMB unit prices converted at the fixed rate');
    assert.ok(!Object.keys(full.approval.prices).includes(byModel['deepseek-v4-pro']), 'unknown-price model not in the run');
    assert.equal(full.approval.approveExternalTools, false); assert.deepEqual(full.approval.allowedTools, []);
    assert.ok(full.usage.cost <= full.approval.maxCost);
    checks.push(['budget gate kept: explicit per-run approval, USD cap and rates from the RMB confirmation, MCP/code off', null]);
    await shot(page, '4-progress');
    /* QA-B7-03: HALOFLUX keeps its look; every label has a Chinese primary text (English only as small .en sub-labels) */
    const panel = await ctx.newPage();
    await panel.goto(base + '/'); await panel.waitForTimeout(4500);
    await panel.addStyleTag({ content: '.en{display:none!important}' });
    const panelText = (await panel.innerText('body')).split('Based on HALOFLUX by Ryder191 (RYDER CODE / Ms MAIKEBAIs CAT) · github.com/Ryder191/haloflux · modified').join(' ');
    assert.deepEqual(englishLeft(panelText).words, [], 'HALOFLUX primary labels');
    assert.match(panelText, /接入模型[\s\S]*用量[\s\S]*错误[\s\S]*事件流/);
    assert.ok(await panel.$('.ov.credit'), 'upstream attribution still shown');
    await panel.close();
    checks.push(['QA-B7-03 HALOFLUX: Chinese primary labels after a real run (English kept as small sub-labels), attribution kept', null]);
    await page.click('#s-adjust');
    await page.waitForSelector('#simple:not([hidden])');
    assert.equal(await page.inputValue('#s-goal'), '给社区咖啡店写一份周末促销方案'); await page.waitForSelector('#s-plan:not([hidden])');
    assert.equal(await page.isVisible('#project-name'), false, '调整团队 stays in simple mode');
    checks.push(['QA-B7-04 调整团队 returns to the simple form prefilled (expert form not on the ordinary path)', null]);

    /* ---- B7e: over the per-run cap -> 效果优先 / 省钱, no silent downgrade; money runs out -> stop, keep finished work ---- */
    assert.equal((await app.call('PUT', '/api/models/' + byModel['deepseek-v4-pro'], { price: { currency: 'CNY', inputPerMillion: 40, outputPerMillion: 160 } })).status, 200);
    assert.equal((await app.call('POST', '/api/settings', { simpleRunCapCny: 0.2 })).status, 200);
    await page.fill('#s-goal', '再写一份周末促销方案');
    await page.click('#s-go');
    await page.waitForSelector('#s-confirm[open]');
    const choiceText = await page.innerText('#s-confirm');
    assert.match(choiceText, /效果优先 约¥\d+\.\d{2}，最多 ¥0\.20，可能中途停下。起草员 → .*审核员 → 自定义 · deepseek-v4-pro/);
    assert.match(choiceText, /省钱 约¥\d+\.\d{2}（效果可能稍差）/);
    assert.equal(await page.isChecked('input[name=s-choice][value=quality]'), true, 'quality is the default');
    assert.doesNotMatch(choiceText, /\$|USD|美元/);
    await shot(page, '5-choice');
    await page.click('#s-confirm-ok');
    await page.waitForSelector('#s-stop:not([hidden])', { timeout: 30000 });
    const stopText = await page.innerText('#s-stop');
    assert.match(stopText, /已完成 1\/2 步，花了约 ¥\d+\.\d{2}/); assert.match(stopText, /没有超支/);
    const stopped = await lastRun();
    assert.equal(Object.values(stopped.approval.prices).length, 2);
    assert.ok(Object.keys(stopped.approval.prices).includes(byModel['deepseek-v4-pro']), 'quality choice kept the strong reviewer (no silent downgrade)');
    assert.ok(stopped.usage.cost <= stopped.approval.maxCost + 1e-12, 'never above the confirmed maximum');
    assert.ok(stopped.steps.some(s => s.status === 'done'));
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#s-stop-download')]);
    assert.equal(fs.readFileSync(await dl2.path()).subarray(0, 2).toString(), 'PK', 'finished part downloads as a real file');
    assert.ok(await page.isDisabled('#s-stop-more'), '追加 is a visible placeholder only');
    assert.deepEqual(englishLeft(await page.innerText('body')).words, []);
    checks.push(['B7e over cap: 效果优先(default)/省钱 offered, no silent downgrade; ran out -> stopped at 1/2, within the confirmed max, finished part downloadable', null]);
    await shot(page, '6-stopped');
    assert.equal((await app.call('POST', '/api/settings', { simpleRunCapCny: 5 })).status, 200);

    /* ---- B7f: advanced form, cost 0 (owner's screenshot) -> reason next to the button + fixes ---- */
    const tested = (await app.call('GET', '/api/models')).json.models.find(m => m.status === 'available');
    await page.goto(base + '/workspace.html');
    await page.waitForSelector('#s-advanced');
    await page.click('#s-advanced');
    await page.fill('#project-name', '高级模式复现'); await page.fill('#project-description', '费用上限为 0 时点击开始执行');
    for (const s of await page.$$('#roles-editor select')) await s.selectOption(tested.connectionId);
    assert.ok((await page.$$eval('#roles-editor select option', o => o.map(x => x.textContent))).some(t => t.startsWith('自定义 · ')), 'B7c label in role picker');
    assert.equal(await page.isVisible('#max-tokens'), false, 'Token cap folded under 专业设置'); assert.equal(await page.isVisible('#max-cost'), false, 'USD cap folded under 专业设置');
    assert.ok(await page.isVisible('#max-cost-cny'), 'RMB is the primary amount');
    await page.fill('#max-cost-cny', '2'); assert.equal(await page.inputValue('#max-cost'), String(Math.floor(2 / 7.5 * 100) / 100), 'RMB converts to the USD cap');
    await page.fill('#max-cost-cny', '0'); await page.check('#approve-paid');
    await page.click('#start-run');
    await page.waitForSelector('#start-error:not([hidden])');
    const box = await page.$eval('#start-error', e => { const r = e.getBoundingClientRect(); return { text: e.innerText, inView: r.top >= 0 && r.bottom <= innerHeight }; });
    assert.match(box.text, /预算为 0/); assert.ok(box.inView, 'error is next to the button, inside the viewport');
    assert.deepEqual(englishLeft(box.text).words, []);
    await shot(page, '5-cost-zero');
    const seen = [box.text.split('\n')[0]];
    for (let i = 0; i < 3 && !(await page.isVisible('#panel-run')); i++) {
      await page.click('#start-error button');
      await page.waitForFunction(() => !document.querySelector('#panel-run').hidden || !document.querySelector('#start-error').hidden);
      await page.waitForTimeout(300);
      if (await page.isVisible('#start-error')) { const t = await page.innerText('#start-error'); seen.push(t.split('\n')[0] + ' [' + (await page.$eval('#start-error', e => e.textContent)).slice(-160) + ']'); assert.deepEqual(englishLeft(t).words, [], 'fix step shows English: ' + t); }
    }
    assert.ok(await page.isVisible('#panel-run'), 'run view opens after the fixes: ' + seen.join(' -> '));
    checks.push(['B7f cost 0: ' + seen.join(' -> ') + ' -> run view opens', null]);
    checks.push(['QA-B7-04 expert form: RMB primary amount, Token/USD folded under 专业设置 and kept in sync', null]);

    /* ---- B7f: execution check shows a Chinese checklist with fixes, never raw JSON ---- */
    const proj = (await app.call('POST', '/api/v2/projects', { name: '能力检查', description: '岗位需要资料研究能力', roles: [{ roleId: 'analyst', name: '研究员', duty: '研究', connectionId: tested.connectionId, requiredCapabilities: ['research'] }], steps: [{ stepId: 's1', roleId: 'analyst', title: '研究' }] })).json.project;
    await page.goto(base + '/workspace.html?project=' + proj.projectId);
    await page.waitForSelector('#validate-project');
    await page.click('#validate-project');
    await page.waitForSelector('#validation-list .alert');
    const list = await page.innerText('#validation-list');
    assert.match(list, /岗位「研究员」需要的能力，自定义 · \S+ 还没有登记：资料研究/);
    assert.equal(await page.isVisible('#validation-text'), false, 'raw JSON stays hidden');
    assert.equal(englishLeft(list).json, false);
    await page.click('#validation-list button:has-text("补充能力")');
    await page.waitForSelector('#validation-list >> text=执行条件都满足了');
    assert.ok((await app.call('GET', '/api/models')).json.models.find(m => m.connectionId === tested.connectionId).capabilities.includes('research'));
    checks.push(['B7f checklist: capability_missing shown in Chinese with one-click fix, auto re-check passes', null]);
    await shot(page, '6-checklist');
  } finally { await browser.close(); await app.stop(); mock.close(); }
  for (const [n] of checks) console.log('PASS ' + n);
  console.log(`B7 UI checks: ${checks.length} passed, 0 failed; mock chat calls ${chats.length}`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
