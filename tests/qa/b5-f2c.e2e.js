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
const modes = { coverOnly,  json5: () => JSON.stringify(jsonDeck(5)), json10: () => JSON.stringify(jsonDeck(10)), json6: () => JSON.stringify(jsonDeck(6)), fenced5: () => '```json\n' + JSON.stringify(jsonDeck(5)) + '\n```', md: () => MD, junk: () => '抱歉，我没法完成这个请求。', empty: () => '', prose: () => '周末促销方案的目标是提高客流。第一，客流集中在上午十点以后。第二，新客多而回头客少。第三，可以做第二杯半价。第四，用社群和海报宣传。第五，集章满五杯送小食。第六，两人同行各减三元。第七，周三定稿海报。第八，周四在社群预热。第九，周六正式开始。第十，周日统计效果并复盘。', prose1: () => '这是一段没有任何结构的话' };
let mode = 'json5';
const WORDMD = '## 周末促销方案\n\n**目标**：提高周末客流\n\n- 第二杯半价\n- 集章送小食\n\n### 时间安排\n1. 周三定稿海报\n2. 周六开始活动\n\n> 备注：先小范围试点\n';
modes.wordmd = () => WORDMD;

(async () => {
  const chats = [];
  const mock = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/models$/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: LIST.map(id => ({ id })) })); }
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const j = JSON.parse(b || '{}'); const isReview = /审核上一步/.test(JSON.stringify(j.messages || '')); const real = j.max_tokens > 32; if (real) chats.push(isReview ? 'review' : 'draft');
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
      await page.waitForTimeout(600);
    };
    const download = async tag => { const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#s-download')]); const f = path.join(OUT, tag + '.pptx'); await dl.saveAs(f); return f; };
    const text = async sel => (await page.locator(sel).innerText().catch(() => '')).replace(/\s+/g, ' ');

    /* ① QA-F2-1 unusable output -> no empty deck, plain message, no download, 重新生成 (RMB confirmation again) */
    for (const m of ['junk', 'coverOnly', 'empty']) {
      mode = m; await startUi('帮我做一份5页的店铺周末促销方案PPT', 'ppt');
      const err = await text('#s-run-error'); const dl = await vis('#s-download'); const regen = await vis('#s-regenerate');
      rec('① QA-F2-1 [' + m + '] 不交空壳：提示+无下载按钮+有“重新生成”', /没能生成合格的页面/.test(err) && !dl && regen, `提示=${err.slice(0, 200)} | 下载按钮=${dl} | 重新生成=${regen}`);
      await shot('f21-' + m);
      rec('① QA-F2-1 [' + m + '] 提示文字无英文技术词/JSON', !/[{[]\s*"|JSON|json/.test(err), err.slice(0, 120));
    }
    // regenerate once for the last case: confirm RMB again, new run uses fixed model output
    mode = 'junk'; await startUi('帮我做一份5页的店铺周末促销方案PPT', 'ppt');
    if (await vis('#s-regenerate')) {
      await page.click('#s-regenerate'); await page.waitForTimeout(900); mode = 'json5';
      const formBack = await vis('#s-goal'); const goalV = formBack ? await page.inputValue('#s-goal') : ''; const pptOn = formBack && await page.isChecked('input[name=s-output][value=ppt]');
      rec('① 点“重新生成”：回到新建表单，同一需求、PPT 已选中、团队沿用', formBack && /5页的店铺周末促销方案PPT/.test(goalV) && pptOn, `表单=${formBack} 目标=[${goalV}] PPT选中=${pptOn} 团队=[${await text('#s-plan-team')}]`); await shot('f21-regen-form');
      await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]', { timeout: 10000 });
      const rd = await text('#s-confirm'); rec('① 重新生成：再次确认人民币（同一需求）', /预计.*¥.*最多.*¥/.test(rd) && !/\$|USD|美元|[Tt]oken/.test(rd), rd.slice(0, 260)); await shot('f21-regen-confirm');
      await page.click('#s-confirm-ok'); await page.waitForSelector('#s-result:not([hidden])', { timeout: 40000 }); await page.waitForTimeout(600);
      rec('② 重新生成成功后：下载按钮立即出现（不刷新）', await vis('#s-download'), '下载按钮=' + await vis('#s-download') + '；成果预览=' + (await text('#s-final')).slice(0, 60)); if (await vis('#s-download')) { const f = await download('regen-ok'); rec('② 重新生成后真的能下载合格 PPTX', fs.statSync(f).size > 5000, path.basename(f) + ' ' + fs.statSync(f).size + ' 字节'); }
    } else rec('① 重新生成入口', false, '没有“重新生成”按钮');

    /* ② QA-F2-2 preview == deck; other formats lose Markdown too */
    mode = 'md'; await startUi('帮我做一份五页的店铺周末促销方案PPT', 'ppt');
    const pv = await text('#s-final'); await shot('f22-preview-ppt');
    rec('② QA-F2-2 PPT 预览无 #/**/---/视觉建议/配图/备注', !/(^|\s)#{1,6}\s|\*\*|---|视觉建议|设计建议|配图建议|备注|讲稿/.test(pv), pv.slice(0, 260));
    if (await vis('#s-download')) await download('p5md-c');
    mode = 'wordmd'; await startUi('给小店写一份周末促销方案', 'word');
    const wv = await text('#s-final'); await shot('f22-preview-word');
    rec('② QA-F2-2 Word 预览去掉 Markdown（#/**/-/>/数字点）', !/(^|\s)#{1,6}\s|\*\*|(^|\s)>\s|(^|\s)- /.test(wv), wv.slice(0, 260));
    for (const [o, tag] of [['text', 'text'], ['table', 'table']]) { if (await page.locator('input[name=s-output][value=' + o + ']').count()) { mode = 'wordmd'; await startUi('给小店写一份周末促销方案', o); const t = await text('#s-final'); rec('② QA-F2-2 ' + tag + ' 预览去掉 Markdown', !/(^|\s)#{1,6}\s|\*\*|(^|\s)>\s/.test(t), t.slice(0, 160)); } }

    /* ⑤ page counts (regression) + ④ footer / summary / truncation */
    const cases = [['p5json', '帮我做一份5页的店铺周末促销方案PPT', 'json5'], ['p10json', '帮我做一份10页的店铺周末促销方案PPT', 'json10'], ['pnone', '帮我做一份店铺周末促销方案PPT', 'json6'], ['p5md', '帮我做一份五页的店铺周末促销方案PPT', 'md'], ['p5fenced', '帮我做一份5页的店铺周末促销方案PPT', 'fenced5'], ['p10short', '帮我做一份10页的店铺周末促销方案PPT', 'json6']];
    for (const [tag, goal, m] of cases) { try { mode = m; await startUi(goal, 'ppt'); if (await vis('#s-download')) { const f = await download(tag); rec('⑤ 导出 ' + tag, true, path.basename(f) + '；成果预览：' + (await text('#s-final')).slice(0, 100)); } else rec('⑤ 导出 ' + tag, false, '无下载按钮：' + (await text('#s-run-error')).slice(0, 160)); } catch (e) { rec('⑤ 导出 ' + tag, false, String(e).slice(0, 200)); } }

    /* ③ unstructured prose -> paged by sentences, honest notice above the preview */
    for (const [tag, goal, m] of [['prose5', '帮我做一份5页的店铺周末促销方案PPT', 'prose'], ['proseN', '帮我做一份店铺周末促销方案PPT', 'prose'], ['prose1', '帮我做一份5页的店铺周末促销方案PPT', 'prose1']]) {
      mode = m; await startUi(goal, 'ppt');
      const top = await text('#s-result'); const dlv = await vis('#s-download'); let f = null; if (dlv) f = await download(tag);
      rec('③ ' + tag + ' 一段话：有如实提示（预览上方）', /没有分页结构|只有一段话/.test(top), top.slice(0, 260)); await shot('f3-' + tag);
      rec('③ ' + tag + ' 一段话：仍可下载（不是空壳）', dlv && !!f, 'dl=' + dlv);
    }
    /* ③ budget (cheap prices 1/3 first, then expensive) */
    const budgetGo = async (v) => { await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-goal'); await page.fill('#s-goal', '给小店写一份周末促销方案'); await page.waitForTimeout(700); await page.fill('#s-budget-cny', v).catch(() => {}); await page.click('#s-go'); await page.waitForTimeout(1300); };
    const state = async () => ({ warn: await vis('#s-budget-warn') ? await text('#s-budget-warn') : '', err: await vis('#s-error') ? await text('#s-error') : '', dlg: (await vis('#s-confirm[open]')) ? await text('#s-confirm') : '', keep: await vis('#s-budget-keep'), suggest: await vis('#s-budget-suggest') });
    await budgetGo('0.53'); let st = await state();
    rec('③ 填 0.53 → 确认框“最多”就是 ¥0.53（不被抬高）', /最多不超过 ¥0\.53/.test(st.dlg) && !/¥0\.10/.test(st.dlg), st.dlg.slice(0, 260)); await shot('f23-053'); if (st.dlg) await page.click('#s-confirm-cancel');
    await budgetGo('0.03'); st = await state();
    rec('③ 填 0.03 → 提示“连第一步都不够”，只有“改成建议金额”', /连第一步都不够/.test(st.warn) && st.suggest && !st.keep && !st.dlg, `提示=${st.warn.slice(0, 200)} | 改成建议=${st.suggest} 就用这个金额=${st.keep} | 确认框=${!!st.dlg}`); await shot('f23-003');
    rec('③ 填 0.03 时不再出现“按你填的金额”却被抬高', !/按你填的金额/.test(st.warn + st.dlg), (st.warn + st.dlg).slice(0, 120));
    if (st.suggest) { await page.click('#s-budget-suggest'); await page.waitForTimeout(600); rec('③ 点“改成建议金额”后输入框=建议值', parseFloat(await page.inputValue('#s-budget-cny')) >= 0.1, '输入框=' + await page.inputValue('#s-budget-cny')); }
    for (const v of ['0', '-5', '0.00']) { await budgetGo(v); st = await state(); rec('③ 填 “' + v + '” → “请填大于 0 的金额，或者留空”', /请填大于 0 的金额，或者留空/.test(st.err + st.warn) && !st.dlg, `提示=${(st.err + st.warn).slice(0, 120)} | 确认框=${!!st.dlg}`); if (v === '0') await shot('f23-zero'); }
    await budgetGo(''); st = await state(); rec('③ 留空 → 确认框照常弹出', !!st.dlg, st.dlg.slice(0, 120)); if (st.dlg) await page.click('#s-confirm-cancel');
    await budgetGo('0.03'); st = await state();
    if (st.keep) { await page.click('#s-budget-keep'); await page.waitForTimeout(1200); const d = await text('#s-confirm'); rec('③ 便宜模型填 0.03（够第一步）→ “就用这个金额”→ 确认框最多', true, d.slice(0, 260)); if (await vis('#s-confirm[open]')) await page.click('#s-confirm-cancel'); }
    for (const m of (await app.call('GET', '/api/models')).json.models) await app.call('PUT', '/api/models/' + m.connectionId, { price: { currency: 'CNY', inputPerMillion: 40, outputPerMillion: 160 } });
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-goal'); await page.fill('#s-goal', '给小店写一份周末促销方案，要详细一些'); await page.waitForTimeout(800);
    const sug = parseFloat((/¥(\d+(\.\d+)?)/.exec(await text('#s-budget-auto')) || [])[1] || '0');
    await page.fill('#s-budget-cny', String(Math.max(0.2, +(sug / 3).toFixed(2)))); await page.click('#s-go'); await page.waitForTimeout(1200); st = await state();
    rec('③ 回归：比建议低但够第一步 → 两个按钮；“就用这个金额”后确认框最多=所填', st.keep && st.suggest, st.warn.slice(0, 200));
    await page.fill('#s-budget-cny', '0.1'); await page.click('#s-go'); await page.waitForTimeout(1200); st = await state();
    rec('③ 贵模型填 0.1（连第一步都不够）→ 提示“连第一步都不够”，只有“改成建议金额”，没有确认框', /连第一步都不够/.test(st.warn) && st.suggest && !st.keep && !st.dlg, `提示=${st.warn.slice(0, 220)} | 改成建议=${st.suggest} 就用这个金额=${st.keep} | 确认框=${!!st.dlg}`); await shot('f23-first-step');
    rec('③ 该提示不再写“按你填的金额”', !/按你填的金额/.test(st.warn + st.dlg), (st.warn).slice(0, 120));
    await page.fill('#s-budget-cny', String(Math.max(0.2, +(sug / 3).toFixed(2)))); await page.click('#s-go'); await page.waitForTimeout(1200); st = await state();
    if (st.keep) { const typed = await page.inputValue('#s-budget-cny'); await page.click('#s-budget-keep'); await page.waitForTimeout(1200); const d = await text('#s-confirm'); const mx = parseFloat((/最多不超过 ¥(\d+(\.\d+)?)/.exec(d) || [])[1] || 'NaN'); rec('③ 回归：确认框最多不高于所填', mx <= parseFloat(typed) + 1e-9, `所填 ¥${typed} 确认框 ¥${mx}`); if (await vis('#s-confirm[open]')) await page.click('#s-confirm-cancel'); }
  } catch (e) { rec('脚本异常', false, String(e && e.stack || e).slice(0, 700)); }
  finally { await browser.close(); await app.stop(); mock.close(); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ rows, shots, chats: chats.length }, null, 2)); console.log(`DONE pass=${rows.filter(r => r.ok).length} fail=${rows.filter(r => !r.ok).length} mockCalls=${chats.length}`); }
})();
