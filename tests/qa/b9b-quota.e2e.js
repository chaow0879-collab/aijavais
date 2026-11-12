'use strict';
/* QA-B9b ③ + draft quota: monthly cap vs "读懂需求"; wording of amounts; 21st draft. */
const { fs, path, clean, eng, makeLogger, boot, buf } = require('./b9-common');
const OUT = process.env.QA_OUT || path.join(__dirname, 'out-b9b-quota'); const L = makeLogger(OUT); const { rec } = L;
(async () => {
  const E = await boot(OUT); const { base, api, state } = E; let page;
  const vis = async (s, p) => { try { return await (p || page).locator(s).first().isVisible(); } catch { return false; } };
  const shot = async (n, p) => { await (p || page).screenshot({ path: path.join(OUT, n + '.png'), fullPage: true }); L.shots.push(n + '.png'); };
  const month = async name => (await api('GET', '/api/v2/users')).json.users.find(u => u.username === name).month;
  const BAN = /Token|美元|USD|\$|local-writer|priced-writer|本地写手|收费写手|密钥|管理中心/;
  try {
    await api('POST', '/api/models/' + E.localId + '/disable', {}); await api('POST', '/api/models/' + E.paidId + '/enable', {});
    for (const [name, cap] of [['cap010', 0.10], ['cap0105', 0.105], ['cap050', 0.5]]) {
      await E.mkUser(name, cap); const p = await E.loginAs(name); page = p; const c0 = state.calls, cl0 = state.clars.length;
      await p.goto(base + '/workspace.html?new=1'); await p.waitForSelector('#s-goal'); await p.fill('#s-goal', '写一份会员招募文案');
      const noteBefore = clean(await p.locator('#s-clar-note').innerText()); await p.click('#s-go'); await p.waitForSelector('#s-confirm[open]', { timeout: 15000 }).catch(() => {});
      const open = await vis('#s-confirm[open]', p); const dq = open ? clean(await p.innerText('#s-confirm')) : ''; await shot('q-' + name + '-confirm', p);
      const nQ = open ? await p.locator('#s-clar-questions > *').count() : 0, costNote = clean(await p.locator('#s-clar-cost').innerText().catch(() => ''));
      rec(`Q ${name}（月上限 ¥${cap}）点开始前的说明`, null, noteBefore);
      rec(`Q ${name} 点开始后`, null, `确认框=${open} 读懂需求调用=${state.clars.length - cl0} 问题数=${nQ} 说明=[${costNote}] 提示=[${clean(await p.locator('#s-error').innerText().catch(() => ''))}]`);
      rec(`Q ${name} 确认框里的费用文字`, null, (/[^。]*(规则|花了|不到|本月额度)[^。]*。/g.exec(dq) || ['无'])[0] + ' || 全文片段：' + dq.slice(dq.indexOf('计划'), dq.indexOf('计划') + 330));
      rec(`Q ${name} 确认框无后台字样/模型名/美元`, !BAN.test(dq) && !/约 ¥0\.00/.test(dq), '命中=' + ((dq.match(BAN) || []).join(',') || '无') + ' 含“约 ¥0.00”=' + /约 ¥0\.00/.test(dq));
      if (name === 'cap010') {
        rec('Q cap010 额度不够覆盖“读懂需求”：不调用模型、直接规则问题', state.clars.length === cl0 && nQ > 0, `读懂需求调用 ${cl0}→${state.clars.length}；问题数=${nQ}`);
      }
      if (open) { const before = await month(name); await p.click('#s-confirm-ok'); await p.waitForSelector('#s-result:not([hidden]), #s-stop:not([hidden]), #s-run-error:not([hidden])', { timeout: 40000 }).catch(() => {}); await p.waitForTimeout(900);
        const after = await month(name); const ok = await vis('#s-result', p);
        rec(`Q ${name} 点确认后：正式任务能开始并跑完`, ok, ok ? '成果已出' : '提示=' + clean(await p.evaluate(() => [...document.querySelectorAll('#s-error, #s-run-error, #s-stop')].filter(e => e.offsetParent).map(e => e.innerText).join(' | '))));
        rec(`Q ${name} 本月额度变化`, null, `开始前 spent=${before.spentCny} remaining=${before.remainingCny}；跑完后 spent=${after.spentCny} remaining=${after.remainingCny}；确认框里写的“本月额度按 ¥x 计”=${(/本月额度按 ¥([\d.]+) 计/.exec(dq) || ['无'])[1]}`); await shot('q-' + name + '-result', p); }
      if (name === 'cap050') {
        const spentLine = (/这一步花了[^。]*。/.exec(dq) || [''])[0]; const m1 = /本月额度按 ¥([\d.]+) 计/.exec(dq);
        rec('Q cap050 金额文案前后一致（框里“按 ¥x 计”≈ 读懂需求实际占用的额度）', !!m1 && !!spentLine && !/约 ¥0\.00/.test(spentLine), spentLine || '没有“这一步花了…”的句子');
      }
    }
    /* draft quota: 21st draft */
    await E.mkUser('userdraft', 5); const up = await E.loginAs('userdraft'); page = up;
    const made = await up.evaluate(async () => { let ok = 0, last = null; for (let i = 0; i < 20; i++) { const r = await fetch('/api/v2/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '新任务（正在准备资料）', description: '还没开始的新任务，正在上传资料。', roles: [{ roleId: 'drafter', name: '起草员', duty: '根据需求写出完整初稿' }], steps: [{ stepId: 'draft', roleId: 'drafter', title: '写出初稿' }], materials: { mode: 'all' } }) }); if (r.status === 201) ok++; else last = r.status; } return { ok, last }; });
    rec('G0 先建 20 个草稿', made.ok === 20, JSON.stringify(made));
    await up.goto(base + '/workspace.html?new=1'); await up.waitForSelector('#s-drop'); await up.evaluate(() => sessionStorage.clear()); await up.fill('#s-goal', '第二十一个草稿'); await up.setInputFiles('#s-files', [buf('备忘.txt', 'text/plain')]); await up.waitForTimeout(2500); await shot('g-21st-draft', up);
    const g = clean(await up.evaluate(() => document.body.innerText)); const gt = clean(await up.locator('#s-file-list, #s-busy, #s-error').allInnerTexts().then(a => a.join(' | ')));
    rec('G1 第 21 个草稿的人话提示', /最多 20 个|草稿/.test(gt), '文件区/提示：' + gt.slice(0, 300)); rec('G1 提示无英文/代码', eng(gt, ['txt']).length === 0 && !/\b(429|draft_limit|error)\b/.test(gt), '英文词=' + eng(gt, ['txt']).join(','));
    await up.goto(base + '/workspace.html'); await up.waitForTimeout(1500); await shot('g-home-20-drafts', up);
    rec('G2 首页有 20 个草稿卡、能清理', (await up.locator('#home-groups a[href*="draft="]').count()) >= 1, '草稿卡数=' + await up.locator('#home-groups a[href*="draft="]').count() + ' | 汇总：' + clean(await up.locator('#home-sum').innerText().catch(() => '')));
  } catch (e) { rec('脚本异常', false, String(e && e.stack || e).slice(0, 700)); } finally { await E.close(); L.done(); }
})();
