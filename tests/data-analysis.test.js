'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const H = require('./helpers');
const DA = require('../lib/data-analysis');
const { readSpreadsheet } = require('../lib/file-extract');

test('analysis: CSV parsing handles quotes, delimiters, BOM and CRLF', () => {
  assert.deepEqual(DA.parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n'), [['a', 'b'], ['x, y', 'he said "hi"']]);
  assert.deepEqual(DA.parseCsv('a\tb\n1\t2\n'), [['a', 'b'], ['1', '2']]);
  assert.throws(() => DA.parseCsv('a,"b\n'), e => e.code === 'invalid_csv');
});

test('analysis: describe / group / top / filter are computed exactly', () => {
  const t = DA.table(DA.parseCsv('地区,销量,单价\n华东,120,3.5\n华南,80,4\n华东,"1,000",2\n华北,,5\n华南,12%,1\n'));
  const [desc, group, top, filter] = DA.analyze(t, [{ op: 'describe', columns: ['销量'] }, { op: 'group', by: '地区', aggregates: [{ column: '销量', fn: 'sum' }, { column: '单价', fn: 'mean' }, { column: '地区', fn: 'count' }] }, { op: 'top', column: '销量', n: 2 }, { op: 'filter', column: '地区', equals: '华南' }]);
  assert.deepEqual(desc.rows[0], ['销量', 5, 4, 1, 1200.12, 300.03, 100, 0.12, 1000, 469.3001920591], 'sample stdev cross-checked with Python statistics.stdev');
  assert.deepEqual(group.rows, [['华东', 1120, 2.75, 2], ['华南', 80.12, 2.5, 2], ['华北', 0, 5, 1]]);
  assert.deepEqual(top.rows.map(r => r[0]), ['华东', '华东']);
  assert.equal(filter.matched, 2);
  assert.throws(() => DA.analyze(t, [{ op: 'eval', code: '1' }]), e => e.code === 'invalid_operations');
  assert.throws(() => DA.analyze(t, [{ op: 'group', by: '不存在' }]), e => e.code === 'column_missing');
});

test('analysis: externally generated XLSX is read as values; uncomputed formulas are counted, never evaluated', () => {
  const r = readSpreadsheet(fs.readFileSync(path.join(__dirname, 'fixtures', 'files', 'sales.xlsx')));
  assert.equal(r.sheet, '销售'); assert.deepEqual(r.sheets, ['销售', 'Summary']); assert.equal(r.uncomputedFormulas, 2);
  assert.deepEqual(r.rows[1], ['华东', '120', '3.5', null]);
  assert.equal(readSpreadsheet(fs.readFileSync(path.join(__dirname, 'fixtures', 'files', 'sales.xlsx')), { sheet: 'Summary' }).rows[0][1], '740');
});

test('charts: SVG bar/line/pie are well-formed, escape labels and reject missing data', () => {
  const svg = DA.svgChart({ type: 'bar', title: '销量 <对比>', labels: ['华东', 'A&B'], series: [{ name: '2026', values: [120, 80] }, { name: '2027', values: [130, -5] }] }).toString();
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/); assert.match(svg, /销量 &lt;对比&gt;/); assert.match(svg, /A&amp;B/);
  assert.equal((svg.match(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" fill="#/g) || []).length, 4 + 2, 'four bars + two legend swatches');
  assert.match(DA.svgChart({ type: 'line', labels: ['1', '2'], series: [{ values: [1, 2] }] }).toString(), /<polyline/);
  assert.match(DA.svgChart({ type: 'pie', labels: ['a', 'b'], series: [{ values: [1, 3] }] }).toString(), /75\.0%/);
  assert.throws(() => DA.svgChart({ labels: ['a', 'b'], series: [{ values: [1] }] }), e => e.code === 'invalid_chart');
  assert.throws(() => DA.svgChart({ type: 'pie', labels: ['a'], series: [{ values: [1] }, { values: [2] }] }), e => e.code === 'invalid_chart');
});

test('V2 HTTP: data_analysis and chart_generation run as granted step tools and save real files (local model fixture)', async t => {
  const prompts = [];
  const mock = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { prompts.push(JSON.parse(b).messages.map(m => m.content).join('\n')); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'LOCAL MOCK summary' } }] }) + '\n\ndata: [DONE]\n\n'); }); });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const S = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mock.address().port } });
  t.after(async () => { await S.stop(); await new Promise(r => mock.close(r)); });
  const id = (await S.call('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, modelId: 'm', displayName: 'm', pricingMode: 'local' })).json.connection.connectionId;
  await S.call('POST', '/api/models/' + id + '/test', {});
  const pid = (await S.call('POST', '/api/v2/projects', { name: '数据', description: '分析销售表', materials: { mode: 'none' }, roles: [{ roleId: 'a', name: '分析', duty: '解释结果', connectionId: id }], steps: [{ stepId: 's', roleId: 'a', title: '分析', toolCalls: [] }] })).json.project.projectId;
  const up = await S.call('POST', `/api/v2/projects/${pid}/files`, { filename: 'sales.csv', contentBase64: Buffer.from('地区,销量\n华东,120\n华南,80\n华东,30\n').toString('base64') });
  const fileId = up.json.file.fileId;
  const project = (await S.call('GET', '/api/v2/projects/' + pid)).json.project;
  const upd = await S.call('PUT', '/api/v2/projects/' + pid, { version: project.version, steps: [{ stepId: 's', roleId: 'a', title: '分析', toolCalls: [
    { toolId: 'data_analysis', args: { fileId, operations: [{ op: 'group', by: '地区', aggregates: [{ column: '销量', fn: 'sum' }] }], saveAs: 'xlsx' } },
    { toolId: 'chart_generation', args: { type: 'bar', title: '各地区销量', labels: ['华东', '华南'], series: [{ name: '销量', values: [150, 80] }] } }] }] });
  assert.equal(upd.status, 200, upd.text);
  assert.equal((await S.call('POST', `/api/v2/projects/${pid}/runs`, { maxTokens: 50000, maxOutputTokens: 50 })).status, 403, 'tools need an explicit grant');
  const run = (await S.call('POST', `/api/v2/projects/${pid}/runs`, { maxTokens: 50000, maxOutputTokens: 50, allowedTools: ['data_analysis', 'chart_generation'] })).json.run;
  let done; for (let i = 0; i < 100 && ['running'].includes((done = (await S.call('GET', '/api/v2/runs/' + run.runId)).json.run).status); i++) await H.sleep(30);
  assert.equal(done.status, 'review_required', done.error);
  const stepPrompt = prompts.find(p => p.includes('\nStep: '));
  assert.match(stepPrompt, /\| 华东 \| 150 \|/, 'computed sum reached the model as tool evidence');
  const files = done.artifacts.filter(a => a.kind === 'file');
  assert.deepEqual(files.map(f => f.mime).sort(), ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'image/svg+xml']);
  const xlsx = await fetch(`http://127.0.0.1:${S.port}${files.find(f => f.producer === 'data_analysis').downloadUrl}`, { headers: { cookie: S.cookie } });
  const r = readSpreadsheet(Buffer.from(await xlsx.arrayBuffer()));
  assert.deepEqual(r.rows.slice(1, 4), [['地区', '销量·sum'], ['华东', '150'], ['华南', '80']]);
});
