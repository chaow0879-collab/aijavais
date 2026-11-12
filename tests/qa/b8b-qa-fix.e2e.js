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
const MODELNAME = /local-writer|priced-writer|本地写手|收费写手|本地模型 ·|自定义 ·|均衡/;
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
  const app = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mp } });
  const base = 'http://localhost:' + app.port;
  const browser = await chromium.launch({ headless: true, env: { ...process.env, LANG: 'C.UTF-8' } });
  try {
    const api = (m, u, b) => app.call(m, u, b);
    const mk = async (extra) => (await api('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mp}/v1`, ...extra })).json.connection.connectionId;
    const localId = await mk({ modelId: 'local-writer', displayName: '本地写手', pricingMode: 'local', capabilities: ['writing', 'reasoning', 'chinese', 'data_analysis'] }); await api('POST', '/api/models/' + localId + '/test', {});
    const paidId = await mk({ modelId: 'priced-writer', displayName: '收费写手', pricingMode: 'paid_api', capabilities: ['writing', 'reasoning', 'chinese', 'data_analysis'], price: { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 1 } }); await api('POST', '/api/models/' + paidId + '/test', { approvePaid: true }); await api('POST', '/api/models/' + paidId + '/disable', {});
    const mkUser = async (name, cap) => (await api('POST', '/api/v2/users', { username: name, password: PASSW, monthlyCapCny: cap })).json.user.userId;
    const loginAs = async name => { const c = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, acceptDownloads: true }); const p = await c.newPage(); await p.goto(base + '/login.html'); await p.fill('#un', name); await p.fill('#upw', PASSW); await p.click('#userBtn'); await p.waitForURL(/workspace\.html/); await p.waitForTimeout(1000); return p; };
    const errs = p => p.evaluate(() => [...document.querySelectorAll('#s-error, #s-run-error, #s-budget-warn, #s-stop')].filter(e => e.offsetParent).map(e => e.innerText).join(' | ')).then(clean);

    await api('POST', '/api/models/' + localId + '/disable', {}); await api('POST', '/api/models/' + paidId + '/enable', {});
    await mkUser('userlow', 0.02); const pq = await loginAs('userlow'); page = pq;
    await pq.goto(base + '/workspace.html?new=1'); await pq.waitForSelector('#s-goal'); await pq.fill('#s-goal', '写一份会员招募文案'); await pq.fill('#s-budget-cny', '0.02'); await pq.click('#s-go'); await pq.waitForTimeout(1800);
    const dlg = (await vis('#s-confirm[open]', pq)) ? clean(await pq.innerText('#s-confirm')) : ''; rec('Q 按提示把预算改到 ¥0.02 后：确认框', null, `确认框=[${dlg.slice(0, 300)}] 提示=[${await errs(pq)}]`); await shot('q-budget-fix', pq);
    // path 1: 就用这个金额
    await pq.click('#s-budget-keep'); await pq.waitForTimeout(1500);
    const d2 = (await vis('#s-confirm[open]', pq)) ? clean(await pq.innerText('#s-confirm')) : ''; rec('Q1 点“就用这个金额”后', null, `确认框=[${d2.slice(0, 300)}] 提示=[${await errs(pq)}]`); await shot('q1-keep', pq);
    if (d2) { await pq.click('#s-confirm-ok'); await pq.waitForSelector('#s-result:not([hidden]), #s-stop:not([hidden]), #s-run-error:not([hidden])', { timeout: 40000 }).catch(() => {}); await pq.waitForTimeout(1000); rec('Q1 之后任务结果', null, (await body(pq)).slice(0, 380)); await shot('q1-result', pq); }
    // path 2: 改成建议金额 -> exceeds the monthly quota
    await pq.goto(base + '/workspace.html?new=1'); await pq.waitForSelector('#s-goal'); await pq.fill('#s-goal', '再写一份'); await pq.fill('#s-budget-cny', '0.02'); await pq.click('#s-go'); await pq.waitForTimeout(1500);
    if (await vis('#s-budget-suggest', pq)) { await pq.click('#s-budget-suggest'); await pq.waitForTimeout(600); const v = await pq.inputValue('#s-budget-cny'); await pq.click('#s-go'); await pq.waitForTimeout(1500); rec('Q2 点“改成建议金额”后再开始', null, `输入框=${v} 确认框=${await vis('#s-confirm[open]', pq)} 提示=[${await errs(pq)}]`); await shot('q2-suggest', pq); }
    else rec('Q2', null, '没有出现“改成建议金额”按钮：' + (await errs(pq)));
  } catch (e) { rec('脚本异常', false, String(e && e.stack || e).slice(0, 700)); }
  finally { await browser.close(); await app.stop(); mock.close(); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ rows, shots, chats: chats.length }, null, 2)); console.log(`DONE rows=${rows.length} fail=${rows.filter(r => r.ok === false).length} mockCalls=${chats.length}`); }
})();
