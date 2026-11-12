'use strict';
/* QA-B9b ②: truncated materials are described in plain Chinese, numbers match what the model really received. */
const { fs, path, clean, eng, makeLogger, boot, buf, FX } = require('./b9-common');
const OUT = process.env.QA_OUT || path.join(__dirname, 'out-b9b-mat'); const L = makeLogger(OUT); const { rec } = L;
(async () => {
  const E = await boot(OUT); const { base, state } = E; let page;
  const shot = async n => { await page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true }); L.shots.push(n + '.png'); };
  const rows = () => page.$$eval('#s-file-list li', ls => ls.map(li => ({ name: li.querySelector('.fname')?.textContent, state: li.querySelector('.fstate')?.textContent })));
  const settle = n => page.waitForFunction(k => document.querySelectorAll('#s-file-list li.file-done').length >= k && !document.querySelector('#s-file-list li.file-busy'), n, { timeout: 30000 }).then(() => page.waitForTimeout(500));
  const mkText = (tag, chars) => { let s = tag + '开头。'; let i = 0; while (s.length < chars - 8) s += '这是第' + (++i) + '段内容，用来占位。'; return Buffer.from(s.slice(0, chars - 6) + tag + '结尾。'); };
  const run = async () => { state.bodies.length = 0; await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]', { timeout: 15000 }); const dlg = clean(await page.innerText('#s-confirm')); await shot('m-confirm-' + Date.now() % 1000); await page.click('#s-clar-skip').catch(() => {}); await page.click('#s-confirm-ok'); await page.waitForSelector('#s-result:not([hidden]), #s-stop:not([hidden]), #s-run-error:not([hidden])', { timeout: 40000 }); await page.waitForTimeout(600); return dlg; };
  try {
    const ctx = await E.adminCtx(); page = await ctx.newPage();
    /* A: nothing truncated */
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-drop'); await page.fill('#s-goal', '根据资料写小结');
    rec('A0 上传区说明（还没传文件）', null, clean(await page.locator('#s-files-hint').innerText()));
    await page.setInputFiles('#s-files', [buf('经营简报.docx'), buf('销量表.xlsx')]); await settle(2);
    rec('A1 未截取：文件行', null, JSON.stringify(await rows())); rec('A1 未截取：上传区说明', null, clean(await page.locator('#s-files-hint').innerText()));
    let dlg = await run(); rec('A2 未截取：确认框写“全部资料内容”', /全部资料内容|拿到全部/.test(dlg) && !/没被使用|没用上|只用前/.test(dlg), (/资料：[^。]*。[^。]*。?/.exec(dlg) || [dlg.slice(0, 160)])[0]);
    /* B: one long file */
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-drop'); await page.fill('#s-goal', '根据资料写小结');
    await page.setInputFiles('#s-files', [buf('经营简报.docx'), { name: '很长的资料.md', mimeType: 'text/markdown', buffer: mkText('长甲', 77000) }]); await settle(2); await shot('m-B-upload');
    const rowsB = await rows(); rec('B1 长文件：每个文件旁的说明', null, JSON.stringify(rowsB));
    rec('B1 长文件旁用人话写明“只用前 N 字/第 N+1 字之后没被使用”', /前\s*[\d,]+\s*字/.test(rowsB.find(r => r.name === '很长的资料.md')?.state || '') && /之后没被使用|没被使用/.test(rowsB.find(r => r.name === '很长的资料.md')?.state || ''), rowsB.find(r => r.name === '很长的资料.md')?.state || '');
    rec('B1 短文件旁没有截取说明', !/没被使用|没用上/.test(rowsB.find(r => r.name === '经营简报.docx')?.state || ''), rowsB.find(r => r.name === '经营简报.docx')?.state || '');
    rec('B2 上传区总说明', null, clean(await page.locator('#s-files-hint').innerText()));
    dlg = await run(); rec('B3 确认框里的资料说明', null, (/资料：[\s\S]{0,420}/.exec(dlg) || [''])[0]);
    rec('B3 确认框写明起草/审核各用了多少', /起草/.test(dlg) && /审核/.test(dlg) && /(没被使用|没用上)/.test(dlg), (/[^。]*起草[^。]*。[^。]*审核[^。]*。/.exec(dlg) || ['无'])[0]);
    rec('B3 未截取的话术不再出现', !/拿到全部资料内容/.test(dlg), '“全部资料内容”出现=' + /全部资料内容/.test(dlg));
    // numbers vs reality: what each role's prompt really contains
    const claimed = [...dlg.matchAll(/前\s*([\d,]+)\s*字/g)].map(m => Number(m[1].replace(/,/g, '')));
    const inPrompt = b => { const i = b.indexOf('长甲开头'); if (i < 0) return { present: false, chars: 0, hasEnd: false }; const seg = b.slice(i); const m = /长甲结尾/.test(seg); const upto = seg.search(/\\n\\n\[资料\]|（资料太长|\\n（/); return { present: true, hasEnd: m, firstChars: (seg.match(/这是第(\d+)段内容/g) || []).length * 12 }; };
    const d0 = state.bodies[0] || '', d1 = state.bodies[1] || '';
    const seg = b => { const i = b.indexOf('长甲开头'); if (i < 0) return ''; const rest = b.slice(i); const j = rest.search(/（资料太长|\\n\\n\[资料\]|Previous|\\n\\nQuality/); return j > 0 ? rest.slice(0, j) : rest.slice(0, 40000); };
    const len0 = seg(d0).length, len1 = seg(d1).length;
    rec('B4 起草员实际收到的该文件字数', null, `${len0} 字（含结尾标记=${/长甲结尾/.test(seg(d0))}）；提示里的截取说明=${(/资料太长[^\\]{0,80}/.exec(d0) || ['无'])[0]}`);
    rec('B4 审核员实际收到的该文件字数', null, `${len1} 字（含结尾标记=${/长甲结尾/.test(seg(d1))}）；提示里的截取说明=${(/资料太长[^\\]{0,80}/.exec(d1) || ['无'])[0]}`);
    rec('B4 界面写的数字与起草员实际收到的一致（误差 ≤ 3%）', claimed.length > 0 && Math.abs(claimed[0] - len0) / Math.max(1, len0) <= 0.03, `界面数字=${JSON.stringify(claimed)} 实际=${len0}`);
    /* C: several files that together exceed the per-role budget */
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-drop'); await page.fill('#s-goal', '根据资料写小结');
    await page.setInputFiles('#s-files', [{ name: '资料甲.md', mimeType: 'text/markdown', buffer: mkText('甲', 20000) }, { name: '资料乙.md', mimeType: 'text/markdown', buffer: mkText('乙', 20000) }, { name: '资料丙.md', mimeType: 'text/markdown', buffer: mkText('丙', 20000) }, { name: '资料丁.md', mimeType: 'text/markdown', buffer: mkText('丁', 20000) }]); await settle(4); await shot('m-C-upload');
    rec('C1 四个 2 万字文件：每个文件旁的说明', null, JSON.stringify(await rows()));
    const stC = (await rows()).map(r => r.state).join(' ');
    rec('C1 总量超出时，至少有一个文件旁写明“起草时没用上/只用了前 N 字”', /没用上|没被使用|只用/.test(stC), stC.slice(0, 260));
    dlg = await run(); rec('C2 确认框', null, (/资料：[\s\S]{0,520}/.exec(dlg) || [''])[0]);
    const used = tag => ({ d: new RegExp(tag + '开头').test(state.bodies[0] || ''), dEnd: new RegExp(tag + '结尾').test(state.bodies[0] || ''), r: new RegExp(tag + '开头').test(state.bodies[1] || ''), rEnd: new RegExp(tag + '结尾').test(state.bodies[1] || '') });
    for (const t of ['甲', '乙', '丙', '丁']) rec('C3 文件“资料' + t + '”实际：起草员收到' , null, JSON.stringify(used(t)));
    /* D: user view of the same */
    await E.mkUser('userone', 5); const up = await E.loginAs('userone'); page = up;
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-drop'); await page.fill('#s-goal', '根据资料写小结');
    await page.setInputFiles('#s-files', [{ name: '很长的资料.md', mimeType: 'text/markdown', buffer: mkText('长乙', 77000) }]); await settle(1); await shot('m-D-user-upload');
    rec('D1 使用者看到的文件说明', null, JSON.stringify(await rows())); dlg = await run(); rec('D2 使用者确认框的资料说明', null, (/资料：[\s\S]{0,420}/.exec(dlg) || [''])[0]);
    const bad = /密钥|管理中心|模型设置|Token|美元|local-writer|本地写手/.test(dlg); rec('D3 使用者确认框无后台字样/模型名', !bad && eng(dlg, ['local-writer']).length === 0, '英文词=' + eng(dlg).join(','));
    /* result page: any note about cut materials? */
    rec('E 成果页是否提到资料被截取', null, /截取|没被使用|没用上/.test(await page.evaluate(() => document.body.innerText)) ? '有说明' : '没有说明');
  } catch (e) { rec('脚本异常', false, String(e && e.stack || e).slice(0, 700)); } finally { await E.close(); L.done(); }
})();
