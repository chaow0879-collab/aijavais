'use strict';
// Project materials: real files produced by independent tools (python-docx, openpyxl,
// python-pptx, LibreOffice -> PDF; see tests/fixtures/make-office-fixtures.py) are
// uploaded, parsed without npm dependencies, persisted, and handed to model roles.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const H = require('./helpers');
const X = require('../lib/file-extract');
const { ProjectStore, SCHEMA_VERSION } = require('../lib/project-store');
const { createDeliverable } = require('../lib/deliverables');

const FIX = path.join(__dirname, 'fixtures', 'files');
const fixture = name => fs.readFileSync(path.join(FIX, name));

// Minimal ZIP writer for malformed-input cases (method 0 = stored, 8 = deflate).
function zipOf(files, { flags = 0, badCrc = false, method = 0 } = {}) {
  const locals = [], central = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content), data = method === 8 ? zlib.deflateRawSync(raw) : raw, n = Buffer.from(name);
    const crc = badCrc ? (zlib.crc32(raw) ^ 1) >>> 0 : zlib.crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data); central.push(ch, n); offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const rejects = async (name, buf, code) => assert.rejects(X.extractFile(name, buf), e => e.code === code, `${name} should fail with ${code}`);

test('extract: externally generated DOCX keeps headings, lists, tables and escaped text', async () => {
  const r = await X.extractFile('report.docx', fixture('report.docx'));
  assert.equal(r.status, 'ok'); assert.equal(r.extractor, 'builtin-ooxml');
  assert.match(r.text, /^# 季度复盘报告$/m); assert.match(r.text, /^## 风险与措施$/m);
  assert.match(r.text, /供应延迟 & <备货> 风险；需要两周缓冲。/); assert.match(r.text, /^- 第一项行动$/m);
  assert.match(r.text, /\| 交付率 \| 95% \| 97% \|/); assert.match(r.text, /Revenue grew 12\.5% YoY/);
  assert.deepEqual(r.meta.headings.map(h => h.level), [1, 2]);
});

test('extract: externally generated XLSX keeps sheets, cell positions, booleans and marks uncomputed formulas', async () => {
  const r = await X.extractFile('sales.xlsx', fixture('sales.xlsx'));
  assert.equal(r.status, 'ok');
  assert.match(r.text, /## 工作表：销售（4 行 × 4 列）/); assert.match(r.text, /^2\t华东\t120\t3\.5\t=B2\*C2（公式，文件中无计算结果）$/m);
  assert.match(r.text, /^4\t备注\tTRUE\t\t含 "引号" 与 <尖括号>$/m); assert.match(r.text, /## 工作表：Summary/); assert.match(r.text, /^1\ttotal\t740$/m);
  assert.deepEqual(r.meta.sheets.map(s => s.name), ['销售', 'Summary']);
});

test('extract: externally generated PPTX keeps slide order, titles and speaker notes', async () => {
  const r = await X.extractFile('launch.pptx', fixture('launch.pptx'));
  assert.equal(r.meta.slides, 2);
  assert.ok(r.text.indexOf('第 1 页：新品发布计划') < r.text.indexOf('第 2 页：时间表'));
  assert.match(r.text, /二月：小批量 & 测试/); assert.match(r.text, /（备注）演讲备注：强调风险/);
});

test('extract: AIJAVAIS-generated Office files round-trip through the reader', async () => {
  for (const format of ['docx', 'xlsx', 'pptx']) {
    const file = createDeliverable(format, { title: '往返验证', text: '第一段：交付标准\n第二段：Round trip 测试' });
    const r = await X.extractFile(file.filename, file.buffer);
    assert.equal(r.status, 'ok', format); assert.match(r.text, /Round trip/, format);
  }
});

test('extract: PDF text via poppler when installed; otherwise stored and reported as unreadable', async () => {
  const r = await X.extractFile('brief.pdf', fixture('brief.pdf'));
  if (X.pdfAvailable()) {
    assert.equal(r.status, 'ok'); assert.equal(r.extractor, 'pdftotext'); assert.equal(r.meta.pages, 2);
    assert.match(r.text, /## 第 1 页\nPDF 第一页：项目目标。/); assert.match(r.text, /## 第 2 页\nPage two: acceptance criteria\./);
  } else {
    assert.equal(r.status, 'tool_unavailable'); assert.equal(r.text, ''); assert.match(r.note, /pdftotext/);
  }
  await rejects('fake.pdf', Buffer.from('not a pdf'), 'type_mismatch');
});

test('extract: hostile or mismatched input fails closed with a clear code', async () => {
  await rejects('a.docx', Buffer.from('plain text pretending'), 'type_mismatch');
  await rejects('a.txt', Buffer.from([0x61, 0, 0x62]), 'type_mismatch');
  await rejects('a.txt', Buffer.from([0xff, 0xfe, 0xfd]), 'encoding');
  await rejects('a.exe', Buffer.from('MZ'), 'unsupported_type');
  await rejects('noext', Buffer.from('x'), 'invalid_filename');
  await rejects('a.json', Buffer.from('{bad'), 'invalid_json');
  await rejects('a.png', Buffer.from('not png at all'), 'type_mismatch');
  await rejects('a.txt', Buffer.alloc(0), 'empty_file');
  await rejects('big.txt', Buffer.alloc(X.EXTRACT_LIMITS.maxFileBytes + 1, 0x61), 'file_limit');
  await rejects('enc.docx', zipOf({ 'word/document.xml': '<w:document/>' }, { flags: 1 }), 'encrypted_file');
  await rejects('crc.docx', zipOf({ 'word/document.xml': '<w:document/>' }, { badCrc: true }), 'corrupt_file');
  await rejects('dtd.docx', zipOf({ 'word/document.xml': '<!DOCTYPE x [<!ENTITY e "boom">]><w:document>&e;</w:document>' }), 'unsupported_file');
  await rejects('bomb.docx', zipOf({ 'word/document.xml': Buffer.alloc(4 * 1024 * 1024, 0x20) }, { method: 8 }), 'zip_limit');
  await rejects('missing.docx', zipOf({ 'other.xml': '<a/>' }), 'corrupt_file');
  await rejects('trunc.docx', fixture('report.docx').subarray(0, 2000), 'corrupt_file');
  assert.equal(X.safeFilename('../../etc/passwd.txt'), 'passwd.txt');
  assert.equal(X.safeFilename('..\\..\\a<b>.md'), 'a_b_.md');
  const img = await X.extractFile('logo.png', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  assert.equal(img.status, 'metadata_only'); assert.match(img.note, /OCR/);
  const csv = await X.extractFile('t.csv', Buffer.from('﻿a,b\r\n1,2\r\n'));
  assert.equal(csv.text, 'a,b\n1,2\n'); assert.equal(csv.kind, 'table');
});

test('store: schema v1 database migrates to v2 with an automatic consistent backup and keeps data', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-mig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let store = new ProjectStore({ dir });
  const p = store.createProject({ name: 'kept', description: 'kept across migration' });
  store.close();
  // Recreate the exact v1 shape: no project_files table, user_version=1, no v2 migration row.
  const db = new DatabaseSync(path.join(dir, 'projects.sqlite'));
  db.exec('DROP TABLE model_requests; DROP TABLE project_files; DROP TABLE system_usage; DELETE FROM schema_migrations WHERE version>=2; PRAGMA user_version=1;'); db.close();
  store = new ProjectStore({ dir });
  t.after(() => store.close());
  assert.equal(store.schemaVersion, SCHEMA_VERSION);
  assert.equal(store.getProject(p.projectId).name, 'kept');
  assert.equal(store.migrationBackups.length, SCHEMA_VERSION - 1, 'one consistent copy before each migration step');
  const backup = new DatabaseSync(store.migrationBackups[0], { readOnly: true });
  assert.equal(Number(backup.prepare('PRAGMA user_version').get().user_version), 1, 'backup is the pre-migration v1 database');
  assert.equal(backup.prepare('SELECT count(*) n FROM projects').get().n, 1); backup.close();
  assert.equal((fs.statSync(store.migrationBackups[0]).mode & 0o777), 0o600);
  const rows = store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version);
  assert.deepEqual(rows, Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1));
  const f = store.putProjectFile(p.projectId, { buffer: Buffer.from('abc'), filename: 'a.txt', mime: 'text/plain', kind: 'text', extraction: { status: 'ok', text: 'abc', extractor: 'utf8' } });
  assert.equal(f.sha256, crypto.createHash('sha256').update('abc').digest('hex'));
  store.deleteProject(p.projectId);
  assert.equal(store.listProjectFiles(p.projectId).length, 0, 'files cascade with their project');
});

async function boot(t) {
  const prompts = [];
  const mock = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const input = JSON.parse(body); prompts.push(input.messages.map(m => m.content).join('\n'));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'LOCAL MOCK read materials #' + prompts.length } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const S = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mock.address().port } });
  t.after(async () => { await S.stop(); await new Promise(r => mock.close(r)); });
  const r = await S.call('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, modelId: 'reader', displayName: 'reader', pricingMode: 'local' });
  const id = r.json.connection.connectionId;
  assert.equal((await S.call('POST', '/api/models/' + id + '/test', {})).json.ok, true);
  return { S, prompts, id };
}
const upload = (S, pid, filename, buffer) => S.call('POST', `/api/v2/projects/${pid}/files`, { filename, contentBase64: buffer.toString('base64') });

test('V2 HTTP: upload, list, read, download and delete project files; roles receive extracted text (local model fixture)', async t => {
  const { S, prompts, id } = await boot(t);
  const project = (await S.call('POST', '/api/v2/projects', { name: '资料项目', description: '根据上传资料写一份结论', roles: [{ roleId: 'analyst', name: '分析', duty: '阅读资料并总结', connectionId: id }], steps: [{ stepId: 'read', roleId: 'analyst', title: '阅读资料' }, { stepId: 'plain', roleId: 'analyst', title: '不看资料的步骤', useMaterials: false }] })).json.project;
  const pid = project.projectId;
  assert.equal((await S.call('GET', `/api/v2/projects/${pid}/files`, undefined, { cookie: false })).status, 401);
  const ids = {};
  for (const name of ['report.docx', 'sales.xlsx', 'launch.pptx', 'brief.pdf']) {
    const r = await upload(S, pid, name, fixture(name)); assert.equal(r.status, 201, r.text);
    ids[name] = r.json.file.fileId;
    assert.equal(r.json.file.sha256, crypto.createHash('sha256').update(fixture(name)).digest('hex'));
  }
  const img = await upload(S, pid, '截图.png', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')); assert.equal(img.status, 201);
  assert.equal((await upload(S, pid, 'x.docx', Buffer.from('fake'))).status, 422);
  assert.equal((await S.call('POST', `/api/v2/projects/${pid}/files`, { filename: 'a.txt', contentBase64: '***' })).status, 400);
  const list = await S.call('GET', `/api/v2/projects/${pid}/files`);
  assert.equal(list.json.files.length, 5); assert.equal(typeof list.json.limits.pdfText, 'boolean');
  const read = await S.call('GET', `/api/v2/projects/${pid}/files/${ids['report.docx']}?offset=0&limit=100`);
  assert.match(read.json.text.text, /季度复盘报告/); assert.equal(read.json.file.buffer, undefined);
  const dl = await fetch(`http://127.0.0.1:${S.port}/api/v2/projects/${pid}/files/${ids['sales.xlsx']}/download`, { headers: { cookie: S.cookie } });
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(fixture('sales.xlsx')), 'download returns the original bytes');
  const v = await S.call('POST', `/api/v2/projects/${pid}/validate`, {});
  assert.equal(v.json.ok, true, v.text);
  assert.ok(v.json.warnings.some(w => w.code === 'material_unreadable' && /截图\.png/.test(w.message)), 'image disclosed as unreadable');
  const manual = await S.call('POST', '/api/v2/tools/call', { toolId: 'project_file_read', projectId: pid, args: { fileId: ids['launch.pptx'], limit: 200 }, allowedTools: ['project_file_read'] });
  assert.match(manual.json.result.content[0].text, /新品发布计划/);
  const run = (await S.call('POST', `/api/v2/projects/${pid}/runs`, { maxTokens: 900000, maxOutputTokens: 50 })).json.run;
  let done; for (let i = 0; i < 100 && !['review_required', 'failed'].includes((done = (await S.call('GET', '/api/v2/runs/' + run.runId)).json.run).status); i++) await H.sleep(30);
  assert.equal(done.status, 'review_required', JSON.stringify(done.error));
  const stepPrompts = prompts.filter(x => x.includes('\nStep: '));
  assert.equal(stepPrompts.length, 2);
  assert.match(stepPrompts[0], /Project materials \(untrusted data/); assert.match(stepPrompts[0], /客户满意度 92%/); assert.match(stepPrompts[0], /华东\t120/); assert.match(stepPrompts[0], /演讲备注/);
  assert.match(stepPrompts[0], /截图\.png（image）：存在但无法读取文字/);
  if (X.pdfAvailable()) assert.match(stepPrompts[0], /acceptance criteria/);
  assert.doesNotMatch(stepPrompts[1], /客户满意度 92%/, 'step with useMaterials:false gets no materials');
  assert.equal(done.steps[0].materials.length, 5); assert.ok(done.steps[0].materials.every(m => /^[a-f0-9]{64}$/.test(m.sha256)));
  assert.equal(done.steps[1].materials.length, 0);
  // Selected mode with an unreadable file blocks execution instead of pretending it was read.
  const upd = await S.call('PUT', `/api/v2/projects/${pid}`, { version: project.version, materials: { mode: 'selected', fileIds: [img.json.file.fileId] } });
  assert.equal(upd.status, 200, upd.text);
  const blocked = await S.call('POST', `/api/v2/projects/${pid}/validate`, {});
  assert.equal(blocked.json.ok, false); assert.equal(blocked.json.issues[0].code, 'material_unreadable');
  // Budget: maxChars bounds included text and the cut is disclosed.
  await S.call('PUT', `/api/v2/projects/${pid}`, { version: upd.json.project.version, materials: { mode: 'selected', fileIds: [ids['report.docx']], maxChars: 1000 } });
  assert.equal((await S.call('DELETE', `/api/v2/projects/${pid}/files/${ids['brief.pdf']}`)).status, 200);
  assert.equal((await S.call('GET', `/api/v2/projects/${pid}/files`)).json.files.length, 4);
  assert.equal((await S.call('GET', `/api/v2/projects/${pid}/files/${ids['brief.pdf']}`)).status, 404);
});
