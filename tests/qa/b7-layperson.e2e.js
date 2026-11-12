'use strict';
/* QA-B7 independent layperson walkthrough (ProductQA). Real server.js + SQLite + real Chromium,
 * LOCAL MOCK OpenAI-compatible provider only (evidence level E3). No paid calls, no Secrets.
 * Findings are collected (not asserted) so one defect does not hide the next. Output: findings.json + screenshots. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const H = require('../helpers');

const OUT = process.env.QA_OUT || path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const LIST = ['deepseek-flash', 'deepseek-v4-pro', 'qwen3.8-flash', 'qwen3.8-max', 'text-embedding-v4'];
const ALLOW = ['AIJAVAIS', 'Word', 'Excel', 'PPT', 'HALOFLUX', 'Anthropic', 'Claude', 'OpenAI', 'ChatGPT', 'Google', 'Gemini', 'DeepSeek', 'Kimi', 'GLM', 'SiliconFlow', 'Ollama', ...LIST];
const findings = []; const steps = [];
const log = (step, ok, note, extra) => { steps.push({ step, ok, note, ...(extra || {}) }); console.log((ok ? 'OK   ' : 'ISSUE') + ' ' + step + ' :: ' + note); };
function scan(text) {
  let t = String(text);
  for (const w of [...ALLOW].sort((a, b) => b.length - a.length)) t = t.split(w).join(' ');
  const words = [...new Set(t.match(/[A-Za-z][A-Za-z_]{2,}/g) || [])];
  const money = /\$|USD|美元|[Tt]oken/.test(t);
  const json = /[{[]\s*"[^"]*"\s*:/.test(t) || /\b(null|undefined)\b/.test(t);
  return { words, money, json };
}
let page; const shots = [];
async function shot(name) { const f = path.join(OUT, name + '.png'); await page.screenshot({ path: f, fullPage: true }); shots.push(name + '.png'); }
async function audit(where) {
  const text = await page.evaluate(() => document.body.innerText);
  const r = scan(text);
  if (r.words.length || r.money || r.json) { findings.push({ where, words: r.words, money_or_token: r.money, raw_json_or_null: r.json }); log('扫描 ' + where, false, `英文词=${r.words.join(',') || '无'} 美元/Token=${r.money} JSON/null=${r.json}`); }
  else log('扫描 ' + where, true, '无英文技术词/原始JSON/美元/Token');
  return r;
}
const vis = async s => { try { return await page.locator(s).first().isVisible(); } catch { return false; } };

(async () => {
  const chats = [];
  const mock = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/models$/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: LIST.map(id => ({ id })) })); }
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const j = JSON.parse(body || '{}'); chats.push(j.model); const over = global.__over && j.max_tokens > 32;
      const text = j.max_tokens <= 32 ? '好' : '【模拟回复】周末促销方案\n一、时间：周六、周日\n二、优惠：第二杯半价\n三、宣传：社区群与店内海报';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: over ? 5000 : 300, completion_tokens: over ? 9000 : 400 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mp = mock.address().port;
  const app = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mp }, login: false });
  const base = 'http://localhost:' + app.port;
  let ck = ''; const api = (m, u, b) => app.call(m, u, b, { cookie: ck });
  const browser = await chromium.launch({ headless: true, env: { ...process.env, LANG: 'C.UTF-8' } });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
    page = await ctx.newPage();
    const pageErrors = []; page.on('pageerror', e => pageErrors.push(String(e)));

    /* STEP 1 first login (real first-time setup path) */
    await page.goto(base + '/login.html'); await page.waitForTimeout(600);
    await shot('01-first-visit'); await audit('首次打开登录页（设置密码）');
    const setupVisible = await vis('#setupForm');
    log('1 首次打开看到什么', true, setupVisible ? '显示“设置密码”表单，要求输入一次性设置码（文案：' + (await page.locator('#setupForm label').first().innerText()).replace(/\n/g, ' ') + '）' : '显示登录表单');
    const code = /([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(fs.readFileSync(path.join(app.dir, 'setup-code.txt'), 'utf8'))[1];
    await page.fill('#code', code);
    const pws = await page.$$('#setupForm input[type=password]'); for (const p of pws) await p.fill(H.TEST_PASSWORD);
    await page.click('#setupBtn');
    await page.waitForURL(/workspace\.html|admin\.html/, { timeout: 15000 });
    await page.waitForTimeout(800);
    ck = (await ctx.cookies()).map(c => c.name + '=' + c.value).join('; ');
    log('1 登录后落点', /workspace/.test(page.url()), page.url().replace(base, ''));
    await shot('02-after-login'); await audit('登录后首页（无模型）');
    const guide = await vis('#ws-guide'); const nt = await vis('#aij-new');
    log('1 新手引导 + ＋新建任务', guide && nt, `引导可见=${guide} ＋新建任务可见=${nt}；引导文字：` + (guide ? (await page.locator('#ws-guide').innerText()).replace(/\s+/g, ' ').slice(0, 120) : '无'));

    /* STEP 2 add models */
    await page.goto(base + '/admin.html'); await page.waitForSelector('#wProv option', { state: 'attached' });
    await shot('03-admin-empty'); await audit('管理中心（无模型）');
    await page.selectOption('#wProv', 'custom');
    await page.evaluate(() => { const d = document.querySelector('#wBase').closest('details'); if (d) d.open = true; });
    await page.fill('#wBase', `http://127.0.0.1:${mp}/v1`); await page.fill('#wKey', 'mock-key-not-secret-0000');
    await page.click('#wAddAll');
    await page.waitForFunction(() => /已添加 \d+ 个/.test(document.querySelector('#wAllRes').textContent), null, { timeout: 20000 });
    const res = await page.innerText('#wAllRes');
    log('2 一次点击添加全部', /已添加 \d+ 个/.test(res), res.replace(/\s+/g, ' ').slice(0, 200));
    await page.waitForTimeout(500);
    const cards = await page.innerText('#mList');
    log('2 模型卡片“平台 · 模型名”', /自定义 · deepseek-flash/.test(cards), cards.replace(/\s+/g, ' ').slice(0, 300));
    log('2 中文擅长标签', /推理|写作|中文/.test(cards), /推理|写作|中文/.test(cards) ? '卡片含中文擅长项' : '卡片没有中文擅长项');
    await shot('04-models-added'); await audit('管理中心（已添加模型）');

    /* STEP 3 new task + simple form */
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-go');
    log('3 ＋新建任务', await vis('#aij-new'), '工作台顶栏可见');
    const budgetEls = await page.$$('input[name=s-budget], #max-cost, #max-tokens');
    const simpleVisibleInputs = await page.$$eval('#simple input:not([type=hidden]), #simple textarea, #simple select', els => els.filter(e => e.offsetParent).length);
    log('3 简单模式输入项数量', simpleVisibleInputs <= 8, `可见输入控件 ${simpleVisibleInputs} 个（想做什么 / 成果 / 时间）`);
    await audit('简单模式表单'); await shot('05-simple-form');

    /* custom connections get no built-in price: record the block, then fix it through the admin edit dialog like a person would */
    await page.fill('#s-goal', '价格未知时的任务'); await page.click('#s-go'); await page.waitForTimeout(1200);
    const blockTxt = (await page.evaluate(() => (document.querySelector('#s-error') || {}).innerText || '')).replace(/\s+/g, ' ');
    log('B7-06 自定义接入未填单价：明确指引', /管理中心.*编辑.*单价/.test(blockTxt), '主线被挡住，提示：' + blockTxt);
    await shot('05b-price-unknown-block');
    await page.goto(base + '/admin.html'); await page.waitForSelector('#mList [data-act=edit]');
    for (const id of ['deepseek-flash', 'qwen3.8-flash']) {
      const card = page.locator('#mList .card', { hasText: id + ' ·' }).first();
      await card.locator('[data-act=edit]').click(); await page.waitForSelector('#ePriceIn');
      if (id === 'deepseek-flash') { await shot('05c-edit-dialog'); await audit('编辑模型对话框（单价）'); const dt = await page.evaluate(() => document.querySelector('#ePriceIn').closest('label').innerText + ' || ' + (document.querySelector('dialog[open], .modal, #modal') || document.body).innerText.split('\n').filter(l => /Token|USD|美元/.test(l)).join(' / ')); log('B7-02 编辑框单价文案', !/Token/.test(dt.split('||')[0]), dt.slice(0, 300)); }
      await page.fill('#ePriceIn', '1'); await page.fill('#ePriceOut', '3'); await page.click('#eSave'); await page.waitForTimeout(900);
    }
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-go');
    /* STEP 3b/4: nothing priced except builtin: qwen3.8-flash & deepseek-flash have built-in prices. Normal run: */
    await page.fill('#s-goal', '给社区咖啡店写一份周末促销方案'); await page.check('input[name=s-output][value=word]');
    await page.click('#s-preview'); await page.waitForSelector('#s-plan:not([hidden]), #s-error:not([hidden])'); if (await vis('#s-error')) { log('3 先看看配置出错', false, (await page.innerText('#s-error')).replace(/\s+/g, ' ')); await shot('06-plan-error'); await audit('先看看配置(出错)'); }
    const plan = (await page.innerText('#s-plan').catch(() => '')).replace(/\s+/g, ' ');
    log('3 先看看配置（人话）', true, plan.slice(0, 400)); await shot('06-plan'); await audit('先看看配置');
    await page.click('#s-go'); await page.waitForSelector('#s-confirm[open], #s-error:not([hidden])');
    if (!(await vis('#s-confirm[open]'))) { log('3 点开始没有弹确认框', false, (await page.innerText('#s-error')).replace(/\s+/g, ' ')); await shot('07-no-confirm'); await audit('点开始后(无确认框)'); throw new Error('主线中断：无确认框'); }
    const dlg = (await page.innerText('#s-confirm')).replace(/\s+/g, ' ');
    log('3 确认框', /预计.*¥.*最多.*¥.*自动停/.test(dlg) && !/\$|USD|美元|[Tt]oken/.test(dlg), dlg);
    await shot('07-confirm'); await audit('确认框');
    await page.click('#s-confirm-ok');
    const t0 = Date.now();
    await page.waitForSelector('#s-progress:not([hidden])', { timeout: 10000 });
    log('4 直达进度页', true, `点击确认后 ${Date.now() - t0}ms 内进入进度页`);
    await shot('08-progress-early');
    await page.waitForSelector('#s-result:not([hidden]), #s-stop:not([hidden]), #s-run-error:not([hidden])', { timeout: 40000 });
    await shot('09-progress-done'); await audit('进度/成果页');
    log('4 进度页内容可读', true, (await page.innerText('#s-steps')).replace(/\s+/g, ' ').slice(0, 200));

    /* STEP 6 download */
    if (await vis('#s-download')) {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#s-download')]);
      const buf = fs.readFileSync(await dl.path());
      log('6 下载成果', buf.subarray(0, 2).toString() === 'PK', `文件名 ${dl.suggestedFilename()}，${buf.length} 字节，真实 zip 头=${buf.subarray(0, 2).toString() === 'PK'}`);
    } else log('6 下载成果', false, '没有找到下载按钮');

    /* QA-B7-01 rework: plain-words button, RMB confirmation again, only review redone */
    const simpleButtons = (await page.locator('#s-progress button, #s-result button').allInnerTexts()).map(s => s.trim()).filter(Boolean);
    log('B7-01 返工入口（简单模式）', simpleButtons.some(b => /不满意|修改/.test(b)), '进度页可见按钮：' + simpleButtons.join(' | '));
    if (await vis('#s-rework')) {
      await page.click('#s-rework'); await page.waitForSelector('#s-rework-text', { state: 'visible' });
      await shot('10a-rework-box'); await audit('返工输入框');
      await page.fill('#s-rework-text', '语气再活泼一些，加上一句口号');
      await page.click('#s-rework-go'); await page.waitForSelector('#s-confirm[open]', { timeout: 10000 });
      const rd = (await page.innerText('#s-confirm')).replace(/\s+/g, ' ');
      log('B7-01 返工时再次确认（人民币）', /确认修改/.test(rd) && /预计.*¥.*最多.*¥/.test(rd) && !/\$|USD|美元|[Tt]oken/.test(rd), rd);
      await shot('10b-rework-confirm'); await audit('返工确认框');
      await page.click('#s-confirm-ok');
      await page.waitForSelector('#s-progress:not([hidden])');
      await page.waitForSelector('#s-result:not([hidden]), #s-stop:not([hidden]), #s-run-error:not([hidden])', { timeout: 40000 });
      await page.waitForTimeout(500);
      const afterTxt = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
      log('B7-01 返工完成后看到新成果', await vis('#s-result'), afterTxt.slice(0, 260));
      await shot('10c-rework-done'); await audit('返工完成页');
      if (await vis('#s-download')) { const [d2] = await Promise.all([page.waitForEvent('download'), page.click('#s-download')]); log('B7-01 返工后再下载', fs.readFileSync(await d2.path()).subarray(0, 2).toString() === 'PK', d2.suggestedFilename()); }
      await page.click('#s-accept').catch(() => {}); await page.waitForTimeout(600);
      log('6 满意，确认完成', /已确认完成/.test(await page.evaluate(() => document.body.innerText)), '确认完成状态');
    }
    if (await vis('#s-adjust')) {
      await page.click('#s-adjust'); await page.waitForTimeout(800);
      const backToSimple = await vis('#s-go') && !(await vis('#max-cost'));
      log('B7-01 “调整团队”回到简单表单（不进高级页）', backToSimple, '当前页面是否为简单表单=' + backToSimple + '；目标预填=' + (await page.inputValue('#s-goal')).slice(0, 30));
      await shot('10-adjust'); await audit('调整团队后页面');
    }

    /* STEP 5 errors: budget zero in settings, unknown prices, no key */
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-go');
    const capR = await api('POST', '/api/settings', { simpleRunCapCny: 0 }); log('5 管理员把单次上限设为0', true, 'HTTP ' + capR.status + ' ' + (capR.text || '').slice(0, 120));
    await page.fill('#s-goal', '预算为零的任务'); await page.click('#s-go');
    await page.waitForTimeout(1500);
    const zeroState = (await page.evaluate(() => { const c = document.querySelector('#s-confirm'); return (c && c.open ? c.innerText : '') + '||' + (document.querySelector('#s-error') ? document.querySelector('#s-error').innerText : ''); })).replace(/\s+/g, ' ');
    log('5 单次上限=0', !/\$|USD|undefined|null/.test(zeroState), zeroState.slice(0, 300)); await shot('11-cap-zero'); await audit('预算为0');
    if (await vis('#s-confirm[open]')) await page.click('#s-confirm-cancel');
    await api('POST', '/api/settings', { simpleRunCapCny: 5 });

    /* low budget: strong reviewer priced high, cap tiny */
    const byModel = Object.fromEntries((await api('GET', '/api/models')).json.models.map(m => [m.modelId, m.connectionId]));
    await api('PUT', '/api/models/' + byModel['deepseek-v4-pro'], { price: { currency: 'CNY', inputPerMillion: 40, outputPerMillion: 160 } });
    await api('POST', '/api/settings', { simpleRunCapCny: 0.05 });
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-go');
    await page.fill('#s-goal', '低预算任务'); await page.click('#s-go'); await page.waitForTimeout(1500);
    const lowDlg = (await page.evaluate(() => { const c = document.querySelector('#s-confirm'); return (c && c.open ? c.innerText : '') + '||' + (document.querySelector('#s-error') ? document.querySelector('#s-error').innerText : ''); })).replace(/\s+/g, ' ');
    log('5a 预算很低：开始前效果优先/省钱', /效果优先/.test(lowDlg) && /省钱/.test(lowDlg), lowDlg.slice(0, 400)); await shot('12-low-budget-choice'); await audit('低预算选择框');
    if (await vis('#s-confirm[open]')) {
      await page.click('#s-confirm-ok');
      await page.waitForSelector('#s-stop:not([hidden]), #s-result:not([hidden]), #s-run-error:not([hidden])', { timeout: 40000 });
      const stopTxt = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
      const m = /已完成 \d+\/\d+ 步，花了约 ¥[\d.]+/.exec(stopTxt);
      log('5b 钱用完：中文提示+可下载已完成部分', !!m && await vis('#s-stop-download'), m ? m[0] : '未出现“已完成 k/n 步，花了约 ¥”提示；页面：' + stopTxt.slice(0, 200));
      await shot('13-low-budget-stopped'); await audit('钱用完停止页');
      const runs = (await api('GET', '/api/v2/projects')).json.projects.sort((a, b) => b.createdAt - a.createdAt)[0];
      const rr = ((await api('GET', '/api/v2/projects/' + runs.projectId)).json.runs || [])[0] || {};
      const run = (await api('GET', '/api/v2/runs/' + rr.runId)).json.run;
      const used = Object.keys(run.approval.prices || {});
      log('5c 是否悄悄换成更差模型', used.includes(byModel['deepseek-v4-pro']), '实际纳入运行的模型：' + used.map(id => Object.keys(byModel).find(k => byModel[k] === id)).join(','));
    }
    await api('POST', '/api/settings', { simpleRunCapCny: 5 });

    /* no key / no price at all */
    for (const id of Object.values(byModel)) await api('PUT', '/api/models/' + id, { price: null }).catch(() => {});
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-go');

    /* QA-B7-07 usage above the estimate */
    for (const id of ['deepseek-flash', 'qwen3.8-flash']) await api('PUT', '/api/models/' + byModel[id], { price: { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 3 } });
    global.__over = true;
    await api('POST', '/api/settings', { simpleRunCapCny: 5 });
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-go'); await page.fill('#s-goal', '用量超出预计的任务'); await page.click('#s-go');
    await page.waitForSelector('#s-confirm[open]', { timeout: 10000 }).catch(() => {});
    if (await vis('#s-confirm[open]')) {
      await page.click('#s-confirm-ok');
      await page.waitForSelector('#s-stop:not([hidden]), #s-run-error:not([hidden]), #s-result:not([hidden])', { timeout: 40000 });
      const st = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
      log('B7-07 用量超出预计：停下页文案', !/预留/.test(st) && /下一步|管理员|下载已完成/.test(st) && await vis('#s-stop-download'), st.slice(0, 420)); await shot('18-overuse-stop'); await audit('用量超出停下页');
    } else log('B7-07 用量超出预计', false, '没弹确认框：' + (await page.evaluate(() => (document.querySelector('#s-error') || {}).innerText || '')));
    global.__over = false;
    /* advanced mode: untouched defaults (cost cap 0, no paid approval) + a role needing a missing ability */
    page = ctx.pages()[0];
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-advanced'); await page.click('#s-advanced');
    await page.fill('#project-name', 'QA高级模式'); await page.fill('#project-description', '默认设置直接开始');
    for (const x of await page.$$('#roles-editor select')) await x.selectOption(byModel['deepseek-flash']);
    await page.click('#start-run'); await page.waitForTimeout(1200);
    const adv1 = (await page.evaluate(() => { const e = document.querySelector('#start-error'); return e && !e.hidden ? e.innerText : ''; })).replace(/\s+/g, ' ');
    log('5d 高级模式默认设置点开始', !!adv1 && !scan(adv1).words.length, '提示：' + (adv1 || '（无提示，页面没反应）')); await shot('15-advanced-default'); await audit('高级模式默认开始');
    const advForm = await page.evaluate(() => document.querySelector('#max-cost') ? document.querySelector('#max-cost').closest('.card').innerText : '');
    log('B7-04 高级表单主值为人民币，Token/USD 收进专业设置', /本次最多花费（元）/.test(advForm) && !/USD|Token/.test(await page.evaluate(() => document.body.innerText)), advForm.replace(/\s+/g, ' ').slice(0, 160));
    const pr = await api('POST', '/api/v2/projects', { name: 'QA能力缺失', description: '岗位需要资料研究', roles: [{ roleId: 'analyst', name: '研究员', duty: '研究', connectionId: byModel['deepseek-flash'], requiredCapabilities: ['research'] }], steps: [{ stepId: 's1', roleId: 'analyst', title: '研究' }] });
    await page.goto(base + '/workspace.html?project=' + pr.json.project.projectId); await page.waitForSelector('#validate-project'); await page.click('#validate-project'); await page.waitForTimeout(1500);
    const vtxt = (await page.evaluate(() => (document.querySelector('#validation-list') || {}).innerText || '')).replace(/\s+/g, ' ');
    log('5e 缺少能力：中文说明+一键修复', /还没有登记/.test(vtxt) && /补充能力|更换/.test(vtxt), vtxt.slice(0, 300)); await shot('16-capability-missing'); await audit('检查执行条件(能力缺失)');
    await page.setViewportSize({ width: 390, height: 800 }); await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-go'); await shot('17-mobile-simple');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
    log('手机宽度(390)简单模式', !overflow, overflow ? '页面出现横向滚动' : '无横向滚动');
    await page.setViewportSize({ width: 1280, height: 900 });
    /* HALOFLUX */
    const pp = await ctx.newPage(); page = pp;
    await page.goto(base + '/panel.html'); await page.waitForTimeout(1500);
    await shot('14-haloflux'); await audit('实时大屏 HALOFLUX（含小号英文副标）');
    const mainOnly = await page.evaluate(() => { const c = document.body.cloneNode(true); c.querySelectorAll('.en,script,style').forEach(n => n.remove()); return c.innerText; });
    const mr = scan(mainOnly); log('B7-03 大屏主文案（去掉 .en 小号副标）', mr.words.length === 0, '剩余英文词：' + (mr.words.join(',') || '无'));
    log('页面脚本错误', pageErrors.length === 0, pageErrors.join(' | ') || '无');
  } catch (e) { log('测试脚本异常', false, String(e && e.stack || e).slice(0, 600)); }
  finally {
    await browser.close(); await app.stop(); mock.close();
    fs.writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify({ steps, findings, shots, mockChatCalls: chats.length }, null, 2));
    console.log(`DONE steps=${steps.length} issues=${steps.filter(s => !s.ok).length} mockChatCalls=${chats.length}`);
  }
})();
