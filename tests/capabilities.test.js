'use strict';
// Capability center and readiness: statuses are computed from the running server,
// built-in / MCP / Skill / external / planned are kept distinct, and project
// templates only count a tool as ready when a real implementation exists.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const CAP = require('../lib/capabilities');

const builtin = ids => ids.map(toolId => ({ toolId, name: toolId, executionMode: 'builtin', available: true }));
const withEnv = (key, value, fn) => { const old = process.env[key]; process.env[key] = value; try { return fn(); } finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; } };

test('capabilities: kinds are distinct and nothing is "available" without a registered implementation', () => {
  const tools = [...builtin(['docx_generation', 'project_file_read', 'file_read']), { toolId: 'mcp:fx:echo', name: 'echo', executionMode: 'mcp', serverId: 'fx', available: true }];
  const skills = [{ skillId: 'review', name: '审查', version: '1.0.0', steps: [{ type: 'prompt', text: 'x' }, { type: 'tool', toolId: 'builtin:text-stats' }] }];
  const { capabilities } = CAP.listCapabilities({ tools, skills });
  const by = id => capabilities.find(c => c.id === id);
  assert.equal(by('docx-generate').status, 'available');
  assert.equal(by('xlsx-generate').status, 'needs_setup', 'xlsx tool not registered in this fixture');
  for (const id of ['repository-access', 'diagrams', 'image-read']) assert.equal(by(id).status, 'not_implemented', id);
  assert.equal(by('code-execution').kind, 'builtin'); assert.notEqual(by('code-execution').status, 'available', 'code execution is never available unless registered, enabled and isolated');
  assert.equal(by('office-render').kind, 'builtin'); assert.notEqual(by('office-render').status, 'available', 'render tool not registered in this fixture');
  for (const id of ['charts', 'calculation']) { assert.equal(by(id).kind, 'builtin'); assert.equal(by(id).status, 'needs_setup', id + ' tool not registered in this fixture'); }
  assert.equal(by('web-search').kind, 'external'); assert.equal(by('web-search').status, 'not_implemented');
  assert.equal(by('mcp:fx:echo').kind, 'mcp');
  const skill = by('skill:review');
  assert.equal(skill.kind, 'skill'); assert.match(skill.note, /本身不是工具/); assert.deepEqual(skill.usesTools, ['builtin:text-stats']);
  assert.ok(capabilities.every(c => ['builtin', 'mcp', 'skill', 'external', 'planned'].includes(c.kind)));
});

test('capabilities: template tool IDs resolve to real tools; missing programs and unknown IDs are reported', () => {
  const tools = builtin(['project_file_read', 'file_read', 'docx_generation']);
  const ok = withEnv('PATH', process.env.PATH, () => CAP.resolveIntakeTools(['docx_read', 'docx_generation', 'web_search', 'made_up'], { tools }));
  assert.deepEqual(ok.map(r => [r.intakeId, r.toolId, r.status]), [['docx_read', 'project_file_read', 'available'], ['docx_generation', 'docx_generation', 'available'], ['web_search', null, 'not_implemented'], ['made_up', null, 'unknown']]);
  assert.ok(ok[2].alternative, 'a free alternative is suggested');
  const noPdf = withEnv('AIJ_PDFTOTEXT', '0', () => CAP.resolveIntakeTools(['pdf_read'], { tools }))[0];
  assert.equal(noPdf.status, 'needs_setup'); assert.deepEqual(noPdf.missingPrograms, ['pdftotext']); assert.equal(noPdf.toolId, null);
});

test('readiness: grouped missing-configuration list depends on chosen scenarios', () => {
  const store = { schemaVersion: 2 };
  const base = { system: { node: 'v24.1.0', adminSetup: true, https: false, local: true }, tools: builtin(['docx_generation']), skills: [], store };
  const empty = CAP.readiness({ ...base, models: [] }, ['basic']);
  assert.equal(empty.ready, false);
  assert.ok(empty.missing.required.some(i => i.id === 'models' && /添加至少一个模型/.test(i.howTo)));
  assert.ok(!empty.missing.required.some(i => i.id === 'https'), 'HTTPS is not required for local basic use');
  const models = [{ connectionId: 'm', enabled: true, ready: true, status: 'available', pricingMode: 'local' }];
  const local = CAP.readiness({ ...base, models }, ['basic']);
  assert.equal(local.ready, true, JSON.stringify(local.missing.required));
  const pub = CAP.readiness({ ...base, models, system: { ...base.system, local: false } }, ['basic', 'public', 'files']);
  assert.ok(pub.missing.required.some(i => i.id === 'https'));
  assert.ok(pub.items.find(i => i.id === 'mcp').level === 'optional', 'MCP is never a prerequisite for basic use');
  const old = CAP.readiness({ ...base, models, system: { ...base.system, node: 'v22.0.0' } });
  assert.ok(old.missing.required.some(i => i.id === 'runtime'));
  const keyless = CAP.readiness({ ...base, models: [{ connectionId: 'r', enabled: true, ready: true, status: 'available', pricingMode: 'paid_api', hasKey: false, envReady: false }] });
  assert.ok(keyless.missing.required.some(i => i.id === 'api-keys'));
});

test('V2 HTTP: capability center and readiness are admin-only and reflect the live server', async t => {
  const S = await H.boot({});
  t.after(() => S.stop());
  assert.equal((await S.call('GET', '/api/v2/capabilities', undefined, { cookie: false })).status, 401);
  assert.equal((await S.call('GET', '/api/v2/readiness', undefined, { cookie: false })).status, 401);
  const caps = await S.call('GET', '/api/v2/capabilities');
  assert.equal(caps.status, 200);
  for (const id of ['file-upload-read', 'docx-generate', 'xlsx-generate', 'pptx-generate', 'calculation', 'charts']) assert.equal(caps.json.capabilities.find(c => c.id === id).status, 'available', id);
  assert.ok(caps.json.capabilities.some(c => c.kind === 'skill'));
  const cx = caps.json.capabilities.find(c => c.id === 'code-execution');
  assert.equal(cx.status, 'needs_setup', 'off by default on a fresh server'); assert.match(cx.reason, /管理员未开启/);
  const r = await S.call('GET', '/api/v2/readiness?scenarios=basic,files');
  assert.equal(r.json.items.find(i => i.id === 'admin').status, 'ok');
  assert.equal(r.json.items.find(i => i.id === 'database').status, 'ok');
  assert.ok(r.json.missing.required.some(i => i.id === 'models'), 'no model configured yet');
  assert.doesNotMatch(r.text, /setup-code|password|apiKey/i);
  const plan = await S.call('POST', '/api/v2/intake/plan', { templateId: 'contract-review', description: '请审阅上传的合同 PDF 与 Word 附件，列出风险条款。' });
  assert.equal(plan.status, 200, plan.text);
  const check = Object.fromEntries(plan.json.toolCheck.map(x => [x.intakeId, x]));
  assert.equal(check.docx_read.toolId, 'project_file_read');
  assert.equal(check.pdf_read.status, require('../lib/file-extract').pdfAvailable() ? 'available' : 'needs_setup');
  const draft = await S.call('POST', '/api/v2/intake/projects', { templateId: 'contract-review', description: '请审阅上传的合同 PDF 与 Word 附件，列出风险条款。' });
  assert.equal(draft.status, 201, draft.text);
  assert.ok(draft.json.project.requiredToolIds.includes('project_file_read'), 'template IDs mapped to real registry tools');
});
