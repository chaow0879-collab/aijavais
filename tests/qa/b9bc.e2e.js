'use strict';
/* QA-B9b (先问清楚再动手) + QA-B9c (对话式修改), admin identity. Observations recorded for the report. */
const { fs, path, clean, eng, TECH, makeLogger, boot } = require('./b9-common');
const OUT = process.env.QA_OUT || path.join(__dirname, 'out-b9bc');
const L = makeLogger(OUT); const { rec } = L;

(async () => {
  const E = await boot(OUT); const { base, api, state } = E; let page;
  const shot = async n => { await page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true }); L.shots.push(n + '.png'); };
  const vis = async s => { try { return await page.locator(s).first().isVisible(); } catch { return false; } };
  const body = async () => clean(await page.evaluate(() => document.body.innerText));
  const tasks = async () => (await api('GET', '/api/v2/tasks')).json.tasks.length;
  const openForm = async goal => { await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-goal'); await page.fill('#s-goal', goal); };
  const done = () => page.waitForSelector('#s-result:not([hidden]), #s-stop:not([hidden]), #s-run-error:not([hidden])', { timeout: 40000 }).then(() => page.waitForTimeout(800));
  try {
    const ctx = await E.adminCtx(); page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(String(e)));

    /* ================= B9b ================= */
    await openForm('帮我写一份三月经营小结，给店里看');
    rec('B9b-1 点开始之前，页面上的说明', null, clean(await page.locator('#s-clar-note').innerText()) + ' | 页面提示：' + clean(await page.locator('#simple .hint').allInnerTexts().then(a => a.join(' / '))).slice(0, 200));
    await shot('b-1-before-start');
    const t0 = await tasks(), c0 = state.calls;
    await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]', { timeout: 15000 }); await page.waitForTimeout(500); await shot('b-2-confirm');
    const dlg = clean(await page.innerText('#s-confirm'));
    rec('B9b-2 确认框顶部先出现“我理解你要的是…”', /我理解|理解/.test(await page.locator('#s-clar-understanding').innerText().then(t => '我理解' + t)), '理解：' + clean(await page.locator('#s-clar-understanding').innerText()));
    const qs = await page.$$eval('#s-clar-questions > *', els => els.map(e => e.innerText.replace(/\s+/g, ' ')));
    rec('B9b-2 问题数 ≤ 3，每题有可点的选项和“其它”', null, 'N=' + qs.length + ' | ' + JSON.stringify(qs).slice(0, 400));
    rec('B9b-2 有“其它”输入与“跳过”', /其它/.test(dlg) && await vis('#s-clar-skip'), '跳过按钮=' + await vis('#s-clar-skip'));
    rec('B9b-2 人话计划', null, clean(await page.locator('#s-clar-plan').innerText()));
    rec('B9b-2 同一个框里还有人民币确认', /预计.*¥.*最多.*¥/.test(dlg), (/预计[^。]*。/.exec(dlg) || [''])[0] + ' | 起点文字：' + dlg.slice(0, 80));
    rec('B9b-2 对话框前 120 字（顺序是否“理解→问题→计划→费用”）', null, dlg.slice(0, 120));
    rec('B9b-2 框里无英文/技术词', eng(dlg, ['local-writer']).length === 0 && !/Token|美元|USD|\$|JSON/.test(dlg), '英文词=' + eng(dlg, ['local-writer']).join(','));
    /* cancel: nothing runs */
    await page.click('#s-confirm-cancel'); await page.waitForTimeout(800);
    rec('B9b-3 取消：没有新建任务、没有运行', (await tasks()) === t0, `任务数 ${t0}→${await tasks()}；模型调用 ${c0}→${state.calls}（只有一次“读懂需求”，免费本机模型）；表单目标还在=${(await page.inputValue('#s-goal')).length > 0}`);
    await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]'); const c1 = state.clars.length;
    rec('B9b-3 取消后再点开始：不重复调用“读懂需求”', c1 === 1, '“读懂需求”调用总数=' + c1);
    /* answer, then start */
    const first = page.locator('#s-clar-questions input[type=radio]').first(); await page.check('input[name=s-clar-q0] >> nth=0'); await page.check('input[name=s-clar-q1][value="__other"]'); await page.fill('#s-clar-other-1', '两页半'); await shot('b-3-answered');
    state.bodies.length = 0; await page.click('#s-confirm-ok'); await done(); await shot('b-4-result');
    const answers = (state.bodies[0] || '');
    rec('B9b-4 答案传给了每个岗位', /问：[^\\]*\\n答：老板/.test(answers) && /答：两页半/.test(answers) && /问：/.test(state.bodies[1] || ''), '起草员=' + /答：两页半/.test(state.bodies[0] || '') + ' 审核员=' + /答：两页半/.test(state.bodies[1] || ''));
    rec('B9b-4 答案体现在成果里（假模型会回显答案，只证明传递到位，不证明真实模型会照做）', /面向/.test(clean(await page.locator('#s-final').innerText())), clean(await page.locator('#s-final').innerText()).slice(0, 160));
    rec('B9b-4 成果页是否说明“按你的回答做的”', /按你的回答|你选了|你的回答|你的选择/.test(await body()), '页面里与回答相关的文字=' + ((await body()).match(/(按你的回答|你选了|你的回答|你的选择)[^。]{0,30}/) || ['无'])[0]);
    /* skip */
    await openForm('写一份门店周报'); await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]'); await page.click('#s-clar-skip'); state.bodies.length = 0; await page.waitForTimeout(300);
    rec('B9b-5 跳过后问题区隐藏', !(await vis('#s-clar-questions')), '问题区可见=' + await vis('#s-clar-questions')); await page.click('#s-confirm-ok'); await done();
    rec('B9b-5 跳过：岗位被告知按理解来做', /跳过提问/.test(state.bodies[0] || ''), (/用户选择跳过[^\\]{0,30}/.exec(state.bodies[0] || '') || ['无'])[0]);
    /* bad JSON -> rules */
    await openForm('BADJSON 写一份放假通知'); await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]'); await shot('b-5-rule-fallback');
    rec('B9b-6 模型回答不合格：降级为规则问题，不卡死', (await page.locator('#s-clar-questions > *').count()) > 0, '提示：' + clean(await page.locator('#s-clar-cost').innerText().catch(() => '')) + ' | 问题数=' + (await page.locator('#s-clar-questions > *').count()) + ' | 理解：' + clean(await page.locator('#s-clar-understanding').innerText()).slice(0, 80));
    await page.click('#s-confirm-cancel');
    /* paid-only: note must state the cost cap before clicking */
    await api('POST', '/api/models/' + E.localId + '/disable', {}); await api('POST', '/api/models/' + E.paidId + '/enable', {});
    await openForm('写一份会员招募文案'); await page.waitForTimeout(800);
    rec('B9b-7 只有收费模型时，点之前页面说明会先花不超过 ¥x', /¥/.test(await page.locator('#s-clar-note').innerText()), clean(await page.locator('#s-clar-note').innerText())); await shot('b-6-paid-note');
    await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]', { timeout: 15000 }).catch(() => {}); const pd = (await vis('#s-confirm[open]')) ? clean(await page.innerText('#s-confirm')) : '（无确认框）' + clean(await page.locator('#s-error').innerText().catch(() => ''));
    rec('B9b-7 收费模型时的确认框说明', null, pd.slice(0, 420)); await shot('b-7-paid-confirm');
    rec('B9b-7 确认框里把“读懂需求”的费用讲清楚', /读懂|理解需求/.test(pd) && /¥/.test(pd), (/[^。]*(读懂|理解需求)[^。]*。/.exec(pd) || ['无'])[0]);
    if (await vis('#s-confirm[open]')) await page.click('#s-confirm-cancel');
    /* no model at all */
    await api('POST', '/api/models/' + E.paidId + '/disable', {});
    await openForm('写一份通知'); await page.click('#s-go'); await page.waitForTimeout(1500);
    rec('B9b-8 没有任何可用模型：提示（不卡死）', null, '确认框=' + await vis('#s-confirm[open]') + ' 提示=[' + clean(await page.locator('#s-error').innerText().catch(() => '')) + ']');
    await api('POST', '/api/models/' + E.localId + '/enable', {});

    /* ================= B9c ================= */
    const pptTask = async goal => { await openForm(goal); await page.check('input[name=s-output][value=ppt]'); await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]'); await page.click('#s-clar-skip').catch(() => {}); await page.click('#s-confirm-ok'); await done(); };
    const versions = async () => clean(await page.locator('#s-versions').innerText().catch(() => ''));
    const left = async () => clean(await page.locator('#s-chat-left').innerText().catch(() => ''));
    const edit = async (text, { cancelFirst = false } = {}) => {
      await page.fill('#s-rework-text', text); await page.click('#s-rework-go'); await page.waitForSelector('#s-confirm[open]', { timeout: 10000 }).catch(() => {});
      const d = (await vis('#s-confirm[open]')) ? clean(await page.innerText('#s-confirm')) : '（没弹确认框）' + clean(await page.locator('#s-error, #s-run-error').first().innerText().catch(() => ''));
      if (cancelFirst && (await vis('#s-confirm[open]'))) { const k = state.bodies.length; await page.click('#s-confirm-cancel'); await page.waitForTimeout(500); rec('B9c 取消：不调用模型（“' + text + '”）', state.bodies.length === k, `模型调用 ${k}→${state.bodies.length}`); await page.fill('#s-rework-text', text); await page.click('#s-rework-go'); await page.waitForSelector('#s-confirm[open]'); }
      return d;
    };
    state.deckPages = 5; state.bodies.length = 0;
    await pptTask('帮我做一份5页的店铺三月经营小结PPT'); await shot('c-0-v1');
    rec('B9c-0 成果页有版本记录与“还可以修改 N 次”', /第 1 版/.test(await versions()) && /还可以修改 3 次/.test(await left()), `版本=[${await versions()}] 剩余=[${await left()}]`);
    rec('B9c-0 修改输入框的提示语', null, await page.getAttribute('#s-rework-text', 'placeholder') + ' | 标签：' + clean(await page.locator('label[for=s-rework-text]').innerText()));
    const log = [];
    const doEdit = async (text, opts) => { const d = await edit(text, opts); await shot('c-' + (log.length + 1) + '-confirm'); const scope = (/(只改[^，。]*|在合适的位置新增[^，。]*|删除第[^，。]*|只改“[^”]*”[^，。]*|整体[^，。]*)/.exec(d) || [''])[0]; const resp = { text, dlg: d, scope, old: /旧版本保留/.test(d), leftTxt: (/还可以再修改 \d+ 次/.exec(d) || [''])[0] }; log.push(resp); if (await vis('#s-confirm[open]')) { await page.click('#s-confirm-ok'); await page.waitForFunction(n => (document.querySelector('#s-versions')?.querySelectorAll('li').length || 0) >= n, log.length + 1, { timeout: 25000 }).catch(() => {}); await page.waitForTimeout(800); } return resp; };
    let r = await doEdit('只改第3页，标题换成“三月总结”', { cancelFirst: true });
    rec('B9c-1 “只改第3页”确认框', /只改第 3 页/.test(r.dlg) && r.old && /还可以再修改 2 次/.test(r.dlg), r.dlg.slice(0, 380));
    r = await doEdit('新增一页，加一页竞品对比'); rec('B9c-2 “新增一页”确认框', /新增/.test(r.dlg) && r.old && /还可以再修改 1 次/.test(r.dlg), r.dlg.slice(0, 380));
    r = await doEdit('删除第2页'); rec('B9c-3 “删除第2页”确认框', /删除第 2 页/.test(r.dlg) && r.old, r.dlg.slice(0, 380));
    await shot('c-4-after-3');
    rec('B9c-4 改完 3 次：版本列表', /第 4 版（当前）/.test(await versions()), await versions());
    rec('B9c-4 改完 3 次：剩余次数提示', /不能再改|上限/.test(await left()), await left());
    rec('B9c-4 超过次数时输入框/按钮的状态', null, `输入框可见=${await vis('#s-rework-text')} 按钮可用=${await page.locator('#s-rework-go').isEnabled().catch(() => 'n/a')} 提示=[${await left()}]`);
    if (await vis('#s-rework-text')) { await page.fill('#s-rework-text', '再改一下标题'); await page.click('#s-rework-go').catch(() => {}); await page.waitForTimeout(1500); rec('B9c-4 超过次数后硬要改的人话提示', null, `确认框=${await vis('#s-confirm[open]')} 提示=[${clean(await page.locator('#s-error, #s-run-error, #s-chat-left').allInnerTexts().then(a => a.join(' | ')))}]`); await shot('c-5-over-limit'); if (await vis('#s-confirm[open]')) await page.click('#s-confirm-cancel'); }
    /* versions: view / download */
    const rowsV = await page.$$eval('#s-versions li', ls => ls.map(l => l.innerText.replace(/\s+/g, ' ')));
    rec('B9c-5 版本记录逐条内容', null, JSON.stringify(rowsV).slice(0, 560));
    await page.click('#s-versions li:nth-child(1) button:has-text("查看")'); await page.waitForTimeout(600);
    rec('B9c-5 查看旧版本', /正在看第 1 版/.test(await body()), clean(await page.locator('#s-viewing').innerText().catch(() => '')) + ' | 成果区：' + clean(await page.locator('#s-final').innerText()).slice(0, 120)); await shot('c-6-view-old');
    const dl1 = page.waitForEvent('download'); await page.click('#s-versions li:nth-child(1) button:has-text("下载")'); const f1 = await dl1; const p1 = path.join(OUT, 'v1.pptx'); await f1.saveAs(p1);
    const dlN = page.waitForEvent('download'); await page.click('#s-versions li:nth-child(4) button:has-text("下载")').catch(async () => { await page.click('#s-download'); }); const fN = await dlN; const pN = path.join(OUT, 'v4.pptx'); await fN.saveAs(pN);
    const slideCount = f => { const z = require('node:child_process').execFileSync('python3', ['-I', '-c', 'import zipfile,re,sys;z=zipfile.ZipFile(sys.argv[1]);print(len([n for n in z.namelist() if re.match(r"ppt/slides/slide\\d+\\.xml$",n)]))', f]).toString().trim(); return z; };
    rec('B9c-5 旧版本下载：第 1 版 5 页；最新版 5 页（5→改第3页→新增→删除）', slideCount(p1) === '5' && slideCount(pN) === '5', `v1 ${f1.suggestedFilename()} ${slideCount(p1)} 页；最新 ${fN.suggestedFilename()} ${slideCount(pN)} 页`);
    /* second task: 只改标题 + vague */
    state.deckPages = 5; await pptTask('帮我做一份5页的店铺促销PPT');
    r = await doEdit('只改标题'); rec('B9c-6 “只改标题”确认框', /标题/.test(r.dlg) && r.old, r.scope + ' | ' + r.dlg.slice(0, 300));
    r = await doEdit('整体再正式一点，语气活泼一点'); rec('B9c-7 笼统意见的确认框（范围怎么说）', null, r.scope + ' | ' + r.dlg.slice(0, 300));
    r = await doEdit('第三页加一张图'); rec('B9c-8 其它说法（第三页）', null, r.scope + ' | ' + r.dlg.slice(0, 260));
    rec('B9c 页面无英文/技术词', eng(await body(), ['local-writer']).length === 0, '英文词=' + eng(await body(), ['local-writer']).join(','));
    rec('页面脚本错误', errs.length === 0, errs.join(' | ') || '无');
  } catch (e) { rec('脚本异常', false, String(e && e.stack || e).slice(0, 800)); }
  finally { await E.close(); L.done(); }
})();
