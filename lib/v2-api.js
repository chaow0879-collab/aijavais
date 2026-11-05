'use strict';
// Called only after the existing session, display-role and same-origin gates.
const { ProjectStore, ProjectError } = require('./project-store');
const { ProjectEngine } = require('./project-engine');
const { ToolRegistry, loadMcpServers } = require('./tools-v2');
const { SkillRegistry } = require('./skills-v2');
const { createDeliverable } = require('./deliverables');
const Intake = require('../public/project-intake/engine');
const intakeCatalog = require('../public/project-intake/catalog.v1.json');
const SEC = require('./security');

function createV2Api({ dir, models, teams, callModel, emit, audit = () => {} }) {
  const store = new ProjectStore({ dir });
  const runContext = context => ensure(store.getRun(context?.runId), 'Tool run');
  const builtinTools = ['docx', 'xlsx', 'pptx'].map(format => ({
    toolId: format + '_generation', name: format.toUpperCase() + ' 真实文件生成',
    description: '在当前运行内生成真实 ' + format.toUpperCase() + ' 文件并保存字节与校验值；默认使用上一步实际输出。',
    inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 200000 }, title: { type: 'string', maxLength: 160 } }, additionalProperties: false },
    handler: async (args, { context, signal }) => {
      const run = runContext(context); if (signal?.aborted) throw new ProjectError('Cancelled');
      const text = args.text === undefined ? context.input : args.text;
      if (typeof text !== 'string' || !text.trim()) throw new ProjectError('Document tool needs actual input text');
      const file = createDeliverable(format, { text, title: args.title || store.getProject(run.projectId)?.name });
      if (signal?.aborted) throw new ProjectError('Cancelled');
      const a = store.putArtifact(run.runId, { buffer: file.buffer, filename: file.filename, mime: file.mime, kind: 'file', producer: format + '_generation', executionMode: 'builtin' });
      return { content: [{ type: 'text', text: 'File generated: ' + a.filename }], structuredContent: { artifactId: a.artifactId, filename: a.filename, bytes: a.bytes, sha256: a.sha256, mime: a.mime } };
    }
  }));
  builtinTools.push({ toolId: 'file_read', name: '读取本运行的文本成果', description: '按成果ID读取本运行已有的文本/JSON文件；不是任意主机路径或 PDF/Word 附件读取器。',
    inputSchema: { type: 'object', properties: { artifactId: { type: 'string', maxLength: 80 } }, additionalProperties: false },
    handler: async (args, { context, signal }) => {
      const run = runContext(context); if (signal?.aborted) throw new ProjectError('Cancelled');
      const metadata = args.artifactId ? { artifactId: args.artifactId } : store.listArtifacts(run.runId).filter(a => a.kind === 'role-output').at(-1);
      const a = metadata && store.getArtifact(run.runId, metadata.artifactId);
      if (!a || (!a.mime.startsWith('text/') && a.mime !== 'application/json')) throw new ProjectError('Text artifact not found in this run');
      if (a.buffer.length > 200000) throw new ProjectError('Text artifact exceeds tool output limit');
      return { content: [{ type: 'text', text: a.buffer.toString('utf8') }], structuredContent: { artifactId: a.artifactId, sha256: a.sha256, bytes: a.bytes } };
    }
  });
  const tools = new ToolRegistry({ mcpServers: loadMcpServers(), builtinTools, audit: detail => audit('tool', detail) });
  const skills = new SkillRegistry({ tools, initial: store.getSetting('skills', null) ?? undefined, save: list => store.setSetting('skills', list) });
  const engine = new ProjectEngine({ store, models, teams, callModel, tools, skills, emit });
  const ensure = (value, name) => { if (!value) throw new ProjectError(name + ' not found', 'not_found', 404); return value; };
  const object = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProjectError('Expected a JSON object');
    return value;
  };
  function planFrom(input) {
    object(input);
    for (const k of ['selectedRoleIds', 'selectedStepIds', 'customRoles']) {
      if (input[k] != null && (!Array.isArray(input[k]) || input[k].length > 40 || input[k].some(x => x == null))) throw new ProjectError('Invalid ' + k);
    }
    for (const k of ['answers', 'assignments', 'customDeliverables']) if (input[k] != null) object(input[k]);
    const trustedModels = models.list().map(c => ({ ...c,
      // A successful chat probe proves connectivity, never coding, finance or free eligibility.
      verifiedCapabilities: c.lastTest?.ok ? ['chat'] : [],
      localityVerified: c.lastTest?.ok && c.pricingMode === 'local' && SEC.checkBaseUrlSyntax(c.baseUrl, models.policy).local === true,
      freeEligibilityVerified: false,
    }));
    const availableTools = tools.list().map(t => ({ id: t.toolId, available: true, verified: t.executionMode === 'builtin' }));
    const result = Intake.buildPlan(intakeCatalog, { ...input, availableModels: trustedModels, availableTools });
    if (!result.ok) throw new ProjectError((result.errors || []).join('; '), 'invalid_plan');
    return result;
  }
  function fromPlan(result) {
    const plan = result.plan;
    return { name: plan.projectTypeName || '立项项目', description: plan.description, plan,
      roles: plan.roles.map(r => ({ roleId: r.id, name: r.name, duty: r.duty, boundary: r.duty, standard: r.standard, requiredCapabilities: r.capabilities, connectionId: r.modelConnectionId })),
      steps: plan.steps.map(s => ({ stepId: s.id, roleId: s.roleId, title: s.title, prompt: s.quality + '\n交付：' + s.deliverable })),
      standards: plan.quantification.map(q => q.label + '：' + q.selectedText),
      deliverables: [...new Set(plan.steps.map(s => s.deliverable))], maxReworks: 2 };
  }
  function runView(runId) {
    const run = ensure(engine.getRun(runId), 'Run');
    return { ...run, messages: store.getMessages(runId), events: store.getEvents(runId),
      artifacts: store.listArtifacts(runId).map(a => ({ ...a, downloadUrl: '/api/v2/runs/' + runId + '/artifacts/' + a.artifactId + '/download' })),
      usageLedger: store.getUsage(runId) };
  }
  async function handle(req, res, url, { readBody, json, user }) {
    if (!url.pathname.startsWith('/api/v2/')) return false;
    const p = url.pathname.slice('/api/v2'.length), m = req.method;
    const body = async () => object(await readBody(req, 2 << 20));
    try {
      if (p === '/health' && m === 'GET') { json(res, 200, { version: '2.0.0', schemaVersion: store.schemaVersion, storage: 'sqlite', activeRuns: store.activeRunCount() }); return true; }
      if (p === '/tools' && m === 'GET') { json(res, 200, { tools: tools.list() }); return true; }
      if (p === '/tools/discover' && m === 'POST') { json(res, 200, await tools.discover()); return true; }
      if (p === '/tools/call' && m === 'POST') {
        const b = await body();
        const result = await tools.call(b.toolId, b.args || {}, { allowedTools: b.allowedTools || [], context: { userId: user.userId } });
        audit('tool_manual', { toolId: b.toolId, executionMode: result.executionMode });
        json(res, 200, { result }); return true;
      }
      if (p === '/skills' && m === 'GET') { json(res, 200, { skills: skills.list() }); return true; }
      if (p === '/skills' && m === 'POST') { json(res, 200, { skill: skills.upsert(await body()) }); return true; }
      let match;
      if ((match = p.match(/^\/skills\/([\w.-]+)$/)) && m === 'DELETE') { skills.remove(match[1]); json(res, 200, { ok: true }); return true; }
      if (p === '/intake/plan' && m === 'POST') { json(res, 200, planFrom(await body())); return true; }
      if (p === '/intake/projects' && m === 'POST') {
        const result = planFrom(await body());
        const project = engine.create(fromPlan(result), { ownerId: user.userId });
        json(res, 201, { project, plan: result.plan, warnings: result.warnings }); return true;
      }
      if (p === '/projects' && m === 'GET') { json(res, 200, { projects: store.listProjects() }); return true; }
      if (p === '/projects' && m === 'POST') { json(res, 201, { project: engine.create(await body(), { ownerId: user.userId }) }); return true; }
      if ((match = p.match(/^\/projects\/([\w-]+)(?:\/(validate|runs))?$/))) {
        const projectId = match[1], action = match[2];
        const project = ensure(store.getProject(projectId), 'Project');
        if (!action && m === 'GET') { json(res, 200, { project, runs: store.listRuns(projectId) }); return true; }
        if (!action && m === 'PUT') {
          const b = await body();
          // Validate via the same schema as creation; only the store updates version/owner.
          json(res, 200, { project: engine.update(projectId, b, { expectedVersion: b.expectedVersion ?? b.version }) }); return true;
        }
        if (!action && m === 'DELETE') { store.deleteProject(projectId); json(res, 200, { ok: true }); return true; }
        if (action === 'validate' && m === 'POST') { json(res, 200, engine.validate(projectId)); return true; }
        if (action === 'runs' && m === 'POST') { json(res, 202, { run: await engine.start(projectId, await body()) }); return true; }
      }
      if ((match = p.match(/^\/runs\/([\w-]+)(?:\/(cancel|review|export))?$/))) {
        const runId = match[1], action = match[2];
        const run = ensure(engine.getRun(runId), 'Run');
        if (!action && m === 'GET') { json(res, 200, { run: runView(runId) }); return true; }
        if (action === 'cancel' && m === 'POST') { json(res, 200, { run: await engine.cancel(runId) }); return true; }
        if (action === 'review' && m === 'POST') { const b = await body(); json(res, 200, { run: await engine.review(runId, { ...b, feedback: b.feedback || b.comment || '' }) }); return true; }
        if (action === 'export' && m === 'POST') {
          const b = await body();
          if (run.status === 'running' || run.executionActive) throw new ProjectError('Wait until execution and billing settle before exporting', 'run_active', 409);
          const steps = store.getSteps(runId);
          const final = run.finalArtifactId && store.getArtifact(runId, run.finalArtifactId);
          const text = final ? final.buffer.toString('utf8') : [...steps].reverse().find(s => typeof s.output === 'string' && s.output)?.output;
          if (typeof text !== 'string' || !text.trim()) throw new ProjectError('No completed textual output to export', 'no_output', 409);
          const project = store.getProject(run.projectId);
          let structured = {};
          try {
            const parsed = JSON.parse(text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, ''));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              for (const k of ['sections', 'rows', 'slides', 'files']) if (Array.isArray(parsed[k])) structured[k] = parsed[k];
            }
          } catch { /* Ordinary text is a valid office-document input. */ }
          if (['zip', 'code'].includes(b.format) && !Array.isArray(b.files || structured.files)) throw new ProjectError('Code ZIP requires actual structured files: model output JSON {"files":[{"path":"...","content":"..."}]}', 'files_required', 409);
          const file = createDeliverable(b.format || 'md', { ...structured, ...b, title: project?.name || 'AIJAVAIS', text });
          const a = store.putArtifact(runId, { buffer: file.buffer, mime: file.mime, filename: file.filename, kind: 'file', format: file.extension, reviewStatus: run.status });
          store.appendEvent(runId, { eventType: 'file_generated', executionMode: 'builtin', artifactId: a.artifactId, sha256: a.sha256, bytes: a.bytes });
          audit('file_generated', { runId, artifactId: a.artifactId, format: file.extension, bytes: a.bytes });
          res.writeHead(200, { 'content-type': file.mime, 'content-length': file.buffer.length, 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename), 'cache-control': 'no-store', 'x-artifact-id': a.artifactId });
          res.end(file.buffer); return true;
        }
      }
      if ((match = p.match(/^\/runs\/([\w-]+)\/artifacts\/([\w-]+)\/download$/)) && m === 'GET') {
        ensure(store.getRun(match[1]), 'Run'); const a = ensure(store.getArtifact(match[1], match[2]), 'Artifact');
        res.writeHead(200, { 'content-type': a.mime, 'content-length': a.buffer.length, 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(a.filename), 'cache-control': 'no-store' });
        res.end(a.buffer); return true;
      }
      json(res, 404, { error: 'Unknown V2 endpoint' });
    } catch (e) {
      const status = e.status || (typeof e.code === 'number' ? e.code : 400);
      json(res, status >= 400 && status <= 599 ? status : 400, { error: e.message || 'V2 operation failed', code: typeof e.code === 'string' ? e.code : 'invalid' });
    }
    return true;
  }
  return { handle, store, engine, tools, skills, async close() { await engine.close?.(); await tools.close(); store.close(); } };
}
module.exports = { createV2Api };
