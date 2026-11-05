'use strict';
// Optional system programs: LibreOffice (soffice) and poppler (pdftoppm).
// When a program is missing the affected tests are reported as SKIPPED with the reason.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./helpers');
const OR = require('../lib/office-render');
const { createDeliverable } = require('../lib/deliverables');
const have = OR.officeTools();
const pdftotext = buf => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aij-t-')), 'a.pdf'); fs.writeFileSync(f, buf); return execFileSync('pdftotext', ['-enc', 'UTF-8', f, '-'], { encoding: 'utf8' }); };

test('render: missing programs fail with a clear tool_unavailable code', async () => {
  const old = process.env.PATH; process.env.PATH = '/nonexistent';
  try {
    await assert.rejects(OR.convertToPdf(Buffer.from('x'), 'docx'), e => e.code === 'tool_unavailable');
    await assert.rejects(OR.renderPdf(Buffer.from('%PDF-1.4')), e => e.code === 'tool_unavailable');
  } finally { process.env.PATH = old; }
});

test('render: LibreOffice converts AIJAVAIS DOCX/XLSX/PPTX to real PDFs', { skip: !have.soffice && 'LibreOffice (soffice) not installed' }, async () => {
  for (const format of ['docx', 'xlsx', 'pptx']) {
    const file = createDeliverable(format, { title: '转换验证', text: '第一段：交付标准\n第二段：Conversion check 2026' });
    const pdf = await OR.convertToPdf(file.buffer, format);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', format);
    assert.match(pdftotext(pdf), /Conversion check 2026/, format + ' text survives conversion');
  }
  // Content type is validated before conversion (uploads are magic-checked); the converter itself refuses other extensions.
  await assert.rejects(OR.convertToPdf(Buffer.from('x'), 'exe'), e => e.code === 'unsupported_type');
});

test('render: pdftoppm renders pages to PNG and flags blank pages', { skip: !have.pdftoppm && 'poppler (pdftoppm) not installed' }, async () => {
  const pages = await OR.renderPdf(fs.readFileSync(path.join(__dirname, 'fixtures', 'files', 'brief.pdf')), { maxPages: 5 });
  assert.equal(pages.length, 2);
  for (const p of pages) { assert.ok(p.png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))); assert.equal(p.blank, false); assert.ok(p.inkRatio > 0.002); }
  // Minimal valid one-page PDF with no content stream -> blank page.
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>'];
  let body = '%PDF-1.4\n', offs = [];
  objs.forEach((o, i) => { offs.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const blank = await OR.renderPdf(Buffer.from(body));
  assert.equal(blank.length, 1); assert.equal(blank[0].blank, true);
});

test('V2 HTTP: generated DOCX is converted and rendered by granted step tools (local model fixture)', { skip: !(have.soffice && have.pdftoppm) && 'LibreOffice and poppler required' }, async t => {
  const mock = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '# 渲染验证报告\n正文 Render check line.' } }] }) + '\n\ndata: [DONE]\n\n'); }); });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const S = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mock.address().port } });
  t.after(async () => { await S.stop(); await new Promise(r => mock.close(r)); });
  const id = (await S.call('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, modelId: 'm', displayName: 'm', pricingMode: 'local' })).json.connection.connectionId;
  await S.call('POST', '/api/models/' + id + '/test', {});
  const pid = (await S.call('POST', '/api/v2/projects', { name: '渲染', description: '生成并检查文档', roles: [{ roleId: 'w', name: '撰写', duty: '写报告', connectionId: id }],
    steps: [{ stepId: 'draft', roleId: 'w', title: '撰写' }, { stepId: 'check', roleId: 'w', title: '检查版式', toolCalls: [{ toolId: 'docx_generation', args: {} }, { toolId: 'document_convert', args: {} }, { toolId: 'document_render', args: { maxPages: 3 } }] }] })).json.project.projectId;
  const run = (await S.call('POST', `/api/v2/projects/${pid}/runs`, { maxTokens: 50000, maxOutputTokens: 50, allowedTools: ['docx_generation', 'document_convert', 'document_render'] })).json.run;
  let done; for (let i = 0; i < 300 && (done = (await S.call('GET', '/api/v2/runs/' + run.runId)).json.run).status === 'running'; i++) await H.sleep(50);
  assert.equal(done.status, 'review_required', done.error);
  const mimes = done.artifacts.filter(a => a.kind === 'file').map(a => a.mime);
  assert.ok(mimes.includes('application/pdf')); assert.ok(mimes.includes('image/png'));
  const evidence = done.artifacts.find(a => a.producer === 'document_render' && a.kind === 'tool-result');
  const text = await (await fetch(`http://127.0.0.1:${S.port}${evidence.downloadUrl}`, { headers: { cookie: S.cookie } })).text();
  assert.match(text, /未发现空白页/);
});
