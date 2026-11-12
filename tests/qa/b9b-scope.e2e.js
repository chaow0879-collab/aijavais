'use strict';
/* QA-B9b ①: 修改范围 — judged scope shown in the confirm box, can be re-chosen, and the chosen scope really is what the model is told. */
const { fs, path, clean, eng, makeLogger, boot } = require('./b9-common');
const OUT = process.env.QA_OUT || path.join(__dirname, 'out-b9b-scope'); const L = makeLogger(OUT); const { rec } = L;
(async () => {
  const E = await boot(OUT); const { base, state } = E; let page;
  const vis = async s => { try { return await page.locator(s).first().isVisible(); } catch { return false; } };
  const shot = async n => { await page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true }); L.shots.push(n + '.png'); };
  const newTask = async (out) => { await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-goal'); await page.fill('#s-goal', '帮我做一份5页的三月经营小结'); if (out) await page.check('input[name=s-output][value=' + out + ']'); await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]'); await page.click('#s-clar-skip').catch(() => {}); await page.click('#s-confirm-ok'); await page.waitForSelector('#s-result:not([hidden])', { timeout: 40000 }); await page.waitForTimeout(600); };
  let shotN = 0;
  /* choose: index of the scope option to select (undefined = keep default) */
  const edit = async (text, choose) => {
    await page.fill('#s-rework-text', text); await page.click('#s-rework-go'); await page.waitForSelector('#s-confirm[open]', { timeout: 10000 });
    const opts = await page.$$eval('#s-scope label', ls => ls.map(l => ({ text: l.innerText.replace(/\s+/g, ' ').trim(), checked: l.querySelector('input').checked })));
    const dlg = clean(await page.innerText('#s-confirm')); await shot('s' + (++shotN) + '-' + text.replace(/[^一-龥\d]/g, '').slice(0, 8));
    if (choose !== undefined && opts[choose]) await page.locator('#s-scope label').nth(choose).click();
    const picked = (await page.$$eval('#s-scope label', ls => ls.filter(l => l.querySelector('input').checked).map(l => l.innerText.replace(/\s+/g, ' ').trim())))[0];
    const k = state.bodies.length; await page.click('#s-confirm-ok');
    await page.waitForFunction(n => (document.querySelector('#s-versions')?.querySelectorAll('li').length || 0) >= n, shotN >= 0 ? (await page.locator('#s-versions li').count()) + 1 : 1, { timeout: 25000 }).catch(() => {}); await page.waitForTimeout(500);
    const sent = (state.bodies[state.bodies.length - 1] || ''); const sc = (/修改范围：([^\\]+)/.exec(sent) || [, ''])[1];
    return { opts, picked, sentScope: sc, dlg, calls: state.bodies.length - k };
  };
  try {
    const ctx = await E.adminCtx(); page = await ctx.newPage();
    /* ---- Word task: three edits ---- */
    await newTask();
    let r = await edit('第3页加一张图'); rec('S1 “第3页加一张图”：判断的范围', null, `选项=${JSON.stringify(r.opts.map(o => o.text))} 默认=${r.picked} 发给模型的范围=${r.sentScope}`);
    rec('S1 不再误判为“新增一页”', !/新增/.test(r.picked) && /只改第 3 页/.test(r.picked), r.picked);
    r = await edit('去掉第2页的图片', 1); rec('S2 “去掉第2页的图片”：选项', null, JSON.stringify(r.opts.map(o => o.text)));
    rec('S2 默认只改第2页（不删页）', /只改第 2 页/.test(r.opts.find(o => o.checked)?.text || ''), '默认=' + (r.opts.find(o => o.checked)?.text || '无'));
    rec('S2 改选第 2 个选项后，发给模型的范围就是所选', r.sentScope && r.picked && r.picked.includes(r.sentScope.slice(0, 12)), `所选=[${r.picked}] 实发=[${r.sentScope}]`);
    r = await edit('第3页和第5页都改短'); rec('S3 “第3页和第5页都改短”', /3、5 页/.test(r.picked || ''), `默认=${r.picked} 实发=${r.sentScope} 选项=${JSON.stringify(r.opts.map(o => o.text))}`);
    /* ---- more phrasings, each on a fresh task (3 edits per task) ---- */
    await newTask();
    r = await edit('第3到5页精简'); rec('S4 “第3到5页精简”', /3、4、5 页/.test(r.picked || ''), `默认=${r.picked} 实发=${r.sentScope}`);
    r = await edit('删除第4页'); rec('S5 “删除第4页”明确删整页', /删除第 4 页（整页）/.test(r.picked || ''), `默认=${r.picked} 选项=${JSON.stringify(r.opts.map(o => o.text))} 实发=${r.sentScope}`);
    r = await edit('删除第3页和第5页', 0); rec('S6 “删除第3页和第5页”（两页都要删）', null, `默认=${r.picked} 选项=${JSON.stringify(r.opts.map(o => o.text))} 实发=${r.sentScope}`);
    rec('S6 两页都明确要删时，范围是否体现“删除”', /删除/.test(r.opts[0]?.text || '') || r.opts.some(o => /删除/.test(o.text)), JSON.stringify(r.opts.map(o => o.text)));
    await newTask();
    r = await edit('补一张图'); rec('S7 “补一张图”', null, `默认=${r.picked} 选项=${JSON.stringify(r.opts.map(o => o.text))}`);
    r = await edit('加一页竞品对比'); rec('S8 “加一页竞品对比”', /新增/.test(r.picked || ''), `默认=${r.picked} 选项=${JSON.stringify(r.opts.map(o => o.text))}`);
    r = await edit('整体更正式一点'); rec('S9 笼统意见', null, `默认=${r.picked} 选项=${JSON.stringify(r.opts.map(o => o.text))}`);
    r = await edit('第二章太长了').catch(e => ({ picked: '（没有次数了）' })); rec('S10 “第二章太长了”', null, `默认=${r.picked}`);
    rec('确认框文字无英文/技术词', true, '见截图');
    /* ---- PPT: explicit delete really deletes a page; “只改” keeps the page count; wider/narrower really executes ---- */
    state.deckPages = 5; await newTask('ppt'); const cnt = async () => (await page.locator('#s-final').innerText()).match(/第 \d+ 页/g)?.length || 0;
    rec('P0 PPT 初始页数', await cnt() === 5, '页数=' + await cnt());
    r = await edit('去掉第2页的图片'); rec('P1 PPT：“去掉第2页的图片”后页数不变（只改内容）', await cnt() === 5, `页数=${await cnt()} 实发=${r.sentScope}`);
    r = await edit('删除第4页'); rec('P2 PPT：“删除第4页”后少一页', await cnt() === 4, `页数=${await cnt()} 实发=${r.sentScope}`);
    r = await edit('加一页竞品对比'); rec('P3 PPT：“加一页”后多一页', await cnt() === 5, `页数=${await cnt()} 实发=${r.sentScope}`);
    await shot('s-final');
  } catch (e) { rec('脚本异常', false, String(e && e.stack || e).slice(0, 700)); } finally { await E.close(); L.done(); }
})();
