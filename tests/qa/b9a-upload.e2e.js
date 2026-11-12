'use strict';
/* QA-B9a: 资料上传 (admin identity). Independent of the developer's e2e. Observations recorded for the report. */
const { fs, path, clean, eng, TECH, makeLogger, boot, buf, FX } = require('./b9-common');
const OUT = process.env.QA_OUT || path.join(__dirname, 'out-b9a');
const L = makeLogger(OUT); const { rec } = L;

(async () => {
  const E = await boot(OUT); const { base, browser, api, state } = E;
  let page;
  const shot = async (n, p) => { await (p || page).screenshot({ path: path.join(OUT, n + '.png'), fullPage: true }); L.shots.push(n + '.png'); };
  const fileRows = () => page.$$eval('#s-file-list li', ls => ls.map(li => ({ name: li.querySelector('.fname')?.textContent, state: li.querySelector('.fstate')?.textContent, cls: li.className })));
  const waitIdle = () => page.waitForFunction(() => document.querySelectorAll('#s-file-list li').length > 0 && !document.querySelector('#s-file-list li.file-busy'), null, { timeout: 25000 });
  try {
    const ctx = await E.adminCtx(); page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(String(e)));
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-drop'); await page.waitForTimeout(500);
    rec('0 上传区说明文字', null, clean(await page.locator('#s-drop').innerText()) + ' | ' + clean(await page.locator('#s-files-hint').innerText()));
    await shot('a0-upload-area');
    await page.fill('#s-goal', '根据上传的资料写一份三月经营小结');

    /* ---- click-to-choose, multi-select, every supported type ---- */
    const chooser = page.waitForEvent('filechooser'); await page.click('#s-drop'); const fc = await chooser;
    rec('1 点击选择文件：可多选', fc.isMultiple(), 'isMultiple=' + fc.isMultiple());
    await fc.setFiles([buf('经营简报.docx'), buf('销量表.xlsx'), buf('活动复盘.pptx'), buf('文字版.pdf'), buf('扫描件.pdf'), buf('门店照片.png', 'image/png'), buf('客户名单.csv'), buf('会议纪要.md'), buf('备忘.txt')]);
    await waitIdle(); await page.waitForTimeout(600); await shot('a1-all-types');
    const rows1 = await fileRows(); for (const r of rows1) rec('1 文件状态：' + r.name, null, r.state);
    const wantStates = { '经营简报.docx': /字/, '销量表.xlsx': /表格 \d 张/, '活动复盘.pptx': /页|字/, '文字版.pdf': /页|字/, '扫描件.pdf': /扫描|读不到文字/, '门店照片.png': /不会看图/, '客户名单.csv': /字|行|表格/, '会议纪要.md': /字/, '备忘.txt': /字/ };
    for (const [n, re] of Object.entries(wantStates)) { const r = rows1.find(x => x.name === n); rec('1 状态说明合理：' + n, !!r && re.test(r.state || ''), r ? r.state : '没有这一行'); }
    rec('1 状态文字无英文/JSON', eng(rows1.map(r => (r.state || '')).join(' '), rows1.map(r => r.name)).length === 0, '英文词=' + eng(rows1.map(r => (r.state || '')).join(' '), rows1.map(r => r.name)).join(','));

    /* ---- drag and drop ---- */
    await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(['拖进来的一条备注：周五截止。'], '拖拽备注.txt', { type: 'text/plain' })); const z = document.getElementById('s-drop'); z.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true })); z.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })); z.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); });
    await page.waitForFunction(() => [...document.querySelectorAll('#s-file-list li')].some(li => li.textContent.includes('拖拽备注.txt') && /已读取/.test(li.textContent)), null, { timeout: 10000 }).catch(() => {});
    rec('2 拖拽上传', (await fileRows()).some(r => r.name === '拖拽备注.txt' && /已读取/.test(r.state || '')), JSON.stringify((await fileRows()).find(r => r.name === '拖拽备注.txt')));

    /* ---- limits / unsupported / mismatched ---- */
    await page.setInputFiles('#s-files', [buf('超大.txt', 'text/plain'), buf('旧合同.doc'), buf('程序.exe'), buf('假文档.docx')]);
    await page.waitForFunction(() => document.querySelectorAll('#s-file-list li').length >= 14, null, { timeout: 25000 }); await page.waitForTimeout(800); await shot('a2-bad-files');
    const rows2 = await fileRows();
    for (const n of ['超大.txt', '旧合同.doc', '程序.exe', '假文档.docx']) { const r = rows2.find(x => x.name === n); rec('3 异常文件的提示：' + n, null, r ? r.state : '没有这一行'); }
    const badTxt = rows2.filter(r => ['超大.txt', '旧合同.doc', '程序.exe', '假文档.docx'].includes(r.name)).map(r => r.state).join(' ');
    rec('3 异常提示是中文人话（无英文/代码/JSON）', eng(badTxt, ['doc', 'docx', 'exe', 'txt']).length === 0 && !/[{[]\s*"|\b(400|413|415|422|error|code)\b/i.test(badTxt), '英文词=' + eng(badTxt, ['doc', 'docx', 'exe', 'txt']).join(','));
    rec('3 异常提示都给了下一步（改格式/压缩/重新另存）', /压缩|拆分/.test(badTxt) && /另存/.test(badTxt), badTxt.slice(0, 260));

    /* ---- delete ---- */
    const draftId = await page.evaluate(() => sessionStorage.getItem('aij.b9.draft')); rec('4 草稿任务已建立', !!draftId, draftId);
    const del = n => page.click(`#s-file-list li:has(.fname:text-is("${n}")) button`);
    await del('备忘.txt'); await page.waitForTimeout(900);
    const onServer = (await api('GET', '/api/v2/projects/' + draftId + '/files')).json.files.map(f => f.filename);
    rec('4 删除一个已上传的文件：界面和服务器都没了', !(await fileRows()).some(r => r.name === '备忘.txt') && !onServer.includes('备忘.txt'), '服务器上剩 ' + onServer.length + ' 个');
    for (const n of ['超大.txt', '旧合同.doc', '程序.exe', '假文档.docx']) { await del(n).catch(() => {}); await page.waitForTimeout(250); }
    rec('4 失败的行也能清掉', !(await fileRows()).some(r => ['超大.txt', '旧合同.doc', '程序.exe', '假文档.docx'].includes(r.name)), JSON.stringify((await fileRows()).map(r => r.name)));
    await page.reload(); await page.waitForTimeout(1800); await shot('a3-after-reload');
    rec('4 刷新页面后资料还在', (await fileRows()).length >= 8, '刷新后文件数=' + (await fileRows()).length);

    /* ---- many files over the limit (50) and one huge text (truncation note) ---- */
    const longText = '很长的资料。' + '这是第二段内容，重复很多遍用来超过摘录上限。'.repeat(1200);
    await page.setInputFiles('#s-files', [{ name: '很长的资料.md', mimeType: 'text/markdown', buffer: Buffer.from(longText) }]);
    await page.waitForFunction(() => [...document.querySelectorAll('#s-file-list li')].some(li => li.textContent.includes('很长的资料.md') && /已读取/.test(li.textContent)), null, { timeout: 15000 }).catch(() => {});
    rec('5 很长的资料的状态', null, JSON.stringify((await fileRows()).find(r => r.name === '很长的资料.md')));

    /* ---- start (admin, free local model): materials really used ---- */
    state.bodies.length = 0; state.clars.length = 0;
    await page.fill('#s-goal', '根据上传的资料写一份三月经营小结'); await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]', { timeout: 15000 });
    const dlg = clean(await page.innerText('#s-confirm')); await shot('a4-confirm');
    rec('6 确认框里说明了资料', /资料：\d+ 个文件/.test(dlg), (/资料：[^。]*。[^。]*。/.exec(dlg) || [''])[0]);
    await page.click('#s-clar-skip').catch(() => {}); await page.click('#s-confirm-ok');
    await page.waitForSelector('#s-result:not([hidden]), #s-stop:not([hidden]), #s-run-error:not([hidden])', { timeout: 40000 }); await page.waitForTimeout(800); await shot('a5-result');
    const final = clean(await page.locator('#s-final').innerText());
    rec('7 成果里有出处文件名', /出处：/.test(final) && /经营简报\.docx/.test(final), final.slice(0, 220));
    const body0 = state.bodies[0] || '', body1 = state.bodies[1] || '';
    for (const [who, b] of [['起草员', body0], ['审核员', body1]]) {
      rec('7 ' + who + ' 的提示里有 docx 内容', /复购率为 38%/.test(b), /复购率为 38%/.test(b) ? '有' : '没有');
      rec('7 ' + who + ' 的提示里有 xlsx 内容', /桂花拿铁/.test(b) && /燕麦拿铁/.test(b), '');
      rec('7 ' + who + ' 的提示里要求注明出处文件名', /注明出处文件名/.test(b), '');
    }
    rec('7 PPT/PDF/CSV/MD/TXT 内容也进了提示', /活动回顾|雨天客流/.test(body0) && /金卡/.test(body0) && /集章活动/.test(body0) && /周三补货/.test(body0), '' + ['活动回顾', '金卡', '集章活动', '周三补货', '周末客流占全周'].map(k => k + '=' + body0.includes(k)).join(' '));
    rec('7 扫描件 PDF / 图片：提示里如实标注读不到', /\[资料\] 扫描件\.pdf（读不到文字）|扫描件\.pdf[^\\]*读不到/.test(body0), (/扫描件\.pdf[^\\]{0,40}/.exec(body0) || [''])[0]);
    rec('7 被截取的长资料有说明', /只给了开头一部分|已截取|截取/.test(body0), (/很长的资料\.md[^\\]{0,80}/.exec(body0) || [''])[0] + ' | 提示尾部说明=' + (/(只给了开头一部分|已截取)[^\\]{0,40}/.exec(body0) || ['无'])[0]);
    const prog = clean(await page.evaluate(() => document.body.innerText));
    rec('7 进度/成果页无英文与技术词', eng(prog, ['local-writer', ...fs.readdirSync(FX)]).length === 0, '英文词=' + eng(prog, ['local-writer', ...fs.readdirSync(FX)]).join(','));
    rec('页面脚本错误', errs.length === 0, errs.join(' | ') || '无');
  } catch (e) { rec('脚本异常', false, String(e && e.stack || e).slice(0, 700)); }
  finally { await E.close(); L.done(); }
})();
