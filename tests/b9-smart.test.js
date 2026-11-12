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
  assert.match(withMat.materialsNote, /^资料：2 个文件，能读到的文字共 4\.5 万字。每个岗位都会拿到资料摘录。资料比较长：起草时带上前 3 万字，审核时带上前 2 万字，截取的地方会注明“已截取前 N 字”。有 1 个文件读不到文字/);
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
  // a project without materialsMaxChars keeps its old behaviour (field absent, run budget applies)
  const plain = (await S.call('POST', '/api/v2/projects', { name: 'x', description: 'x', roles: [{ roleId: 'a', name: 'a', connectionId: id }], steps: [{ stepId: 's', roleId: 'a', title: 's' }] })).json.project;
  assert.equal('materialsMaxChars' in plain.steps[0], false);
  assert.equal((await S.call('POST', '/api/v2/projects', { ...p.project, steps: [{ ...p.project.steps[0], materialsMaxChars: 10 }] })).status, 400, 'below 1000 is refused');
});
