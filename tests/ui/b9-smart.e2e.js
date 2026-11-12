'use strict';
/* B9 in real Chromium against the real server + SQLite and a LOCAL MOCK model (no paid API).
 * B9a 资料上传：新建任务页拖拽/点击上传、多选；人话状态（页数/字数/表格张数/图片/扫描件）；可删除；超限用人话说明；
 *     资料真的交给每个岗位：MOCK 收到的请求体里有 docx 和 xlsx 的内容和“注明出处”的要求；页面上没有英文和 JSON。 */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const H = require('../helpers');
const FIX = path.join(__dirname, '..', 'fixtures', 'files');

const SHOTS = process.env.UI_SHOTS || null;
const results = [];
const ok = name => { results.push(name); console.log('PASS', name); };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
(async () => {
  const bodies = [], clars = [];
  const CLAR = JSON.stringify({ understanding: '我理解你要的是一份季度复盘总结，重点讲满意度和销量。', questions: [{ question: '主要给谁看？', options: ['领导', '团队内部'] }, { question: '要多长？', options: ['一页', '三页'] }], plan: { draft: '根据资料写出三页初稿', review: '核对数字和出处并定稿' } });
  const mock = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const j = JSON.parse(body || '{}');
      const all = JSON.stringify(j.messages || ''), isClar = all.includes('你是任务助理');
      if (j.max_tokens > 32) (isClar ? clars : bodies).push(all);
      const reply = j.max_tokens <= 32 ? '好' : isClar ? (all.includes('MOCK_BAD') ? '好的！请问你要给谁看？' : CLAR) : all.includes('Previous version of the deliverable') ? '第二版：精简后的季度复盘，满意度 92%（出处：report.docx）。' : '根据资料，本季度客户满意度 92%（出处：report.docx）。华东销量 120（出处：sales.xlsx）。';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mp = mock.address().port;
  const app = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mp } });
  const base = 'http://localhost:' + app.port;
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'b9-' + name + '.png'), fullPage: true }); } };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const ck = H.cookies.get(app.port).split('=');
  await ctx.addCookies([{ name: ck[0], value: ck.slice(1).join('='), domain: 'localhost', path: '/' }]);
  // 页面上不应出现英文单词或 JSON（文件名是用户自己的，产品名缩写 Word/Excel/PPT/PDF 等是格式名）
  const ALLOWED = /\b(Word|Excel|PPT|PDF|TXT|MD|CSV|MB|UTF)\b/g;
  const noEnglish = (text, names, where) => {
    let t = text; for (const n of names) t = t.split(n).join('');
    t = t.replace(ALLOWED, '');
    assert.doesNotMatch(t, /[A-Za-z]{2,}/, where + ' has English: ' + (t.match(/.{0,20}[A-Za-z]{2,}.{0,20}/) || [''])[0]);
    assert.doesNotMatch(t, /[{[]\s*"/, where + ' has JSON');
  };
  const fileState = (page, name) => page.$eval('#s-file-list', (ul, n) => { const li = [...ul.children].find(x => x.querySelector('.fname').textContent === n); return li ? li.querySelector('.fstate').textContent : null; }, name);
  try {
    const add = await app.call('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mp}/v1`, modelId: 'local-writer', displayName: '本地写手', pricingMode: 'local', capabilities: ['writing', 'reasoning'] });
    assert.equal(add.status, 200, add.text);
    assert.equal((await app.call('POST', '/api/models/' + add.json.connection.connectionId + '/test', {})).json.ok, true);

    const page = await ctx.newPage();
    const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
    await page.goto(base + '/workspace.html?new=1'); await page.waitForSelector('#s-drop');
    assert.match(await page.innerText('#s-files-hint'), /Word、Excel、PPT、PDF、TXT、MD、CSV 和图片；单个文件不超过 8 MB/);
    await page.fill('#s-goal', '根据上传的资料写一份季度复盘总结');

    /* ---- click-to-choose, multi-select: docx + xlsx + png ---- */
    const chooser = page.waitForEvent('filechooser'); await page.click('#s-drop'); const fc = await chooser;
    assert.equal(fc.isMultiple(), true, 'multi-select');
    const buf = (name, mimeType) => ({ name, mimeType, buffer: fs.readFileSync(path.join(FIX, name)) });
    await fc.setFiles([buf('report.docx', 'application/octet-stream'), buf('sales.xlsx', 'application/octet-stream'), { name: '门店照片.png', mimeType: 'image/png', buffer: PNG }]);
    await page.waitForFunction(() => document.querySelectorAll('#s-file-list li').length === 3 && !document.querySelector('#s-file-list li.file-busy'), null, { timeout: 15000 });
    assert.equal(await fileState(page, 'report.docx'), '已读取 148 字');
    assert.equal(await fileState(page, 'sales.xlsx'), '表格 2 张，已读取 178 字');
    assert.equal(await fileState(page, '门店照片.png'), '图片已保存（当前模型不会看图）');
    ok('click to choose, multi-select: docx / xlsx / image each show a plain status (字数、表格张数、图片不会看)');

    /* ---- drag and drop a markdown note ---- */
    await page.evaluate(() => {
      const dt = new DataTransfer(); dt.items.add(new File(['# 会议纪要\n下季度重点：会员复购，目标 35%。'], '会议纪要.md', { type: 'text/markdown' }));
      const zone = document.getElementById('s-drop');
      zone.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => /已读取/.test([...document.querySelectorAll('#s-file-list li')].find(li => li.textContent.includes('会议纪要.md'))?.textContent || ''), null, { timeout: 10000 });
    ok('drag and drop uploads too');

    /* ---- limits and unsupported types in plain words, nothing sent to the server ---- */
    const big = Buffer.alloc(8 * 1024 * 1024 + 10, 0x61);
    await page.setInputFiles('#s-files', [{ name: '超大.txt', mimeType: 'text/plain', buffer: big }, { name: '旧合同.doc', mimeType: 'application/msword', buffer: Buffer.from('x') }, { name: '程序.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') }]);
    await page.waitForFunction(() => document.querySelectorAll('#s-file-list li').length === 7);
    assert.match(await fileState(page, '超大.txt'), /^「超大\.txt」有 8 MB，超过了单个文件 8 MB 的上限，请压缩或拆分后再传。$/);
    assert.equal(await fileState(page, '旧合同.doc'), '「旧合同.doc」是旧版 Word 格式，请先另存为 .docx 再上传。');
    assert.match(await fileState(page, '程序.exe'), /这种文件暂时读不了。可以上传 Word、Excel、PPT、PDF、TXT、MD、CSV 和图片/);
    // a file whose content does not match its extension: the server's Chinese reason is shown, not a code
    await page.setInputFiles('#s-files', [{ name: '假文档.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('not a zip') }]);
    await page.waitForFunction(() => /没有上传成功/.test(document.querySelector('#s-file-list').textContent));
    assert.match(await fileState(page, '假文档.docx'), /^「假文档\.docx」没有上传成功：文件内容和它的类型对不上（可能改过扩展名，或者文件已损坏），请用原来的软件重新另存后再传。$/);
    await shot(page, '1-files');
    noEnglish(await page.innerText('#simple'), ['report.docx', 'sales.xlsx', '门店照片.png', '会议纪要.md', '超大.txt', '旧合同.doc', '程序.exe', '假文档.docx', '.docx', '.doc'], 'new-task page');
    ok('size limit, old Office formats, unsupported and mismatched files are explained in plain Chinese');

    /* ---- delete: image removed on the server, error rows removed locally ---- */
    const draftId = await page.evaluate(() => sessionStorage.getItem('aij.b9.draft'));
    assert.match(draftId, /^[\w-]+$/);
    const del = async name => page.click(`#s-file-list li:has(.fname:text-is("${name}")) button`);
    for (const n of ['门店照片.png', '超大.txt', '旧合同.doc', '程序.exe', '假文档.docx']) { await del(n); await page.waitForFunction(x => ![...document.querySelectorAll('#s-file-list .fname')].some(s => s.textContent === x), n); }
    const onServer = (await app.call('GET', '/api/v2/projects/' + draftId + '/files')).json.files.map(f => f.filename).sort();
    assert.deepEqual(onServer, ['report.docx', 'sales.xlsx', '会议纪要.md'].sort());
    ok('删除 removes the file from the task (server) and error rows from the list');

    /* ---- reload keeps the not-yet-started draft's materials ---- */
    await page.reload(); await page.waitForFunction(() => document.querySelectorAll('#s-file-list li.file-done').length === 3, null, { timeout: 10000 });
    ok('reloading the new-task page restores the uploaded materials');

    /* ---- start: confirm shows the materials; every role gets them ---- */
    await page.fill('#s-goal', '根据上传的资料写一份季度复盘总结');
    assert.equal(await page.innerText('#s-clar-note'), '点开始后，会先读懂需求、问你几个问题（本机模型，不花钱），确认后才正式开始。');
    await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]');
    const dlg = await page.innerText('#s-confirm');
    /* B9b: the dialog first says what was understood, asks (model questions), shows the plan */
    assert.equal(clars.length, 1); assert.match(clars[0], /\[资料\] report\.docx（共 148 字）/, 'the clarification reads the start of the materials');
    assert.equal(await page.innerText('#s-clar-understanding'), '一份季度复盘总结，重点讲满意度和销量。');
    assert.match(dlg, /1\. 主要给谁看？[\s\S]*领导[\s\S]*团队内部[\s\S]*其它[\s\S]*2\. 要多长？/);
    assert.equal(await page.innerText('#s-clar-plan'), '计划：起草员：根据资料写出三页初稿 → 审核员：核对数字和出处并定稿。');
    assert.match(dlg, /理解需求用的是本机模型，不花钱。/);
    await page.check('input[name=s-clar-q0][value="领导"]');
    await page.check('input[name=s-clar-q1][value="__other"]'); await page.fill('#s-clar-other-1', '两页半');
    assert.match(dlg, /资料：3 个文件，能读到的文字共 \d+ 字。每个岗位都会拿到全部资料内容。/);
    noEnglish(dlg, ['local-writer'], 'confirm dialog'); // the model's own ID is a name
    await shot(page, '2-confirm');
    await page.click('#s-confirm-ok');
    await page.waitForSelector('#s-progress:not([hidden])');
    await page.waitForFunction(() => !document.querySelector('#s-result').hidden, null, { timeout: 20000 });
    assert.equal(bodies.length, 2, 'draft + review: ' + bodies.length);
    for (const [i, b] of bodies.entries()) {
      const who = i ? 'reviewer' : 'drafter';
      assert.match(b, /客户满意度 92%/, who + ' gets the docx text'); assert.match(b, /华东\\t120/, who + ' gets the xlsx cells');
      assert.match(b, /会员复购，目标 35%/, who + ' gets the dropped note');
      assert.match(b, /\[资料\] report\.docx/); assert.match(b, /\[资料\] sales\.xlsx/);
      assert.match(b, /引用以上资料中的内容时，请在相应句子后注明出处文件名/, who + ' is asked to cite the source file');
    }
    assert.match(bodies[1], /对照资料核实引用的内容和出处/);
    for (const b of bodies) { assert.match(b, /对需求的理解：我理解你要的是一份季度复盘总结/); assert.match(b, /问：主要给谁看？\\n答：领导\\n问：要多长？\\n答：两页半/); }
    assert.match(bodies[0], /本步重点：根据资料写出三页初稿/); assert.match(bodies[1], /本步重点：核对数字和出处并定稿/);
    assert.match(bodies[1], /根据资料，本季度客户满意度 92%/, 'reviewer also gets the previous role output');
    const run = (await app.call('GET', '/api/v2/runs/' + new URL(page.url()).searchParams.get('run'))).json.run;
    assert.equal(run.projectId, draftId, 'the task is the draft that holds the materials');
    assert.equal(run.materials.length, 3);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('aij.b9.draft')), null, 'draft forgotten after start');
    assert.match(await page.innerText('#s-final'), /出处：report\.docx/);
    noEnglish(await page.innerText('#s-progress'), ['report.docx', 'sales.xlsx', 'local-writer'], 'progress page');
    await shot(page, '3-result');
    ok('MOCK request bodies of BOTH roles contain the docx and xlsx content plus the cite-the-source instruction; the run uses the draft task');
    ok('B9b: understanding, model questions with clickable options + 其它, plain plan; the answers reach both roles\' prompts');

    /* ---- B9c 对话式修改 ---- */
    await page.waitForSelector('#s-rework-box:not([hidden])'); await page.waitForSelector('#s-versions-box:not([hidden])');
    assert.match(await page.innerText('#s-versions'), /第 1 版（当前）\s*最初的成果/);
    assert.equal(await page.innerText('#s-chat-left'), '这个任务还可以修改 3 次。');
    await page.fill('#s-rework-text', '第3页太啰嗦，精简一下'); await page.click('#s-rework-go'); await page.waitForSelector('#s-confirm[open]');
    const rdlg = await page.innerText('#s-confirm');
    assert.match(rdlg, /确认修改/); assert.match(rdlg, /会在上一版的基础上修改，改完是新的一版，旧版本保留/);
    assert.match(await page.innerText('#s-scope'), /^只改第 3 页的内容（页数不变），其它部分逐字保留\s*按意见修改；意见没有提到的部分尽量保持原样$/);
    assert.equal(await page.isChecked('#s-scope input >> nth=0'), true, 'the detected scope is preselected');
    assert.match(rdlg, /确认后这个任务还可以再修改 2 次/);
    const k0 = bodies.length; await page.click('#s-confirm-cancel'); await page.waitForTimeout(500);
    assert.equal(bodies.length, k0, 'cancelled: no model call without a new confirmation');
    await page.click('#s-rework-go'); await page.waitForSelector('#s-confirm[open]'); await page.click('#s-confirm-ok');
    await page.waitForFunction(() => /第 2 版（当前）/.test(document.querySelector('#s-versions')?.textContent || ''), null, { timeout: 20000 });
    assert.equal(bodies.length - k0, 1, 'only the review step reruns');
    assert.match(bodies.at(-1), /Previous version of the deliverable[\s\S]*根据资料，本季度客户满意度 92%/, 'starts from version 1');
    assert.match(bodies.at(-1), /修改意见：第3页太啰嗦，精简一下\\n修改范围：只改第 3 页/);
    assert.match(await page.innerText('#s-versions'), /第 1 版\s*最初的成果[\s\S]*第 2 版（当前）\s*你说：第3页太啰嗦，精简一下/);
    assert.match(await page.innerText('#s-final'), /第二版：精简后的季度复盘/);
    assert.equal(await page.innerText('#s-chat-left'), '这个任务还可以修改 2 次。');
    // view and download the old version
    await page.click('#s-versions li:nth-child(1) button:has-text("查看")');
    assert.match(await page.innerText('#s-final'), /根据资料，本季度客户满意度 92%/); assert.match(await page.innerText('#s-viewing'), /正在看第 1 版（旧版本）/);
    await page.evaluate(() => { window.__dl = []; document.addEventListener('click', e => { if (e.target.tagName === 'A' && e.target.download) window.__dl.push(e.target.download); }, true); });
    const dl = page.waitForEvent('download'); await page.click('#s-versions li:nth-child(1) button:has-text("下载")'); const file = await dl;
    assert.deepEqual(await page.evaluate(() => window.__dl), ['Word 文档-第1版.docx'], 'the old version is saved under its version name');
    const X = require('../../lib/file-extract'), oldDoc = await X.extractFile('v1.docx', fs.readFileSync(await file.path()));
    assert.match(oldDoc.text, /根据资料，本季度客户满意度 92%/); assert.doesNotMatch(oldDoc.text, /第二版/);
    noEnglish(await page.innerText('#s-result'), ['report.docx', 'sales.xlsx'], 'result page with versions');
    await shot(page, '5-versions');
    ok('B9c: 对话式修改 -> RMB confirmation (cancel sends nothing) -> version 2 from version 1 with the scope; version 1 still viewable and downloadable');

    /* ---- a new task starts empty ---- */
    await page.click('#s-new'); await page.waitForSelector('#simple:not([hidden])');
    assert.equal(await page.locator('#s-file-list li').count(), 0);
    ok('＋ 新建任务 starts with an empty materials list');

    /* ---- QA-B9 P2-②: a long file says which part is not used ---- */
    await page.setInputFiles('#s-files', [{ name: '长报告.txt', mimeType: 'text/plain', buffer: Buffer.from('甲'.repeat(35000)) }]);
    await page.waitForFunction(() => /已读取/.test(document.querySelector('#s-file-list').textContent), null, { timeout: 10000 });
    assert.equal(await fileState(page, '长报告.txt'), '已读取 3.5 万字。起草时只用前 30000 字，第 30001 字之后没被使用；审核时只用前 20000 字，第 20001 字之后没被使用');
    await page.click('#s-preview'); await page.waitForSelector('#s-plan:not([hidden])');
    assert.match(await page.innerText('#s-plan-note'), /资料比较长，岗位只用得上一部分：「长报告\.txt」起草时只用前 30000 字，第 30001 字之后没被使用/);
    await page.click('#s-file-list li:has(.fname:text-is("长报告.txt")) button'); await page.waitForFunction(() => !document.querySelector('#s-file-list li'));
    ok('QA-B9 P2-②: a cut file says in plain words which part is not used (upload list and plan note)');

    /* ---- B9b 跳过：按理解来做 ---- */
    await page.fill('#s-goal', '写一份门店周报'); await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]');
    await page.click('#s-clar-skip'); assert.equal(await page.isVisible('#s-clar-questions'), false);
    const n0 = bodies.length; await page.click('#s-confirm-ok');
    for (let i = 0; i < 200 && bodies.length - n0 < 2; i++) await page.waitForTimeout(50);
    await page.waitForFunction(() => !document.querySelector('#s-result').hidden, null, { timeout: 20000 });
    assert.equal(bodies.length - n0, 2);
    for (const b of bodies.slice(n0)) { assert.match(b, /用户选择跳过提问：按以上理解来做/); assert.doesNotMatch(b, /问：主要给谁看/); }
    ok('B9b 跳过，按你的理解来: the run starts and the roles are told to follow the understanding');

    /* ---- B9b bad JSON from the model -> rule-based questions; same requirement is not asked twice ---- */
    await page.click('#s-new'); await page.waitForSelector('#simple:not([hidden])');
    await page.fill('#s-goal', 'MOCK_BAD 写一份放假通知'); const c0 = clars.length;
    await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]');
    assert.equal(clars.length - c0, 1);
    assert.equal(await page.innerText('#s-clar-cost'), '模型这次的回答不合格，已改用按规则列出的问题；');
    assert.match(await page.innerText('#s-clar-understanding'), /^：MOCK_BAD 写一份放假通知。成果是一份Word 文档。$|^MOCK_BAD 写一份放假通知。成果是一份Word 文档。$/);
    assert.match(await page.innerText('#s-clar-questions'), /篇幅大概多长？[\s\S]*主要给谁看？/);
    await shot(page, '4-rules');
    await page.click('#s-confirm-cancel');
    await page.click('#s-go'); await page.waitForSelector('#s-confirm[open]'); await page.click('#s-confirm-cancel');
    assert.equal(clars.length - c0, 1, 'no second paid call for the same requirement');
    ok('B9b: a bad JSON reply falls back to rule-based questions (no dead end); re-opening does not call again');
    assert.deepEqual(pageErrors, []);

    /* ---- B8 front user: uploads to their own task, the materials reach the roles too ---- */
    const PASS = 'user-password-123';
    assert.equal((await app.call('POST', '/api/v2/users', { username: 'xiaozhang', password: PASS, monthlyCapCny: 5 })).status, 201);
    const uctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }), up = await uctx.newPage();
    await up.goto(base + '/login.html'); await up.fill('#un', 'xiaozhang'); await up.fill('#upw', PASS); await up.click('#userBtn');
    await up.waitForURL(/\/workspace\.html/); await up.waitForFunction(() => document.body.dataset.role === 'user');
    await up.click('#aij-new'); await up.waitForSelector('#s-drop');
    await up.fill('#s-goal', '根据资料写一页销售小结');
    await up.setInputFiles('#s-files', [{ name: 'sales.xlsx', mimeType: 'application/octet-stream', buffer: fs.readFileSync(path.join(FIX, 'sales.xlsx')) }]);
    await up.waitForFunction(() => /表格 2 张/.test(document.querySelector('#s-file-list').textContent), null, { timeout: 10000 });
    const userDraft = await up.evaluate(() => sessionStorage.getItem('aij.b9.draft'));
    const before = bodies.length;
    await up.click('#s-go'); await up.waitForSelector('#s-confirm[open]');
    assert.match(await up.innerText('#s-confirm'), /资料：1 个文件/);
    await up.click('#s-confirm-ok'); await up.waitForSelector('#s-progress:not([hidden])');
    await up.waitForFunction(() => !document.querySelector('#s-result').hidden, null, { timeout: 20000 });
    assert.equal(bodies.length - before, 2);
    for (const b of bodies.slice(before)) assert.match(b, /华东\\t120/);
    noEnglish(await up.innerText('#s-progress'), ['sales.xlsx', 'report.docx'], 'user progress page');
    // AUD-FEB8-01: an unfinished draft is on 我的任务, opens with its materials, and can be discarded
    await up.click('#aij-new'); await up.waitForSelector('#s-drop');
    await up.setInputFiles('#s-files', [{ name: '草稿资料.md', mimeType: 'text/markdown', buffer: Buffer.from('# 草稿\n还没想好要做什么') }]);
    await up.waitForFunction(() => /已读取/.test(document.querySelector('#s-file-list').textContent));
    const keep = await up.evaluate(() => sessionStorage.getItem('aij.b9.draft'));
    assert.match(await up.innerText('#s-draft-row'), /这是一个还没开始的草稿，资料已保存（30 天不动会自动清理）/);
    await up.evaluate(() => sessionStorage.clear()); // a later visit: only 我的任务 knows the draft
    await up.click('#aij-home'); await up.waitForSelector(`#home-groups a[href*="draft=${keep}"]`);
    await up.click(`#home-groups a[href*="draft=${keep}"]`); await up.waitForURL(/\?draft=/);
    await up.waitForFunction(() => /草稿资料\.md/.test(document.querySelector('#s-file-list').textContent));
    assert.equal(await up.isVisible('#simple'), true);
    await up.click('#s-draft-del'); assert.equal(await up.innerText('#s-draft-del'), '确定删除？再点一次');
    await up.click('#s-draft-del'); await up.waitForFunction(() => /草稿和资料已删除/.test(document.querySelector('#s-busy').textContent));
    assert.equal(await up.locator('#s-file-list li').count(), 0);
    assert.equal(await up.evaluate(async id => (await fetch('/api/v2/projects/' + id)).status, keep), 404, 'the draft and its files are gone on the server');
    ok('AUD-FEB8-01: a user\'s unfinished draft is on 我的任务, reopens with its materials, and 放弃这个草稿 deletes it (two clicks)');
    // the user's draft is theirs only: another account cannot read its files
    const stranger = await app.call('POST', '/api/v2/users', { username: 'xiaoli', password: PASS, monthlyCapCny: 5 });
    assert.equal(stranger.status, 201);
    const lc = await browser.newContext(), lp = await lc.newPage();
    await lp.goto(base + '/login.html'); await lp.fill('#un', 'xiaoli'); await lp.fill('#upw', PASS); await lp.click('#userBtn'); await lp.waitForURL(/\/workspace\.html/);
    assert.equal(await lp.evaluate(async id => (await fetch('/api/v2/projects/' + id + '/files')).status, userDraft), 404);
    ok('user account: uploads materials to their own task, roles receive them; another user gets 404 on those files');
    console.log('\nB9 BROWSER CHECKS PASSED:', results.length);
  } finally {
    await browser.close(); await app.stop(); mock.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
