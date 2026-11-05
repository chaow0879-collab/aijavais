'use strict';
// #14 package 5: three synthetic industry projects through the REAL server
// (server.js + HTTP + auth + SQLite + real file export) with a deterministic
// local MOCK model. This proves the APPLICATION FLOW only; it does not judge
// model intelligence or real industry deliverable quality, and it is developer
// self-test material - not the independent product acceptance of #4.
// Evidence (drafts, saved projects, exported files, SHA-256, parser results)
// is written to $INDUSTRY_E2E_OUT (or a printed temp dir) and kept.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const H = require('./helpers');
const INDUSTRIES = ['software-development', 'enterprise-organization', 'cross-domain-research']
  .map(id => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'industry', id + '.json'), 'utf8')));
const OUT = process.env.INDUSTRY_E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'aij-industry-e2e-'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const write = (dir, name, data) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2)); };

function replyFor(fx, mode, abnormal) {
  if (mode === 'malicious') {
    const r = JSON.parse(JSON.stringify(fx.draftReply));
    Object.assign(r, fx.malicious.extra); Object.assign(r.roles[0], fx.malicious.roleExtra); Object.assign(r.steps[0], fx.malicious.stepExtra);
    return '```json\n' + JSON.stringify(r) + '\n```';
  }
  if (mode === 'abnormal') {
    if (abnormal.reply) return abnormal.reply;
    const r = { ...JSON.parse(JSON.stringify(fx.draftReply)), ...(abnormal.patch || {}) };
    if (abnormal.goalLength) r.goal = '长'.repeat(abnormal.goalLength);
    return JSON.stringify(r);
  }
  return JSON.stringify(fx.draftReply);
}
async function boot(t, fx) {
  const state = { mode: 'ok', abnormal: null, draftCalls: 0, stepCalls: 0, held: [] };
  const provider = http.createServer((req, res) => {
    let input = ''; req.on('data', c => { input += c; }); req.on('end', () => {
      const body = JSON.parse(input), all = body.messages.map(m => m.content).join('\n'), last = body.messages.at(-1).content;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let content = '好';
      if (last.startsWith('Design a team')) {
        state.draftCalls++;
        if (state.mode === 'hang') { state.held.push(res); res.write(': pending\n\n'); return; }
        content = replyFor(fx, state.mode, state.abnormal);
      } else {
        const markers = [...all.matchAll(/\[\[STEP:([\w.-]+)\]\]/g)];
        if (markers.length) { state.stepCalls++; const out = fx.stepOutputs[markers.at(-1)[1]]; content = typeof out === 'string' ? out : JSON.stringify(out); }
      }
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 60 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  const env = { LOCAL_MODEL_TARGETS: '127.0.0.1:' + provider.address().port };
  let app = await H.boot({ env });
  t.after(async () => { await app.stop(); provider.closeAllConnections(); await new Promise(r => provider.close(r)); });
  const added = await app.call('POST', '/api/models', { providerId: 'ollama', modelId: 'MOCK-' + fx.id, displayName: 'Industry MOCK ' + fx.id,
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, pricingMode: 'local', capabilities: ['reasoning', 'writing', 'coding', 'data_analysis', 'research'] });
  const model = added.json.connection.connectionId;
  assert.equal((await app.call('POST', '/api/models/' + model + '/test', {})).json.ok, true);
  return { state, model, get app() { return app; }, async restart() { const dir = app.dir; await app.kill(); app = await H.boot({ dir, env }); } };
}
async function finish(app, runId) {
  for (let i = 0; i < 200; i++) { const r = await app.call('GET', '/api/v2/runs/' + runId); if (!['running', 'queued'].includes(r.json.run.status)) return r.json.run; await H.sleep(25); }
  throw new Error('run did not finish');
}
async function download(app, method, url, body) {
  const r = await fetch(`http://127.0.0.1:${app.port}${url}`, { method, headers: { cookie: app.cookie, ...(body ? { 'content-type': 'application/json', origin: `http://127.0.0.1:${app.port}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, headers: r.headers, buffer: Buffer.from(await r.arrayBuffer()) };
}
// Independent parsing with python-docx / openpyxl / python-pptx (not our generator).
function independentParse(dir, files) {
  const probe = spawnSync('python3', ['-c', 'import docx, openpyxl, pptx'], { encoding: 'utf8' });
  if (probe.status !== 0) return { status: 'NOT_RUN', reason: 'python-docx/openpyxl/python-pptx not installed: ' + (probe.stderr || probe.error?.message || '').slice(0, 160) };
  const script = `
import sys, json, docx, openpyxl, pptx
d = sys.argv[1]; files = json.loads(sys.argv[2]); out = {}
for fmt, name in files.items():
    p = d + '/' + name
    if fmt == 'docx':
        out[fmt] = [para.text for para in docx.Document(p).paragraphs]
    elif fmt == 'xlsx':
        ws = openpyxl.load_workbook(p, read_only=True).active
        out[fmt] = [[('' if c is None else str(c)) for c in row] for row in ws.iter_rows(values_only=True)]
    elif fmt == 'pptx':
        out[fmt] = [sh.text_frame.text for s in pptx.Presentation(p).slides for sh in s.shapes if sh.has_text_frame]
    elif fmt == 'md':
        out[fmt] = open(p, encoding='utf-8').read().splitlines()
print(json.dumps(out, ensure_ascii=False))`;
  const r = spawnSync('python3', ['-c', script, dir, JSON.stringify(files)], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) return { status: 'FAILED', reason: r.stderr.slice(0, 400) };
  return { status: 'PARSED', content: JSON.parse(r.stdout) };
}

for (const fx of INDUSTRIES) test(`industry MOCK E2E [${fx.industry}]: draft→abnormal/malicious→cancel→edit→confirm save→restart→explicit grant→run→review→export+independent parse`, async t => {
  const f = await boot(t, fx), out = path.join(OUT, fx.id), evidence = { industry: fx.industry, id: fx.id, seed: fx.seed, outputDir: out, steps: [] };
  const note = (step, data = {}) => evidence.steps.push({ step, draftCalls: f.state.draftCalls, stepCalls: f.state.stepCalls, ...data });
  const input = (requestId, extra = {}) => ({ description: fx.description, connectionId: f.model, maxTokens: 64000, maxOutputTokens: 4096, maxCost: 0, requestId, ...extra });
  const projects = async () => (await f.app.call('GET', '/api/v2/projects')).json.projects;
  // 1. Estimate never calls the model.
  const est = await f.app.call('POST', '/api/v2/intake/ai-draft/estimate', input('est'));
  assert.equal(est.status, 200); assert.equal(est.json.requestSent, false); assert.equal(est.json.local, true); assert.equal(f.state.draftCalls, 0);
  note('estimate', { local: est.json.local, costBound: est.json.costBound });
  // 2. Abnormal model replies: 422 + manual fallback, billed honestly (local => 0), nothing saved.
  f.state.mode = 'abnormal';
  for (const [i, abnormal] of fx.abnormal.entries()) {
    f.state.abnormal = abnormal;
    const r = await f.app.call('POST', '/api/v2/intake/ai-draft', input('abnormal-' + i));
    assert.equal(r.status, abnormal.status, abnormal.label + ' ' + r.text); assert.equal(r.json.fallback, 'manual'); assert.ok(r.json.fallbackDraft.roles.length);
    assert.equal(r.json.usage.cost, 0); assert.equal(r.json.usage.billingFact, 'local_free_zero');
    note('abnormal:' + abnormal.label, { status: r.status, code: r.json.code });
  }
  assert.equal((await projects()).length, 0);
  // 3. Malicious fields from the model never become permissions, budgets, identities or tool calls.
  f.state.mode = 'malicious';
  const mal = await f.app.call('POST', '/api/v2/intake/ai-draft', input('malicious'));
  assert.equal(mal.status, 200, mal.text);
  const encoded = JSON.stringify(mal.json.draft);
  for (const bad of ['attacker', 'sk-MALICIOUS', 'process.exit', '"*"', 'approvePaid', 'allowedTools']) assert.ok(!encoded.includes(bad), 'draft leaked ' + bad);
  assert.deepEqual(mal.json.toolPermissions.granted, []); assert.ok(mal.json.draft.steps.every(s => s.toolCalls.length === 0 && s.skillId === ''));
  assert.ok(mal.json.draft.roles.every(r => r.connectionId === '' && r.fallbackConnectionIds.length === 0));
  note('malicious stripped', { status: mal.status });
  // 4. Cancel an in-flight request (real cooperative adapter): provider really stops, no project, no resend.
  f.state.mode = 'hang';
  const pending = f.app.call('POST', '/api/v2/intake/ai-draft', input('cancel-me'));
  for (let i = 0; i < 200 && !f.state.held.length; i++) await H.sleep(5);
  assert.equal((await f.app.call('POST', '/api/v2/intake/ai-draft/cancel', { requestId: 'cancel-me' })).status, 202);
  const cancelled = await pending; assert.equal(cancelled.status, 409); assert.equal(cancelled.json.code, 'cancelled');
  const callsAfterCancel = f.state.draftCalls;
  note('cancel', { status: cancelled.status, billingStatus: cancelled.json.billingStatus });
  // 5. The real draft; same-ID second click is refused without a new model call.
  f.state.mode = 'ok';
  const gen = await f.app.call('POST', '/api/v2/intake/ai-draft', input('final-draft'));
  assert.equal(gen.status, 200, gen.text); assert.equal(f.state.draftCalls, callsAfterCancel + 1);
  const again = await f.app.call('POST', '/api/v2/intake/ai-draft', input('final-draft')); assert.equal(again.status, 409); assert.equal(f.state.draftCalls, callsAfterCancel + 1);
  const draft = gen.json.draft;
  assert.deepEqual(draft.roles.map(r => r.roleId), fx.expect.roleIds); assert.deepEqual(draft.steps.map(s => s.stepId), fx.expect.stepIds);
  assert.deepEqual(gen.json.handoffs.at(-1).fromStepIds, fx.expect.lastHandoffFrom);
  for (const rec of gen.json.toolRecommendations) {
    const want = fx.expect.toolVerification[rec.intakeId]; assert.ok(want, 'unexpected tool ' + rec.intakeId);
    if (want !== '*') assert.equal(rec.verification, want, rec.intakeId);
    assert.equal(rec.permission, 'not_granted'); assert.equal(rec.approval, 'needs_approval_per_run');
  }
  assert.ok(draft.planning.humanDecisions.some(x => /必须由用户另行明确确认/.test(x)));
  assert.equal((await projects()).length, 0, 'generation never saves');
  write(out, 'draft.json', gen.json);
  note('draft', { roles: draft.roles.length, steps: draft.steps.length, toolRecommendations: gen.json.toolRecommendations.map(r => [r.intakeId, r.verification]) });
  // 6. Human edits, then explicit save (the browser's POST /api/v2/projects).
  const e = fx.humanEdits;
  draft.name = e.projectName; draft.roles.find(r => r.roleId === e.renameRole.roleId).name = e.renameRole.name;
  draft.planning.humanDecisions.push(e.addHumanDecision); draft.requiredToolIds = e.keepTools;
  for (const r of draft.roles) r.connectionId = f.model;
  const saved = await f.app.call('POST', '/api/v2/projects', { ...draft, allowedTools: ['*'], approval: { allowedTools: ['*'] } });
  assert.equal(saved.status, 201, saved.text);
  const pid = saved.json.project.projectId;
  assert.equal(saved.json.project.allowedTools, undefined); assert.equal(saved.json.project.approval, undefined);
  note('saved', { projectId: pid });
  // 7. Restart: persisted edits, nothing auto-started, no model call replayed.
  const draftCallsBeforeRestart = f.state.draftCalls;
  await f.restart();
  const view = (await f.app.call('GET', '/api/v2/projects/' + pid)).json;
  assert.equal(view.project.name, e.projectName); assert.equal(view.project.roles.find(r => r.roleId === e.renameRole.roleId).name, e.renameRole.name);
  assert.ok(view.project.planning.humanDecisions.includes(e.addHumanDecision)); assert.deepEqual(view.runs, []);
  assert.equal(f.state.draftCalls, draftCallsBeforeRestart); assert.equal(f.state.stepCalls, 0);
  assert.equal((await f.app.call('GET', '/api/v2/intake/ai-draft/status')).json.activeSlots, 0);
  write(out, 'saved-project.json', view.project);
  note('restart', { runs: view.runs.length });
  // 8. Validation, then explicit per-run grants. Without the grant: refused before any model call.
  const v = await f.app.call('POST', '/api/v2/projects/' + pid + '/validate', {}); assert.equal(v.json.ok, true, JSON.stringify(v.json.issues));
  const budget = { maxTokens: 200000, maxOutputTokens: 2000, maxCost: 0 };
  if (e.keepTools.length) {
    const denied = await f.app.call('POST', '/api/v2/projects/' + pid + '/runs', budget);
    assert.equal(denied.status, 403); assert.equal(denied.json.code, 'tool_permission'); assert.equal(f.state.stepCalls, 0);
  }
  const launched = await f.app.call('POST', '/api/v2/projects/' + pid + '/runs', { ...budget, allowedTools: e.keepTools });
  assert.equal(launched.status, 202, launched.text);
  const run = await finish(f.app, launched.json.run.runId);
  assert.equal(run.status, 'review_required', JSON.stringify(run.error)); assert.equal(f.state.stepCalls, fx.expect.stepIds.length);
  assert.equal(run.usage.cost, 0, 'local verified target');
  const approved = await f.app.call('POST', '/api/v2/runs/' + run.runId + '/review', { decision: 'approve', feedback: '人工核对Mock成果流程' });
  assert.equal(approved.json.run.status, 'approved');
  note('run', { runId: run.runId, steps: run.steps.length, status: 'approved' });
  // 9. Real exported files: hash, re-download equality, independent parsing.
  const files = {}, hashes = {};
  for (const format of fx.exports) {
    const file = await download(f.app, 'POST', '/api/v2/runs/' + run.runId + '/export', { format });
    assert.equal(file.status, 200, file.buffer.toString().slice(0, 300));
    const artifactId = file.headers.get('x-artifact-id'); assert.ok(artifactId);
    const again2 = await download(f.app, 'GET', `/api/v2/runs/${run.runId}/artifacts/${artifactId}/download`);
    assert.equal(sha(again2.buffer), sha(file.buffer), format + ' persisted bytes match');
    if (format !== 'md') assert.equal(file.buffer.subarray(0, 2).toString(), 'PK');
    files[format] = 'deliverable.' + format; hashes[format] = { sha256: sha(file.buffer), bytes: file.buffer.length, artifactId };
    write(out, files[format], file.buffer);
  }
  const parsed = independentParse(out, files);
  evidence.parse = { status: parsed.status, reason: parsed.reason };
  if (parsed.status === 'PARSED') {
    const flat = x => JSON.stringify(x);
    for (const needle of fx.deliverableChecks.docx) assert.ok(parsed.content.docx.some(p => p.includes(needle)), 'docx missing ' + needle);
    for (const pair of fx.deliverableChecks.xlsx) assert.ok(parsed.content.xlsx.some(row => pair.every(c => row.includes(c))), 'xlsx missing ' + flat(pair));
    for (const needle of fx.deliverableChecks.pptx) assert.ok(parsed.content.pptx.some(p => p.includes(needle)), 'pptx missing ' + needle);
    for (const needle of fx.deliverableChecks.md) assert.ok(parsed.content.md.some(p => p.includes(needle)), 'md missing ' + needle);
  } else assert.notEqual(parsed.status, 'FAILED', parsed.reason);
  write(out, 'hashes.json', hashes);
  // 10. Final invariants: one project, one approved run, draft ledger complete, nothing outstanding.
  assert.equal((await projects()).length, 1);
  const ledger = (await f.app.call('GET', '/api/v2/usage/system')).json.usage.filter(u => u.kind === 'intake_draft');
  assert.ok(ledger.every(u => u.status !== 'reserved' && u.cost === 0), 'local draft calls settled at 0');
  assert.equal(ledger.length, fx.abnormal.length + 3, 'abnormal + malicious + cancelled + final, nothing duplicated');
  evidence.hashes = hashes; evidence.ledgerRows = ledger.length; evidence.result = 'PASS';
  write(out, 'summary.json', evidence);
  t.diagnostic('evidence: ' + path.join(out, 'summary.json'));
  console.log('INDUSTRY E2E PASS ' + fx.id + ' parse=' + parsed.status + ' out=' + out);
});
