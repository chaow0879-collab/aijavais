'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../lib/db');
const { ArtifactStore } = require('../lib/artifact-store');
const { diffText } = require('../lib/diff');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-art-'));
  const db = openDb(path.join(dir, 'a.db'));
  const events = [];
  return { dir, db, events, store: new ArtifactStore({ db, dir: path.join(dir, 'artifacts'), onEvent: e => events.push(e) }) };
}

test('成果：创建、版本、SHA-256、审核状态、任务隔离、重启后仍可读取', async () => {
  const { dir, db, store, events } = setup();
  const a = store.create('t1', { name: '方案.md', text: '# 方案\n第一版', createdBy: { type: 'agent', id: 'ai_1_exec', roleId: 'executor' }, stepId: 's1' });
  assert.match(a.artifactId, /^art_[a-f0-9]{12}$/);
  assert.deepEqual([a.kind, a.currentVersion, a.reviewStatus, a.version.size], ['markdown', 1, 'draft', Buffer.byteLength('# 方案\n第一版')]);
  assert.match(a.version.sha256, /^[a-f0-9]{64}$/);
  assert.equal(store.get('t2', a.artifactId), null, '其它任务看不到');
  assert.throws(() => store.read('t2', a.artifactId), /不存在/);
  const v2 = store.addVersion('t1', a.artifactId, { text: '# 方案\n第二版\n新增一节', createdBy: { type: 'agent', id: 'ai_1_exec' }, note: '按审核意见修改' });
  assert.equal(v2.currentVersion, 2); assert.equal(v2.version.parentVersion, 1);
  assert.throws(() => store.addVersion('t1', a.artifactId, { name: 'x.docx', text: 'x' }), /类型必须与原文件一致/);
  assert.equal(store.read('t1', a.artifactId, 1).buffer.toString(), '# 方案\n第一版');
  const d = await store.diff('t1', a.artifactId, 1, 2);
  assert.deepEqual([d.added, d.removed], [2, 1]); assert.match(d.unified, /\+ 第二版/);
  store.setReview('t1', a.artifactId, 2, 'changes_requested', { reviewId: 'rv1', verdict: 'request_changes', by: 'ai_2_rev' });
  assert.equal(store.get('t1', a.artifactId).reviewStatus, 'changes_requested');
  const r = store.restore('t1', a.artifactId, 1, { type: 'user' });
  assert.equal(r.currentVersion, 3); assert.equal(store.read('t1', a.artifactId).buffer.toString(), '# 方案\n第一版', '回退生成新版本，历史保留');
  assert.equal(store.get('t1', a.artifactId).versions.length, 3);
  assert.deepEqual(events.map(e => e.type), ['artifact_created', 'artifact_version', 'artifact_review', 'artifact_version']);
  // 重启（重新打开数据库与存储）后仍可读取
  db.close();
  const db2 = openDb(path.join(dir, 'a.db'));
  const s2 = new ArtifactStore({ db: db2, dir: path.join(dir, 'artifacts') });
  assert.equal(s2.read('t1', a.artifactId, 2).buffer.toString(), '# 方案\n第二版\n新增一节');
  assert.deepEqual(s2.verify(), []);
  // 篡改文件 → 读取报错，一致性检查发现
  const f = path.join(dir, 'artifacts', 't1', a.artifactId, 'v2.md');
  fs.writeFileSync(f, 'tampered');
  assert.throws(() => s2.read('t1', a.artifactId, 2), /校验失败/);
  assert.deepEqual(s2.verify(), [{ artifactId: a.artifactId, version: 2, problem: 'hash_mismatch' }]);
  fs.unlinkSync(path.join(dir, 'artifacts', 't1', a.artifactId, 'v1.md'));
  assert.ok(s2.verify().some(p => p.version === 1 && p.problem === 'missing'));
  db2.close();
});

test('按需读取：Word / Excel / PPTX / PDF 按页或分段提取文本', async () => {
  const { store } = setup();
  const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell } = require('docx');
  const doc = new Document({ sections: [{ children: [new Paragraph({ text: '组织结构方案', heading: HeadingLevel.HEADING_1 }), new Paragraph('总经理下设三个中心。'), new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('部门')] }), new TableCell({ children: [new Paragraph('职责')] })] })] })] }] });
  const d = store.create('t1', { name: '方案.docx', buffer: await Packer.toBuffer(doc) });
  const dt = await store.readText('t1', d.artifactId, {});
  assert.match(dt.text, /# 组织结构方案/); assert.match(dt.text, /总经理下设三个中心/); assert.match(dt.text, /\| 部门 \| 职责/);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('编制'); ws.addRow(['部门', '人数']); ws.addRow(['研发', 12]); ws.getCell('C2').value = { formula: 'B2*2', result: 24 };
  const x = store.create('t1', { name: '编制.xlsx', buffer: Buffer.from(await wb.xlsx.writeBuffer()) });
  const xt = await store.readText('t1', x.artifactId, { page: 1 });
  assert.equal(xt.title, '编制'); assert.match(xt.text, /研发\t12\t24/);
  const PptxGenJS = require('pptxgenjs');
  const p = new PptxGenJS(); p.addSlide().addText('第一页标题', { x: 1, y: 1, w: 8, h: 1 }); const s2 = p.addSlide(); s2.addText('第二页内容', { x: 1, y: 1, w: 8, h: 1 }); s2.addNotes('讲者备注');
  const pp = store.create('t1', { name: '汇报.pptx', buffer: Buffer.from(await p.write({ outputType: 'nodebuffer' })) });
  const pt = await store.readText('t1', pp.artifactId, { page: 2 });
  assert.equal(pt.pages, 2); assert.match(pt.text, /第二页内容/); assert.match(pt.text, /讲者备注/);
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText('Hello PDF page one', { x: 50, y: 700, font, size: 14 }); pdf.addPage().drawText('Second page text', { x: 50, y: 700, font, size: 14 });
  const pf = store.create('t1', { name: 'r.pdf', buffer: Buffer.from(await pdf.save()) });
  const pdt = await store.readText('t1', pf.artifactId, { page: 2 });
  assert.equal(pdt.pages, 2); assert.match(pdt.text, /Second page text/);
  const big = store.create('t1', { name: 'big.txt', text: 'x'.repeat(30000) });
  const part = await store.readText('t1', big.artifactId, { offset: 0, limit: 10000 });
  assert.equal(part.length, 10000); assert.equal(part.nextOffset, 10000); assert.equal(part.total, 30000);
});

test('行级差异', () => {
  const r = diffText('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual([r.added, r.removed, r.unchanged], [2, 1, 3]);
  assert.match(r.unified, /- b\n\+ B/);
});
