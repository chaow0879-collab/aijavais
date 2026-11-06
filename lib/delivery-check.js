'use strict';
/* Delivery verification for the three industry deliverable kinds (#17).
 * It reports FACTS in four separate levels and never upgrades one into another:
 *   generated      – bytes exist as a stored artifact / structured output
 *   structure      – the format parses (OOXML parts, ZIP paths, SVG, JSON, JS syntax)
 *   usable         – a mechanical usefulness check really ran and passed:
 *                      software: runnable_verified only after a sandbox smoke test passed
 *                      organization: graph_validated (tree is consistent)
 *                      research: evidence_mapped_unverified (every claim mapped; sources NOT verified)
 *   expertReview   – always 'not_run': no domain expert has reviewed anything here.
 * Nothing here executes generated code except runSoftwareSmoke(), which only uses
 * the existing controlled executor (off unless the administrator enabled it, no
 * network, fs confined to a temp dir, no child processes) and only on explicit
 * request. Install/run instructions are displayed, never executed. No URL is
 * ever fetched; external citations stay 'unverified'. */
const vm = require('node:vm');
const crypto = require('node:crypto');

const LIMITS = Object.freeze({ maxFiles: 256, maxFileBytes: 512 * 1024, maxNodes: 200, maxDepth: 12, maxClaims: 200, maxEvidence: 400, maxText: 2000 });
const LABELS = Object.freeze({
  structure: { valid: '结构可解析', invalid: '结构无效', not_applicable: '不适用', not_checked: '未检查' },
  usable: {
    runnable_verified: '隔离沙盒冒烟测试通过（真实运行）', mock_placeholder: '占位/Mock内容，不是可用软件', failed: '检查未通过',
    not_run: '未运行可用性验证', graph_validated: '组织结构数据已校验（专业合理性未评审）',
    evidence_mapped_unverified: '主张均有证据映射，但来源未经核实', evidence_gaps: '存在缺证主张', not_applicable: '不适用',
    structure_only: '仅结构可解析，未验证能否实际使用',
  },
  expertReview: { not_run: '领域专家评审：未进行（NOT_RUN）' },
});
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const ID = /^[A-Za-z0-9_.-]{1,64}$/;
const unsafeId = x => ['__proto__', 'prototype', 'constructor'].includes(x);
const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
const str = (x, max = LIMITS.maxText) => typeof x === 'string' ? x.slice(0, max) : '';
function status(kind, { generated = true, structure = 'not_checked', usable = 'not_run', reason = '' } = {}) {
  return { kind, generated, structure, usable, expertReview: 'not_run', reason,
    labels: { generated: generated ? '文件已生成' : '未生成', structure: LABELS.structure[structure] || structure, usable: LABELS.usable[usable] || usable, expertReview: LABELS.expertReview.not_run } };
}

/* ------------------------------------------------------------ software (M1) */
function pathProblem(p) {
  if (typeof p !== 'string' || !p) return 'empty_path';
  if (Buffer.byteLength(p) > 240) return 'path_too_long';
  if (/[\\\x00-\x1f\x7f:<>"|?*]/.test(p)) return 'illegal_characters';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'absolute_path';
  const parts = p.split('/');
  if (parts.some(x => x === '..')) return 'path_traversal';
  if (parts.some(x => !x || x === '.' || /^[. ]+$/.test(x) || /[. ]$/.test(x))) return 'invalid_segment';
  if (parts.some(x => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x))) return 'reserved_name';
  return null;
}
const PLACEHOLDER = /\bMOCK\b|PLACEHOLDER|占位|lorem ipsum|NotImplemented|TODO[:：]?\s*(implement|实现|fill)/i;
const UNSAFE = [[/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i, '下载后直接管道执行'], [/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\*)/i, '递归删除根/家目录'], [/\bsudo\b/i, '需要sudo提权'],
  [/\bchmod\s+(-R\s+)?777\b/i, '全局可写权限'], [/\bmkfs|\bdd\s+if=/i, '磁盘级写入'], [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork炸弹'], [/\beval\s*\$\(/i, '动态执行下载内容']];
function fileType(p) {
  if (/(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[a-z]+$/i.test(p)) return 'test';
  if (/\.(m?[jt]sx?|cjs|py|go|rs|java|rb|php|cs|cpp|c|h|sh)$/i.test(p)) return 'source';
  if (/(^|\/)(readme|install|usage|changelog)[^/]*$|\.(md|txt|rst)$/i.test(p)) return 'doc';
  if (/\.(json|ya?ml|toml|ini|lock)$|(^|\/)(package\.json|dockerfile|makefile)$/i.test(p)) return 'config';
  return 'other';
}
function syntaxOf(p, content) {
  try {
    if (/\.(js|cjs)$/i.test(p)) { new vm.Script(content, { filename: p }); return 'ok'; } // compile only, never run
    if (/\.json$/i.test(p)) { JSON.parse(content); return 'ok'; }
    return 'not_checked';
  } catch (e) { return 'error: ' + String(e.message).slice(0, 160); }
}
function softwareManifest(output) {
  const items = Array.isArray(output?.files) ? output.files : isObj(output?.files) ? Object.entries(output.files).map(([path, content]) => ({ path, content })) : [];
  const meta = isObj(output?.software) ? output.software : {};
  const files = [], rejected = [], warnings = [];
  for (const it of items.slice(0, LIMITS.maxFiles)) {
    const p = isObj(it) ? it.path : undefined, problem = pathProblem(p);
    if (problem) { rejected.push({ path: typeof p === 'string' ? p.slice(0, 120) : String(p), reason: problem }); continue; }
    if (typeof it.content !== 'string') { rejected.push({ path: p, reason: 'content_not_text' }); continue; }
    const bytes = Buffer.byteLength(it.content);
    if (bytes > LIMITS.maxFileBytes) { rejected.push({ path: p, reason: 'file_too_large' }); continue; }
    if (files.some(f => f.path === p)) { rejected.push({ path: p, reason: 'duplicate_path' }); continue; }
    files.push({ path: p, type: fileType(p), bytes, sha256: sha256(it.content), syntax: syntaxOf(p, it.content), placeholder: !it.content.trim() || PLACEHOLDER.test(it.content) });
  }
  if (items.length > LIMITS.maxFiles) warnings.push('文件数超过上限，仅检查前' + LIMITS.maxFiles + '个');
  const has = p => files.some(f => f.path === p);
  const entry = typeof meta.entry === 'string' ? meta.entry : null, testFile = typeof meta.test === 'string' ? meta.test : null;
  const instructions = { install: str(meta.install, 1000), run: str(meta.run, 1000), test: str(meta.testCommand, 1000) };
  for (const [field, text] of Object.entries(instructions)) for (const [re, why] of UNSAFE) if (re.test(text)) warnings.push(`unsafe_instruction:${field}:${why}（只显示，平台从不执行安装/运行指令）`);
  const consistency = [
    { check: 'has_files', ok: files.length > 0, detail: files.length + ' 个有效文件' },
    { check: 'no_rejected_paths', ok: rejected.length === 0, detail: rejected.map(r => r.path + ':' + r.reason).join('; ') || '无' },
    { check: 'readme_present', ok: files.some(f => /(^|\/)readme(\.[a-z]+)?$/i.test(f.path)), detail: '需要说明文件' },
    { check: 'entry_declared_and_present', ok: !!entry && has(entry), detail: entry || '未声明入口' },
    { check: 'test_declared_and_present', ok: !!testFile && has(testFile), detail: testFile || '未声明测试' },
    { check: 'run_instruction_mentions_entry', ok: !!entry && instructions.run.includes(entry), detail: instructions.run || '无运行说明' },
    { check: 'syntax_ok', ok: files.every(f => !f.syntax.startsWith('error')), detail: files.filter(f => f.syntax.startsWith('error')).map(f => f.path + ' ' + f.syntax).join('; ') || '无语法错误（仅编译检查）' },
    { check: 'no_placeholder_content', ok: !files.some(f => f.placeholder && f.type !== 'doc'), detail: files.filter(f => f.placeholder).map(f => f.path).join(', ') || '无占位内容' },
  ];
  const structureOk = files.length > 0 && rejected.length === 0 && consistency.find(c => c.check === 'syntax_ok').ok;
  const placeholder = files.some(f => f.placeholder && f.type !== 'doc');
  return { kind: 'software', files, rejected, entry, test: testFile, expectOutput: str(meta.expectOutput, 200), instructions, warnings, consistency,
    status: status('software', { structure: structureOk ? 'valid' : 'invalid', usable: placeholder ? 'mock_placeholder' : structureOk ? 'not_run' : 'failed',
      reason: placeholder ? '检测到占位/Mock内容：不能视为真实软件' : structureOk ? '尚未在隔离沙盒运行冒烟测试' : '结构检查未通过' }) };
}
/* Explicitly requested sandbox smoke test via the existing controlled executor. */
async function runSoftwareSmoke(manifest, output, { exec, requested = false, signal } = {}) {
  const st = exec?.codeExecStatus?.() || { enabled: false, isolated: false, reason: '执行器不可用' };
  const smoke = { requested, enabled: !!st.enabled, isolated: !!st.isolated, ran: false };
  const finish = (usable, reason) => { manifest.smoke = smoke; manifest.status = status('software', { structure: manifest.status.structure, usable, reason }); return manifest; };
  if (manifest.status.usable === 'mock_placeholder') return finish('mock_placeholder', '占位/Mock内容不运行；不能视为真实软件');
  if (manifest.status.structure !== 'valid') return finish('failed', '结构检查未通过，不运行');
  if (!requested) return finish('not_run', '未请求沙盒冒烟测试');
  if (!st.enabled || !st.isolated) return finish('not_run', '受控执行器不可用：' + (st.reason || '未隔离'));
  if (!manifest.test || !/\.(js|cjs)$/i.test(manifest.test)) return finish('not_run', '只支持JavaScript测试文件的冒烟测试');
  const files = {};
  for (const f of output.files) if (manifest.files.some(x => x.path === f.path)) files[f.path] = f.content;
  let r;
  try { r = await exec.runJavaScript({ code: `require(${JSON.stringify('./' + manifest.test)});`, files, timeoutMs: 10000 }, { signal }); }
  catch (e) { smoke.error = String(e.code || e.message).slice(0, 200); return finish('failed', '沙盒执行失败：' + smoke.error); }
  Object.assign(smoke, { ran: true, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, stdout: r.stdout.slice(0, 2000), stderr: r.stderr.slice(0, 2000), isolation: r.isolation });
  const passed = r.exitCode === 0 && !r.timedOut && (!manifest.expectOutput || r.stdout.includes(manifest.expectOutput));
  return finish(passed ? 'runnable_verified' : 'failed', passed ? '隔离沙盒中测试文件退出码0' + (manifest.expectOutput ? '且输出包含期望文本' : '') : '沙盒冒烟测试未通过');
}

/* ------------------------------------------------------- organization (M2) */
function orgChart(data) {
  const errors = [], warnings = [];
  const raw = Array.isArray(data?.nodes) ? data.nodes : null;
  if (!raw || !raw.length) return { kind: 'organization', valid: false, errors: ['nodes必须是非空数组'], warnings, nodes: [], roots: [], depth: 0, status: status('organization', { structure: 'invalid', usable: 'failed', reason: '缺少组织节点' }) };
  if (raw.length > LIMITS.maxNodes) errors.push(`节点超过上限${LIMITS.maxNodes}`);
  const nodes = [], seen = new Set();
  for (const [i, n] of raw.slice(0, LIMITS.maxNodes).entries()) {
    if (!isObj(n)) { errors.push(`第${i + 1}个节点不是对象`); continue; }
    const id = typeof n.id === 'string' ? n.id : '';
    if (!ID.test(id) || unsafeId(id)) { errors.push(`第${i + 1}个节点ID非法`); continue; }
    if (seen.has(id)) { errors.push(`重复ID：${id}`); continue; }
    seen.add(id);
    const name = str(n.name, 80).trim();
    if (!name) errors.push(`${id}：缺少名称`);
    const parentId = n.parentId === undefined || n.parentId === null || n.parentId === '' ? null : String(n.parentId);
    const list = v => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.slice(0, 200)).slice(0, 20) : [];
    const node = { id, name, title: str(n.title, 80), parentId, duties: list(n.duties), authority: list(n.authority), boundary: str(n.boundary, 400) };
    if (!node.duties.length) warnings.push(`${id}：未写明职责`);
    if (!node.boundary) warnings.push(`${id}：未写明权责边界`);
    nodes.push(node);
  }
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const n of nodes) {
    if (n.parentId === n.id) errors.push(`${n.id}：上级不能是自己（环）`);
    else if (n.parentId && !byId.has(n.parentId)) errors.push(`${n.id}：上级${n.parentId}不存在（孤点）`);
  }
  // Cycle detection by walking the parent chain with a visited set.
  const cyclic = new Set();
  for (const n of nodes) {
    const path = new Set(); let cur = n;
    while (cur && cur.parentId && byId.has(cur.parentId)) {
      if (path.has(cur.id)) { for (const id of path) cyclic.add(id); break; }
      path.add(cur.id); cur = byId.get(cur.parentId);
      if (path.size > LIMITS.maxNodes) break;
    }
  }
  if (cyclic.size) errors.push('存在汇报关系环：' + [...cyclic].sort().join('、'));
  const roots = nodes.filter(n => !n.parentId).map(n => n.id);
  if (!roots.length) errors.push('没有最高层节点（全部有上级，形成环）');
  if (roots.length > 1) warnings.push('存在多个最高层节点：' + roots.join('、'));
  const children = new Map(nodes.map(n => [n.id, []]));
  for (const n of nodes) if (n.parentId && children.has(n.parentId) && !cyclic.has(n.id)) children.get(n.parentId).push(n.id);
  const level = new Map(); let depth = 0;
  const queue = roots.map(id => [id, 0]);
  while (queue.length) { const [id, d] = queue.shift(); if (level.has(id)) continue; level.set(id, d); depth = Math.max(depth, d + 1); for (const c of children.get(id) || []) queue.push([c, d + 1]); }
  if (depth > LIMITS.maxDepth) errors.push(`层级超过${LIMITS.maxDepth}`);
  const unreachable = nodes.filter(n => !level.has(n.id)).map(n => n.id);
  if (unreachable.length && !errors.some(e => /环|孤点/.test(e))) errors.push('不可达节点：' + unreachable.join('、'));
  const valid = errors.length === 0;
  return { kind: 'organization', valid, errors, warnings, nodes, roots, depth, children: Object.fromEntries(children), level: Object.fromEntries(level),
    status: status('organization', { structure: valid ? 'valid' : 'invalid', usable: valid ? 'graph_validated' : 'failed', reason: valid ? '层级、上下级与唯一性已校验；专业合理性需专家评审（NOT_RUN）' : errors[0] }) };
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const clip = (s, n) => [...String(s)].length > n ? [...String(s)].slice(0, n - 1).join('') + '…' : String(s);
/* Static, self-contained SVG: no script, no event handlers, no external or data references. */
function orgChartSvg(chart, { title = '组织结构图' } = {}) {
  if (!chart.valid) throw Object.assign(new Error('组织结构未通过校验，不生成图示'), { code: 'org_invalid' });
  const W = 190, H = 64, GX = 24, GY = 56, M = 24;
  // Subtree layout: leaves take consecutive slots, each parent is centred over ITS children,
  // so every subtree stays contiguous and connectors of different parents never interleave.
  const slot = new Map(); let next = 0;
  const place = id => { const kids = chart.children[id] || []; if (!kids.length) { slot.set(id, next++); return; } kids.forEach(place); slot.set(id, (slot.get(kids[0]) + slot.get(kids.at(-1))) / 2); };
  chart.roots.forEach(place);
  const pos = new Map();
  for (const n of chart.nodes) pos.set(n.id, { x: M + slot.get(n.id) * (W + GX), y: M + 40 + chart.level[n.id] * (H + GY) });
  const width = M * 2 + Math.max(1, next) * (W + GX) - GX, height = M * 2 + 40 + chart.depth * (H + GY) - GY;
  const lines = [], boxes = [];
  for (const n of chart.nodes) {
    const p = pos.get(n.id);
    if (n.parentId && pos.has(n.parentId)) { const q = pos.get(n.parentId); lines.push(`<path d="M${q.x + W / 2} ${q.y + H} V${(q.y + H + p.y) / 2} H${p.x + W / 2} V${p.y}" fill="none" stroke="#64748b" stroke-width="1.5"/>`); }
    boxes.push(`<g data-node-id="${esc(n.id)}"><rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="8" fill="#0f2740" stroke="#38bdf8"/>` +
      `<text x="${p.x + W / 2}" y="${p.y + 26}" text-anchor="middle" font-size="15" fill="#e8eef5">${esc(clip(n.name, 12))}</text>` +
      `<text x="${p.x + W / 2}" y="${p.y + 48}" text-anchor="middle" font-size="12" fill="#94a3b8">${esc(clip(n.title || n.id, 16))}</text></g>`);
  }
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">` +
    `<rect width="100%" height="100%" fill="#0b1726"/><text x="${M}" y="${M + 16}" font-size="18" fill="#e8eef5">${esc(clip(title, 40))}</text>${lines.join('')}${boxes.join('')}</svg>\n`);
}
function orgChartText(chart) {
  const out = [];
  const walk = (id, d) => { const n = chart.nodes.find(x => x.id === id); out.push('  '.repeat(d) + '- ' + n.name + (n.title ? '（' + n.title + '）' : '') + (n.duties.length ? '：' + n.duties.join('；') : '') + (n.boundary ? ' ｜边界：' + n.boundary : '')); for (const c of chart.children[id] || []) walk(c, d + 1); };
  for (const r of chart.roots) walk(r, 0);
  return out.join('\n');
}

/* ----------------------------------------------------------- research (M3) */
const NEEDS_SOURCE = /\d|%|％|￥|\$|€|万元|亿元|法规|条例|法律|regulation|statute|GDP|营收|利润|市场规模/i;
function evidenceChain(data) {
  const errors = [], warnings = [];
  const list = (v, max) => Array.isArray(v) ? v.slice(0, max) : [];
  const evidence = [], evIds = new Set();
  for (const [i, e] of list(data?.evidence, LIMITS.maxEvidence).entries()) {
    if (!isObj(e) || typeof e.id !== 'string' || !ID.test(e.id) || unsafeId(e.id)) { errors.push(`第${i + 1}条证据ID非法`); continue; }
    if (evIds.has(e.id)) { errors.push(`重复证据ID：${e.id}`); continue; }
    evIds.add(e.id);
    const synthetic = e.kind === 'synthetic' || e.synthetic === true;
    let url = null, urlProblem = null;
    if (e.url !== undefined && e.url !== null && e.url !== '') {
      try { const u = new URL(String(e.url)); if (!['http:', 'https:'].includes(u.protocol)) urlProblem = '不允许的链接协议'; else url = u.href.slice(0, 500); } catch { urlProblem = '链接格式无效'; }
      if (urlProblem) warnings.push(`${e.id}：${urlProblem}，已丢弃`);
    }
    // A model cannot verify its own sources: declared "verified" is recorded but ignored.
    const declared = typeof e.verification === 'string' ? e.verification.slice(0, 40) : null;
    if (declared && /verified|已核实|已验证/i.test(declared) && !synthetic) warnings.push(`${e.id}：模型自称已核实，平台未核实，按unverified处理`);
    evidence.push({ id: e.id, kind: synthetic ? 'synthetic' : ['source', 'data', 'regulation', 'financial'].includes(e.kind) ? e.kind : 'source',
      citation: str(e.citation, 500), url, verification: synthetic ? 'synthetic' : 'unverified', declaredVerification: declared, fetched: false });
  }
  const assumptions = [], asIds = new Set();
  for (const a of list(data?.assumptions, 100)) if (isObj(a) && typeof a.id === 'string' && ID.test(a.id) && !asIds.has(a.id)) { asIds.add(a.id); assumptions.push({ id: a.id, text: str(a.text, 1000) }); }
  const claims = [], clIds = new Set();
  for (const [i, c] of list(data?.claims, LIMITS.maxClaims).entries()) {
    if (!isObj(c) || typeof c.id !== 'string' || !ID.test(c.id) || unsafeId(c.id)) { errors.push(`第${i + 1}条主张ID非法`); continue; }
    if (clIds.has(c.id)) { errors.push(`重复主张ID：${c.id}`); continue; }
    clIds.add(c.id);
    const evidenceIds = list(c.evidenceIds, 20).filter(x => typeof x === 'string'), assumptionIds = list(c.assumptionIds, 20).filter(x => typeof x === 'string');
    const missing = evidenceIds.filter(x => !evIds.has(x)), missingAssumptions = assumptionIds.filter(x => !asIds.has(x));
    if (missing.length) errors.push(`${c.id}：引用了不存在的证据 ${missing.join('、')}`);
    if (missingAssumptions.length) errors.push(`${c.id}：引用了不存在的假设 ${missingAssumptions.join('、')}`);
    const linked = evidence.filter(e => evidenceIds.includes(e.id));
    const text = str(c.text, 2000);
    let state = !linked.length ? 'unsupported' : linked.every(e => e.verification === 'synthetic') ? 'synthetic_only' : 'unverified';
    const alerts = [];
    if (state === 'unsupported') alerts.push('缺证：没有任何证据支撑');
    if (NEEDS_SOURCE.test(text) && state !== 'synthetic_only') alerts.push('含数字/金额/法规表述：需人工核实原始来源');
    if (state === 'synthetic_only') alerts.push('仅合成数据（synthetic），不能作为真实结论');
    claims.push({ id: c.id, text, citedText: text + evidenceIds.map(x => `[${x}]`).join(''), evidenceIds, assumptionIds, state, alerts, declaredConfidence: str(c.confidence, 40) || null });
  }
  if (!claims.length) errors.push('没有可复核的主张（claims）');
  const gaps = claims.filter(c => c.state === 'unsupported').map(c => c.id);
  const unusedEvidence = evidence.filter(e => !claims.some(c => c.evidenceIds.includes(e.id))).map(e => e.id);
  if (unusedEvidence.length) warnings.push('未被任何主张引用的证据：' + unusedEvidence.join('、'));
  const valid = errors.length === 0;
  const usable = !valid ? 'failed' : gaps.length ? 'evidence_gaps' : 'evidence_mapped_unverified';
  return { kind: 'research', valid, errors, warnings, claims, evidence, assumptions, gaps,
    summary: { claims: claims.length, unsupported: gaps.length, synthetic: evidence.filter(e => e.verification === 'synthetic').length, unverified: evidence.filter(e => e.verification === 'unverified').length, verified: 0 },
    status: status('research', { structure: valid ? 'valid' : 'invalid', usable, reason: !valid ? errors[0] : gaps.length ? '缺证主张：' + gaps.join('、') : '映射完整；外部来源未核实（unverified），合成数据标为synthetic' }) };
}
function evidenceRows(chain) {
  return [['主张ID', '主张（含引用标注）', '证据', '证据核验状态', '假设', '提醒'],
    ...chain.claims.map(c => [c.id, c.citedText, c.evidenceIds.join(',') || '无', c.evidenceIds.map(id => id + ':' + (chain.evidence.find(e => e.id === id)?.verification || 'missing')).join(',') || 'unsupported', c.assumptionIds.join(',') || '无', c.alerts.join('；') || '无'])];
}

/* ------------------------------------------------------- stored artifacts */
function zipEntries(buffer) {
  // Read the ZIP central directory (no extraction, no decompression).
  const sig = 0x06054b50; let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === sig) { eocd = i; break; }
  if (eocd < 0) throw new Error('不是有效的ZIP（缺少目录结尾）');
  const count = buffer.readUInt16LE(eocd + 10), size = buffer.readUInt32LE(eocd + 12), offset = buffer.readUInt32LE(eocd + 16);
  if (offset + size > buffer.length) throw new Error('ZIP目录越界');
  const names = []; let p = offset;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP目录项损坏');
    const n = buffer.readUInt16LE(p + 28), x = buffer.readUInt16LE(p + 30), k = buffer.readUInt16LE(p + 32);
    names.push(buffer.subarray(p + 46, p + 46 + n).toString('utf8')); p += 46 + n + x + k;
  }
  return names;
}
const REQUIRED_PARTS = { docx: ['[Content_Types].xml', 'word/document.xml'], xlsx: ['[Content_Types].xml', 'xl/workbook.xml'], pptx: ['[Content_Types].xml', 'ppt/presentation.xml'] };
function checkArtifact(a, buffer) {
  const format = a.format || (a.filename || '').split('.').pop();
  const base = { artifactId: a.artifactId, filename: a.filename, format, bytes: buffer.length, sha256: sha256(buffer), producer: a.producer || null };
  try {
    if (REQUIRED_PARTS[format]) {
      const names = zipEntries(buffer), missing = REQUIRED_PARTS[format].filter(x => !names.includes(x));
      if (missing.length) return { ...base, ...status('file', { structure: 'invalid', usable: 'failed', reason: '缺少必要部件：' + missing.join(',') }) };
      return { ...base, parts: names.length, ...status('file', { structure: 'valid', usable: 'structure_only', reason: 'OOXML结构完整；内容是否满足需求需人工判断' }) };
    }
    if (format === 'zip') {
      const names = zipEntries(buffer), bad = names.map(n => [n, pathProblem(n)]).filter(([, p]) => p);
      if (bad.length) return { ...base, ...status('file', { structure: 'invalid', usable: 'failed', reason: '不安全的ZIP路径：' + bad.map(([n, p]) => n + ':' + p).join(',') }) };
      const mock = names.some(n => /mock|placeholder/i.test(n)) || PLACEHOLDER.test(buffer.toString('latin1'));
      return { ...base, entries: names.length, ...status('file', { structure: 'valid', usable: mock ? 'mock_placeholder' : 'structure_only', reason: mock ? '包含占位/Mock内容' : 'ZIP路径安全；可运行性见软件检查' }) };
    }
    if (format === 'svg') {
      const s = buffer.toString('utf8');
      const unsafe = /<script|on[a-z]+\s*=|<foreignObject|href\s*=\s*["'](?!#)|url\(\s*["']?(?!#)/i.test(s);
      const ok = /^<\?xml[^>]*>\s*<svg[\s>]/.test(s) && s.trim().endsWith('</svg>');
      return { ...base, ...status('file', { structure: ok && !unsafe ? 'valid' : 'invalid', usable: ok && !unsafe ? 'structure_only' : 'failed', reason: unsafe ? 'SVG含脚本/事件/外部引用' : ok ? '静态SVG（无脚本/外链）' : 'SVG格式不完整' }) };
    }
    if (format === 'json') { JSON.parse(buffer.toString('utf8')); return { ...base, ...status('file', { structure: 'valid', usable: 'structure_only' }) }; }
    if (['md', 'txt', 'csv'].includes(format)) { new TextDecoder('utf-8', { fatal: true }).decode(buffer); return { ...base, ...status('file', { structure: 'valid', usable: 'structure_only' }) }; }
    return { ...base, ...status('file', { structure: 'not_checked', usable: 'not_run', reason: '未知格式' }) };
  } catch (e) { return { ...base, ...status('file', { structure: 'invalid', usable: 'failed', reason: String(e.message).slice(0, 200) }) }; }
}

/* ------------------------------------------------- structured run output */
function parseStructured(text) {
  if (typeof text !== 'string') return {};
  try { const v = JSON.parse(text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')); return isObj(v) ? v : {}; } catch { return {}; }
}
/* Extra sections/slides/rows that link verified structures into DOCX/PPTX/XLSX/MD exports. */
function augmentExport(format, structured, refs = {}) {
  const sections = [], slides = []; let rows;
  if (isObj(structured.orgChart)) {
    const chart = orgChart(structured.orgChart);
    const text = chart.valid ? orgChartText(chart) + (refs.orgSvg ? `\n\n组织图文件：${refs.orgSvg.filename}（artifactId ${refs.orgSvg.artifactId}，SHA-256 ${refs.orgSvg.sha256}）` : '') + '\n\n校验：上下级、唯一ID、无环、无孤点已通过；专业合理性：领域专家评审未进行（NOT_RUN）。'
      : '组织结构未通过校验：' + chart.errors.join('；');
    sections.push({ heading: chart.valid ? '组织结构（已校验）' : '组织结构（校验未通过）', text });
    slides.push({ title: '组织结构', body: chart.valid ? chart.nodes.slice(0, 12).map(n => '• ' + n.name + (n.parentId ? ' ← ' + (chart.nodes.find(x => x.id === n.parentId)?.name || n.parentId) : '（最高层）')).join('\n') : '校验未通过：' + chart.errors[0] });
    if (!Array.isArray(structured.rows) && chart.valid) rows = [['节点ID', '名称', '岗位', '上级', '职责', '权责边界'], ...chart.nodes.map(n => [n.id, n.name, n.title, n.parentId || '（最高层）', n.duties.join('；'), n.boundary])];
  }
  if (Array.isArray(structured.claims)) {
    const chain = evidenceChain(structured);
    sections.push({ heading: '证据清单与核验状态', text: chain.claims.map(c => `${c.citedText}\n  状态：${c.state}${c.alerts.length ? '；' + c.alerts.join('；') : ''}`).join('\n') +
      '\n\n来源：' + chain.evidence.map(e => `[${e.id}] ${e.citation}${e.url ? ' ' + e.url : ''}（${e.verification}）`).join('；') + '\n\n说明：平台未访问任何链接；unverified表示未经核实，synthetic表示合成测试数据。' });
    slides.push({ title: '证据链摘要', body: `主张${chain.summary.claims}条；缺证${chain.summary.unsupported}条；合成${chain.summary.synthetic}条；未核实${chain.summary.unverified}条；已核实0条` });
    if (!Array.isArray(structured.rows) && !rows) rows = evidenceRows(chain);
  }
  if (structured.files && (isObj(structured.software) || Array.isArray(structured.files))) {
    const m = softwareManifest(structured);
    sections.push({ heading: '软件交付清单', text: m.files.map(f => `${f.path}（${f.type}，${f.bytes}字节，语法：${f.syntax}${f.placeholder ? '，占位内容' : ''}）`).join('\n') +
      `\n\n安装：${m.instructions.install || '未提供'}\n运行：${m.instructions.run || '未提供'}\n状态：${m.status.labels.usable}（安装/运行指令只显示，平台不执行）` });
  }
  const out = { ...structured };
  if (sections.length) out.sections = [...(Array.isArray(structured.sections) ? structured.sections : []), ...sections];
  if (format === 'pptx' && slides.length && Array.isArray(structured.slides)) out.slides = [...structured.slides, ...slides];
  if (rows && ['xlsx', 'csv'].includes(format)) out.rows = rows;
  return out;
}
/* One delivery check over a finished run. Returns the manifest plus new files to store
 * (org chart SVG). Pure apart from the optional, explicitly requested sandbox smoke test. */
async function checkRun({ run, finalText, artifacts = [], exec, smokeTest = false, signal, reviewStatus = null }) {
  const structured = parseStructured(finalText);
  const items = [], newFiles = [];
  if (structured.files !== undefined) {
    const software = await runSoftwareSmoke(softwareManifest(structured), structured, { exec, requested: smokeTest === true, signal });
    items.push(software);
  }
  if (isObj(structured.orgChart)) {
    const chart = orgChart(structured.orgChart);
    const entry = { ...chart, children: undefined, level: undefined };
    if (chart.valid) {
      const svg = orgChartSvg(chart, { title: (str(structured.orgChart.title, 60) || '组织结构图') });
      newFiles.push({ buffer: svg, mime: 'image/svg+xml', filename: 'org-chart.svg', format: 'svg', producer: 'delivery_check' });
      entry.svg = { bytes: svg.length, sha256: sha256(svg) };
    }
    items.push(entry);
  }
  if (Array.isArray(structured.claims) || Array.isArray(structured.evidence)) items.push(evidenceChain(structured));
  const files = artifacts.map(({ meta, buffer }) => checkArtifact(meta, buffer));
  const all = [...items.map(i => i.status), ...files];
  return {
    runId: run.runId, checkedAt: new Date().toISOString(), kinds: items.map(i => i.kind),
    items, files,
    summary: { generated: all.filter(s => s.generated).length, structureValid: all.filter(s => s.structure === 'valid').length,
      usableVerified: all.filter(s => ['runnable_verified', 'graph_validated', 'evidence_mapped_unverified'].includes(s.usable)).length,
      mockPlaceholder: all.filter(s => s.usable === 'mock_placeholder').length, expertReviewed: 0 },
    humanReview: { runReviewStatus: reviewStatus, note: '运行审核是用户的人工确认，不等于领域专家评审' },
    note: '四级状态彼此独立：文件已生成≠结构可解析≠可实际使用≠领域专家已评审。平台不执行安装/运行指令，不访问引用链接；领域专家评审一律NOT_RUN。',
    newFiles,
  };
}
module.exports = { checkRun, softwareManifest, runSoftwareSmoke, orgChart, orgChartSvg, orgChartText, evidenceChain, evidenceRows, checkArtifact, zipEntries, parseStructured, augmentExport, status, LABELS, DELIVERY_LIMITS: LIMITS };
