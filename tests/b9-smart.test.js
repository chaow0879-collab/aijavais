'use strict';
// B9a: plain-language material status, upload checks, materials in the cost estimate, and per-role truncation
// that is disclosed to the model ("已截取前 N 字"). Local model fixture only; no paid provider is called.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const H = require('./helpers');
const Plan = require('../public/smart-plan.js');

const PAID = [{ connectionId: 'c1', providerId: 'deepseek', modelId: 'deepseek-v4-flash', capabilities: ['writing', 'reasoning'], price: { inputPerMillion: 2, outputPerMillion: 8, currency: 'CNY' }, enabled: true }];
const meta = (kind, status, chars, m = {}) => ({ kind, extraction: { status, chars, meta: m } });

test('B9a: every file gets one plain sentence (pages / chars / sheets / image / scanned PDF)', () => {
  const s = f => Plan.fileStatus(f).text;
  assert.equal(s(meta('pdf', 'ok', 12345, { pages: 3 })), '已读取 3 页 / 1.2 万字');
  assert.equal(s(meta('docx', 'ok', 148)), '已读取 148 字');
  assert.equal(s(meta('xlsx', 'ok', 178, { sheets: [{}, {}] })), '表格 2 张，已读取 178 字');
  assert.equal(s(meta('pptx', 'ok', 900, { slides: 12 })), '已读取 12 页幻灯片 / 900 字');
  assert.equal(s(meta('table', 'ok', 40)), '表格 1 张，已读取 40 字');
  assert.equal(s(meta('image', 'metadata_only', 0)), '图片已保存（当前模型不会看图）');
  assert.equal(s(meta('pdf', 'no_text', 0, { pages: 4 })), '这个 PDF 是扫描件，读不到文字');
  assert.equal(s(meta('pdf', 'tool_unavailable', 0)), 'PDF 已保存，但服务器暂时读不了 PDF 里的文字');
  assert.equal(Plan.fileStatus(meta('image', 'metadata_only', 0)).ok, false);
});

test('B9a: size limits, old Office formats and server errors are explained in Chinese, never as codes', () => {
  assert.equal(Plan.checkUpload({ name: '报告.docx', size: 1000 }), '');
  assert.match(Plan.checkUpload({ name: '大.pdf', size: 9 * 1024 * 1024 }), /^「大\.pdf」有 9 MB，超过了单个文件 8 MB 的上限/);
  assert.match(Plan.checkUpload({ name: '旧.xls', size: 10 }), /旧版 Excel 格式，请先另存为 \.xlsx/);
  assert.match(Plan.checkUpload({ name: 'a.exe', size: 10 }), /这种文件暂时读不了/);
  assert.match(Plan.checkUpload({ name: '空.txt', size: 0 }), /空文件/);
  assert.equal(Plan.uploadError({ message: 'Upload needs filename and contentBase64', status: 400 }, 'a.txt'), '「a.txt」没有上传成功，请再试一次。');
  assert.equal(Plan.uploadError({ message: 'Body too large', status: 413 }, 'a.txt'), '「a.txt」太大了，单个文件不能超过 8 MB。');
  assert.match(Plan.uploadError({ message: '每个项目最多 50 个资料文件', status: 413, code: 'file_limit' }, 'a.txt'), /每个项目最多 50 个资料文件/);
  assert.doesNotMatch(Plan.uploadError({ message: '文件损坏：ZIP 目录项无效', code: 'corrupt_file' }, 'a.docx'), /ZIP/);
});

test('B9a: materials are in the estimate and the project; the confirmation says when they will be cut', () => {
  const base = Plan.plan({ models: PAID, goal: '写一份总结', capCny: 50 });
  const files = [meta('docx', 'ok', 45000), meta('image', 'metadata_only', 0)];
  const withMat = Plan.plan({ models: PAID, goal: '写一份总结', capCny: 50, materials: files });
  assert.ok(withMat.chosen.estimateCny > base.chosen.estimateCny, 'materials cost money');
  assert.ok(withMat.chosen.maxCny > base.chosen.maxCny, 'the cap covers the bigger reservation');
  assert.deepEqual(withMat.project.materials, { mode: 'all', fileIds: [], maxChars: 30000 });
  assert.equal(withMat.project.steps[1].materialsMaxChars, 20000);
  assert.match(withMat.project.steps[1].prompt, /对照资料核实引用的内容和出处/);
  assert.ok(withMat.project.standards.includes('引用上传资料时注明出处文件名'));
  assert.match(withMat.materialsNote, /^资料：2 个文件，能读到的文字共 4\.5 万字。资料比较长，岗位只用得上一部分：「资料」起草时只用前 30000 字，第 30001 字之后没被使用；审核时只用前 20000 字，第 20001 字之后没被使用。没被使用的部分岗位看不到[\s\S]*有 1 个文件读不到文字/);
  assert.equal(base.materialsNote, ''); assert.equal(base.project.materials.mode, 'none');
  // the engine reserves by bytes: the first step's reservation fits the confirmed cap
  const rate = Plan.cnyRate(PAID[0]), firstBound = ((1800 + 30000 * 3 + 2 * 200 + 200 + 256) * rate.input + 2048 * rate.output) / 1e6;
  assert.ok(withMat.chosen.maxCny >= firstBound, withMat.chosen.maxCny + ' >= ' + firstBound);
  const rw = Plan.rework({ models: PAID, snapshot: withMat.project, feedback: '再精简', capCny: 50, materials: files });
  const rw0 = Plan.rework({ models: PAID, snapshot: withMat.project, feedback: '再精简', capCny: 50 });
  assert.ok(rw.chosen.estimateCny > rw0.chosen.estimateCny, 'rework estimate includes the reviewer share of the materials');
});

test('B9a engine: each role gets its share of a long file, cut disclosed as "已截取前 N 字", and is asked to cite the file', async t => {
  const prompts = [];
  const mock = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const input = JSON.parse(body); prompts.push(input.messages.map(m => m.content).join('\n'));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '本地模型的成果文字（出处：长资料.txt）' } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const S = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mock.address().port } });
  t.after(async () => { await S.stop(); await new Promise(r => mock.close(r)); });
  const id = (await S.call('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, modelId: 'reader', displayName: 'reader', pricingMode: 'local', capabilities: ['writing', 'reasoning'] })).json.connection.connectionId;
  assert.equal((await S.call('POST', '/api/models/' + id + '/test', {})).json.ok, true);
  const models = (await S.call('GET', '/api/models')).json.models;
  const p = Plan.plan({ models, goal: '根据资料写总结', capCny: 5, materials: [meta('text', 'ok', 35000)] });
  const project = (await S.call('POST', '/api/v2/projects', p.project)).json.project;
  const text = '甲'.repeat(25000) + '乙'.repeat(10000);
  assert.equal((await S.call('POST', `/api/v2/projects/${project.projectId}/files`, { filename: '长资料.txt', contentBase64: Buffer.from(text).toString('base64') })).status, 201);
  const run = (await S.call('POST', `/api/v2/projects/${project.projectId}/runs`, p.approval));
  assert.equal(run.status, 202, run.text);
  let done; for (let i = 0; i < 200 && !['review_required', 'failed'].includes((done = (await S.call('GET', '/api/v2/runs/' + run.json.run.runId)).json.run).status); i++) await H.sleep(30);
  assert.equal(done.status, 'review_required', JSON.stringify(done.error));
  const steps = prompts.filter(x => x.includes('\nStep: '));
  assert.equal(steps.length, 2);
  assert.match(steps[0], /资料太长，已截取前 30000 字，原文共 35000 字/); assert.match(steps[0], /乙{5000}/);
  assert.match(steps[1], /资料太长，已截取前 20000 字，原文共 35000 字/); assert.doesNotMatch(steps[1], /乙/);
  for (const s of steps) assert.match(s, /引用以上资料中的内容时，请在相应句子后注明出处文件名，例如（出处：长资料\.txt）/);
  assert.deepEqual(done.steps.map(s => s.materials[0].includedChars), [30000, 20000], 'evidence records what each role received');
  // QA-B9 P2-②: what the page tells the user is exactly what the engine used
  const files = (await S.call('GET', `/api/v2/projects/${project.projectId}/files`)).json.files, a = Plan.materialAllocation(files)[0];
  assert.deepEqual([a.draft, a.review], done.steps.map(s => s.materials[0].includedChars));
  assert.equal(Plan.cutText(a), '起草时只用前 30000 字，第 30001 字之后没被使用；审核时只用前 20000 字，第 20001 字之后没被使用');
  // a project without materialsMaxChars keeps its old behaviour (field absent, run budget applies)
  const plain = (await S.call('POST', '/api/v2/projects', { name: 'x', description: 'x', roles: [{ roleId: 'a', name: 'a', connectionId: id }], steps: [{ stepId: 's', roleId: 'a', title: 's' }] })).json.project;
  assert.equal('materialsMaxChars' in plain.steps[0], false);
  assert.equal((await S.call('POST', '/api/v2/projects', { ...p.project, steps: [{ ...p.project.steps[0], materialsMaxChars: 10 }] })).status, 400, 'below 1000 is refused');
});

/* ---------------- B9b: 先问清楚再动手 ---------------- */
const CLAR_JSON = JSON.stringify({ understanding: '我理解你要的是一份季度复盘总结，重点是满意度和销量。', questions: [{ question: '主要给谁看？', options: ['领导', '团队内部', '领导'] }, { question: '要多长？', options: ['一页', '三页'] }, { question: '只有一个选项', options: ['x'] }, { question: '第四个问题', options: ['a', 'b'] }], plan: { draft: '根据资料写出三页初稿', review: '核对数字和出处并定稿' } });
test('B9b: clarification reply is validated strictly (JSON object, at most 3 questions with 2-4 options, bounded text)', () => {
  const { validateClarify } = require('../lib/clarify');
  const v = validateClarify('```json\n' + CLAR_JSON + '\n```').clarify;
  assert.deepEqual(v.questions.map(q => q.question), ['主要给谁看？', '要多长？'], 'single-option question dropped, no 4th question');
  assert.deepEqual(v.questions[0].options, ['领导', '团队内部'], 'duplicates removed');
  assert.equal(v.plan.draft, '根据资料写出三页初稿');
  for (const bad of ['好的，我来问几个问题', '[]', '{"questions":[]}', '']) assert.throws(() => validateClarify(bad), e => e.code === 'invalid_draft', bad);
  assert.equal(validateClarify(JSON.stringify({ understanding: '<img src=x onerror=alert(1)> 我理解' })).clarify.understanding, '<img src=x onerror=alert(1)> 我理解', 'kept as plain text; the page renders it with textContent');
});
test('B9b: rule-based questions, the plan in plain words, answers merged into the project and every step', () => {
  const r = Plan.clarifyRules({ goal: '做一份新品介绍', output: 'ppt', materials: [{}] });
  assert.match(r.understanding, /^我理解你要的是：做一份新品介绍。成果是一份PPT 演示，会参考你上传的 1 个文件。$/);
  assert.deepEqual(r.questions.map(q => q.question), ['大概要几页？', '主要给谁看？', '语气偏向哪种？']);
  assert.ok(r.questions.every(q => q.options.length >= 2 && q.options.length <= 4));
  assert.equal(Plan.clarifyRules({ goal: '给领导写一份 3 页的正式汇报', output: 'word' }).questions.length, 0, 'nothing asked that the goal already says');
  const p = Plan.plan({ models: PAID, goal: '写季度总结', capCny: 5 });
  assert.equal(Plan.planText(p, r), '起草员：阅读资料，写出完整初稿 → 审核员：检查错误和遗漏，修订定稿');
  const merged = Plan.applyClarify(p.project, r, { answers: ['8 页左右', '', '自己写的语气'] });
  assert.match(merged.description, /开始前的确认：\n对需求的理解：我理解你要的是：做一份新品介绍[\s\S]*问：大概要几页？\n答：8 页左右\n问：主要给谁看？\n答：（没有回答，按常见做法处理）\n问：语气偏向哪种？\n答：自己写的语气$/);
  assert.match(merged.steps[0].prompt, /本步重点：阅读资料，写出完整初稿$/); assert.match(merged.steps[1].prompt, /本步重点：检查错误和遗漏，修订定稿$/);
  assert.match(Plan.applyClarify(p.project, r, { skipped: true }).description, /用户选择跳过提问：按以上理解来做/);
  assert.doesNotMatch(Plan.applyClarify(p.project, r, { skipped: true }).description, /\n问：/);
  // the cap is shown before the click; a model too expensive for this step is not used (rules instead)
  const est = Plan.clarifyEstimate({ model: PAID[0], goal: '写季度总结' });
  assert.ok(est.maxCny >= 0.01 && est.maxCostUsd <= Plan.CLARIFY.maxUsd && est.approvePaid);
  assert.equal(Plan.clarifyEstimate({ model: { ...PAID[0], price: { inputPerMillion: 5000, outputPerMillion: 20000, currency: 'CNY' } }, goal: 'x' }), null);
  assert.deepEqual(Plan.clarifyEstimate({ model: { modelId: 'm', pricingMode: 'local' }, goal: 'x' }), { free: true, maxCny: 0, maxCostUsd: 0, approvePaid: false });
});
test('B9b API: one budgeted call through system_usage (purpose clarify); approval required; bad JSON -> 422 for rules; user quota and isolation', async t => {
  const prompts = [];
  const mock = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const input = JSON.parse(body), all = input.messages.map(m => m.content).join('\n'); prompts.push(all);
      const reply = input.max_tokens <= 32 ? '好' : /MOCK_BAD/.test(all) ? '好的，我先问几个问题：你要给谁看？' : CLAR_JSON;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 400, completion_tokens: 100 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mp = mock.address().port;
  const S = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mp } });
  t.after(async () => { await S.stop(); await new Promise(r => mock.close(r)); });
  const paid = (await S.call('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mp}/v1`, modelId: 'priced-writer', pricingMode: 'paid_api', capabilities: ['writing', 'reasoning'], price: { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 1 } })).json.connection.connectionId;
  assert.equal((await S.call('POST', '/api/models/' + paid + '/test', { approvePaid: true })).json.ok, true);
  const n0 = prompts.length, ask = (call, b) => call('POST', '/api/v2/intake/clarify', { goal: '写一份季度复盘总结', output: 'Word 文档', connectionId: paid, ...b });
  // no explicit approval, or a cap above 0.1 USD: refused before any model request
  assert.equal((await ask(S.call, {})).json.code, 'paid_approval_required');
  assert.equal((await ask(S.call, { approvePaid: true, maxCost: 0.5 })).status, 400);
  assert.equal(prompts.length, n0, 'nothing sent without approval');
  const proj = (await S.call('POST', '/api/v2/projects', { name: '草稿', description: '草稿', roles: [{ roleId: 'd', name: '起草员' }], steps: [{ stepId: 's', roleId: 'd', title: 's' }] })).json.project;
  await S.call('POST', `/api/v2/projects/${proj.projectId}/files`, { filename: '纪要.txt', contentBase64: Buffer.from('下季度重点：会员复购，目标 35%。').toString('base64') });
  const good = await ask(S.call, { approvePaid: true, maxCost: 0.002, projectId: proj.projectId });
  assert.equal(good.status, 200, good.text);
  assert.equal(good.json.clarify.questions.length, 2); assert.equal(good.json.requestSent, true); assert.equal(good.json.billingStatus, 'settled');
  assert.match(prompts.at(-1), /你是任务助理/); assert.match(prompts.at(-1), /\[资料\] 纪要\.txt（共 \d+ 字）\n下季度重点：会员复购/);
  const cost = 500 / 1e6 / 7.5; assert.ok(Math.abs(good.json.usage.cost - cost) < 1e-12, 'provider usage x server price: ' + good.json.usage.cost);
  const row = (await S.call('GET', '/api/v2/usage/system')).json.usage.find(u => u.ledgerId === good.json.ledgerId);
  assert.equal(row.purpose, 'clarify'); assert.equal(row.kind, 'intake_draft'); assert.equal(row.status, 'completed');
  // a client-supplied price is ignored: the server budgets with its own rate
  const low = await ask(S.call, { approvePaid: true, maxCost: 0.002, price: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' } });
  assert.ok(low.json.usage.cost > 0);
  const bad = await ask(S.call, { goal: 'MOCK_BAD 写一份总结', approvePaid: true, maxCost: 0.002 });
  assert.equal(bad.status, 422); assert.equal(bad.json.code, 'invalid_draft'); assert.equal(bad.json.requestSent, true); assert.ok(bad.json.usage.cost > 0, 'a bad reply is still billed and recorded');
  // front user: counted in the monthly spend; another user's draft cannot be read
  const PASS = 'user-password-123';
  await S.call('POST', '/api/v2/users', { username: 'dora', password: PASS, monthlyCapCny: 1 });
  const ck = (await S.call('POST', '/api/auth/user-login', { username: 'dora', password: PASS }, { cookie: false })).headers['set-cookie'][0].split(';')[0];
  const D = (m, u, b) => S.call(m, u, b, { cookie: ck });
  assert.equal((await ask(D, { approvePaid: true, maxCost: 0.002, projectId: proj.projectId })).status, 404, 'not her project');
  const before = (await D('GET', '/api/v2/me')).json.me.month.spentCny;
  const mine = await ask(D, { approvePaid: true, maxCost: 0.002 });
  assert.equal(mine.status, 200, mine.text);
  assert.ok((await D('GET', '/api/v2/me')).json.me.month.spentCny > before, 'the clarification counts in her month');
  const users = (await S.call('GET', '/api/v2/users')).json.users;
  await S.call('PUT', '/api/v2/users/' + users.find(u => u.username === 'dora').userId, { monthlyCapCny: 0 });
  const n1 = prompts.length;
  assert.equal((await ask(D, { approvePaid: true, maxCost: 0.002 })).json.code, 'monthly_quota_exhausted');
  assert.equal(prompts.length, n1, 'no call over the quota');
});

/* ---------------- B9c: 对话式修改 ---------------- */
test('B9c: scope from the user\'s words; feedback carries scope and earlier requests', () => {
  assert.equal(Plan.reviseScope('第3页太啰嗦，精简一下'), '只改第 3 页的内容（页数不变），其它部分逐字保留');
  assert.equal(Plan.reviseScope('加一页竞品对比'), '在合适的位置新增内容页，已有的页面逐字保留');
  assert.equal(Plan.reviseScope('删掉第二页'), '删除第 2 页（整页），其它部分逐字保留');
  assert.equal(Plan.reviseScope('整体再活泼些'), '按意见修改；意见没有提到的部分尽量保持原样');
  const f = Plan.reviseFeedback({ message: '加一页竞品对比', history: ['第3页太啰嗦'] });
  assert.match(f, /^修改意见：加一页竞品对比\n修改范围：在合适的位置新增内容页[\s\S]*1\. 第3页太啰嗦\n请在上一版成果的基础上修改/);
  const snapshot = Plan.plan({ models: PAID, goal: '写季度总结', capCny: 5 }).project;
  const a = Plan.rework({ models: PAID, snapshot, feedback: '精简', capCny: 5 }), b = Plan.rework({ models: PAID, snapshot, feedback: '精简', capCny: 5, previousChars: 6000 });
  assert.ok(b.chosen.estimateCny > a.chosen.estimateCny, 'the previous version is part of the revision cost');
  assert.equal(b.approval.revise, true);
});
test('B9c API: a revision starts from the previous version, makes version N+1, old versions stay exportable, maxReworks holds, no paid call without approval', async t => {
  const prompts = [];
  const mock = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const input = JSON.parse(body), all = input.messages.map(m => m.content).join('\n'); if (input.max_tokens > 32) prompts.push(all);
      const n = (all.match(/Previous version of the deliverable/) ? 'V' + (prompts.length) : 'FIRST');
      const reply = input.max_tokens <= 32 ? '好' : '成果正文 ' + n + '：季度复盘，满意度 92%。';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mp = mock.address().port;
  const S = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mp } });
  t.after(async () => { await S.stop(); await new Promise(r => mock.close(r)); });
  const paid = (await S.call('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mp}/v1`, modelId: 'priced-writer', pricingMode: 'paid_api', capabilities: ['writing', 'reasoning'], price: { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 1 } })).json.connection.connectionId;
  assert.equal((await S.call('POST', '/api/models/' + paid + '/test', { approvePaid: true })).json.ok, true);
  const models = (await S.call('GET', '/api/models')).json.models;
  const p = Plan.plan({ models, goal: '写季度总结', capCny: 5 });
  const project = (await S.call('POST', '/api/v2/projects', { ...p.project, maxReworks: 2 })).json.project;
  const runId = (await S.call('POST', `/api/v2/projects/${project.projectId}/runs`, p.approval)).json.run.runId;
  const wait = async () => { let r; for (let i = 0; i < 200; i++) { r = (await S.call('GET', '/api/v2/runs/' + runId)).json.run; if (!r.executionActive && r.status !== 'running') return r; await H.sleep(30); } return r; };
  assert.equal((await wait()).status, 'review_required');
  let v = (await S.call('GET', `/api/v2/runs/${runId}/versions`)).json;
  assert.equal(v.versions.length, 1); assert.equal(v.reworksLeft, 2); assert.match(v.versions[0].text, /FIRST/);
  // no confirmation (no approvePaid / cap) -> refused, nothing sent
  const n0 = prompts.length;
  const noApproval = await S.call('POST', `/api/v2/runs/${runId}/review`, { decision: 'rework', feedback: '精简', fromStepId: 'review', revise: true });
  assert.equal(noApproval.status, 402, noApproval.text); assert.equal(prompts.length, n0, 'no model call without a new confirmation');
  const ask = msg => { const r = Plan.rework({ models, snapshot: project, feedback: msg, capCny: 5, previousChars: 200 }); return S.call('POST', `/api/v2/runs/${runId}/review`, { ...r.approval, message: msg, feedback: Plan.reviseFeedback({ message: msg }) }); };
  assert.equal((await ask('第3页太啰嗦，精简一下')).status, 200);
  assert.equal((await wait()).status, 'review_required');
  const revisePrompt = prompts.at(-1);
  assert.equal(prompts.length - n0, 1, 'only the review step reruns');
  assert.match(revisePrompt, /Previous version of the deliverable \(data\)\. Revise THIS version[\s\S]*成果正文 FIRST/);
  assert.match(revisePrompt, /修改意见：第3页太啰嗦，精简一下\n修改范围：只改第 3 页的内容（页数不变），其它部分逐字保留/);
  v = (await S.call('GET', `/api/v2/runs/${runId}/versions`)).json;
  assert.deepEqual(v.versions.map(x => [x.version, x.current, x.message]), [[1, false, null], [2, true, '第3页太啰嗦，精简一下']]);
  assert.equal(v.reworksLeft, 1);
  const old = await fetch(`http://127.0.0.1:${S.port}/api/v2/runs/${runId}/export`, { method: 'POST', headers: { cookie: S.cookie, 'content-type': 'application/json', origin: `http://127.0.0.1:${S.port}` }, body: JSON.stringify({ format: 'md', artifactId: v.versions[0].artifactId }) });
  assert.equal(old.status, 200); assert.match(await old.text(), /成果正文 FIRST/, 'version 1 is still downloadable');
  const cur = await fetch(`http://127.0.0.1:${S.port}/api/v2/runs/${runId}/export`, { method: 'POST', headers: { cookie: S.cookie, 'content-type': 'application/json', origin: `http://127.0.0.1:${S.port}` }, body: JSON.stringify({ format: 'md' }) });
  assert.match(await cur.text(), /成果正文 V/);
  const bogus = await S.call('POST', `/api/v2/runs/${runId}/export`, { format: 'md', artifactId: 'art_000000000000000000000000' });
  assert.equal(bogus.status, 404);
  assert.equal((await ask('加一页竞品对比')).status, 200); assert.equal((await wait()).status, 'review_required');
  assert.match(prompts.at(-1), /Previous version of the deliverable[\s\S]*成果正文 V/, 'the third version starts from the second');
  v = (await S.call('GET', `/api/v2/runs/${runId}/versions`)).json;
  assert.equal(v.versions.length, 3); assert.equal(v.reworksLeft, 0);
  const n1 = prompts.length, limit = await ask('再改一次');
  assert.equal(limit.status, 409); assert.equal(limit.json.code, 'rework_limit'); assert.equal(prompts.length, n1);
});

/* ---------------- AUD-FEB8-01: drafts are bounded, resumable, deletable and expire ---------------- */
test('AUD-FEB8-01: per-user draft limit; storage counted per owner; abandoned drafts expire, never a project with a run', async t => {
  const mock = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '好的成果文字，内容足够长。' } }] }) + '\n\ndata: [DONE]\n\n'); }); });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mp = mock.address().port;
  const S = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mp } });
  t.after(async () => { await S.stop(); await new Promise(r => mock.close(r)); });
  const PASS = 'user-password-123';
  await S.call('POST', '/api/v2/users', { username: 'erin', password: PASS, monthlyCapCny: 5 });
  const ck = (await S.call('POST', '/api/auth/user-login', { username: 'erin', password: PASS }, { cookie: false })).headers['set-cookie'][0].split(';')[0];
  const E = (m, u, b) => S.call(m, u, b, { cookie: ck });
  const draft = { name: '新任务（正在准备资料）', description: '还没开始的新任务，正在上传资料。', roles: [{ roleId: 'drafter', name: '起草员' }], steps: [{ stepId: 'draft', roleId: 'drafter', title: '写出初稿' }] };
  const ids = [];
  for (let i = 0; i < 20; i++) { const r = await E('POST', '/api/v2/projects', draft); assert.equal(r.status, 201, r.text); ids.push(r.json.project.projectId); }
  const over = await E('POST', '/api/v2/projects', draft);
  assert.equal(over.status, 429); assert.equal(over.json.code, 'draft_limit'); assert.match(over.json.error, /还没开始的任务最多 20 个/);
  assert.equal((await S.call('POST', '/api/v2/projects', draft)).status, 201, 'the admin is not limited');
  assert.equal((await E('POST', `/api/v2/projects/${ids[0]}/files`, { filename: 'a.txt', contentBase64: Buffer.from('资料内容').toString('base64') })).status, 201);
  assert.equal((await E('DELETE', `/api/v2/projects/${ids[1]}`)).status, 200, 'a user deletes her own draft');
  assert.equal((await E('POST', '/api/v2/projects', draft)).status, 201, 'room again after deleting');
  // expiry: age everything, then keep the recent ones / the ones with a run / the admin's own non-placeholder projects
  const { DatabaseSync } = require('node:sqlite'), path = require('node:path');
  const models = (await S.call('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mp}/v1`, modelId: 'w', pricingMode: 'local', capabilities: ['writing'] })).json.connection.connectionId;
  await S.call('POST', '/api/models/' + models + '/test', {});
  const withRun = (await E('PUT', `/api/v2/projects/${ids[2]}`, { ...draft, name: '已运行', roles: [{ roleId: 'drafter', name: '起草员', connectionId: models }], expectedVersion: 1 })).json.project;
  assert.equal((await E('POST', `/api/v2/projects/${withRun.projectId}/runs`, { maxTokens: 20000, maxOutputTokens: 100, maxCost: 0 })).status, 202);
  const adminOwn = (await S.call('POST', '/api/v2/projects', { ...draft, name: '管理员自己的项目', description: '高级设置里配的项目' })).json.project.projectId;
  const adminPlaceholder = (await S.call('POST', '/api/v2/projects', draft)).json.project.projectId;
  const before = (await S.call('GET', '/api/v2/projects')).json.projects.length;
  for (let i = 0; i < 100; i++) { const r = (await S.call('GET', '/api/v2/projects/' + withRun.projectId)).json.runs[0]; if (!r.executionActive && r.status !== 'running') break; await H.sleep(30); }
  // the sweep runs at start-up and every 6 h: stop the server, age the rows, start it again on the same data
  await new Promise(r => { if (S.child.exitCode !== null) return r(); S.child.once('exit', r); S.child.kill('SIGTERM'); });
  const old = Date.now() - 31 * 86400e3, db = new DatabaseSync(path.join(S.dir, 'projects.sqlite')); db.exec('PRAGMA busy_timeout=5000');
  db.prepare('UPDATE projects SET updated_at=?').run(old); db.prepare('UPDATE project_files SET created_at=?').run(old); db.prepare('UPDATE runs SET created_at=?').run(old);
  const fresh = ids[3]; db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(Date.now(), fresh);
  db.close();
  const S2 = await H.boot({ dir: S.dir, env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mp } }); t.after(() => S2.kill());
  const after = (await S2.call('GET', '/api/v2/projects')).json.projects.map(p => p.projectId);
  assert.ok(after.includes(withRun.projectId), 'a project with a run is never removed');
  assert.ok(after.includes(adminOwn), "the admin's own project is not a draft to expire");
  assert.ok(after.includes(fresh), 'a recently touched draft stays');
  assert.ok(!after.includes(ids[0]) && !after.includes(ids[4]), 'abandoned user drafts (and their files) expired');
  assert.ok(!after.includes(adminPlaceholder), 'an abandoned new-task placeholder draft expired');
  assert.equal(after.length, before - 20, 'exactly the 18 old user drafts and the 2 old placeholder drafts');
});

/* ---------------- AUD-8CDD-01: the admin's exception ledger shows users' unknown-cost clarification rows ---------------- */
test('AUD-8CDD-01: a user clarification left with unknown cost appears in the admin exception view (with username); users cannot read it', async t => {
  const hung = [];
  const mock = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const input = JSON.parse(body), all = input.messages.map(m => m.content).join('\n');
      const send = () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: input.max_tokens <= 32 ? '好' : CLAR_JSON } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n'); };
      if (/MOCK_HANG/.test(all)) hung.push(send); else send();
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mp = mock.address().port;
  const S = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mp } });
  t.after(async () => { hung.splice(0).forEach(f => { try { f(); } catch { /* closed */ } }); await S.stop(); await new Promise(r => mock.close(r)); });
  const paid = (await S.call('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mp}/v1`, modelId: 'priced-writer', pricingMode: 'paid_api', capabilities: ['writing'], price: { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 1 } })).json.connection.connectionId;
  assert.equal((await S.call('POST', '/api/models/' + paid + '/test', { approvePaid: true })).json.ok, true);
  const PASS = 'user-password-123';
  await S.call('POST', '/api/v2/users', { username: 'fay', password: PASS, monthlyCapCny: 5 });
  const ck = (await S.call('POST', '/api/auth/user-login', { username: 'fay', password: PASS }, { cookie: false })).headers['set-cookie'][0].split(';')[0];
  // the user's page gives up (client disconnect) while the provider still hangs: the row stays with an unknown cost
  const ctl = new AbortController();
  const req = fetch(`http://127.0.0.1:${S.port}/api/v2/intake/clarify`, { method: 'POST', signal: ctl.signal, headers: { cookie: ck, 'content-type': 'application/json', origin: `http://127.0.0.1:${S.port}` },
    body: JSON.stringify({ goal: 'MOCK_HANG 写一份总结', output: 'Word 文档', connectionId: paid, approvePaid: true, maxCost: 0.002 }) }).catch(e => e);
  for (let i = 0; i < 100 && !hung.length; i++) await H.sleep(20);
  assert.equal(hung.length, 1, 'the request reached the provider'); ctl.abort(); await req; await H.sleep(600);
  const view = await S.call('GET', '/api/v2/usage/system/exceptions');
  assert.equal(view.status, 200);
  const row = view.json.exceptions.find(e => e.username === 'fay');
  assert.ok(row, 'the admin sees the user\'s row: ' + view.text.slice(0, 300));
  assert.deepEqual([row.ownerKind, row.purpose, row.cost, row.needsReconciliation], ['user', 'clarify', null, true]);
  assert.ok(row.costUpperBound > 0);
  assert.equal(JSON.stringify(view.json).includes('MOCK_HANG'), false, 'no prompt text in the view');
  const ready = await S.call('GET', '/api/v2/readiness');
  assert.ok(ready.json.accounting.exceptions.some(e => e.username === 'fay'), 'the capability center warning counts it too');
  // a front user cannot read the exception ledger (admin back end)
  assert.equal((await S.call('GET', '/api/v2/usage/system/exceptions', undefined, { cookie: ck })).status, 403);
  // the month still counts it at its upper bound
  assert.ok((await S.call('GET', '/api/v2/me', undefined, { cookie: ck })).json.me.month.spentCny > 0);
});

/* ---------------- AUD-717C-01: the draft and storage limits hold under concurrent requests ---------------- */
test('AUD-717C-01: 25 concurrent draft creations make exactly 20; concurrent PDF uploads never pass 256 MB; refused ones write nothing', async t => {
  const S = await H.boot({});
  t.after(() => S.stop());
  const PASS = 'user-password-123';
  await S.call('POST', '/api/v2/users', { username: 'gina', password: PASS, monthlyCapCny: 5 });
  const ck = (await S.call('POST', '/api/auth/user-login', { username: 'gina', password: PASS }, { cookie: false })).headers['set-cookie'][0].split(';')[0];
  const G = (m, u, b) => S.call(m, u, b, { cookie: ck });
  const draft = { name: '新任务（正在准备资料）', description: '还没开始的新任务，正在上传资料。', roles: [{ roleId: 'drafter', name: '起草员' }], steps: [{ stepId: 'draft', roleId: 'drafter', title: '写出初稿' }] };
  // slow request bodies: every request is in flight before any of them is written
  const net = require('node:net'), slowPost = (path, obj) => new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(obj)), sock = net.connect(S.port, '127.0.0.1');
    let raw = ''; sock.on('data', d => raw += d); sock.on('error', reject);
    sock.on('end', () => resolve({ status: Number((/^HTTP\/1\.1 (\d+)/.exec(raw) || [])[1]), text: (b => b.slice(b.indexOf('{'), b.lastIndexOf('}') + 1))(raw.slice(raw.indexOf('\r\n\r\n') + 4)) })); // the JSON object of a (possibly chunked) body
    sock.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${S.port}\r\nOrigin: http://127.0.0.1:${S.port}\r\nCookie: ${ck}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
    sock.write(body.subarray(0, 10)); setTimeout(() => sock.write(body.subarray(10)), 300);
  });
  const made = await Promise.all(Array.from({ length: 25 }, () => slowPost('/api/v2/projects', draft)));
  assert.equal(made.filter(r => r.status === 201).length, 20, made.map(r => r.status).join(','));
  assert.ok(made.filter(r => r.status !== 201).every(r => r.status === 429 && /draft_limit/.test(r.text)));
  assert.equal((await G('GET', '/api/v2/projects')).json.projects.length, 20, 'nothing extra written');
  // storage: fill the user's materials to 256 MB - 30 KB, then upload 5 PDFs (12 KB each) at once: at most 2 fit
  const [pid, fillPid] = made.filter(r => r.status === 201).slice(0, 2).map(r => JSON.parse(r.text).project.projectId); // filler in another draft (a project alone is capped at 64 MB)
  const fs = require('node:fs'), path = require('node:path'), X = require('../lib/file-extract');
  if (!X.pdfAvailable()) return t.skip('pdftotext not installed (the race needs an asynchronous extractor)');
  const pdf = fs.readFileSync(path.join(__dirname, 'fixtures', 'files', 'brief.pdf'));
  await S.kill();
  const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(path.join(S.dir, 'projects.sqlite'));
  const filler = 256 * 1024 * 1024 - 30 * 1024;
  db.prepare("INSERT INTO project_files VALUES('fil_000000000000000000000001',?,?,?,?,zeroblob(?),'')").run(fillPid, Date.now(), '0'.repeat(64), JSON.stringify({ fileId: 'fil_000000000000000000000001', projectId: fillPid, filename: '填充.txt', kind: 'text', bytes: filler, extraction: { status: 'ok', chars: 0 } }), filler);
  db.close();
  const S2 = await H.boot({ dir: S.dir }); t.after(() => S2.kill());
  const ck2 = (await S2.call('POST', '/api/auth/user-login', { username: 'gina', password: PASS }, { cookie: false })).headers['set-cookie'][0].split(';')[0];
  const up = await Promise.all(Array.from({ length: 5 }, (_, i) => S2.call('POST', `/api/v2/projects/${pid}/files`, { filename: `b${i}.pdf`, contentBase64: pdf.toString('base64') }, { cookie: ck2 })));
  const ok = up.filter(r => r.status === 201).length;
  assert.equal(ok, Math.floor(30 * 1024 / pdf.length), up.map(r => r.status).join(','));
  assert.ok(up.filter(r => r.status !== 201).every(r => r.status === 413 && r.json.code === 'storage_limit'));
  const db2 = new DatabaseSync(path.join(S.dir, 'projects.sqlite'), { readOnly: true });
  const total = Number(db2.prepare('SELECT SUM(length(content)) b FROM project_files f JOIN projects p ON p.id=f.project_id WHERE p.owner_id=(SELECT id FROM users WHERE username=?)').get('gina').b);
  db2.close();
  assert.ok(total <= 256 * 1024 * 1024, 'stored ' + total + ' bytes');
});

test('QA-B9 P2-①: revision scope is conservative - pictures and sentences inside a page are not pages, whole-page deletion only when said, every page number counts', () => {
  const k = m => [Plan.reviseScopeInfo(m).kind, Plan.reviseScopeInfo(m).pages.join(',')];
  assert.deepEqual(k('第3页加一张图'), ['pages', '3'], 'adding a picture to page 3 is not a new page');
  assert.deepEqual(k('去掉第2页的图片'), ['pages', '2'], 'removing a picture is not deleting page 2');
  assert.deepEqual(k('去掉第2页最后一句话'), ['pages', '2']);
  assert.deepEqual(k('删除第2页'), ['delete', '2']); assert.deepEqual(k('把第4页删掉'), ['delete', '4']); assert.deepEqual(k('删掉第二页。'), ['delete', '2']);
  assert.deepEqual(k('第3页和第5页太长'), ['pages', '3,5']); assert.deepEqual(k('第3、4页要更具体'), ['pages', '3,4']);
  assert.deepEqual(k('第3到5页合并精简'), ['pages', '3,4,5']); assert.deepEqual(k('第十二页有错别字'), ['pages', '12']);
  assert.deepEqual(k('加一页竞品对比'), ['add', '']); assert.deepEqual(k('在第3页后面加一页竞品对比'), ['add', '3']); assert.deepEqual(k('新增两页案例'), ['add', '']);
  assert.deepEqual(k('加一张图'), ['all', ''], 'a picture is not a page');
  assert.equal(Plan.reviseScope('第3页和第5页太长'), '只改第 3、5 页的内容（页数不变），其它部分逐字保留');
  // the confirmation offers the detected scope first, then a more conservative and a broader one
  assert.deepEqual(Plan.reviseScopeOptions('删除第2页'), ['删除第 2 页（整页），其它部分逐字保留', '只改第 2 页的内容（页数不变），其它部分逐字保留', '按意见修改；意见没有提到的部分尽量保持原样']);
  assert.deepEqual(Plan.reviseScopeOptions('整体再活泼些'), ['按意见修改；意见没有提到的部分尽量保持原样']);
  assert.match(Plan.reviseFeedback({ message: '删除第2页', scope: '只改第 2 页的内容（页数不变），其它部分逐字保留' }), /修改范围：只改第 2 页的内容（页数不变）/, 'the scope the user picked is what the model gets');
});

test('QA-B9 P2-②: the user is told, per file, which part of long materials is not used (same order and budgets as the engine)', () => {
  const f = (filename, chars, status = 'ok') => ({ filename, kind: 'docx', extraction: { status, chars } });
  const alloc = Plan.materialAllocation([f('a.docx', 25000), f('pic.png', 0, 'metadata_only'), f('b.docx', 9000), f('c.docx', 100)]);
  assert.deepEqual(alloc.map(x => [x.draft, x.review]), [[25000, 20000], [0, 0], [5000, 0], [0, 0]]);
  assert.equal(Plan.cutText(alloc[0]), '起草时全部用上；审核时只用前 20000 字，第 20001 字之后没被使用');
  assert.equal(Plan.cutText(alloc[2]), '起草时只用前 5000 字，第 5001 字之后没被使用；审核时没用上（前面的资料已经占满）');
  assert.equal(Plan.cutText(alloc[3]), '起草时没用上（前面的资料已经占满）；审核时没用上（前面的资料已经占满）');
  const note = Plan.materialsNote(Plan.materialShare([f('a.docx', 77000)]));
  assert.match(note, /共 7\.7 万字。资料比较长，岗位只用得上一部分：「a\.docx」起草时只用前 30000 字，第 30001 字之后没被使用/);
  assert.doesNotMatch(note, /每个岗位都会拿到/, 'no claim that every role gets the materials when they are cut');
  assert.match(Plan.materialsNote(Plan.materialShare([f('x.docx', 100)])), /每个岗位都会拿到全部资料内容/);
});
