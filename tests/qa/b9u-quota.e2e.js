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
    await E.api('POST', '/api/models/' + E.localId + '/disable', {}); await E.api('POST', '/api/models/' + E.paidId + '/enable', {});
    for (const [name, cap] of [['capmid', 0.10], ['capmid2', 0.105], ['caproom', 0.5]]) {
      await E.mkUser(name, cap); const p = await E.loginAs(name); page = p; const c0 = state.calls;
      await p.goto(base + '/workspace.html?new=1'); await p.waitForSelector('#s-goal'); await p.fill('#s-goal', '写一份会员招募文案'); await p.click('#s-go'); await p.waitForTimeout(2500);
      const open = await vis('#s-confirm[open]', p); const dq = open ? clean(await p.innerText('#s-confirm')) : '';
      rec('Q ' + name + '（月上限 ¥' + cap + '）点开始', null, `确认框=${open} 读懂需求调用=${state.calls - c0} 问题数=${open ? await p.locator('#s-clar-questions > *').count() : 0} 说明=[${clean(await p.locator('#s-clar-cost').innerText().catch(() => ''))}] 提示=[${clean(await p.locator('#s-error').innerText().catch(() => ''))}] 框=${dq.slice(0, 330)}`);
      await shot('q-' + name, p);
      if (open) { await p.click('#s-confirm-ok'); await p.waitForSelector('#s-result:not([hidden]), #s-stop:not([hidden]), #s-run-error:not([hidden])', { timeout: 40000 }).catch(() => {}); await p.waitForTimeout(800); rec('Q ' + name + ' 点确认后', null, clean(await p.evaluate(() => [...document.querySelectorAll('#s-error, #s-run-error, #s-stop, #s-result')].filter(e => e.offsetParent).map(e => e.innerText).join(' | '))).slice(0, 260)); }
    }
  } catch (e) { rec('脚本异常', false, String(e && e.stack || e).slice(0, 800)); }
  finally { await E.close(); L.done(); }
})();
