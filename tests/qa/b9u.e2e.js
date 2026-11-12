'use strict';
/* QA-B9 草稿 + 使用者身份 + 额度不足降级. Observations recorded for the report. */
const { fs, path, clean, eng, TECH, makeLogger, boot, buf, FX } = require('./b9-common');
const OUT = process.env.QA_OUT || path.join(__dirname, 'out-b9u');
const L = makeLogger(OUT); const { rec } = L;

(async () => {
  const E = await boot(OUT); const { base, api, state } = E; let page;
  const shot = async (n, p) => { await (p || page).screenshot({ path: path.join(OUT, n + '.png'), fullPage: true }); L.shots.push(n + '.png'); };
  const vis = async (s, p) => { try { return await (p || page).locator(s).first().isVisible(); } catch { return false; } };
  const body = async p => clean(await (p || page).evaluate(() => document.body.innerText));
  const BANNED = /密钥|管理中心|智能立项|管理后台|模型设置|能力中心|高级设置|Token|美元|USD|\$|local-writer|priced-writer|本地写手|收费写手|本地模型 ·/;
  const scan = async (label, p) => { const t = await body(p); const bad = [...new Set(t.match(new RegExp(BANNED.source, 'g')) || [])]; const en = eng(t, ['userone', ...fs.readdirSync(FX), 'txt', 'xlsx', 'docx']).filter(w => !/^(pptx|pdf|png|csv)$/i.test(w)); rec('使用者页面扫描：' + label, bad.length === 0 && en.length === 0, `后台/模型字样=${bad.join(',') || '无'} 英文词=${en.join(',') || '无'}`); };
  try {
    /* ============ draft flow (admin) ============ */
    const ac = await E.adminCtx(); page = await ac.newPage();
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-drop');
    rec('D0 新建页没有上传时没有“草稿”提示', !(await vis('#s-draft-row')), '草稿行可见=' + await vis('#s-draft-row'));
    await page.fill('#s-goal', '还没想好的任务'); await page.setInputFiles('#s-files', [buf('会议纪要.md', 'text/markdown')]);
    await page.waitForFunction(() => /已读取/.test(document.querySelector('#s-file-list').textContent), null, { timeout: 15000 }); await page.waitForTimeout(500);
    rec('D1 上传后出现草稿说明', /草稿/.test(await page.locator('#s-draft-row').innerText()), clean(await page.locator('#s-draft-row').innerText())); await shot('d1-draft-row');
    const draftId = await page.evaluate(() => sessionStorage.getItem('aij.b9.draft'));
    /* leave via 我的任务 */
    await page.click('#aij-home'); await page.waitForSelector('#home-groups', { timeout: 8000 }).catch(() => {}); await page.waitForTimeout(1500); await shot('d2-home-with-draft');
    const homeT = clean(await page.locator('#home').innerText().catch(() => ''));
    rec('D2 离开后在“我的任务”里能看到草稿卡', /草稿/.test(homeT), homeT.slice(0, 300));
    rec('D2 草稿卡写了什么', null, clean(await page.locator('#home-groups a[href*="draft="]').first().innerText().catch(() => '（没找到草稿卡）')));
    await page.click('#home-groups a[href*="draft="]'); await page.waitForURL(/draft=/); await page.waitForTimeout(1500); await shot('d3-draft-reopened');
    rec('D3 点草稿卡：回到新建表单，资料还在', await vis('#simple') && (await page.locator('#s-file-list li').count()) === 1, `表单=${await vis('#simple')} 文件数=${await page.locator('#s-file-list li').count()} 目标=[${await page.inputValue('#s-goal')}]`);
    /* discard: two confirmations */
    const label0 = clean(await page.locator('#s-draft-del').innerText()); await page.click('#s-draft-del'); await page.waitForTimeout(400);
    const label1 = clean(await page.locator('#s-draft-del').innerText());
    rec('D4 “放弃草稿”第一次点：变成再次确认', label0 !== label1 && /再点一次|确定/.test(label1), `点前=[${label0}] 点后=[${label1}]`); await shot('d4-discard-confirm');
    const stillThere = (await api('GET', '/api/v2/projects/' + draftId)).status; rec('D4 第一次点后草稿还没被删', stillThere === 200, 'HTTP ' + stillThere);
    await page.click('#s-draft-del'); await page.waitForTimeout(1500);
    rec('D4 第二次点：草稿和资料一起删除', (await api('GET', '/api/v2/projects/' + draftId)).status === 404 && (await page.locator('#s-file-list li').count()) === 0, `项目 HTTP ${(await api('GET', '/api/v2/projects/' + draftId)).status}；提示=[${clean(await page.locator('#s-busy').innerText().catch(() => ''))}]`); await shot('d5-discarded');
    await page.goto(base + '/workspace.html'); await page.waitForTimeout(1200);
    rec('D5 删除后“我的任务”里没有草稿卡', !(await vis('#home-groups a[href*="draft="]')), '草稿卡可见=' + await vis('#home-groups a[href*="draft="]'));
    /* 30-day cleanup is described; started task is not a draft */
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-goal'); await page.fill('#s-goal', '开始后不再是草稿'); await page.setInputFiles('#s-files', [buf('备忘.txt', 'text/plain')]); await page.waitForFunction(() => /已读取/.test(document.querySelector('#s-file-list').textContent)); await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]'); await page.click('#s-clar-skip').catch(() => {}); await page.click('#s-confirm-ok');
    await page.waitForSelector('#s-result:not([hidden]), #s-stop:not([hidden]), #s-run-error:not([hidden])', { timeout: 40000 }); await page.goto(base + '/workspace.html'); await page.waitForTimeout(1200);
    rec('D6 已开始的任务不会再出现草稿卡', !(await vis('#home-groups a[href*="draft="]')), clean(await page.locator('#home-sum').innerText().catch(() => '')));

    /* ============ user identity ============ */
    await E.mkUser('userone', 5); const up = await E.loginAs('userone'); page = up;
    await up.goto(base + '/workspace.html?new=1'); await up.waitForSelector('#s-drop'); await scan('新建页', up);
    await up.fill('#s-goal', '根据资料写一份三月经营小结'); await up.setInputFiles('#s-files', [buf('经营简报.docx'), buf('销量表.xlsx'), buf('扫描件.pdf'), buf('门店照片.png', 'image/png'), buf('旧合同.doc')]);
    await up.waitForFunction(() => document.querySelectorAll('#s-file-list li').length >= 5 && !document.querySelector('#s-file-list li.file-busy'), null, { timeout: 25000 }); await up.waitForTimeout(600); await shot('u1-uploads', up); await scan('上传后（含扫描件/图片/旧格式）', up);
    state.bodies.length = 0; state.clars.length = 0; await up.click('#s-go'); await up.waitForSelector('#s-confirm[open]', { timeout: 15000 }); await shot('u2-confirm', up);
    const ud = clean(await up.innerText('#s-confirm')); rec('U1 使用者确认框（理解/问题/计划/额度）', null, ud.slice(0, 520));
    rec('U1 使用者确认框无后台字样/模型名', !BANNED.test(ud) && eng(ud).length === 0, '命中=' + ((ud.match(new RegExp(BANNED.source, 'g')) || []).join(',') || '无') + ' 英文词=' + eng(ud).join(','));
    await up.click('#s-confirm-ok'); await up.waitForSelector('#s-result:not([hidden]), #s-stop:not([hidden]), #s-run-error:not([hidden])', { timeout: 40000 }); await up.waitForTimeout(800); await shot('u3-result', up); await scan('成果页', up);
    rec('U2 使用者的资料到了岗位', /复购率为 38%/.test(state.bodies[0] || '') && /桂花拿铁/.test(state.bodies[0] || ''), '');
    rec('U2 成果里有出处', /出处：/.test(clean(await up.locator('#s-final').innerText())), clean(await up.locator('#s-final').innerText()).slice(0, 160));
    await up.fill('#s-rework-text', '只改第3页'); await up.click('#s-rework-go'); await up.waitForSelector('#s-confirm[open]'); const rd = clean(await up.innerText('#s-confirm')); await shot('u4-rework', up);
    rec('U3 使用者的修改确认框（范围/旧版保留/还能改几次/额度）', /只改第 3 页/.test(rd) && /旧版本保留/.test(rd) && /还可以再修改/.test(rd) && /本月额度/.test(rd), rd.slice(0, 420));
    rec('U3 修改确认框无后台字样/模型名', !BANNED.test(rd), '命中=' + ((rd.match(new RegExp(BANNED.source, 'g')) || []).join(',') || '无'));
    await up.click('#s-confirm-ok'); await up.waitForFunction(() => (document.querySelector('#s-versions')?.querySelectorAll('li').length || 0) >= 2, null, { timeout: 25000 }).catch(() => {}); await up.waitForTimeout(800); await scan('修改后（含版本记录）', up);
    rec('U3 使用者的版本记录', null, clean(await up.locator('#s-versions').innerText().catch(() => '')));
    /* user draft */
    await up.click('#aij-new'); await up.waitForSelector('#s-drop'); await up.setInputFiles('#s-files', [buf('备忘.txt', 'text/plain')]); await up.waitForFunction(() => /已读取/.test(document.querySelector('#s-file-list').textContent)); await up.click('#aij-home'); await up.waitForTimeout(1500); await shot('u5-user-home-draft', up);
    rec('U4 使用者首页有草稿卡', await vis('#home-groups a[href*="draft="]', up), clean(await up.locator('#home-groups').innerText().catch(() => '')).slice(0, 200)); await scan('首页(有草稿)', up);
    await up.click('#home-groups a[href*="draft="]'); await up.waitForTimeout(1200); await up.click('#s-draft-del'); await up.waitForTimeout(300); const ul = clean(await up.locator('#s-draft-del').innerText()); await up.click('#s-draft-del'); await up.waitForTimeout(1200);
    rec('U4 使用者两次确认放弃草稿', /再点一次|确定/.test(ul) && !(await vis('#home-groups a[href*="draft="]', up)), `第一次点后=[${ul}]`);

    /* ============ low quota: clarify degrades to rule-based questions, never blocks ============ */
    await E.api('POST', '/api/models/' + E.localId + '/disable', {}); await E.api('POST', '/api/models/' + E.paidId + '/enable', {});
    await E.mkUser('userlow', 0.005); const lp = await E.loginAs('userlow'); page = lp;
    await lp.goto(base + '/workspace.html?new=1'); await lp.waitForSelector('#s-goal'); await lp.fill('#s-goal', '写一份会员招募文案');
    rec('Q1 额度很低时，点之前的说明', null, clean(await lp.locator('#s-clar-note').innerText())); const calls0 = state.calls;
    await lp.click('#s-go'); await lp.waitForTimeout(2500); const dlgOpen = await vis('#s-confirm[open]', lp); await shot('q1-low-quota', lp);
    rec('Q1 额度很低时：不调用模型读懂需求', state.calls === calls0, `模型调用 ${calls0}→${state.calls}`);
    const qd = dlgOpen ? clean(await lp.innerText('#s-confirm')) : '';
    rec('Q1 额度很低时：降级为规则问题（或明确提示），不卡死', dlgOpen ? (await lp.locator('#s-clar-questions > *').count()) > 0 : /额度/.test(await body(lp)), `确认框=${dlgOpen} 问题数=${dlgOpen ? await lp.locator('#s-clar-questions > *').count() : 0} 说明=[${clean(await lp.locator('#s-clar-cost').innerText().catch(() => ''))}] 页面提示=[${clean(await lp.locator('#s-error').innerText().catch(() => ''))}] 框=${qd.slice(0, 260)}`);
    await scan('额度很低时', lp);
  } catch (e) { rec('脚本异常', false, String(e && e.stack || e).slice(0, 800)); }
  finally { await E.close(); L.done(); }
})();
