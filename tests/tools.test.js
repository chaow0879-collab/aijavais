'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const SEC = require('../lib/security');
const { openDb } = require('../lib/db');
const { Vault } = require('../lib/vault');
const { ArtifactStore } = require('../lib/artifact-store');
const { ToolRegistry } = require('../lib/tools/registry');
const { registerBuiltinTools } = require('../lib/tools/builtin');
const { McpManager } = require('../lib/tools/mcp');
const O = require('../lib/tools/office');

function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-tools-'));
  const db = openDb(path.join(dir, 'a.db'));
  const events = [];
  const artifacts = new ArtifactStore({ db, dir: path.join(dir, 'artifacts') });
  const reg = new ToolRegistry({ db, emit: e => events.push(e) });
  const policy = SEC.policyFromEnv({ LOCAL_MODEL_TARGETS: extra.local || '' });
  let webSearch = extra.webSearch || null;
  registerBuiltinTools(reg, { artifacts, dataDir: dir, policy, webSearch: () => webSearch });
  const ctx = (o = {}) => ({ taskId: 't1', stepId: 's1', instanceId: 'ai_x_exec', roleId: 'executor', ...o });
  return { dir, db, events, artifacts, reg, policy, ctx, setWebSearch: v => { webSearch = v; } };
}

test('工具注册中心：参数校验、权限、审批、超时、取消、结果裁剪、调用日志与事件', async () => {
  const { reg, ctx, db, events } = setup();
  reg.register({ id: 'test.slow', risk: 'read', timeoutMs: 150, inputSchema: { type: 'object', properties: {} }, run: () => new Promise(r => setTimeout(() => r('late'), 1000)) });
  reg.register({ id: 'test.big', risk: 'read', run: () => 'x'.repeat(20000) });
  reg.register({ id: 'test.exec', risk: 'exec', run: () => 'executed' });
  reg.register({ id: 'test.wait', risk: 'read', timeoutMs: 5000, run: (a, c) => new Promise((res, rej) => c.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
  assert.equal((await reg.execute('nope', {}, ctx())).status, 'unavailable');
  const inv = await reg.execute('artifact.read', { artifactId: 'bad' }, ctx());
  assert.equal(inv.status, 'invalid'); assert.match(inv.content, /参数不合法/);
  assert.equal((await reg.execute('artifact.list', {}, ctx({ allowedTools: new Set(['docx.create']) }))).status, 'denied', '岗位未授权');
  const ask = await reg.execute('test.exec', {}, ctx());
  assert.equal(ask.status, 'needs_approval'); assert.equal(ask.approval.risk, 'exec');
  assert.equal((await reg.execute('test.exec', {}, ctx({ approvalGranted: true }))).content, 'executed');
  reg.setPolicy('test.exec', 'deny');
  assert.equal((await reg.execute('test.exec', {}, ctx({ approvalGranted: true }))).status, 'denied', '禁用后即使批准也不执行');
  assert.equal((await reg.execute('test.slow', {}, ctx())).status, 'timeout');
  const ac = new AbortController(); setTimeout(() => ac.abort(), 50);
  assert.equal((await reg.execute('test.wait', {}, ctx({ signal: ac.signal }))).status, 'cancelled');
  const big = await reg.execute('test.big', {}, ctx());
  assert.ok(big.content.length < 13000 && /已截断/.test(big.content));
  const logs = reg.calls('t1');
  assert.ok(logs.length >= 8);
  assert.deepEqual([...new Set(logs.map(l => l.status))].sort(), ['cancelled', 'denied', 'invalid', 'needs_approval', 'ok', 'timeout', 'unavailable'].sort());
  assert.ok(events.some(e => e.type === 'tool_start') && events.some(e => e.type === 'tool_done' && e.status === 'timeout'));
  const defs = await reg.definitions(['docx.create', 'test.exec', 'nope']);
  assert.deepEqual(defs.map(d => d.name), ['docx__create'], '禁用 / 不存在的工具不交给模型');
  db.close();
});

test('办公工具：Word / Excel / PPT 创建与修订、查找替换、改单元格、数据分析（真实文件）', async () => {
  const { reg, ctx, artifacts } = setup();
  const run = async (id, args, o) => { const r = await reg.execute(id, args, ctx(o)); assert.equal(r.status, 'ok', id + '：' + r.content); return r; };
  const d = await run('docx.create', { name: '方案.docx', title: '组织方案', markdown: '# 一、现状\n总经理下设三个中心。\n\n| 部门 | 职责 |\n|---|---|\n| 研发 | 开发 |', deliverable: true });
  const did = d.artifacts[0].artifactId;
  assert.match((await run('artifact.read', { artifactId: did })).content, /# 一、现状[\s\S]*\| 研发 \| 开发/);
  await run('docx.revise', { artifactId: did, markdown: '# 一、现状\n总经理下设四个中心。\n\n# 二、建议\n合并职能。', note: '按审核意见修改' });
  assert.match((await run('artifact.diff', { artifactId: did })).content, /四个中心/);
  const rep = await run('docx.replace_text', { artifactId: did, replacements: [{ find: '四个中心', replace: '两个事业部' }] });
  assert.match(rep.content, /「四个中心」1 处/);
  assert.equal(artifacts.get('t1', did).currentVersion, 3);
  const x = await run('xlsx.create', { name: '编制.xlsx', sheets: [{ name: '编制', columns: ['部门', '岗位', '人数'], rows: [['研发', '工程师', 10], ['研发', '经理', 2], ['工程', '工程师', 7]], totals: { label: '合计', sumColumns: [3] } }] });
  const xid = x.artifacts[0].artifactId;
  const an = await run('data.analyze', { artifactId: xid, operations: [{ type: 'group', by: '部门', metrics: [{ col: '人数', agg: 'sum' }] }, { type: 'describe' }], saveAs: '分析结果.xlsx' });
  assert.match(an.content, /研发\t12/); assert.match(an.content, /工程\t7/); assert.equal(an.artifacts.length, 1);
  await run('xlsx.update_cells', { artifactId: xid, updates: [{ sheet: '编制', cell: 'C2', value: 11 }] });
  assert.match((await run('artifact.read', { artifactId: xid, page: 1 })).content, /研发\t工程师\t11/);
  const csv = artifacts.create('t1', { name: 'sales.csv', text: '区域,金额\n华东,100\n华北,"1,200"\n华东,50' });
  assert.match((await run('data.analyze', { artifactId: csv.artifactId, operations: [{ type: 'group', by: '区域', metrics: [{ col: '金额', agg: 'sum' }] }] })).content, /华东\t150[\s\S]*华北\t1200/);
  const longBullets = Array.from({ length: 16 }, (_, i) => `第 ${i + 1} 条：这是一条用于测试版式溢出的很长很长的要点文字，包含足够多的中文字符`);
  const p = await run('pptx.create', { name: '汇报.pptx', title: '汇报', slides: [{ layout: 'title', title: '汇报' }, { layout: 'bullets', title: '要点', bullets: longBullets }, { layout: 'chart', title: '数据', chart: { type: 'column', categories: ['A', 'B'], series: [{ name: 'x', values: [1, 2] }] } }] });
  assert.match(p.content, /共 3 页/); assert.match(p.content, /第 2 页文字可能溢出/, '溢出被检测出来');
  const pid = p.artifacts[0].artifactId;
  const pr = await run('pptx.revise', { artifactId: pid, replace: [{ index: 2, slide: { layout: 'bullets', title: '要点（精简）', bullets: ['要点一', '要点二'] } }], insert: [{ after: 1, slide: { layout: 'section', number: '01', title: '背景' } }], note: '拆分溢出页' });
  assert.match(pr.content, /共 4 页/); assert.doesNotMatch(pr.content, /溢出/);
  const pt = await run('artifact.read', { artifactId: pid, page: 3 });
  assert.match(pt.content, /要点（精简）/);
  const up = artifacts.create('t1', { name: '外部.pptx', buffer: (await O.buildPptx({ slides: [{ layout: 'bullets', title: 'x', bullets: ['y'] }] })).buffer });
  assert.equal((await reg.execute('pptx.revise', { artifactId: up.artifactId, slides: [] }, ctx())).status, 'error', '没有结构化来源的 PPT 不能按页修订');
});

test('渲染检查与 PDF：LibreOffice 真实渲染页面、转换、合并', { skip: !fs.existsSync('/usr/bin/soffice') && !process.env.CI_HAS_LO }, async () => {
  const { reg, ctx, artifacts } = setup();
  const run = async (id, args) => { const r = await reg.execute(id, args, ctx()); assert.equal(r.status, 'ok', id + '：' + r.content); return r; };
  const p = await run('pptx.create', { name: '检查.pptx', slides: [{ layout: 'title', title: '标题' }, { layout: 'kpi', title: '指标', items: [{ label: 'A', value: '1' }] }] });
  const rc = await run('doc.render_check', { artifactId: p.artifacts[0].artifactId });
  assert.equal(rc.data.pages, 2); assert.equal(rc.data.images.length, 2);
  assert.equal(artifacts.get('t1', rc.data.images[0]).kind, 'image');
  const pdf1 = await run('pdf.create', { name: '报告.pdf', title: '报告', markdown: '# 第一章\n内容' });
  const d = await run('docx.create', { name: 'a.docx', markdown: '# 附录\n内容' });
  const pdf2 = await run('pdf.convert', { artifactId: d.artifacts[0].artifactId });
  const m = await run('pdf.merge', { artifactIds: [pdf1.artifacts[0].artifactId, pdf2.artifacts[0].artifactId], name: '合并.pdf' });
  assert.match(m.content, /共 2 页/);
  assert.match((await run('artifact.read', { artifactId: m.artifacts[0].artifactId, page: 2 })).content, /附录/);
});

test('工作区与执行：路径越界拦截、代码执行需批准、测试运行与报告、Git（钩子被禁用）', async () => {
  const { reg, ctx, dir } = setup();
  const run = async (id, args, o) => { const r = await reg.execute(id, args, ctx(o)); assert.equal(r.status, 'ok', id + '：' + r.content); return r; };
  for (const bad of ['../x.js', '/etc/passwd', 'a/../../x', '.git/hooks/pre-commit']) assert.equal((await reg.execute('workspace.write_file', { path: bad, content: 'x' }, ctx())).status, 'error', bad);
  await run('workspace.write_file', { path: 'src/sum.js', content: 'module.exports = (a, b) => a + b;\n' });
  await run('workspace.write_file', { path: 'test/sum.test.js', content: "const t=require('node:test');const a=require('assert');const s=require('../src/sum');t('sum',()=>a.equal(s(1,2),3));t('sum2',()=>a.equal(s(2,2),4));\n" });
  assert.equal((await reg.execute('code.run', { language: 'javascript', code: 'console.log(1+1)' }, ctx())).status, 'needs_approval', '代码执行默认需要批准');
  const c = await run('code.run', { language: 'javascript', code: "console.log(require('./src/sum')(20, 22)); console.log(Object.keys(process.env).filter(k => /KEY|TOKEN|SECRET/i.test(k)).join(',') || 'no-secrets')" }, { approvalGranted: true });
  assert.match(c.content, /42/); assert.match(c.content, /no-secrets/, '子进程不继承机密环境变量');
  const to = await reg.execute('code.run', { language: 'javascript', code: 'while(true){}', timeoutSec: 1 }, ctx({ approvalGranted: true }));
  assert.match(to.content, /超时被终止/);
  if (fs.existsSync('/usr/local/bin/python3') || fs.existsSync('/usr/bin/python3')) assert.match((await run('code.run', { language: 'python', code: 'print(sum(range(10)))' }, { approvalGranted: true })).content, /45/);
  const t1 = await run('test.run', { runner: 'node', path: 'test' }, { approvalGranted: true });
  assert.equal(t1.data.ok, true); assert.equal(t1.data.passed, 2); assert.equal(t1.data.failed, 0); assert.ok(t1.data.reportArtifactId);
  await run('workspace.write_file', { path: 'test/bad.test.js', content: "require('node:test')('bad',()=>{throw new Error('x')});\n" });
  const t2 = await reg.execute('test.run', { runner: 'node', path: 'test' }, ctx({ approvalGranted: true }));
  assert.equal(t2.status, 'error'); assert.equal(t2.data.ok, false); assert.equal(t2.data.failed, 1);
  // Git：init / add / commit / log；预先放入的钩子不会被执行
  await run('git.run', { command: 'init' });
  const ws = path.join(dir, 'workspaces', 't1');
  fs.writeFileSync(path.join(ws, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ntouch HOOK_RAN\n', { mode: 0o755 });
  await run('git.run', { command: 'add' });
  const cm = await run('git.run', { command: 'commit', message: '初始提交' });
  assert.match(cm.content, /提交：[0-9a-f]{7}/);
  assert.ok(!fs.existsSync(path.join(ws, 'HOOK_RAN')), 'Git 钩子被禁用');
  assert.match((await run('git.run', { command: 'log' })).content, /初始提交/);
  const imp = await run('artifact.import_file', { path: 'src/sum.js', deliverable: true });
  assert.equal(imp.artifacts[0].name, 'sum.js');
});

test('网页工具：读取正文并保存快照、逐跳校验重定向、拒绝内网地址；检索服务未配置时明确不可用', async t => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/old') { res.writeHead(302, { location: '/page' }); return res.end(); }
    if (req.url === '/evil') { res.writeHead(302, { location: 'http://10.0.0.5/secret' }); return res.end(); }
    if (req.url.startsWith('/search')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ results: [{ title: '结果一', url: 'https://example.com/a', content: '摘要一' }] })); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>测试页</title><script>evil()</script></head><body><h1>任职资格</h1><p>行为成果 &amp; 素质能力</p><a href="/x">链接</a></body></html>');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  const port = srv.address().port;
  const { reg, ctx, artifacts, setWebSearch } = setup({ local: '127.0.0.1:' + port });
  const r = await reg.execute('web.fetch', { url: `http://127.0.0.1:${port}/old` }, ctx());
  assert.equal(r.status, 'ok', r.content);
  assert.match(r.content, /经 1 次跳转/); assert.match(r.content, /# 任职资格/); assert.match(r.content, /行为成果 & 素质能力/); assert.doesNotMatch(r.content, /evil\(\)/);
  const snap = artifacts.get('t1', r.artifacts[0].artifactId);
  assert.match(snap.name, /^来源-127\.0\.0\.1-[0-9a-f]{8}\.md$/);
  assert.equal((await reg.execute('web.fetch', { url: `http://127.0.0.1:${port}/evil` }, ctx())).status, 'error', '重定向到内网被拒绝');
  for (const u of ['http://169.254.169.254/latest/meta-data', 'https://10.1.2.3/']) assert.equal((await reg.execute('web.fetch', { url: u }, ctx())).status, 'error', u);
  const un = await reg.execute('web.search', { query: '任职资格' }, ctx());
  assert.equal(un.status, 'unavailable'); assert.match(un.content, /尚未配置检索服务/);
  setWebSearch({ provider: 'searxng', baseUrl: `http://127.0.0.1:${port}` });
  const s = await reg.execute('web.search', { query: '任职资格' }, ctx());
  assert.equal(s.status, 'ok', s.content); assert.match(s.content, /结果一[\s\S]*https:\/\/example\.com\/a/);
});

test('MCP：官方 SDK 连接 stdio 服务器、发现并调用工具；默认停用且需批准；不泄露机密环境变量', async t => {
  const { reg, ctx, db, dir } = setup();
  process.env.AIJ_SECRET_TEST_KEY = 'should-not-leak';
  const mcp = new McpManager({ db, registry: reg, vault: new Vault({ dir, env: {} }), dataDir: dir, policy: SEC.policyFromEnv({}) });
  t.after(async () => { delete process.env.AIJ_SECRET_TEST_KEY; await mcp.closeAll(); });
  const add = mcp.add({ name: 'Test MCP', transport: 'stdio', command: process.execPath, args: [path.join(__dirname, 'fixtures', 'mcp-server.js')], env: { MY_TOOL_TOKEN: 'configured-for-this-server' } });
  assert.ok(add.ok, add.error);
  const id = add.server.serverId;
  assert.equal(add.server.enabled, false, '新增默认停用');
  assert.deepEqual(add.server.envKeys, ['MY_TOOL_TOKEN']); assert.ok(!JSON.stringify(db.getDoc('mcp_servers', 'server_id', id)).includes('configured-for-this-server'), '环境变量加密保存');
  const en = await mcp.setEnabled(id, true);
  assert.ok(en.ok, en.error);
  assert.deepEqual(en.server.tools.map(x => x.name).sort(), ['add', 'echo', 'env_probe']);
  const echoId = `mcp.${id}.echo`;
  assert.equal(reg.policyOf(echoId), 'ask', '第三方工具默认需要批准');
  assert.equal((await reg.execute(echoId, { text: 'hi' }, ctx())).status, 'needs_approval');
  assert.equal((await reg.execute(echoId, { text: 'hi' }, ctx({ approvalGranted: true }))).content, 'echo:hi');
  assert.equal((await reg.execute(`mcp.${id}.add`, { a: 2, b: 3 }, ctx({ approvalGranted: true }))).content, '5');
  assert.equal((await reg.execute(`mcp.${id}.add`, { a: 'x' }, ctx({ approvalGranted: true }))).status, 'invalid', '按服务器声明的 schema 校验参数');
  const probe = JSON.parse((await reg.execute(`mcp.${id}.env_probe`, {}, ctx({ approvalGranted: true }))).content);
  assert.ok(!probe.keys.includes('AIJ_SECRET_TEST_KEY'), '平台环境里的机密不会传给 MCP 进程');
  assert.ok(probe.keys.includes('MY_TOOL_TOKEN'), '只传入为它配置的变量');
  assert.equal(fs.realpathSync(probe.cwd), fs.realpathSync(path.join(dir, 'mcp', id)), '工作目录是独立目录');
  const listed = await reg.list();
  assert.equal(listed.find(x => x.id === echoId).risk, 'read');
  assert.equal(listed.find(x => x.id === `mcp.${id}.add`).risk, 'exec', '未声明只读的第三方工具按高风险处理');
  await mcp.setEnabled(id, false);
  assert.equal(reg.get(echoId), null, '停用后工具从注册中心移除');
  const bad = mcp.add({ name: 'Broken', transport: 'stdio', command: '/nonexistent/binary' });
  const r = await mcp.setEnabled(bad.server.serverId, true);
  assert.equal(r.ok, false); assert.ok(mcp.list().find(s => s.serverId === bad.server.serverId).error);
  assert.match(mcp.add({ name: 'Bad http', transport: 'http', url: 'http://10.0.0.1/mcp' }).error, /https|LOCAL_MODEL_TARGETS/);
});
