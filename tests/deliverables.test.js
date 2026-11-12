'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createDeliverable, DELIVERABLE_LIMITS } = require('../lib/deliverables');

// Independent ZIP reader: trust central directory offsets and verify every local
// signature/filename/size. Python below independently validates all CRCs and XML.
function entries(buffer) {
  const eocd = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(eocd), 0x06054b50);
  const count = buffer.readUInt16LE(eocd + 10), out = new Map();
  let at = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    assert.equal(buffer.readUInt16LE(at + 10), 0); // STORE
    const size = buffer.readUInt32LE(at + 24), length = buffer.readUInt16LE(at + 28);
    const name = buffer.subarray(at + 46, at + 46 + length).toString('utf8');
    const local = buffer.readUInt32LE(at + 42);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    assert.equal(buffer.readUInt32LE(local + 18), size);
    const localLength = buffer.readUInt16LE(local + 26);
    assert.equal(buffer.subarray(local + 30, local + 30 + localLength).toString('utf8'), name);
    out.set(name, buffer.subarray(local + 30 + localLength, local + 30 + localLength + size));
    at += 46 + length + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return out;
}
const sample = { title: 'AIJAVAIS 方案 & "成果"', text: '实际正文：研发 <审核>\n第二段 🧪', sections: [{ heading: '职责边界', text: '草拟 → 审核 → 修订' }] };

test('DOCX contains actual WordprocessingML, styled headings and all escaped Unicode content', () => {
  const result = createDeliverable('docx', sample), zip = entries(result.buffer);
  assert.equal(result.extension, 'docx');
  assert.match(result.mime, /wordprocessingml/);
  assert.match(zip.get('[Content_Types].xml').toString(), /word\/document.xml/);
  const xml = zip.get('word/document.xml').toString();
  assert.match(xml, /实际正文：研发 &lt;审核&gt;/);
  assert.match(xml, /&amp; &quot;成果&quot;/);
  assert.match(xml, /第二段 🧪/);
  assert.match(xml, /w:pStyle w:val="Heading1"/);
  assert.match(zip.get('word/styles.xml').toString(), /w:styleId="Title"/);
});

test('XLSX contains real numeric/boolean cells and stores formula-like input strictly as inline text', () => {
  const result = createDeliverable('xlsx', { title: '[量化]/标准', rows: [['项目', '值'], ['=WEBSERVICE("https://example.invalid")', 42], ['启用', true], ['空', null]] });
  const zip = entries(result.buffer), xml = zip.get('xl/worksheets/sheet1.xml').toString();
  assert.match(xml, /<c r="B2"><v>42<\/v><\/c>/);
  assert.match(xml, /<c r="B3" t="b"><v>1<\/v><\/c>/);
  assert.match(xml, /<c r="A2" t="inlineStr">/);
  assert.match(xml, /=WEBSERVICE\(&quot;https:\/\/example.invalid&quot;\)/);
  assert.doesNotMatch(xml, /<f[ >]/);
  assert.match(xml, /state="frozen"/);
  assert.match(xml, /<autoFilter ref="A1:B4"/);
  assert.match(zip.get('xl/workbook.xml').toString(), /sheet name="量化  标准"/);
});

test('PPTX produces connected slide master/layout/theme and paginates without losing body text', () => {
  const lines = Array.from({ length: 23 }, (_, i) => `第${i + 1}条交付标准`);
  const result = createDeliverable('pptx', { title: '交付检查', text: lines.join('\n') });
  const zip = entries(result.buffer);
  assert.ok(zip.has('ppt/theme/theme1.xml'));
  assert.ok(zip.has('ppt/slideMasters/slideMaster1.xml'));
  assert.ok(zip.has('ppt/slideLayouts/slideLayout1.xml'));
  assert.ok(zip.has('ppt/slides/_rels/slide1.xml.rels'));
  // B5-F2: a cover, then at most 6 points per slide (23 points -> 4 content slides): 5 slides
  assert.equal([...zip.keys()].filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length, 5);
  const allSlides = [...zip.entries()].filter(([n]) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).map(([, v]) => v.toString()).join('');
  for (const line of lines) assert.ok(allSlides.includes(line));
  assert.match(allSlides, /5 \/ 5/);
  const custom = entries(createDeliverable('pptx', { title: '报告', slides: [{ title: '检查点', bullets: ['凭据隔离', '预算控制'] }] }).buffer);
  assert.match(custom.get('ppt/slides/slide2.xml').toString(), /<a:buChar char="●"\/><\/a:pPr><a:r>[\s\S]*?<a:t>凭据隔离<\/a:t>/, 'legacy {title, bullets} input: real bullets after a cover');
});

test('CSV quotes delimiters/newlines and neutralizes spreadsheet formulas', () => {
  const csv = createDeliverable('csv', { rows: [['=1+1', ' +cmd', '@SUM(A1)', '-4', -4, 'a,"b"\nc', '\t=2']] }).buffer.toString();
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /"'=1\+1"/);
  assert.match(csv, /"' \+cmd"/);
  assert.match(csv, /"'@SUM\(A1\)"/);
  assert.match(csv, /"'-4","-4"/);
  assert.match(csv, /"a,""b""\nc"/);
  assert.match(csv, /"'\t=2"/);
});

test('code ZIP contains exactly the supplied files, including UTF-8 nested paths and binary bytes', () => {
  const binary = Buffer.from([0, 1, 128, 255]);
  const result = createDeliverable('code', { filename: '../../example.js', files: [{ path: '源码/main.js', content: 'console.log("actual source");' }, { path: 'asset.bin', content: binary }] });
  const zip = entries(result.buffer);
  assert.equal(result.filename, '_.._example.zip');
  assert.equal(result.mime, 'application/zip');
  assert.equal(zip.get('源码/main.js').toString(), 'console.log("actual source");');
  assert.deepEqual(zip.get('asset.bin'), binary);
  assert.equal(zip.size, 2);
  assert.equal(entries(createDeliverable('zip', { files: { 'README.md': '# actual' } }).buffer).get('README.md').toString(), '# actual');
});

test('code ZIP rejects path traversal, absolute, reserved, colliding and invalid paths', () => {
  for (const name of ['../x.js', '/tmp/x', 'a/../x', './x', 'a//x', 'a\\x', 'C:x', 'a/', 'CON.js', 'a/NUL', 'a. /x', 'a\u0000b', 'a?b']) {
    assert.throws(() => createDeliverable('zip', { files: [{ path: name, content: 'x' }] }), /不安全/);
  }
  assert.throws(() => createDeliverable('zip', { files: [{ path: 'A.js', content: 'x' }, { path: 'a.js', content: 'y' }] }), /重复/);
  assert.throws(() => createDeliverable('zip', { text: 'placeholder' }), /真实文件/);
});

test('format/input/output limits fail closed instead of producing misleading or truncated deliverables', () => {
  assert.throws(() => createDeliverable('pdf', sample), /不支持/);
  assert.throws(() => createDeliverable('docx', { text: 'bad\u0000content' }), /控制字符/);
  assert.throws(() => createDeliverable('docx', { text: '\ud800' }), /控制字符/);
  assert.throws(() => createDeliverable('txt', { title: 'x'.repeat(501) }), /标题/);
  assert.throws(() => createDeliverable('xlsx', { rows: [[Infinity]] }), /有限/);
  assert.throws(() => createDeliverable('xlsx', { rows: [new Array(101).fill('x')] }), /列数/);
  assert.throws(() => createDeliverable('xlsx', { rows: new Array(10001).fill(['x']) }), /行数/);
  assert.throws(() => createDeliverable('pptx', { slides: [] }), /slides/);
  assert.throws(() => createDeliverable('pptx', { title: 'x'.repeat(200), text: 'body' }), /标题过长/);
  assert.throws(() => createDeliverable('txt', { text: 'x'.repeat(DELIVERABLE_LIMITS.maxInputBytes + 1) }), /大小/);
  assert.throws(() => createDeliverable('json', { data: 'x'.repeat(DELIVERABLE_LIMITS.maxInputBytes + 1) }), /大小/);
  assert.throws(() => createDeliverable('code', { files: { 'large.txt': Buffer.alloc(DELIVERABLE_LIMITS.maxInputBytes + 1) } }), /大小/);
});

test('plain text/Markdown/JSON export real content with safe names and deterministic bytes', () => {
  assert.match(createDeliverable('md', sample).buffer.toString(), /^# AIJAVAIS/);
  assert.match(createDeliverable('txt', sample).buffer.toString(), /职责边界/);
  assert.equal(JSON.parse(createDeliverable('json', sample).buffer).text, sample.text);
  assert.deepEqual(JSON.parse(createDeliverable('json', { data: { checks: ['actual', 'structured'] } }).buffer), { checks: ['actual', 'structured'] });
  const a = createDeliverable('docx', sample), b = createDeliverable('docx', sample);
  assert.deepEqual(a.buffer, b.buffer);
  assert.equal(createDeliverable('txt', { filename: 'CON' }).filename, '_CON.txt');
});

test('Python stdlib independently verifies OOXML ZIP CRCs, XML, content types and all relationship targets', t => {
  const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (python.error && python.error.code === 'ENOENT') return t.skip('Python3 optional independent file validator is not installed');
  assert.equal(python.status, 0, python.stderr);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-deliverables-'));
  try {
    for (const format of ['docx', 'xlsx', 'pptx']) fs.writeFileSync(path.join(dir, 'actual.' + format), createDeliverable(format, { ...sample, rows: [['职责', '数量'], ['审核', 3]] }).buffer);
    const script = `import sys, zipfile, xml.etree.ElementTree as E, pathlib, posixpath
root=pathlib.Path(sys.argv[1])
REL='{http://schemas.openxmlformats.org/package/2006/relationships}'
CT='{http://schemas.openxmlformats.org/package/2006/content-types}'
for f in sorted(root.iterdir()):
 with zipfile.ZipFile(f) as z:
  assert z.testzip() is None, f'CRC mismatch: {f}'
  names=set(z.namelist())
  assert len(names)==len(z.namelist())
  for n in names:
   if n.endswith('.xml') or n.endswith('.rels'):
    doc=E.fromstring(z.read(n))
    if n.endswith('.rels'):
     source_dir='' if n=='_rels/.rels' else posixpath.dirname(posixpath.dirname(n))
     for rel in doc.findall(REL+'Relationship'):
      assert rel.get('TargetMode')!='External', 'external relationship'
      target=posixpath.normpath(posixpath.join(source_dir,rel.get('Target')))
      assert target in names, f'missing relationship target: {n} -> {target}'
  for part in E.fromstring(z.read('[Content_Types].xml')).findall(CT+'Override'):
   assert part.get('PartName').lstrip('/') in names
  print(f.name+': ZIP CRC, XML, content types, relationships valid')
`;
    const result = spawnSync('python3', ['-c', script, dir], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const format of ['docx', 'xlsx', 'pptx']) assert.ok(result.stdout.includes('actual.' + format + ': ZIP CRC, XML, content types, relationships valid'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('available independent Office parsers open DOCX/XLSX/PPTX and read semantic content', t => {
  const probe = spawnSync('python3', ['-c', 'import docx, openpyxl, pptx'], { encoding: 'utf8' });
  if (probe.error?.code === 'ENOENT' || probe.status !== 0) return t.skip('Optional python-docx/openpyxl/python-pptx are not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-office-parse-'));
  try {
    for (const format of ['docx', 'xlsx', 'pptx']) fs.writeFileSync(path.join(dir, 'actual.' + format), createDeliverable(format, { ...sample, rows: [['职责', '数量'], ['审核', 3]] }).buffer);
    const script = `import sys, pathlib
from docx import Document
from openpyxl import load_workbook
from pptx import Presentation
p=pathlib.Path(sys.argv[1])
assert any('实际正文' in q.text for q in Document(p/'actual.docx').paragraphs)
assert load_workbook(p/'actual.xlsx').active['B2'].value==3
s=Presentation(p/'actual.pptx')
assert len(s.slides)==3  # B5-F2: cover + text slide + section slide
assert any('实际正文' in shape.text for slide in s.slides for shape in slide.shapes if shape.has_text_frame)
print('Independent Office parsers read actual document, workbook and presentation content')
`;
    const result = spawnSync('python3', ['-c', script, dir], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Independent Office parsers read/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
