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
  const app = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mp } });
  const base = 'http://localhost:' + app.port;
  const browser = await chromium.launch({ headless: true, env: { ...process.env, LANG: 'C.UTF-8' } });
  try {
    const api = (m, u, b) => app.call(m, u, b);
    const mk = async (extra) => (await api('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mp}/v1`, ...extra })).json.connection.connectionId;
    const paidId = await mk({ modelId: 'priced-writer', displayName: '收费写手', pricingMode: 'paid_api', capabilities: ['writing', 'reasoning', 'chinese', 'data_analysis'], price: { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 1 } });
    await api('POST', '/api/models/' + paidId + '/test', { approvePaid: true });
    const mkUser = async (name, cap) => (await api('POST', '/api/v2/users', { username: name, password: PASSW, monthlyCapCny: cap })).json.user.userId;
    const idA = await mkUser('capa', 0.02), idB = await mkUser('capb', 0.3), idC = await mkUser('capc', 0.015);
    const loginAs = async name => { const c = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 }); const p = await c.newPage(); await p.goto(base + '/login.html'); await p.fill('#un', name); await p.fill('#upw', PASSW); await p.click('#userBtn'); await p.waitForURL(/workspace\.html/); await p.waitForTimeout(1000); return p; };
    const startAndConfirm = async (p, goal) => { await p.goto(base + '/workspace.html?new=1'); await p.waitForSelector('#s-goal'); await p.fill('#s-goal', goal); await p.click('#s-go'); await p.waitForSelector('#s-confirm[open]', { timeout: 8000 }).catch(() => {}); const d = (await vis('#s-confirm[open]', p)) ? clean(await p.innerText('#s-confirm')) : ''; if (d) { await p.click('#s-confirm-ok'); await p.waitForTimeout(2500); } return d; };
    /* (a) cap ¥0.02: the confirmation says 最多 ¥0.10 but only ¥0.02 left; what happens on 确认开始 */
    let p = await loginAs('capa'); page = p; const d1 = await startAndConfirm(p, '写一份会员招募文案');
    const after1 = clean(await p.evaluate(() => [...document.querySelectorAll('#s-error, #s-run-error, #s-budget-warn, #s-stop')].filter(e => e.offsetParent).map(e => e.innerText).join(' | ')));
    rec('Q1 月额度 ¥0.02、这次最多 ¥0.10：确认框', null, d1); rec('Q1 点“确认开始”之后', null, `提示=[${after1}] 进度页=${await vis('#s-progress', p)} 模型调用=${chats.length}`); await shot('q1-cap-low-after-confirm', p);
    rec('Q1 提示是人话（含额度只剩/最多要花）', /额度/.test(after1) && eng(after1).length === 0, after1);
    /* (b) cap ¥0.3: run one, then cap lowered to what was spent; rework */
    p = await loginAs('capb'); page = p; const d2 = await startAndConfirm(p, '写一份会员招募文案'); await p.waitForSelector('#s-result:not([hidden])', { timeout: 30000 }).catch(() => {});
    const spent = (await api('GET', '/api/v2/users')).json.users.find(u => u.username === 'capb').month; rec('Q2 capb 第一次运行后', null, `确认框=[${d2.slice(0, 200)}] 本月=${JSON.stringify(spent)}`);
    await api('POST', '/api/v2/users/' + idB, { monthlyCapCny: spent.spentCny });
    await p.click('#s-rework'); await p.fill('#s-rework-text', '再精炼一些'); await p.click('#s-rework-go'); await p.waitForSelector('#s-confirm[open]', { timeout: 8000 }).catch(() => {});
    const d3 = (await vis('#s-confirm[open]', p)) ? clean(await p.innerText('#s-confirm')) : '（没弹确认框）' + clean(await p.locator('#s-error, #s-run-error').first().innerText().catch(() => ''));
    rec('Q2 额度已用完时点返工：确认框', null, d3); await shot('q2-rework-confirm', p);
    if (await vis('#s-confirm[open]', p)) { await p.click('#s-confirm-ok'); await p.waitForTimeout(2500); }
    const after3 = clean(await p.evaluate(() => [...document.querySelectorAll('#s-error, #s-run-error, #s-stop')].filter(e => e.offsetParent).map(e => e.innerText).join(' | ')));
    rec('Q2 点“确认开始”之后', null, `提示=[${after3}]`); await shot('q2-rework-after', p);
    rec('Q2 返工被拒时提示是人话', /额度/.test(after3) && eng(after3).length === 0 && !TECH.test(after3), after3);
    /* (c) cap ¥0.015 (a little less than a full run) */
    p = await loginAs('capc'); page = p; const d4 = await startAndConfirm(p, '写一份会员招募文案');
    const after4 = clean(await p.evaluate(() => [...document.querySelectorAll('#s-error, #s-run-error, #s-stop')].filter(e => e.offsetParent).map(e => e.innerText).join(' | ')));
    rec('Q3 月额度 ¥0.015：确认框', null, d4); rec('Q3 点“确认开始”之后', null, `提示=[${after4}] 进度页=${await vis('#s-progress', p)}`); await shot('q3-after', p);
    /* (d) a user whose cap is exactly 0 (the admin left the box empty) with a paid model only */
    const idD = await mkUser('capzero', 0); p = await loginAs('capzero'); page = p; const d5 = await startAndConfirm(p, '写一份会员招募文案');
    rec('Q4 月上限 ¥0（管理员留空）的使用者开始任务', null, `确认框=[${d5.slice(0, 220)}] 之后=[${clean(await p.evaluate(() => [...document.querySelectorAll('#s-error, #s-run-error')].filter(e => e.offsetParent).map(e => e.innerText).join(' | ')))}]`); await shot('q4-zero-cap', p);
  } catch (e) { rec('脚本异常', false, String(e && e.stack || e).slice(0, 700)); }
  finally { await browser.close(); await app.stop(); mock.close(); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ rows, shots, chats: chats.length }, null, 2)); console.log(`DONE rows=${rows.length} fail=${rows.filter(r => r.ok === false).length} mockCalls=${chats.length}`); }
})();
