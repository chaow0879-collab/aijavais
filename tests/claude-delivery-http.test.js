'use strict';
// #17 M1–M4 through the REAL server (server.js, auth gates, ProjectEngine run,
// SQLite artifacts, export). Local MOCK model only. The sandbox smoke test runs
// only because this test starts its own isolated server with the administrator
// switch on; where the host cannot isolate, the result must be not_run (NOT_RUN).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const H = require('./helpers');
const FX = require('./claude-delivery-fixtures.cjs');
const OUT = process.env.CLAUDE_DELIVERY_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'aij-claude-delivery-http-'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

async function boot(t, outputs) {
  const provider = http.createServer((req, res) => {
    let input = ''; req.on('data', c => { input += c; }); req.on('end', () => {
      const all = JSON.parse(input).messages.map(m => m.content).join('\n');
      const m = /\[\[OUT:([\w-]+)\]\]/.exec(all);
      const content = m ? JSON.stringify(outputs[m[1]]) : '好';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (m && m[1] === 'hang') { res.write(': pending\n\n'); return; }
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 40 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  const app = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + provider.address().port, AIJ_ENABLE_CODE_EXECUTION: '1' } });
  t.after(async () => { await app.stop(); provider.closeAllConnections(); await new Promise(r => provider.close(r)); });
  const added = await app.call('POST', '/api/models', { providerId: 'ollama', modelId: 'MOCK-delivery', displayName: 'Delivery MOCK', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, pricingMode: 'local', capabilities: ['reasoning', 'writing', 'coding'] });
  const model = added.json.connection.connectionId;
  assert.equal((await app.call('POST', '/api/models/' + model + '/test', {})).json.ok, true);
  return { app, model };
}
async function runProject(f, key, name) {
  const created = await f.app.call('POST', '/api/v2/projects', { name, description: '合成交付检查项目：' + name,
    roles: [{ roleId: 'maker', name: '成果制作', duty: '按要求输出结构化成果', standard: '可复核', connectionId: f.model }],
    steps: [{ stepId: 'make', roleId: 'maker', title: '生成结构化成果', prompt: '[[OUT:' + key + ']] 输出约定的JSON成果' }] });
  assert.equal(created.status, 201, created.text);
  const launched = await f.app.call('POST', '/api/v2/projects/' + created.json.project.projectId + '/runs', { maxTokens: 50000, maxOutputTokens: 4000, maxCost: 0 });
  assert.equal(launched.status, 202, launched.text);
  const runId = launched.json.run.runId;
  if (key === 'hang') return runId;
  for (let i = 0; i < 200; i++) { const r = await f.app.call('GET', '/api/v2/runs/' + runId); if (!['running', 'queued'].includes(r.json.run.status)) { assert.equal(r.json.run.status, 'review_required', JSON.stringify(r.json.run.error)); return runId; } await H.sleep(20); }
  throw new Error('run did not finish');
}
async function bytes(app, method, url, body) {
  const r = await fetch(`http://127.0.0.1:${app.port}${url}`, { method, headers: { cookie: app.cookie, ...(body ? { 'content-type': 'application/json', origin: `http://127.0.0.1:${app.port}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, headers: r.headers, buffer: Buffer.from(await r.arrayBuffer()) };
}
const write = (name, data) => { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name), Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2)); };

test('A/B/C delivery check via real server: four-level status, SVG artifact, linked exports, gates and negative cases', async t => {
  const badOrg = FX.organization(); badOrg.orgChart.nodes[0].parentId = 'prod';
  const outputs = { software: FX.software(), placeholder: FX.placeholderSoftware(), organization: FX.organization(), badorg: badOrg, research: FX.research() };
  const f = await boot(t, outputs), S = f.app, evidence = {};
  const runs = {};
  for (const key of Object.keys(outputs)) runs[key] = await runProject(f, key, 'delivery-' + key);
  // Gates: unauthenticated / foreign origin / unknown run / bad body.
  assert.equal((await S.call('POST', '/api/v2/runs/' + runs.software + '/delivery-check', {}, { cookie: false })).status, 401);
  assert.equal((await S.call('POST', '/api/v2/runs/' + runs.software + '/delivery-check', {}, { headers: { origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal((await S.call('POST', '/api/v2/runs/run_missing/delivery-check', {})).status, 404);
  assert.equal((await S.call('POST', '/api/v2/runs/' + runs.software + '/delivery-check', { smokeTest: 'yes' })).status, 400);
  assert.equal((await S.call('GET', '/api/v2/runs/' + runs.software + '/delivery-check')).status, 404, 'nothing checked yet');

  // A: software. Without the explicit request nothing executes.
  const noSmoke = (await S.call('POST', '/api/v2/runs/' + runs.software + '/delivery-check', {})).json.manifest;
  const swNo = noSmoke.items.find(i => i.kind === 'software');
  assert.equal(swNo.status.usable, 'not_run'); assert.equal(swNo.smoke.ran, false); assert.match(swNo.status.reason, /未请求/);
  const smoke = (await S.call('POST', '/api/v2/runs/' + runs.software + '/delivery-check', { smokeTest: true })).json.manifest;
  const sw = smoke.items.find(i => i.kind === 'software');
  if (sw.smoke.isolated) {
    assert.equal(sw.status.usable, 'runnable_verified', JSON.stringify(sw.smoke)); assert.match(sw.smoke.stdout, /LEDGER SMOKE OK/);
    evidence.softwareSmoke = 'PASS (runnable_verified in isolated sandbox)';
  } else {
    assert.equal(sw.status.usable, 'not_run', 'never verified without an isolated real run'); evidence.softwareSmoke = 'NOT_RUN: ' + sw.status.reason;
  }
  assert.equal(sw.status.expertReview, 'not_run'); assert.equal(smoke.summary.expertReviewed, 0);
  const persisted = (await S.call('GET', '/api/v2/runs/' + runs.software + '/delivery-check')).json.manifest;
  assert.equal(persisted.items[0].status.usable, sw.status.usable, 'latest manifest is persisted as a run artifact');
  const placeholder = (await S.call('POST', '/api/v2/runs/' + runs.placeholder + '/delivery-check', { smokeTest: true })).json.manifest.items[0];
  assert.equal(placeholder.status.usable, 'mock_placeholder'); assert.equal(placeholder.smoke.ran, false, 'placeholder code is never executed');
  const zip = await bytes(S, 'POST', '/api/v2/runs/' + runs.software + '/export', { format: 'zip' });
  assert.equal(zip.status, 200); write('A-software.zip', zip.buffer);
  const swDocx = await bytes(S, 'POST', '/api/v2/runs/' + runs.software + '/export', { format: 'docx' });
  assert.equal(swDocx.status, 200); write('A-software-report.docx', swDocx.buffer);

  // B: organization. Valid chart => SVG artifact + linked DOCX/PPTX/XLSX; invalid chart => no SVG, errors shown.
  const org = (await S.call('POST', '/api/v2/runs/' + runs.organization + '/delivery-check', {})).json.manifest;
  const chart = org.items.find(i => i.kind === 'organization');
  assert.equal(chart.status.usable, 'graph_validated'); assert.equal(org.generatedArtifacts.length, 1);
  const svgMeta = org.generatedArtifacts[0];
  const svg = await bytes(S, 'GET', svgMeta.downloadUrl);
  assert.equal(svg.status, 200); assert.equal(svg.headers.get('content-type'), 'image/svg+xml'); assert.equal(sha(svg.buffer), svgMeta.sha256);
  assert.doesNotMatch(svg.buffer.toString(), /<script|on[a-z]+=|href=/i); write('B-org-chart.svg', svg.buffer);
  const recheck = (await S.call('POST', '/api/v2/runs/' + runs.organization + '/delivery-check', {})).json.manifest;
  const svgFile = recheck.files.find(x => x.filename === 'org-chart.svg');
  assert.ok(!svgFile, 'the checker does not grade its own generated files as run outputs');
  const bad = (await S.call('POST', '/api/v2/runs/' + runs.badorg + '/delivery-check', {})).json.manifest;
  assert.equal(bad.items[0].status.usable, 'failed'); assert.ok(bad.items[0].errors.some(e => /环/.test(e))); assert.equal(bad.generatedArtifacts.length, 0);
  const orgFiles = {};
  for (const format of ['docx', 'pptx', 'xlsx']) { const r = await bytes(S, 'POST', '/api/v2/runs/' + runs.organization + '/export', { format }); assert.equal(r.status, 200); orgFiles[format] = r.buffer; write('B-org-report.' + format, r.buffer); }

  // C: research evidence chain.
  const res = (await S.call('POST', '/api/v2/runs/' + runs.research + '/delivery-check', {})).json.manifest.items[0];
  assert.equal(res.kind, 'research'); assert.equal(res.status.usable, 'evidence_gaps'); assert.equal(res.summary.verified, 0);
  assert.deepEqual(res.claims.map(c => c.state), ['synthetic_only', 'unverified', 'unverified', 'unsupported']);
  const resFiles = {};
  for (const format of ['docx', 'xlsx', 'md']) { const r = await bytes(S, 'POST', '/api/v2/runs/' + runs.research + '/export', { format }); assert.equal(r.status, 200); resFiles[format] = r.buffer; write('C-research-report.' + format, r.buffer); }
  assert.match(resFiles.md.toString(), /## 证据清单与核验状态[\s\S]*\[E1\][\s\S]*synthetic[\s\S]*平台未访问任何链接/);

  // Stored run outputs are graded by structure; office files are "structure only", never "usable".
  const files = (await S.call('POST', '/api/v2/runs/' + runs.organization + '/delivery-check', {})).json.manifest.files;
  assert.ok(files.length >= 3); assert.ok(files.every(x => x.structure === 'valid' && x.usable === 'structure_only' && x.expertReview === 'not_run'), JSON.stringify(files.map(x => [x.filename, x.structure, x.usable])));

  // Independent parsing of the exported files.
  const probe = spawnSync('python3', ['-c', 'import docx, openpyxl, pptx'], { encoding: 'utf8' });
  if (probe.status !== 0) evidence.independentParse = 'NOT_RUN (python-docx/openpyxl/python-pptx missing)';
  else {
    const r = spawnSync('python3', ['-c', `import sys,json,zipfile,docx,openpyxl,pptx,xml.etree.ElementTree as ET
d=sys.argv[1]
svg=ET.parse(d+'/B-org-chart.svg').getroot()
ns='{http://www.w3.org/2000/svg}'
o={'zip':zipfile.ZipFile(d+'/A-software.zip').namelist(),
 'swdocx':[p.text for p in docx.Document(d+'/A-software-report.docx').paragraphs],
 'orgdocx':[p.text for p in docx.Document(d+'/B-org-report.docx').paragraphs],
 'orgpptx':[sh.text_frame.text for s in pptx.Presentation(d+'/B-org-report.pptx').slides for sh in s.shapes if sh.has_text_frame],
 'orgxlsx':[[('' if c is None else str(c)) for c in row] for row in openpyxl.load_workbook(d+'/B-org-report.xlsx').active.iter_rows(values_only=True)],
 'resdocx':[p.text for p in docx.Document(d+'/C-research-report.docx').paragraphs],
 'resxlsx':[[('' if c is None else str(c)) for c in row] for row in openpyxl.load_workbook(d+'/C-research-report.xlsx').active.iter_rows(values_only=True)],
 'svgNodes':len(svg.findall('.//'+ns+'g')),'svgTag':svg.tag}
print(json.dumps(o,ensure_ascii=False))`, OUT], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const p = JSON.parse(r.stdout);
    assert.deepEqual(p.zip.sort(), ['README.md', 'package.json', 'src/ledger.js', 'test/ledger.test.js']);
    assert.ok(p.swdocx.includes('软件交付清单'));
    assert.ok(p.orgdocx.includes('组织结构（已校验）')); assert.ok(p.orgdocx.some(x => x.includes('org-chart.svg') && x.includes(svgMeta.sha256)), 'DOCX links the exact SVG artifact hash');
    assert.ok(p.orgpptx.some(x => x.includes('组织优化摘要'))); assert.ok(p.orgxlsx.some(row => row.includes('缩短审批链')), 'model-provided rows are kept');
    assert.ok(p.resdocx.includes('证据清单与核验状态')); assert.deepEqual(p.resxlsx[0].slice(0, 2), ['主张ID', '主张（含引用标注）']); assert.equal(p.resxlsx[4][3], 'unsupported');
    assert.equal(p.svgNodes, 8); assert.equal(p.svgTag, '{http://www.w3.org/2000/svg}svg');
    evidence.independentParse = 'PARSED (zipfile, python-docx, python-pptx, openpyxl, xml.etree)';
  }
  const hashes = Object.fromEntries(fs.readdirSync(OUT).filter(n => !n.endsWith('.json')).map(n => [n, sha(fs.readFileSync(path.join(OUT, n)))]));
  write('evidence.json', { ...evidence, hashes, runs });
  t.diagnostic(JSON.stringify({ out: OUT, ...evidence }));
  console.log('CLAUDE DELIVERY HTTP ' + JSON.stringify(evidence) + ' out=' + OUT);
});

test('delivery check refuses while a run is active and never mutates billing or project state', async t => {
  const outputs = { software: FX.software(), hang: {} };
  const f = await boot(t, outputs);
  const active = await runProject(f, 'hang', 'still-running');
  const refused = await f.app.call('POST', '/api/v2/runs/' + active + '/delivery-check', { smokeTest: true });
  assert.equal(refused.status, 409); assert.equal(refused.json.code, 'run_active');
  await f.app.call('POST', '/api/v2/runs/' + active + '/cancel', {});
  const runId = await runProject(f, 'software', 'billing-neutral');
  const before = (await f.app.call('GET', '/api/v2/runs/' + runId)).json.run;
  await f.app.call('POST', '/api/v2/runs/' + runId + '/delivery-check', { smokeTest: true });
  const after = (await f.app.call('GET', '/api/v2/runs/' + runId)).json.run;
  assert.deepEqual(after.usage, before.usage, 'usage ledger untouched'); assert.equal(after.status, before.status);
  assert.deepEqual(after.usageLedger, before.usageLedger);
  assert.ok(after.events.some(e => e.eventType === 'delivery_checked'));
  assert.equal((await f.app.call('GET', '/api/v2/usage/system')).json.usage.filter(u => u.kind === 'intake_draft').length, 0);
});
