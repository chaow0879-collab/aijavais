'use strict';
const { fs, path, clean, makeLogger, boot, buf } = require('./b9-common');
const OUT = process.env.QA_OUT || path.join(__dirname, 'out-b9a2'); const L = makeLogger(OUT); const { rec } = L;
(async () => {
  const E = await boot(OUT); const { base, state } = E;
  try {
    const ctx = await E.adminCtx(); const page = await ctx.newPage();
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-drop'); await page.fill('#s-goal', '根据资料写小结');
    const long = '开头标记ALPHA。' + '这是第二段内容，重复很多遍用来超过摘录上限。'.repeat(3500) + '结尾标记OMEGA。';
    await page.setInputFiles('#s-files', [buf('经营简报.docx'), { name: '很长的资料.md', mimeType: 'text/markdown', buffer: Buffer.from(long) }]);
    await page.waitForFunction(() => document.querySelectorAll('#s-file-list li.file-done').length === 2, null, { timeout: 20000 });
    await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]'); const dlg = clean(await page.innerText('#s-confirm')); await page.click('#s-clar-skip').catch(() => {}); await page.click('#s-confirm-ok');
    await page.waitForSelector('#s-result:not([hidden])', { timeout: 40000 });
    const b = state.bodies[0] || '';
    const i = b.indexOf('很长的资料.md');
    rec('T1 提示总长度', null, b.length + ' 字符');
    rec('T2 开头标记/结尾标记是否进了提示', null, 'ALPHA=' + b.includes('ALPHA') + ' OMEGA=' + b.includes('OMEGA'));
    rec('T3 长资料附近的说明', null, b.slice(i, i + 240).replace(/\\n/g, ' '));
    rec('T4 提示里与“截取/省略/开头/部分”有关的句子', null, [...b.matchAll(/[^。\\]{0,40}(只给了开头|截取|省略|被截|仅提供|部分内容)[^。\\]{0,50}/g)].map(m => m[0]).join(' || ') || '没有');
    rec('T5 确认框对截取的说明', /截取|开头|部分/.test(dlg), (/资料：[^。]*。[^。]*。/.exec(dlg) || [dlg.slice(0, 120)])[0]);
    const fin = clean(await page.locator('#s-final').innerText()); rec('T6 成果页上对截取的说明', /截取|开头|部分/.test(await page.evaluate(() => document.body.innerText)), fin.slice(0, 160));
  } catch (e) { rec('脚本异常', false, String(e && e.stack || e).slice(0, 500)); } finally { await E.close(); L.done(); }
})();
