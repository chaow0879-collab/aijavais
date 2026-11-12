'use strict';
/* QA-B8 (ProductQA, independent of tests/ui/b8-split.e2e.js): front/back split seen through an ordinary person's eyes.
 * Real server.js + SQLite + real Chromium + LOCAL MOCK model. E3. No paid calls. Observations are recorded, judgement is in the report. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const H = require('../helpers');

const OUT = process.env.QA_OUT || path.join(__dirname, 'out-b8');
fs.mkdirSync(OUT, { recursive: true });
const PASSW = 'xiaowang-pass-2026';
const rows = []; const shots = [];
const rec = (id, ok, note) => { rows.push({ id, ok, note }); console.log((ok === null ? 'NOTE ' : ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + String(note).slice(0, 520)); };
const clean = t => String(t).replace(/\s+/g, ' ').trim();
const BRAND = ['AIJAVAIS', 'Word', 'Excel', 'PPT', 'HALOFLUX'];
const eng = t => { let x = String(t); for (const w of BRAND) x = x.split(w).join(' '); return [...new Set(x.match(/[A-Za-z][A-Za-z_]{2,}/g) || [])]; };
const MODELNAME = /local-writer|priced-writer|本地写手|收费写手|本地模型 ·|自定义 ·|均衡/;
const TECH = /Token|token|USD|美元|\$|API|JSON|provider|capability|null|undefined|模型设置|管理中心|能力中心|智能立项|高级设置|管理后台|价格|单价|密钥|Key\b/;
let page;
const shot = async (n, p) => { await (p || page).screenshot({ path: path.join(OUT, n + '.png') }); shots.push(n + '.png'); };
const vis = async (s, p) => { try { return await (p || page).locator(s).first().isVisible(); } catch { return false; } };
const body = async p => clean(await (p || page).evaluate(() => document.body.innerText));

const jsonDeck = JSON.stringify({ slides: [{ layout: 'cover', title: '周末促销方案', subtitle: '小店' }, { layout: 'bullets', title: '为什么做', bullets: ['客流集中', '新客多'] }, { layout: 'cards', title: '三个动作', cards: [{ title: '半价', text: '第二杯' }, { title: '集章', text: '送小食' }, { title: '拼单', text: '减三元' }] }, { layout: 'summary', title: '总结', bullets: ['小成本', '好执行'] }] });

(async () => {
  let pptMode = false; const chats = [];
  const mock = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/models$/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'local-writer' }, { id: 'priced-writer' }] })); }
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const j = JSON.parse(b || '{}'); const real = j.max_tokens > 32; if (real) chats.push(j.model);
      const review = /审核上一步/.test(JSON.stringify(j.messages || ''));
      const text = !real ? '好' : review && pptMode ? jsonDeck : '周末促销方案：一、活动主题；二、优惠内容；三、宣传渠道；四、预算与分工。内容完整，可以直接使用。';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 400, completion_tokens: 600 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mp = mock.address().port;
  const app = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mp } });
  const base = 'http://localhost:' + app.port;
  const browser = await chromium.launch({ headless: true, env: { ...process.env, LANG: 'C.UTF-8' } });
  try {
    const api = (m, u, b) => app.call(m, u, b);
    const mk = async (extra) => (await api('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mp}/v1`, ...extra })).json.connection.connectionId;
    const localId = await mk({ modelId: 'local-writer', displayName: '本地写手', pricingMode: 'local', capabilities: ['writing', 'reasoning', 'chinese', 'data_analysis'] }); await api('POST', '/api/models/' + localId + '/test', {});
    const paidId = await mk({ modelId: 'priced-writer', displayName: '收费写手', pricingMode: 'paid_api', capabilities: ['writing', 'reasoning', 'chinese', 'data_analysis'], price: { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 1 } }); await api('POST', '/api/models/' + paidId + '/test', { approvePaid: true }); await api('POST', '/api/models/' + paidId + '/disable', {});
    const mkUser = async (name, cap) => (await api('POST', '/api/v2/users', { username: name, password: PASSW, monthlyCapCny: cap })).json.user.userId;
    const loginAs = async name => { const c = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, acceptDownloads: true }); const p = await c.newPage(); await p.goto(base + '/login.html'); await p.fill('#un', name); await p.fill('#upw', PASSW); await p.click('#userBtn'); await p.waitForURL(/workspace\.html/); await p.waitForTimeout(1000); return p; };
    const errs = p => p.evaluate(() => [...document.querySelectorAll('#s-error, #s-run-error, #s-budget-warn, #s-stop')].filter(e => e.offsetParent).map(e => e.innerText).join(' | ')).then(clean);

    /* ============ P2-3 admin: blank / zero / negative cap on the users page (real admin UI) ============ */
    const ac = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 }); const ap = await ac.newPage(); page = ap;
    await ac.addCookies([{ name: 'aij_session', value: H.cookies.get(app.port).split('=')[1], domain: 'localhost', path: '/' }]);
    await ap.goto(base + '/admin.html'); await ap.waitForSelector('#nav-users'); await ap.click('#nav-users'); await ap.waitForSelector('#pane-users.on');
    const tryAdd = async (name, cap) => { await ap.fill('#uName', name); await ap.fill('#uPw', PASSW); await ap.fill('#uCap', cap).catch(async () => { await ap.fill('#uCap', ''); }); await ap.click('#uAdd'); await ap.waitForTimeout(900); return clean(await ap.locator('#uRes').innerText()); };
    const listHas = async n => (await api('GET', '/api/v2/users')).json.users.some(u => u.username === n);
    let r = await tryAdd('blankcap', ''); rec('③ 管理员月上限留空', /请填每月上限/.test(r) && !/已新增/.test(r) && !(await listHas('blankcap')), `提示=[${r}] 账号被创建=${await listHas('blankcap')}`); await shot('p2-3-blank');
    r = await tryAdd('negcap', '-3'); rec('③ 月上限填负数', !(await listHas('negcap')) && !/已新增/.test(r), `提示=[${r}] 账号被创建=${await listHas('negcap')}`);
    r = await tryAdd('textcap', 'abc'); rec('③ 月上限填非数字（number 输入框只接受数字，等同留空）', !(await listHas('textcap')) && !/已新增/.test(r), `提示=[${r}] 账号被创建=${await listHas('textcap')}`);
    r = await tryAdd('bigcap', '999999'); rec('③ 月上限填超大数 999999', !(await listHas('bigcap')) && !/已新增/.test(r), `提示=[${r}] 账号被创建=${await listHas('bigcap')}`);
    r = await tryAdd('zerocap', '0'); rec('③ 月上限填 0（合法：不能用收费模型）', /已新增/.test(r) && await listHas('zerocap'), `提示=[${r}]`);
    r = await tryAdd('okuser', '5'); rec('③ 正常新增（上限 ¥5）', /已新增/.test(r) && await listHas('okuser'), `提示=[${r}]`);
    await ap.locator('#uBody tr', { hasText: 'okuser' }).locator('[data-u-act=cap]').click(); await ap.waitForSelector('#uCapNew'); await ap.fill('#uCapNew', ''); await ap.click('#uCapSave'); await ap.waitForTimeout(700);
    const mr = clean(await ap.locator('#uCapRes').innerText().catch(() => '')); rec('③ 修改上限时留空', /请填每月上限/.test(mr) && ((await api('GET', '/api/v2/users')).json.users.find(u => u.username === 'okuser').monthlyCapCny === 5), `提示=[${mr}] 上限仍为 ¥5`); await shot('p2-3-edit-blank'); await ap.keyboard.press('Escape'); await ap.click('[data-close]').catch(() => {});

    /* ============ P2-1/2 + P3 user pages ============ */
    const idA = await mkUser('userone', 5);
    let p = await loginAs('userone'); page = p;
    const scan = async (label, text) => { const bad = [...new Set(text.match(/密钥|管理中心|智能立项|管理后台|模型设置|能力中心|高级设置|Token|美元|USD|\$/g) || [])]; rec('① 前台页面无后台字样：' + label, bad.length === 0, '命中=' + (bad.join(',') || '无') + '；英文词=' + (eng(text).filter(w => w !== 'userone').join(',') || '无')); };
    await p.goto(base + '/workspace.html'); await p.waitForTimeout(1500); await shot('u1-home-empty'); const homeT = await body(p); await scan('首页(无任务)', homeT); rec('① 首页空任务提示原文', null, homeT.slice(0, 330));
    await p.goto(base + '/workspace.html?new=1'); await p.waitForSelector('#s-goal'); await shot('u2-new'); await scan('新建任务', await body(p));
    /* new-task confirm: no rework sentence, no model names */
    await p.fill('#s-goal', '给社区咖啡店写一份周末促销方案'); await p.click('#s-go'); await p.waitForSelector('#s-confirm[open]'); const nd = clean(await p.innerText('#s-confirm')); await shot('u3-new-confirm');
    rec('② 新任务确认框不含返工句', !/只重做|沿用已完成的初稿/.test(nd), nd); rec('P3 新任务确认框不含模型名', !MODELNAME.test(nd), '命中=' + (nd.match(MODELNAME) || []).join(','));
    await p.click('#s-confirm-ok'); await p.waitForSelector('#s-result:not([hidden]), #s-stop:not([hidden]), #s-run-error:not([hidden])', { timeout: 40000 }); await p.waitForTimeout(800); await shot('u4-progress');
    const prog = await body(p); await scan('进度/成果页', prog); rec('P3 进度页不含模型名', !MODELNAME.test(prog), '命中=' + (prog.match(MODELNAME) || []).join(',') + ' | 团队行：' + (/团队：[^。]*/.exec(prog) || [''])[0]);
    /* rework confirm: the rework sentence is back, quota line present */
    await p.click('#s-rework'); await p.fill('#s-rework-text', '再精炼一些'); await p.click('#s-rework-go'); await p.waitForSelector('#s-confirm[open]'); const rd = clean(await p.innerText('#s-confirm')); await shot('u5-rework-confirm');
    rec('② 返工确认框里有返工句（只在返工时）', /确认修改/.test(rd) && /只重做/.test(rd), rd); rec('P3 返工确认框不含模型名', !MODELNAME.test(rd), '命中=' + (rd.match(MODELNAME) || []).join(','));
    await p.click('#s-confirm-cancel');
    await p.goto(base + '/panel.html'); await p.waitForTimeout(1500); await scan('实时大屏(使用者)', await body(p));
    const entries = await p.$$eval('#aij-topbar a, #aij-topbar button', ns => ns.map(n => n.textContent.trim())); rec('回归：使用者顶栏 4 入口', JSON.stringify(entries.filter(x => x !== 'userone')) === JSON.stringify(['我的任务', '＋ 新建任务', '实时大屏', '退出']), JSON.stringify(entries));

    /* P3 403 page */
    const resp = await p.goto(base + '/admin.html'); await p.waitForTimeout(600); await shot('u6-403');
    const link = await p.evaluate(() => { const a = [...document.querySelectorAll('a')].find(x => /回到我的任务|我的任务/.test(x.textContent)); return a ? { text: a.textContent.trim(), href: a.getAttribute('href') } : null; });
    const styled = await p.evaluate(() => { const b = getComputedStyle(document.body); return { bg: b.backgroundColor, font: b.fontFamily.slice(0, 40) }; });
    rec('P3 403 页有“回到我的任务”链接', resp.status() === 403 && !!link, `HTTP ${resp.status()} 文字=[${(await body(p)).slice(0, 120)}] 链接=${JSON.stringify(link)} 样式=${JSON.stringify(styled)}`);
    if (link) { await p.click('a:has-text("我的任务")'); await p.waitForTimeout(1200); rec('P3 点“回到我的任务”能回前台', /workspace\.html/.test(p.url()), p.url().replace(base, '')); }
    for (const u of ['/capabilities.html', '/project-intake.html']) { const r2 = await p.goto(base + u); rec('P3 ' + u + ' 同样友好', r2.status() === 403 && /回到我的任务|我的任务/.test(await body(p)), (await body(p)).slice(0, 100)); }

    /* P3 disabled / password-reset reason on the login page */
    const idB = await mkUser('userdis', 5), idR = await mkUser('userreset', 5);
    const pd = await loginAs('userdis'); page = pd; await api('POST', '/api/v2/users/' + idB, { enabled: false }); await pd.goto(base + '/workspace.html'); await pd.waitForTimeout(1500); await shot('u7-disabled-bounce', pd);
    const dt = await body(pd); rec('P3 被停用后刷新：登录页说明原因', /停用/.test(dt), `地址=${pd.url().replace(base, '')} 文字=${dt.slice(0, 220)}`);
    const pr = await loginAs('userreset'); page = pr; await api('POST', '/api/v2/users/' + idR + '/password', { password: 'another-new-pass-88' }); await pr.goto(base + '/workspace.html'); await pr.waitForTimeout(1500); await shot('u8-reset-bounce', pr);
    const rt = await body(pr); rec('P3 改密后刷新：登录页说明原因', /密码|重新登录/.test(rt) && /重置|修改|更改|重新登录/.test(rt), `地址=${pr.url().replace(base, '')} 文字=${rt.slice(0, 220)}`);
    const pl = await loginAs('userone').catch(() => null);
    page = pd; await pd.goto(base + '/login.html'); const plain = await body(pd); rec('回归：直接打开登录页（正常，没有原因提示）', !/停用|重置/.test(plain), plain.slice(0, 140));

    /* P3 quota: warning BEFORE the confirm button */
    const idQ = await mkUser('userlow', 0.02); await api('POST', '/api/models/' + localId + '/disable', {}); await api('POST', '/api/models/' + paidId + '/enable', {});
    const pq = await loginAs('userlow'); page = pq; await pq.goto(base + '/workspace.html?new=1'); await pq.waitForSelector('#s-goal'); await pq.fill('#s-goal', '写一份会员招募文案'); await pq.click('#s-go'); await pq.waitForTimeout(1800);
    const dlgOpen = await vis('#s-confirm[open]', pq); const qd = dlgOpen ? clean(await pq.innerText('#s-confirm')) : ''; const qe = await errs(pq); await shot('u9-quota-low-confirm', pq);
    const confirmDisabled = dlgOpen ? await pq.locator('#s-confirm-ok').isDisabled() : null;
    rec('P3 额度不足：在确认框前/确认框里就提示', /额度/.test(qe + qd) && !(/最多不超过 ¥0\.10/.test(qd) && /还剩 ¥0\.02/.test(qd) && !/不够|只剩|超过/.test(qd)), `确认框=${dlgOpen} 确认按钮禁用=${confirmDisabled} | 确认框文字=[${qd.slice(0, 260)}] | 页面提示=[${qe}]`);
    if (dlgOpen) { await pq.click('#s-confirm-ok'); await pq.waitForTimeout(2000); rec('P3 额度不足：点确认后的提示', null, await errs(pq)); await shot('u10-quota-low-after', pq); }
    rec('P3 额度提示是人话', eng(qe + qd).length === 0 && !TECH.test(qe + qd), '英文词=' + eng(qe + qd).join(','));
    /* pure cap 0 / used up */
    const idZ = await mkUser('userzero', 0); const pz = await loginAs('userzero'); page = pz; await pz.goto(base + '/workspace.html?new=1'); await pz.waitForSelector('#s-goal'); await pz.fill('#s-goal', '写一份会员招募文案'); await pz.click('#s-go'); await pz.waitForTimeout(1800);
    rec('回归：月上限 ¥0 的使用者开始任务', null, `确认框=${await vis('#s-confirm[open]', pz)} 提示=[${await errs(pz)}] 确认框文字=[${(await vis('#s-confirm[open]', pz)) ? clean(await pz.innerText('#s-confirm')).slice(0, 200) : ''}]`); await shot('u11-zero-cap', pz);

    /* admin regression spot checks */
    await api('POST', '/api/models/' + localId + '/enable', {}); pptMode = true; page = ap;
    await ap.goto(base + '/workspace.html?new=1'); await ap.waitForSelector('#s-goal'); rec('回归：管理员顶栏', null, JSON.stringify(await ap.$$eval('#aij-topbar a, #aij-topbar button', ns => ns.map(n => n.textContent.trim()))));
    await ap.fill('#s-goal', '帮我做一份4页的店铺周末促销方案PPT'); await ap.check('input[name=s-output][value=ppt]'); await ap.fill('#s-budget-cny', '0.5'); await ap.click('#s-go'); await ap.waitForSelector('#s-confirm[open]', { timeout: 10000 });
    const ad = clean(await ap.innerText('#s-confirm')); rec('回归：管理员确认框 预算 ¥0.5', /最多不超过 ¥0\.50?/.test(ad), ad.slice(0, 220)); rec('回归：管理员确认框仍显示模型名（管理员可见）', null, '含模型名=' + MODELNAME.test(ad)); await ap.click('#s-confirm-ok');
    await ap.waitForSelector('#s-result:not([hidden]), #s-run-error:not([hidden])', { timeout: 40000 }); await ap.waitForTimeout(800);
    if (await vis('#s-download', ap)) { const [dl] = await Promise.all([ap.waitForEvent('download'), ap.click('#s-download')]); const f = path.join(OUT, 'admin.pptx'); await dl.saveAs(f); rec('回归：管理员 PPT 下载', fs.statSync(f).size > 5000, dl.suggestedFilename() + ' ' + fs.statSync(f).size); } else rec('回归：管理员 PPT 下载', false, '无下载按钮');
    await ap.goto(base + '/workspace.html'); await ap.waitForTimeout(1200); rec('回归：管理员“我的任务”', await vis('#home', ap), clean(await ap.locator('#home-sum').innerText().catch(() => '')));
    for (const u of ['/admin.html', '/capabilities.html', '/project-intake.html', '/panel.html']) { const r3 = await ap.goto(base + u); rec('回归：管理员打开 ' + u, r3.status() === 200, 'HTTP ' + r3.status()); }
  } catch (e) { rec('脚本异常', false, String(e && e.stack || e).slice(0, 700)); }
  finally { await browser.close(); await app.stop(); mock.close(); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ rows, shots, chats: chats.length }, null, 2)); console.log(`DONE rows=${rows.length} fail=${rows.filter(r => r.ok === false).length} mockCalls=${chats.length}`); }
})();
