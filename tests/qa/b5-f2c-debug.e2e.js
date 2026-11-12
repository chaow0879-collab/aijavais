'use strict';
/* QA-B5F2b: PPT export through the real UI (goal -> output "PPT" -> confirm -> run -> download .pptx), with LOCAL MOCK model
 * outputs that are OUR OWN fixtures (written from the owner's description, NOT the owner's original script). Then the home
 * "实时动态" card and top-bar "＋新建任务" style. E3, no paid calls. Files land in QA_OUT for LibreOffice rendering. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const H = require('../helpers');

const OUT = process.env.QA_OUT || path.join(__dirname, 'out-f2b');
fs.mkdirSync(OUT, { recursive: true });
const LIST = ['deepseek-flash', 'qwen3.8-flash'];
const rows = []; const shots = [];
const rec = (id, ok, note) => { rows.push({ id, ok, note }); console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + String(note).slice(0, 460)); };
let page;
const shot = async n => { await page.screenshot({ path: path.join(OUT, n + '.png') }); shots.push(n + '.png'); };
const vis = async s => { try { return await page.locator(s).first().isVisible(); } catch { return false; } };

/* ---- our own fixtures -------------------------------------------------------------------- */
const jsonDeck = n => ({ slides: Array.from({ length: n }, (_, i) => i === 0
  ? { layout: 'cover', title: '社区咖啡店周末促销方案', subtitle: '让周末客流翻一番' }
  : i === n - 1 ? { layout: 'summary', title: '一句话总结', bullets: ['周末两天，第二杯半价', '社群加海报，成本最低'] }
  : [{ layout: 'bullets', title: '为什么要做周末促销', bullets: ['周末客流集中在上午十点后', '新客多，复购低', '预算有限，需要小成本'] },
     { layout: 'two-column', title: '现状与目标', left: { title: '现状', bullets: ['周末日均 60 单', '回头客 20%'] }, right: { title: '目标', bullets: ['日均 90 单', '回头客 35%'] } },
     { layout: 'cards', title: '三个促销动作', cards: [{ title: '第二杯半价', text: '周六日全天，所有饮品' }, { title: '集章送小食', text: '满五杯送一份甜点' }, { title: '拼单立减', text: '两人同行各减三元' }] },
     { layout: 'timeline', title: '执行时间表', steps: [{ title: '周三', text: '海报定稿' }, { title: '周四', text: '社群预热' }, { title: '周六', text: '活动开始' }] }][(i - 1) % 4]) });
const MD = `# 社区咖啡店周末促销

---

## 第1页：封面

**标题：** 周末促销，让小店热闹起来
**副标题：** 店铺经营 · 2026 秋季

**视觉建议：** 暖色背景，左侧放咖啡杯插画。

---

## 第2页：为什么做

**标题：** 为什么要做周末促销
**要点：**
- **客流**：周末上午十点后最集中
- **复购**：新客多、回头客少
- **预算**：小成本、见效快

**配图建议：** 放一张客流折线图
备注：讲稿提示——先问大家上周末来过几次

---

## 第3页：怎么做

**标题：** 三个促销动作
**要点：**
- 第二杯半价（周六日全天）
- 集章送小食（满五杯）
- 拼单立减（两人同行各减三元）

**设计建议：** 三栏卡片，图标放在左上角

---

## 第4页：时间表

**标题：** 执行时间表
**要点：**
- 周三：海报定稿
- 周四：社群预热
- 周六：活动开始

---

## 第5页：预算

**标题：** 预算与回报
**要点：**
- 海报与小食成本约 300 元
- 预期多出 60 单，毛利约 900 元

---

## 第6页：总结

**标题：** 一句话总结
**要点：**
- 小成本、好执行、周末见效
`;
const coverOnly = () => JSON.stringify({ slides: [{ layout: 'cover', title: '社区咖啡店周末促销方案', subtitle: '只有封面' }] });
const modes = { coverOnly,  json5: () => JSON.stringify(jsonDeck(5)), json10: () => JSON.stringify(jsonDeck(10)), json6: () => JSON.stringify(jsonDeck(6)), fenced5: () => '```json\n' + JSON.stringify(jsonDeck(5)) + '\n```', md: () => MD, junk: () => '抱歉，我没法完成这个请求。', empty: () => '', prose: () => '周末促销方案。第一，客流集中在上午。第二，新客多。第三，可以做第二杯半价。第四，用社群宣传。' };
let mode = 'json5';
const WORDMD = '## 周末促销方案\n\n**目标**：提高周末客流\n\n- 第二杯半价\n- 集章送小食\n\n### 时间安排\n1. 周三定稿海报\n2. 周六开始活动\n\n> 备注：先小范围试点\n';
modes.wordmd = () => WORDMD;

(async () => {
  const chats = [];
  const mock = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/models$/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: LIST.map(id => ({ id })) })); }
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const j = JSON.parse(b || '{}'); if (j.max_tokens > 32) (global.__p = global.__p || []).push(JSON.stringify(j.messages || '').slice(-420)); const isReview = /只输出一个 JSON 对象/.test(JSON.stringify(j.messages || '')); const real = j.max_tokens > 32; if (real) chats.push(isReview ? 'review' : 'draft');
      const text = !real ? '好' : isReview ? modes[mode]() : '【模拟草稿】第1页 封面；第2页 为什么做；第3页 怎么做；第4页 时间表；第5页 预算';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 300, completion_tokens: 400 } }) + '\n\ndata: [DONE]\n\n');
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
    await page.goto(base + '/admin.html'); await page.waitForSelector('#wProv option', { state: 'attached' });
    await page.selectOption('#wProv', 'custom'); await page.evaluate(() => { const d = document.querySelector('#wBase').closest('details'); if (d) d.open = true; });
    await page.fill('#wBase', `http://127.0.0.1:${mp}/v1`); await page.fill('#wKey', 'mock-key-not-secret-0000'); await page.click('#wAddAll');
    await page.waitForFunction(() => /已添加 \d+ 个/.test(document.querySelector('#wAllRes').textContent), null, { timeout: 20000 });
    for (const m of (await app.call('GET', '/api/models')).json.models) await app.call('PUT', '/api/models/' + m.connectionId, { price: { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 3 } });

    const startUi = async (goal, output) => {
      await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-goal');
      await page.fill('#s-goal', goal); await page.check('input[name=s-output][value=' + output + ']');
      await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]', { timeout: 10000 }); await page.click('#s-confirm-ok');
      await page.waitForSelector('#s-result:not([hidden]), #s-stop:not([hidden]), #s-run-error:not([hidden])', { timeout: 40000 });
      await page.waitForTimeout(1500);
    };
    const text = async sel => (await page.locator(sel).innerText().catch(() => '')).replace(/\s+/g, ' ');
    modes.prose1 = () => '周末促销方案的核心是第二杯半价，同时配合社群预热和店内海报，在周六周日两天集中推广，预计带来三成客流增长';
    for (const [tag, goal] of [['one5', '帮我做一份5页的店铺周末促销方案PPT'], ['oneN', '帮我做一份店铺周末促销方案PPT']]) {
      mode = 'prose1'; await startUi(goal, 'ppt');
      const top = await text('#s-result'); const dl = await vis('#s-download'); let f = null; if (dl) { const [d] = await Promise.all([page.waitForEvent('download'), page.click('#s-download')]); f = path.join(OUT, tag + '.pptx'); await d.saveAs(f); }
      rec('DBG ' + tag + ' 单句', true, `提示/预览=[${top.slice(0, 230)}] 下载=${dl} err=[${(await text('#s-run-error')).slice(0, 80)}]`); await shot('dbg-' + tag);
    }
  } catch (e) { rec('脚本异常', false, String(e && e.stack || e).slice(0, 700)); }
  finally { await browser.close(); await app.stop(); mock.close(); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ rows, shots, chats: chats.length }, null, 2)); console.log(`DONE pass=${rows.filter(r => r.ok).length} fail=${rows.filter(r => !r.ok).length} mockCalls=${chats.length}`); }
})();
