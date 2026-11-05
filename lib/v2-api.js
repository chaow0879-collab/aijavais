'use strict';
// Called only after the existing session, display-role and same-origin gates.
const { ProjectStore, ProjectError } = require('./project-store');
const { ProjectEngine } = require('./project-engine');
const { ToolRegistry, loadMcpServers } = require('./tools-v2');
const { SkillRegistry } = require('./skills-v2');
const { createDeliverable } = require('./deliverables');
const { extractFile, sliceText, EXTRACT_LIMITS, SUPPORTED_TYPES, pdfAvailable } = require('./file-extract');
const Intake = require('../public/project-intake/engine');
const intakeCatalog = require('../public/project-intake/catalog.v1.json');
const SEC = require('./security');
const CAP = require('./capabilities');

function createV2Api({ dir, models, teams, callModel, emit, audit = () => {}, system = () => ({ node: process.version }) }) {
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
  builtinTools.push({ toolId: 'project_file_read', name: '读取项目资料', description: '按资料文件ID分段读取本项目已上传文件（PDF/Word/Excel/PPT/文本）中提取的文字；只能读取当前项目的资料。',
    inputSchema: { type: 'object', properties: { fileId: { type: 'string', maxLength: 40 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 100, maximum: 50000 } }, required: ['fileId'], additionalProperties: false },
    handler: async (args, { context, signal }) => {
      const projectId = context?.projectId;
      if (typeof projectId !== 'string') throw new ProjectError('project_file_read needs a project context');
      if (signal?.aborted) throw new ProjectError('Cancelled');
      const f = store.getProjectFile(projectId, args.fileId, { text: true });
      if (!f) throw new ProjectError('Material file not found in this project');
      if (f.extraction.status !== 'ok') throw new ProjectError('File text is not readable: ' + (f.extraction.note || f.extraction.status));
      const part = sliceText(f.text, args);
      return { content: [{ type: 'text', text: part.text }], structuredContent: { fileId: f.fileId, filename: f.filename, sha256: f.sha256, offset: part.offset, length: part.length, total: part.total, nextOffset: part.nextOffset } };
    }
  });
  const DA = require('./data-analysis');
  const tableFrom = (args, context) => {
    if (args.fileId) {
      const f = store.getProjectFile(context?.projectId, args.fileId, { content: true });
      if (!f) throw new ProjectError('Table file not found in this project');
      if (f.kind === 'xlsx') { const r = require('./file-extract').readSpreadsheet(f.buffer, { sheet: args.sheet }); return { rows: r.rows, source: { fileId: f.fileId, filename: f.filename, sha256: f.sha256, sheet: r.sheet, uncomputedFormulas: r.uncomputedFormulas } }; }
      if (f.kind === 'table' || f.mime.startsWith('text/')) return { rows: DA.parseCsv(f.buffer.toString('utf8')), source: { fileId: f.fileId, filename: f.filename, sha256: f.sha256 } };
      throw new ProjectError('Only CSV/TSV/XLSX files can be analysed');
    }
    if (typeof context?.input === 'string' && context.input.trim()) return { rows: DA.parseCsv(context.input.replace(/^```\w*\n|\n```\s*$/g, '')), source: { from: 'previous step output' } };
    throw new ProjectError('data_analysis needs fileId (CSV/TSV/XLSX project file) or a CSV previous output');
  };
  builtinTools.push({ toolId: 'data_analysis', name: '数据计算与分析', description: '对项目中的 CSV/TSV/Excel 表格做确定性计算：描述统计、分组汇总、排序取前 N、筛选。结果由程序计算，可作为证据；可另存为 Excel/CSV。',
    inputSchema: { type: 'object', properties: { fileId: { type: 'string', maxLength: 40 }, sheet: { type: 'string', maxLength: 100 }, headerRow: { type: 'boolean' }, operations: { type: 'array', maxItems: 10, items: { type: 'object' } }, saveAs: { type: 'string', enum: ['xlsx', 'csv'] } }, required: ['operations'], additionalProperties: false },
    handler: async (args, { context, signal }) => {
      const { rows, source } = tableFrom(args, context);
      const t = DA.table(rows, { headerRow: args.headerRow !== false });
      const results = DA.analyze(t, args.operations);
      if (signal?.aborted) throw new ProjectError('Cancelled');
      let artifact = null;
      if (args.saveAs && context?.runId) {
        const sheetRows = results.filter(r => r.columns).flatMap((r, i) => [...(i ? [[]] : []), [r.op + (r.by ? '：' + r.by : r.column ? '：' + r.column : '')], r.columns, ...r.rows]);
        const file = createDeliverable(args.saveAs, { title: '数据分析结果', text: '', rows: sheetRows });
        artifact = store.putArtifact(context.runId, { buffer: file.buffer, filename: file.filename, mime: file.mime, kind: 'file', producer: 'data_analysis', executionMode: 'builtin' });
      }
      const text = `数据来源：${source.filename || source.from}${source.sheet ? ' / ' + source.sheet : ''}（${t.rows.length} 行，列：${t.columns.join('、')}）${source.uncomputedFormulas ? `\n注意：${source.uncomputedFormulas} 个公式单元格在文件中没有计算结果，已按空值处理。` : ''}\n\n` + results.map(r => `### ${r.op}\n${DA.markdown(r)}`).join('\n\n');
      return { content: [{ type: 'text', text }], structuredContent: { source, columns: t.columns, rowCount: t.rows.length, results, ...(artifact ? { artifactId: artifact.artifactId, filename: artifact.filename, sha256: artifact.sha256 } : {}) } };
    } });
  builtinTools.push({ toolId: 'chart_generation', name: '图表生成（SVG）', description: '根据给定数据生成柱状图、折线图或饼图（SVG 矢量图片），保存为本运行的成果文件。数据必须明确给出，不会编造。',
    inputSchema: { type: 'object', properties: { type: { type: 'string', enum: ['bar', 'line', 'pie'] }, title: { type: 'string', maxLength: 120 }, labels: { type: 'array', maxItems: 200 }, series: { type: 'array', maxItems: 8, items: { type: 'object' } }, filename: { type: 'string', maxLength: 100 } }, required: ['labels', 'series'], additionalProperties: false },
    handler: async (args, { context }) => {
      const svg = DA.svgChart(args);
      const filename = (String(args.filename || args.title || 'chart').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'chart') + '.svg';
      const a = context?.runId ? store.putArtifact(context.runId, { buffer: svg, filename, mime: 'image/svg+xml', kind: 'file', producer: 'chart_generation', executionMode: 'builtin' }) : null;
      return { content: [{ type: 'text', text: a ? 'Chart generated: ' + a.filename : svg.toString('utf8') }], structuredContent: { bytes: svg.length, ...(a ? { artifactId: a.artifactId, filename: a.filename, sha256: a.sha256 } : {}) } };
    } });
  const OR = require('./office-render');
  const officeSource = (args, context, exts) => {
    let f = null;
    if (args.fileId) f = store.getProjectFile(context?.projectId, args.fileId, { content: true });
    else if (context?.runId) {
      const metas = store.listArtifacts(context.runId).filter(a => a.kind === 'file' && exts.includes(String(a.filename).split('.').pop().toLowerCase()));
      const meta = args.artifactId ? metas.find(a => a.artifactId === args.artifactId) : metas.at(-1);
      f = meta && store.getArtifact(context.runId, meta.artifactId);
    }
    if (!f) throw new ProjectError('No ' + exts.join('/').toUpperCase() + ' file found: give fileId (project file) or artifactId (this run)');
    return { buffer: f.buffer, filename: f.filename, ext: String(f.filename).split('.').pop().toLowerCase(), id: f.artifactId || f.fileId };
  };
  const saveRunFile = (context, buffer, filename, mime, producer) => context?.runId ? store.putArtifact(context.runId, { buffer, filename, mime, kind: 'file', producer, executionMode: 'builtin' }) : null;
  builtinTools.push({ toolId: 'document_convert', name: 'Office 转 PDF（LibreOffice）', description: '把本运行生成的或项目上传的 Word/Excel/PPT 用 LibreOffice 转换为真实 PDF 并保存。需要服务器安装 LibreOffice。',
    inputSchema: { type: 'object', properties: { artifactId: { type: 'string', maxLength: 80 }, fileId: { type: 'string', maxLength: 40 } }, additionalProperties: false },
    handler: async (args, { context, signal }) => {
      const src = officeSource(args, context, ['docx', 'xlsx', 'pptx']);
      const pdf = await OR.convertToPdf(src.buffer, src.ext, { signal });
      const a = saveRunFile(context, pdf, src.filename.replace(/\.\w+$/, '') + '.pdf', 'application/pdf', 'document_convert');
      return { content: [{ type: 'text', text: 'PDF generated from ' + src.filename + (a ? ': ' + a.filename : '') }], structuredContent: { source: src.id, bytes: pdf.length, ...(a ? { artifactId: a.artifactId, filename: a.filename, sha256: a.sha256 } : {}) } };
    } });
  builtinTools.push({ toolId: 'document_render', name: '文件渲染检查', description: '把 Word/Excel/PPT/PDF 真实渲染为页面图片（PNG，保存为成果），并检查页数和空白页。Office 需要 LibreOffice，渲染需要 poppler-utils。',
    inputSchema: { type: 'object', properties: { artifactId: { type: 'string', maxLength: 80 }, fileId: { type: 'string', maxLength: 40 }, maxPages: { type: 'integer', minimum: 1, maximum: 30 } }, additionalProperties: false },
    handler: async (args, { context, signal }) => {
      const src = officeSource(args, context, ['docx', 'xlsx', 'pptx', 'pdf']);
      const pdf = src.ext === 'pdf' ? src.buffer : await OR.convertToPdf(src.buffer, src.ext, { signal });
      const pages = await OR.renderPdf(pdf, { maxPages: args.maxPages || 10, signal });
      const saved = pages.map(p => saveRunFile(context, p.png, src.filename.replace(/\.\w+$/, '') + `-第${p.page}页.png`, 'image/png', 'document_render'));
      const blank = pages.filter(p => p.blank).map(p => p.page);
      const text = `已渲染 ${src.filename} 的 ${pages.length} 页` + (blank.length ? `；疑似空白页：第 ${blank.join('、')} 页` : '；未发现空白页') + '。版式是否美观仍需人工查看页面图片。';
      return { content: [{ type: 'text', text }], structuredContent: { source: src.id, pages: pages.map((p, i) => ({ page: p.page, blank: p.blank, inkRatio: p.inkRatio, ...(saved[i] ? { artifactId: saved[i].artifactId } : {}) })), blankPages: blank } };
    } });
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
    const registry = tools.list();
    const availableTools = registry.map(t => ({ id: t.toolId, available: true, verified: t.executionMode === 'builtin' }));
    // Template tool IDs (e.g. pdf_read) count as ready only when the capability center finds a real, usable implementation.
    const intakeIds = intakeCatalog.templates.flatMap(t => t.steps.flatMap(s => s.tools || []));
    for (const r of CAP.resolveIntakeTools(intakeIds, { tools: registry })) if (r.status === 'available' && r.toolId && !registry.some(t => t.toolId === r.intakeId)) availableTools.push({ id: r.intakeId, available: true, verified: registry.find(t => t.toolId === r.toolId)?.executionMode === 'builtin' });
    const result = Intake.buildPlan(intakeCatalog, { ...input, availableModels: trustedModels, availableTools });
    if (!result.ok) throw new ProjectError((result.errors || []).join('; '), 'invalid_plan');
    result.toolCheck = CAP.resolveIntakeTools(result.plan.requiredTools || [], { tools: registry });
    return result;
  }
  function fromPlan(result) {
    const plan = result.plan;
    return { name: plan.projectTypeName || '立项项目', description: plan.description, plan,
      roles: plan.roles.map(r => ({ roleId: r.id, name: r.name, duty: r.duty, boundary: r.duty, standard: r.standard, requiredCapabilities: r.capabilities, connectionId: r.modelConnectionId })),
      steps: plan.steps.map(s => ({ stepId: s.id, roleId: s.roleId, title: s.title, prompt: s.quality + '\n交付：' + s.deliverable })),
      standards: plan.quantification.map(q => q.label + '：' + q.selectedText),
      // Real registry IDs where a usable implementation exists; unresolved IDs stay so validation blocks honestly.
      requiredToolIds: (result.toolCheck || []).map(t => t.toolId || t.intakeId),
      deliverables: [...new Set(plan.steps.map(s => s.deliverable))], maxReworks: 2 };
  }
  function runView(runId) {
    const run = ensure(engine.getRun(runId), 'Run');
    return { ...run, messages: store.getMessages(runId), events: store.getEvents(runId),
      artifacts: store.listArtifacts(runId).map(a => ({ ...a, downloadUrl: '/api/v2/runs/' + runId + '/artifacts/' + a.artifactId + '/download' })),
      usageLedger: store.getUsage(runId) };
  }
  let lastMcp = [];
  async function handle(req, res, url, { readBody, json, user }) {
    if (!url.pathname.startsWith('/api/v2/')) return false;
    const p = url.pathname.slice('/api/v2'.length), m = req.method;
    const body = async () => object(await readBody(req, 2 << 20));
    try {
      if (p === '/health' && m === 'GET') { json(res, 200, { version: '2.0.0', schemaVersion: store.schemaVersion, storage: 'sqlite', activeRuns: store.activeRunCount() }); return true; }
      if (p === '/tools' && m === 'GET') { json(res, 200, { tools: tools.list() }); return true; }
      if (p === '/tools/discover' && m === 'POST') { const d = await tools.discover(); lastMcp = d.servers; json(res, 200, d); return true; }
      if (p === '/capabilities' && m === 'GET') { json(res, 200, CAP.listCapabilities({ tools: tools.list(), skills: skills.list(), mcp: { servers: lastMcp } })); return true; }
      if (p === '/readiness' && m === 'GET') {
        const scenarios = String(url.searchParams.get('scenarios') || 'basic').split(',').slice(0, 10);
        json(res, 200, CAP.readiness({ system: system(req), models: models.list(), tools: tools.list(), skills: skills.list(), mcp: { servers: lastMcp, configured: tools.servers.length }, store }, scenarios)); return true;
      }
      if (p === '/tools/call' && m === 'POST') {
        const b = await body();
        const context = { userId: user.userId, ...(typeof b.projectId === 'string' && store.getProject(b.projectId) ? { projectId: b.projectId } : {}) };
        const result = await tools.call(b.toolId, b.args || {}, { allowedTools: b.allowedTools || [], context });
        audit('tool_manual', { toolId: b.toolId, executionMode: result.executionMode });
        json(res, 200, { result }); return true;
      }
      if (p === '/skills' && m === 'GET') { json(res, 200, { skills: skills.list() }); return true; }
      if (p === '/skills' && m === 'POST') { json(res, 200, { skill: skills.upsert(await body()) }); return true; }
      let match;
      if ((match = p.match(/^\/projects\/([\w-]+)\/files$/))) {
        const projectId = match[1];
        ensure(store.getProject(projectId), 'Project');
        if (m === 'GET') { json(res, 200, { files: store.listProjectFiles(projectId), limits: { ...EXTRACT_LIMITS, pdfText: pdfAvailable() }, supported: SUPPORTED_TYPES }); return true; }
        if (m === 'POST') {
          // JSON + base64 keeps the existing same-origin JSON gate; ~11 MB body for an 8 MB file.
          const b = object(await readBody(req, Math.ceil(EXTRACT_LIMITS.maxFileBytes * 4 / 3) + 4096));
          if (typeof b.filename !== 'string' || typeof b.contentBase64 !== 'string') throw new ProjectError('Upload needs filename and contentBase64');
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b.contentBase64)) throw new ProjectError('contentBase64 is not valid base64', 'invalid_upload');
          const buffer = Buffer.from(b.contentBase64, 'base64');
          const extraction = await extractFile(b.filename, buffer);
          const file = store.putProjectFile(projectId, { buffer, filename: extraction.filename, mime: extraction.mime, kind: extraction.kind, extraction });
          audit('project_file_uploaded', { projectId, fileId: file.fileId, kind: file.kind, bytes: file.bytes, status: file.extraction.status });
          json(res, 201, { file }); return true;
        }
      }
      if ((match = p.match(/^\/projects\/([\w-]+)\/files\/([\w-]+)(\/download)?$/))) {
        const [, projectId, fileId, download] = match;
        const f = ensure(store.getProjectFile(projectId, fileId, { content: !!download, text: !download }), 'File');
        if (download && m === 'GET') {
          res.writeHead(200, { 'content-type': f.mime, 'content-length': f.buffer.length, 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(f.filename), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          res.end(f.buffer); return true;
        }
        if (!download && m === 'GET') { const { text, ...meta } = f; json(res, 200, { file: meta, text: sliceText(text, { offset: url.searchParams.get('offset'), limit: url.searchParams.get('limit') }) }); return true; }
        if (!download && m === 'DELETE') { store.deleteProjectFile(projectId, fileId); audit('project_file_deleted', { projectId, fileId }); json(res, 200, { ok: true }); return true; }
      }
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
