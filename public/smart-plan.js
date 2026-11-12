'use strict';
/* B7e/B7g 智能分配（规则化，不额外调用模型）。Pure: no network, no storage; browser + Node.
 * The user gives only: 想做什么 / 想要什么成果 / 什么时候要（可选）. The system assigns models, estimates the
 * cost in RMB and asks for ONE confirmation, which is this run's explicit paid approval. The server's budget,
 * token and approval gates are unchanged; this module only fills their inputs.
 *
 * Rules (owner/commander, #10 v2.2–v2.3 and B7e revisions):
 *  - Only models with a known unit price (admin-entered or the sourced catalog) or a free local model are used.
 *    Unknown-price models are skipped and named ("价格未知，已换成其它模型").
 *  - Ability first, then price: the drafter gets the cheapest model able to write; the reviewer gets the strongest
 *    tier available; within it a different model than the drafter, then another vendor, then the cheapest.
 *  - Money never silently degrades quality: if the needed maximum exceeds the per-run cap, both
 *    "效果优先" and "省钱" are returned for the user to choose; nothing is switched automatically.
 *  - The confirmed maximum never exceeds the per-run cap; the engine stops before a call it cannot cover.
 *
 * Conversion (written into the report): RMB/USD fixed at FX = 7.5 (deliberately above market, so a USD cap
 * derived from an RMB maximum can only under-spend in RMB). Per call the engine reserves
 *   (input bytes + 256) × input rate + output bound × output rate,  output bound = 2048 (+1024 thinking on DashScope).
 * Estimate (RMB) = Σ steps (expected input tokens × input price + expected output tokens × output price).
 * Maximum (RMB) = min(cap, roundUp0.1(max(3 × estimate, what the reservations of both steps need))). */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./model-hints.js') : root.ModelHints);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SmartPlan = api;
})(typeof self !== 'undefined' ? self : this, function (Hints) {
  const FX = 7.5;
  const MAX_OUTPUT = 2048;
  const EXPECT = { systemTokens: 600, draftOut: 1500, reviewOut: 1800, systemBytes: 1800 };
  /* B9a 资料：起草时最多带前 30000 字，审核时最多带前 20000 字（截取时提示词里会注明“已截取前 N 字”，确认框也会告诉用户） */
  const MATERIALS = Object.freeze({ draft: 30000, review: 20000, perFileBytes: 200 });
  const TIER_ORDER = { high: 0, mid: 1, low: 2 };
  const TIER_TEXT = { low: '便宜快速', mid: '均衡', high: '擅长分析推理' };
  const OUTPUTS = Object.freeze({
    text: { label: '文字', format: 'md', ask: '用清晰的中文分段写出完整内容。' },
    word: { label: 'Word 文档', format: 'docx', ask: '写成一份结构清晰的文档：有标题、分节小标题和正文。' },
    excel: { label: 'Excel 表格', format: 'xlsx', ask: '整理成表格：第一行是列名，之后每行一条记录，列之间用竖线 | 分隔。' },
    ppt: { label: 'PPT 演示', format: 'pptx', ask: '写成演示文稿提纲：每页一个标题，下面 3–5 条要点。' },
    analysis: { label: '表格分析', format: 'xlsx', ask: '给出分析结论和关键数字，并把数据整理成表格：第一行是列名，列之间用竖线 | 分隔。' },
  });
  const bytes = s => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(String(s)).length : Buffer.byteLength(String(s)));
  const yuan = n => Math.ceil(n * 100 - 1e-9) / 100;
  const yuan10 = n => Math.ceil(n * 10 - 1e-9) / 10;
  const fen = n => Math.floor(n * 100 + 1e-9) / 100; // AUD-4AAD-01: a user amount is only ever rounded DOWN
  const isLocal = m => m.pricingMode === 'local';
  const thinkingHost = m => /(^|\.)dashscope(-intl|-us)?\.aliyuncs\.com$/i.test((() => { try { return new URL(m.baseUrl).hostname; } catch { return ''; } })());
  function cnyRate(m) {
    if (isLocal(m)) return { input: 0, output: 0 };
    const p = m.price; if (!p) return null;
    const f = p.currency === 'USD' ? FX : 1;
    return { input: p.inputPerMillion * f, output: p.outputPerMillion * f };
  }
  function usdRate(m) {
    const r = cnyRate(m); if (!r || isLocal(m)) return null;
    return { inputPerMillion: r.input / FX, outputPerMillion: r.output / FX, currency: 'USD' };
  }
  function chat(models) {
    return (models || []).filter(m => m && m.enabled !== false && m.status !== 'disabled' && !Hints.nonChatReason(m.modelId));
  }
  function usable(models) { return chat(models).filter(m => cnyRate(m)); }
  const caps = m => (m.capabilities && m.capabilities.length ? m.capabilities : Hints.suggestCapabilities(m.modelId));
  const can = (m, need) => caps(m).includes(need);
  function roleSet(output) {
    const analysis = output === 'analysis';
    return [
      { roleId: 'drafter', need: 'writing', name: analysis ? '分析员' : '起草员', duty: analysis ? '分析需求与数据，写出分析初稿' : '根据需求写出完整初稿', boundary: '只负责初稿，不自我审核', standard: '内容完整、结构清晰、不编造事实' },
      { roleId: 'reviewer', need: 'reasoning', name: '审核员', duty: '审核初稿并修订成最终成果', boundary: '只审核和修订，不改变任务目标', standard: '指出并修正错误与遗漏，输出可直接使用的终稿' },
    ];
  }
  const unitCost = m => { const r = cnyRate(m); return r.input + r.output * 3; };
  function assign(pool, specs, picks, saving) {
    const roles = [];
    for (const spec of specs) {
      let list = pool.filter(m => can(m, spec.need));
      if (!list.length) list = pool;
      const reviewerQuality = spec.roleId === 'reviewer' && !saving;
      list = [...list].sort((a, b) =>
        (reviewerQuality ? TIER_ORDER[Hints.tierOf(a.modelId)] - TIER_ORDER[Hints.tierOf(b.modelId)] : 0) ||
        (spec.roleId === 'reviewer' && roles[0] ? (a.connectionId === roles[0].model.connectionId) - (b.connectionId === roles[0].model.connectionId) : 0) ||
        (spec.roleId === 'reviewer' && roles[0] ? (a.providerId === roles[0].model.providerId) - (b.providerId === roles[0].model.providerId) : 0) ||
        unitCost(a) - unitCost(b) || String(a.modelId).localeCompare(String(b.modelId)));
      const picked = list.find(m => m.connectionId === picks[spec.roleId]) || list[0];
      roles.push({ spec, model: picked, candidates: list.map(m => m.connectionId) });
    }
    return roles;
  }
  /* B9a: what each step will carry from the uploaded materials (chars; CJK counted at 3 bytes, the engine reserves by bytes) */
  function materialShare(list) {
    const files = (list || []).filter(Boolean), total = files.reduce((n, f) => n + (readableFile(f) ? fileChars(f) : 0), 0);
    return { files: files.length, readable: files.filter(readableFile).length, total, draft: Math.min(total, MATERIALS.draft), review: Math.min(total, MATERIALS.review), items: files };
  }
  const matBytes = (chars, share) => share.files ? chars * 3 + share.files * MATERIALS.perFileBytes + 200 : 0;
  function cost(roles, goal, share = materialShare([])) {
    const goalTok = Math.ceil(String(goal).length * 1.2);
    const steps = [
      { m: roles[0].model, inTok: EXPECT.systemTokens + goalTok + Math.ceil(share.draft * 1.2), outTok: EXPECT.draftOut, inBytes: EXPECT.systemBytes + bytes(goal) + matBytes(share.draft, share) },
      { m: roles[1].model, inTok: EXPECT.systemTokens + goalTok + EXPECT.draftOut + Math.ceil(share.review * 1.2), outTok: EXPECT.reviewOut, inBytes: EXPECT.systemBytes + bytes(goal) + MAX_OUTPUT * 4 + matBytes(share.review, share) },
    ];
    let estimate = 0, reserveNeed = 0, firstNeed = 0;
    steps.forEach((s, i) => {
      const r = cnyRate(s.m);
      const expected = (s.inTok * r.input + s.outTok * r.output) / 1e6;
      const bound = ((s.inBytes + 256) * r.input + (MAX_OUTPUT + (thinkingHost(s.m) ? MAX_OUTPUT / 2 : 0)) * r.output) / 1e6;
      reserveNeed = Math.max(reserveNeed, (i ? estimate : 0) + bound);
      if (!i) firstNeed = bound;
      estimate += expected;
    });
    return { estimate: yuan(estimate), needed: yuan10(Math.max(3 * estimate, reserveNeed)), firstNeed: yuan(firstNeed) };
  }
  function option(roles, goal, capCny, kind, budgetCny = null, share) {
    const c = cost(roles, goal, share), free = roles.every(r => isLocal(r.model));
    // B5-F2：用户自己填了人民币上限就按它（不超过管理员设的单次上限）；没填就“自动”= 需要的金额与单次上限取小
    const fixed = budgetCny != null && !free;
    // a user amount is floored to the fen and never raised; below what the first step needs it is flagged, not lifted
    const maxCny = free ? 0 : fixed ? Math.min(capCny, fen(budgetCny)) : Math.max(0.1, Math.min(capCny, c.needed));
    return { kind, roles, summary: summary(roles), estimateCny: free ? 0 : Math.max(0.01, c.estimate), maxCny, neededCny: c.needed, autoCny: free ? 0 : Math.max(0.1, Math.min(capCny, c.needed)),
      minCny: free ? 0 : Math.max(0.01, c.firstNeed), overCap: !free && !fixed && c.needed > capCny, underBudget: fixed && maxCny < c.needed, belowMin: fixed && maxCny < Math.max(0.01, c.firstNeed), userBudget: fixed, free };
  }
  /* B5-F2 A：PPT 的最后一步输出幻灯片 JSON（服务端严格校验；不合格时按“第N页”回退解析） */
  function pageCount(goal) {
    const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const m = /(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:页|张)(?!面)/.exec(String(goal || '')); if (!m) return null;
    const v = /^\d+$/.test(m[1]) ? Number(m[1]) : m[1] === '十' ? 10 : m[1].length === 2 && m[1][0] === '十' ? 10 + CN[m[1][1]] : m[1].length === 2 && m[1][1] === '十' ? CN[m[1][0]] * 10 : CN[m[1]];
    return v >= 1 && v <= 30 ? v : null;
  }
  function slidesAsk(goal) {
    const n = pageCount(goal);
    return '审核上一步的演示稿提纲，修正错误与遗漏，然后只输出一个 JSON 对象，不要代码块标记，不要任何其它文字。格式：' +
      '{"slides":[{"layout":"cover","title":"主标题","subtitle":"副标题"},{"layout":"bullets","title":"页标题","bullets":["要点"]},' +
      '{"layout":"cards","title":"页标题","cards":[{"title":"卡片标题","text":"一句说明"}]},{"layout":"two-column","title":"页标题","left":{"title":"左栏标题","bullets":["要点"]},"right":{"title":"右栏标题","bullets":["要点"]}},' +
      '{"layout":"timeline","title":"页标题","steps":[{"title":"步骤","text":"一句说明"}]},{"layout":"summary","title":"总结","quote":"一句金句","bullets":["要点"]}]}。' +
      '规则：第一页必须是 cover；' + (n ? '一共正好 ' + n + ' 页（含封面）；' : '一共 5–8 页（含封面）；') +
      '按内容选最合适的 layout（并列的 3–4 个概念用 cards，先后步骤用 timeline，对比用 two-column，最后一页用 summary）；每页要点不超过 6 条，每条不超过 30 个字；' +
      '标题写给听众看，不要写“第N页”；不要写视觉建议、配色、配图或排版说明；不要使用 # * - 等 Markdown 符号。';
  }
  function plan({ models, goal, output = 'word', deadline = '', capCny = 5, picks = {}, choice = 'quality', budgetCny = null, materials = [] } = {}) {
    const share = materialShare(materials);
    // empty = automatic; anything else must be a positive amount (0, negative or text is an error, never "automatic")
    const blank = budgetCny == null || String(budgetCny).trim() === '';
    const budget = blank ? null : Number(budgetCny);
    const problems = [], out = OUTPUTS[output] || OUTPUTS.text, text = String(goal || '').trim();
    const chats = chat(models), pool = usable(models);
    const skipped = chats.filter(m => !cnyRate(m)).map(m => Hints.platformLabel(m));
    if (!text) problems.push({ code: 'goal_missing', text: '请先用一句话说说想做什么。' });
    if (budget !== null && !(Number.isFinite(budget) && budget > 0)) problems.push({ code: 'budget_invalid', text: '请填大于 0 的金额，或者留空让系统自动估算。' });
    else if (budget !== null && fen(budget) < 0.01) problems.push({ code: 'budget_invalid', text: '金额太小了，最少填 ¥0.01，或者留空让系统自动估算。' });
    if (!chats.length) problems.push({ code: 'no_model', text: '还没有可用的模型。请先添加一个模型（填一次密钥即可）。', fix: { action: 'add_model', label: '去添加模型' } });
    // B5-2: known platforms always get a price (official or a conservative estimated ceiling), so this only
    // happens when every model is on a platform without any registered price. Never send the user to edit prices.
    else if (!pool.length) problems.push({ code: 'no_priced_model', text: '现在的模型都来自没有登记价格的平台，按规定不调用：' + skipped.join('、') + '。请管理员添加已登记价格平台的模型。' });
    if (problems.length) return { ok: false, problems, skipped, roles: [], summary: '', options: {} };
    const cap = Math.max(0.1, Number(capCny) || 5), specs = roleSet(output);
    const quality = option(assign(pool, specs, picks, false), text, cap, 'quality', budget, share);
    const options = { quality };
    if (quality.overCap) {
      const saving = option(assign(pool, specs, picks, true), text, cap, 'saving', null, share);
      if (saving.summary !== quality.summary) options.saving = saving;
    }
    const chosen = options[choice] || quality;
    const prices = {};
    for (const r of chosen.roles) { const u = usdRate(r.model); if (u) prices[r.model.connectionId] = u; }
    const project = {
      name: text.replace(/\s+/g, ' ').slice(0, 30),
      description: text + '\n\n想要的成果：' + out.label + (String(deadline || '').trim() ? '\n希望完成时间：' + String(deadline).trim() : ''),
      standards: ['使用中文', '不编造事实或数据', ...(share.files ? ['引用上传资料时注明出处文件名'] : [])], deliverables: [out.label], maxReworks: 3,
      materials: { mode: share.files ? 'all' : 'none', fileIds: [], maxChars: MATERIALS.draft },
      roles: chosen.roles.map(r => ({ roleId: r.spec.roleId, name: r.spec.name, duty: r.spec.duty, boundary: r.spec.boundary, standard: r.spec.standard, connectionId: r.model.connectionId, requiredCapabilities: [] })),
      steps: [
        { stepId: 'draft', roleId: 'drafter', title: '写出初稿', prompt: '任务：' + text + '\n' + out.ask, checks: [{ type: 'minLength', value: 20 }] },
        { stepId: 'review', roleId: 'reviewer', title: '审核并定稿', prompt: output === 'ppt' ? slidesAsk(text) : '审核上一步的初稿，修正错误与遗漏' + (share.files ? '，并对照资料核实引用的内容和出处' : '') + '。只输出修订后的完整最终成果，不要附加审核过程。' + out.ask, checks: [{ type: 'minLength', value: 20 }], handoff: 'previous', materialsMaxChars: MATERIALS.review },
      ],
    };
    const approval = { approvePaid: Object.keys(prices).length > 0, maxCost: Math.floor(chosen.maxCny / FX * 10000) / 10000, maxTokens: 200000, maxOutputTokens: MAX_OUTPUT, prices, allowedTools: [], approveExternalTools: false };
    return { ok: true, problems: [], skipped, options, chosen, roles: chosen.roles, summary: chosen.summary, project, approval, format: out.format, outputLabel: out.label, confirmText: confirmText(chosen, chosen.roles.some(r => estimated(r.model))), estimatedNote: estimatedNote(chosen.roles.map(r => r.model)), capCny: cap,
      materialsNote: materialsNote(share), budgetCny: budget, suggestedCny: chosen.autoCny, minCny: chosen.minCny, underBudget: !!chosen.underBudget, belowMin: !!chosen.belowMin, budgetClipped: budget != null && fen(budget) > cap };
  }
  /* QA-B7-01 返工：只重做"审核并定稿"这一步（沿用已完成的初稿），按审核员单价重新估算，再确认一次人民币。
   * 每轮返工都是新的显式批准，不继承上一次。snapshot = run.projectSnapshot. */
  function rework({ models, snapshot, feedback = '', capCny = 5, materials = [], previousChars = 0 } = {}) {
    // B9c: a revision also shows the reviewer the previous version (CJK counted at 3 bytes)
    const share = materialShare(materials), mBytes = matBytes(share.review, share) + Math.max(0, Number(previousChars) || 0) * 3;
    const byId = new Map((models || []).map(m => [m.connectionId, m]));
    const roles = (snapshot && snapshot.roles) || [], reviewer = roles.find(r => r.roleId === 'reviewer') || roles[roles.length - 1];
    const text = String(feedback || '').trim();
    if (!text) return { ok: false, problems: [{ code: 'feedback_missing', text: '请先用一句话说说哪里不满意、想怎么改。' }] };
    const missing = roles.map(r => byId.get(r.connectionId)).filter(m => !m || !cnyRate(m));
    if (!reviewer || missing.length) return { ok: false, problems: [{ code: 'no_priced_model', text: '这个任务用到的模型现在没有登记价格或已被移除，按规定不调用。请点“＋ 新建任务”重新开始。' }] };
    const m = byId.get(reviewer.connectionId), r = cnyRate(m), goal = String(snapshot.description || '');
    const inTok = EXPECT.systemTokens + Math.ceil((goal.length + text.length + share.review + (Number(previousChars) || 0)) * 1.2) + EXPECT.draftOut, outTok = EXPECT.reviewOut;
    const est = (inTok * r.input + outTok * r.output) / 1e6;
    const bound = ((EXPECT.systemBytes + bytes(goal) + bytes(text) + MAX_OUTPUT * 4 + mBytes + 256) * r.input + (MAX_OUTPUT + (thinkingHost(m) ? MAX_OUTPUT / 2 : 0)) * r.output) / 1e6;
    const cap = Math.max(0.1, Number(capCny) || 5), free = isLocal(m);
    const needed = yuan10(Math.max(3 * est, bound)), maxCny = free ? 0 : Math.max(0.1, Math.min(cap, needed));
    const option = { kind: 'quality', roles: [], summary: reviewer.name + ' → ' + Hints.platformLabel(m), estimateCny: free ? 0 : Math.max(0.01, yuan(est)), maxCny, neededCny: needed, overCap: !free && needed > cap, free };
    const prices = {};
    for (const role of roles) { const u = usdRate(byId.get(role.connectionId)); if (u) prices[role.connectionId] = u; }
    const approval = { decision: 'rework', feedback: text, fromStepId: 'review', revise: true, approvePaid: Object.keys(prices).length > 0, maxCost: Math.floor(maxCny / FX * 10000) / 10000, maxTokens: 200000, maxOutputTokens: MAX_OUTPUT, prices, allowedTools: [], approveExternalTools: false };
    return { ok: true, problems: [], skipped: [], options: { quality: option }, chosen: option, summary: option.summary, approval, confirmText: confirmText(option, estimated(m)), estimatedNote: estimatedNote([m]), capCny: cap };
  }
  /* B5-2 / AUD-F100-01：用了估计价的模型时如实说明——只是估计（同平台最贵价×2），实际可能更高或更低；
   * 引擎按估计价计算并在估计上限处停下，真实单价更高时实际账单可能超出，以厂商账单为准 */
  const estimated = m => !!(m && m.price && m.price.basis === 'estimated_ceiling');
  function estimatedNote(list) {
    const names = [...new Set((list || []).filter(estimated).map(m => Hints.platformLabel(m)))];
    return names.length ? names.join('、') + ' 还没有官方单价，费用按估计价计算（同平台最贵模型价格的 2 倍），只是估计，实际可能更高也可能更低。上限也按估计价计算，到估计上限会自动停下；如果真实单价更高，实际账单可能超出上限，以厂商账单为准。' : '';
  }
  function confirmText(o, byEstimate = false) {
    if (o.free) return '所选模型在本机运行，不产生费用。';
    // AUD-F100-01: with an estimated price the cap is computed from the estimate, so it is not a guarantee
    if (byEstimate) return `预计花费约 ¥${o.estimateCny.toFixed(2)}，按估计价计算的上限是 ¥${o.maxCny.toFixed(2)}，到这个数会自动停下；实际账单以厂商为准，可能超出。`;
    return `预计花费约 ¥${o.estimateCny.toFixed(2)}，最多不超过 ¥${o.maxCny.toFixed(2)}，超过会自动停下。`;
  }
  function summary(roles) {
    return roles.map((r, i) => {
      const why = [TIER_TEXT[Hints.tierOf(r.model.modelId)]];
      if (i === 1 && roles[0].model.providerId !== r.model.providerId) why.push('与起草不同厂商，交叉审核');
      return r.spec.name + ' → ' + Hints.platformLabel(r.model) + '（' + why.join('，') + '）';
    }).join('｜');
  }
  /* ---------- B9a 资料上传：人话状态（不显示英文代码和 JSON） ---------- */
  const ACCEPT = ['docx', 'xlsx', 'pptx', 'pdf', 'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'png', 'jpg', 'jpeg', 'gif', 'webp'];
  const OLD_OFFICE = { doc: 'Word', xls: 'Excel', ppt: 'PPT', wps: 'WPS 文字', et: 'WPS 表格', dps: 'WPS 演示' };
  const NEW_EXT = { doc: 'docx', xls: 'xlsx', ppt: 'pptx', wps: 'docx', et: 'xlsx', dps: 'pptx' };
  const extOf = name => (/\.([a-z0-9]{1,10})$/i.exec(String(name || '')) || [])[1]?.toLowerCase() || '';
  const fileChars = f => Number((f && f.extraction ? f.extraction.chars : f && f.chars) || 0);
  const readableFile = f => ((f && f.extraction ? f.extraction.status : f && f.status) === 'ok');
  const mb = n => (Math.round(n / 1024 / 1024 * 10) / 10) + ' MB';
  function charsText(n) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    return n >= 10000 ? (Math.round(n / 1000) / 10) + ' 万字' : n + ' 字';
  }
  /* 上传完成后的一句人话状态；ok=false 表示岗位读不到文字（会如实告诉岗位“存在但读不到”） */
  function fileStatus(f) {
    const x = (f && f.extraction) || {}, meta = x.meta || {}, chars = fileChars(f), kind = f && f.kind;
    if (x.status === 'ok') {
      if (kind === 'pdf') return { ok: true, text: '已读取 ' + (meta.pages || 1) + ' 页 / ' + charsText(chars) };
      if (kind === 'xlsx') return { ok: true, text: '表格 ' + ((meta.sheets || []).length || 1) + ' 张，已读取 ' + charsText(chars) };
      if (kind === 'pptx') return { ok: true, text: '已读取 ' + (meta.slides || 1) + ' 页幻灯片 / ' + charsText(chars) };
      if (kind === 'table') return { ok: true, text: '表格 1 张，已读取 ' + charsText(chars) };
      return { ok: true, text: '已读取 ' + charsText(chars) };
    }
    if (kind === 'image' || x.status === 'metadata_only') return { ok: false, text: '图片已保存（当前模型不会看图）' };
    if (kind === 'pdf' && x.status === 'no_text') return { ok: false, text: '这个 PDF 是扫描件，读不到文字' };
    if (kind === 'pdf' && x.status === 'tool_unavailable') return { ok: false, text: 'PDF 已保存，但服务器暂时读不了 PDF 里的文字' };
    return { ok: false, text: '文件里没有能读的文字' };
  }
  /* 选文件后、上传前的检查：不支持的类型、超过大小上限，用人话说明 */
  function checkUpload(file, { maxFileBytes = 8 * 1024 * 1024 } = {}) {
    const name = String(file && file.name || ''), ext = extOf(name), size = Number(file && file.size) || 0;
    if (OLD_OFFICE[ext]) return '「' + name + '」是旧版 ' + OLD_OFFICE[ext] + ' 格式，请先另存为 .' + NEW_EXT[ext] + ' 再上传。';
    if (!ACCEPT.includes(ext)) return '「' + name + '」这种文件暂时读不了。可以上传 Word、Excel、PPT、PDF、TXT、MD、CSV 和图片。';
    if (!size) return '「' + name + '」是空文件。';
    if (size > maxFileBytes) return '「' + name + '」有 ' + mb(size) + '，超过了单个文件 ' + mb(maxFileBytes) + ' 的上限，请压缩或拆分后再传。';
    return '';
  }
  /* 服务器拒绝时：中文原因直接说；其它（英文、代码）一律换成人话 */
  function uploadError(err, name) {
    const msg = String(err && err.message || ''), status = err && err.status, code = err && err.code;
    const known = { type_mismatch: '文件内容和它的类型对不上（可能改过扩展名，或者文件已损坏），请用原来的软件重新另存后再传',
      corrupt_file: '文件好像损坏了，打不开', zip_limit: '文件内容异常（解压后过大或压缩比异常），为安全起见没有读取', unsupported_file: '文件里有暂时不支持的内容，没有读取',
      encoding: '文字文件不是通用编码，请用记事本另存为“UTF-8”后再传', text_limit: '文件里的文字太多了，请拆成几个小文件再传', invalid_json: '文件格式不正确，读不了' };
    if (known[code]) return '「' + name + '」没有上传成功：' + known[code] + '。';
    if (status === 413 && !/[\u4e00-\u9fff]/.test(msg)) return '「' + name + '」太大了，单个文件不能超过 8 MB。';
    if (/[\u4e00-\u9fff]/.test(msg)) return '「' + name + '」没有上传成功：' + msg.replace(/[。.]$/, '') + '。';
    return '「' + name + '」没有上传成功，请再试一次。';
  }
  /* QA-B9 P2-②：和引擎同一个算法（按上传顺序，每个岗位的字数额度依次用完）算出每个文件每个岗位实际用到多少字 */
  function materialAllocation(list) {
    let d = MATERIALS.draft, r = MATERIALS.review;
    return (list || []).filter(Boolean).map(f => {
      if (!readableFile(f)) return { file: f, readable: false, total: 0, draft: 0, review: 0 };
      const total = fileChars(f), draft = Math.min(d, total), review = Math.min(r, total);
      d -= draft; r -= review;
      return { file: f, readable: true, total, draft, review };
    });
  }
  /* 一个文件没被用全时的一句人话（上传区、确认框共用） */
  function cutText(a) {
    if (!a || !a.readable || (a.draft >= a.total && a.review >= a.total)) return '';
    const part = (who, n) => n <= 0 ? who + '没用上（前面的资料已经占满）' : n >= a.total ? who + '全部用上' : who + '只用前 ' + n + ' 字，第 ' + (n + 1) + ' 字之后没被使用';
    return part('起草时', a.draft) + '；' + part('审核时', a.review);
  }
  function materialsNote(share) {
    if (!share || !share.files) return '';
    const unread = share.files - share.readable, alloc = materialAllocation(share.items), cut = alloc.filter(a => cutText(a));
    let t = '资料：' + share.files + ' 个文件' + (share.total ? '，能读到的文字共 ' + charsText(share.total) : '') + '。';
    if (share.readable) t += cut.length ? '资料比较长，岗位只用得上一部分：' + cut.map(a => '「' + (a.file.filename || '资料') + '」' + cutText(a)).join('；') + '。没被使用的部分岗位看不到，也不会编造；需要的话可以把重要内容放到前面或拆成小文件。'
      : '每个岗位都会拿到全部资料内容。';
    if (unread) t += '有 ' + unread + ' 个文件读不到文字（图片或扫描件），岗位只知道它存在，不会编造其中内容。';
    return t;
  }
  /* ---------- B9b 先问清楚再动手 ---------- */
  /* 一次便宜的调用的上限（人民币）：按服务端预留的同一口径（输入字节 + 256，输出 800，思考型平台再加一半）×1.2 向上取到分。
   * 服务端：资料最多给开头 3000 字，每个文件一行名字；上限不超过 0.1 美元。 */
  const CLARIFY = Object.freeze({ systemBytes: 2200, out: 800, excerptChars: 3000, perFileBytes: 600, maxUsd: 0.1 });
  function clarifyEstimate({ model, goal = '', deadline = '', materials = [] } = {}) {
    if (!model) return null;
    if (isLocal(model)) return { free: true, maxCny: 0, maxCostUsd: 0, approvePaid: false };
    const r = cnyRate(model); if (!r) return null;
    const files = (materials || []).length;
    const inBytes = CLARIFY.systemBytes + bytes(goal) + bytes(deadline) + 300 + (files ? CLARIFY.excerptChars * 3 + files * CLARIFY.perFileBytes : 0) + 256;
    const out = CLARIFY.out + (thinkingHost(model) ? CLARIFY.out / 2 : 0);
    const bound = (inBytes * r.input + out * r.output) / 1e6;
    const maxCny = Math.max(0.01, yuan(bound * 1.2));
    if (maxCny / FX > CLARIFY.maxUsd) return null; // 太贵的模型不用来做这一步，直接用规则版
    return { free: false, maxCny, maxCostUsd: Math.ceil(maxCny / FX * 1e6) / 1e6, approvePaid: true };
  }
  const has = (re, t) => re.test(String(t || ''));
  /* 规则版（没有可用模型、模型回答不合格时用）：只问需求里没写清楚的事，最多 3 个 */
  function clarifyRules({ goal = '', output = 'word', deadline = '', materials = [] } = {}) {
    const out = OUTPUTS[output] || OUTPUTS.text, g = String(goal).trim(), files = (materials || []).length, qs = [];
    if (output === 'ppt' && !pageCount(g)) qs.push({ question: '大概要几页？', options: ['5 页左右', '8 页左右', '10 页以上'] });
    if ((output === 'word' || output === 'text') && !has(/\d+\s*(字|页)|篇幅|简短|简要|详细|一页/, g)) qs.push({ question: '篇幅大概多长？', options: ['一页左右，简明扼要', '3–5 页', '越详细越好'] });
    if ((output === 'excel' || output === 'analysis') && !has(/趋势|对比|排名|异常|占比|汇总/, g)) qs.push({ question: '最关心哪方面？', options: ['总量和趋势', '分类对比', '异常和问题'] });
    if (!has(/给|面向|汇报|客户|老板|领导|团队|同事|学生|用户|读者|观众/, g)) qs.push({ question: '主要给谁看？', options: ['领导或老板', '客户', '团队内部', '公众'] });
    if (qs.length < 3 && !has(/正式|轻松|活泼|严谨|口语|幽默/, g)) qs.push({ question: '语气偏向哪种？', options: ['正式严谨', '轻松易懂'] });
    const understanding = '我理解你要的是：' + (g.length > 80 ? g.slice(0, 80) + '…' : g).replace(/[。.]$/, '') + '。成果是一份' + out.label +
      (files ? '，会参考你上传的 ' + files + ' 个文件' : '') + (String(deadline).trim() ? '，希望' + String(deadline).trim() + '完成' : '') + '。';
    return { understanding, questions: qs.slice(0, 3), plan: { draft: files ? '阅读资料，写出完整初稿' : '写出完整初稿', review: '检查错误和遗漏，修订定稿' }, source: 'rules' };
  }
  /* 人话版计划：起草员：…… → 审核员：…… */
  function planText(plan, clar) {
    const roles = (plan && plan.roles) || [], p = (clar && clar.plan) || {};
    return roles.map((r, i) => r.spec.name + '：' + ((i === 0 ? p.draft : p.review) || r.spec.duty)).join(' → ');
  }
  /* 用户确认后，把理解、问答（或“跳过”）并入项目说明；每个岗位的提示词都带着项目说明 */
  function applyClarify(project, clar, { answers = [], skipped = false } = {}) {
    if (!project || !clar) return project;
    const qa = skipped ? '\n用户选择跳过提问：按以上理解来做，没写清楚的地方按常见做法处理。'
      : (clar.questions || []).map((q, i) => '\n问：' + q.question + '\n答：' + (String(answers[i] || '').trim() || '（没有回答，按常见做法处理）')).join('');
    const steps = (project.steps || []).map((st, i) => {
      const focus = i === 0 ? clar.plan && clar.plan.draft : clar.plan && clar.plan.review;
      return focus ? { ...st, prompt: st.prompt + '\n本步重点：' + focus } : st;
    });
    return { ...project, description: project.description + '\n\n开始前的确认：\n对需求的理解：' + clar.understanding + qa, steps };
  }
  /* ---------- B9c 对话式修改：判断要改的范围，带上之前的对话，只改相关部分 ---------- */
  const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const CNUM = t => { t = String(t).trim(); if (/^\d+$/.test(t)) return Number(t); if (CN[t]) return CN[t];
    const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(t); return m ? (m[1] ? CN[m[1]] : 1) * 10 + (m[2] ? CN[m[2]] : 0) : null; };
  const NUM = '(?:\\d{1,2}|[一二两三四五六七八九十]{1,3})';
  /* QA-B9 P2-①：所有页码都认（第3页和第5页、第3、4页、第3到5页）；按出现顺序去重 */
  function pagesIn(m) {
    const out = [], re = new RegExp('第\\s*(' + NUM + '(?:\\s*(?:、|,|，|和|与|及|跟|-|—|~|到|至)\\s*第?\\s*' + NUM + ')*)\\s*(页|张)', 'g');
    let x;
    while ((x = re.exec(m))) {
      const parts = x[1].split(/\s*(、|,|，|和|与|及|跟|-|—|~|到|至)\s*第?\s*/);
      for (let i = 0; i < parts.length; i += 2) {
        const n = CNUM(parts[i]); if (!n) continue;
        if (i > 0 && /^(-|—|~|到|至)$/.test(parts[i - 1])) { const a = CNUM(parts[i - 2]); for (let k = a + 1; k < n && k - a < 30; k++) out.push(k); }
        out.push(n);
      }
    }
    return [...new Set(out)].filter(n => n >= 1 && n <= 99);
  }
  const pageList = ps => ps.join('、');
  const WHOLE = '(?=$|[。，,.！!？?；;\\s]|整页|这一?页|吧|了)'; // 页码后面紧跟结束/标点：说的是整页，不是页里的东西
  /* 判断要改的范围；拿不准时更保守（只改提到的页，不增删页），确认框里还可以改选 */
  function reviseScopeInfo(message) {
    const m = String(message || ''), pages = pagesIn(m);
    // 删整页：只在明确说“删除/删掉/去掉/不要 第N页”且后面没有“的…/里…/最后一句”等时
    const del = new RegExp('(删除|删掉|删去|去掉|拿掉|不要)\\s*(?:这|那)?\\s*第\\s*' + NUM + '(?:\\s*(?:、|和|与|及|到|至|-)\\s*第?\\s*' + NUM + ')*\\s*(页|张)' + WHOLE).test(m)
      || new RegExp('把\\s*第\\s*' + NUM + '(?:\\s*(?:、|和|与|及|到|至|-)\\s*第?\\s*' + NUM + ')*\\s*(页|张)\\s*(整页)?\\s*(删除|删掉|删去|去掉|拿掉)' + WHOLE).test(m);
    if (pages.length && del) return { kind: 'delete', pages, text: '删除第 ' + pageList(pages) + ' 页（整页），其它部分逐字保留' };
    // 新增页：“加一页/新增两页/补一张幻灯片”；“加一张图/表/照片”是往页里加东西，不是加页
    const add = /(加|增加|新增|插入|补充?|多)\s*(一|1|两|2|几|三|3)?\s*(页|张(?=幻灯片|PPT|ppt|演示|$|[。，,.！!？?；;\s]))/.test(m);
    if (add) return { kind: 'add', pages, text: '在合适的位置新增内容页，已有的页面逐字保留' + (pages.length ? '（位置参考：第 ' + pageList(pages) + ' 页）' : '') };
    if (pages.length) return { kind: 'pages', pages, text: '只改第 ' + pageList(pages) + ' 页的内容（页数不变），其它部分逐字保留' };
    const part = /(标题|开头|开场|结尾|结论|总结|摘要|封面|目录|表格|第一段|最后一段)/.exec(m);
    if (part) return { kind: 'part', pages, text: '只改“' + part[1] + '”相关的部分，其它部分逐字保留' };
    return { kind: 'all', pages, text: '按意见修改；意见没有提到的部分尽量保持原样' };
  }
  function reviseScope(message) { return reviseScopeInfo(message).text; }
  /* 确认框里可改选的范围：判断出的放第一个，再给更保守 / 更宽的选择 */
  function reviseScopeOptions(message) {
    const info = reviseScopeInfo(message), opts = [info.text];
    if (info.pages.length && info.kind !== 'pages') opts.push('只改第 ' + pageList(info.pages) + ' 页的内容（页数不变），其它部分逐字保留');
    if (info.kind !== 'all') opts.push('按意见修改；意见没有提到的部分尽量保持原样');
    return [...new Set(opts)];
  }
  /* 发给审核岗位的修改说明：本次意见 + 范围 + 之前的修改对话（让模型知道已经改过什么） */
  function reviseFeedback({ message, history = [], scope } = {}) {
    const text = String(message || '').trim();
    const past = (history || []).map(h => String(h || '').trim()).filter(Boolean).slice(-5);
    return '修改意见：' + text + '\n修改范围：' + (scope || reviseScope(text)) +
      (past.length ? '\n之前已经按这些意见改过（已体现在上一版里，不要撤销）：\n' + past.map((h, i) => (i + 1) + '. ' + h).join('\n') : '') +
      '\n请在上一版成果的基础上修改，只输出修改后的完整成果，格式与上一版相同，不要附加说明。';
  }
  const spentCny = usd => Math.round((Number(usd) || 0) * FX * 100) / 100;
  function explain(err, ctx = {}) {
    const code = err && err.code, msg = String(err && err.message || '');
    const name = ctx.modelName ? `「${ctx.modelName}」` : '所选模型';
    if (code === 'budget_required' || /positive maxCost/i.test(msg)) return { text: '预算为 0，无法调用收费模型。', fix: { action: 'set_budget', budgetCny: 1, label: '把预算设为 ¥1' } };
    if (code === 'cost_budget_exceeded' || code === 'token_budget_exceeded' || /budget cannot cover/i.test(msg)) return { text: '这次确认的金额已经用完，任务已停下，没有超支。', fix: null, budgetStop: true };
    if (code === 'reservation_overrun') return { text: '模型这次实际用得比预计多，任务已停下，后面的步骤不会再花钱。多用的那一点费用已经产生，无法撤回。', fix: null, overrun: true };
    if (code === 'paid_approval_required' || code === 'probe_approval_required') return { text: '需要你确认本次可能产生费用。', fix: { action: 'approve', label: '确认并开始' } };
    if (code === 'price_required' || /rates are required|价格 ?JSON|价格表/i.test(msg)) return { text: '缺少模型单价，无法计算费用上限。', fix: { action: 'conservative_prices', label: '按已知单价自动填写' } };
    if (code === 'model_unverified' || /connection test|not ready|未配置 API Key|Key/i.test(msg)) return { text: `${name}还不能用：没有密钥或连接测试没通过。`, fix: { action: 'fix_model', label: '去管理中心修复模型' } };
    if (code === 'model_missing') return { text: '有岗位还没有分配模型。', fix: { action: 'auto_assign', label: '自动分配模型' } };
    if (code === 'capability_missing') return { text: `${name}没有登记这个岗位需要的能力。`, fix: { action: 'add_caps', label: '为模型补充能力' } };
    if (code === 'rework_limit') return { text: '已经修改到这个任务的上限，不能再改了；可以下载现在的版本，或新建一个任务。', fix: null };
    if (code === 'concurrency_limit') return { text: '同时最多运行 3 个任务，请等前面的任务结束后再试。', fix: null };
    if (code === 'model_changed') return { text: '模型设置刚被修改过，需要重新开始一次。', fix: { action: 'retry', label: '重新开始' } };
    if (/exceeded the conservative reservation/i.test(msg)) return { text: '模型这次实际用得比预计多，任务已停下，后面的步骤不会再花钱。多用的那一点费用已经产生，无法撤回。', fix: null, overrun: true };
    if (/HTTP 401|HTTP 403|invalid api key|Incorrect API key/i.test(msg)) return { text: `${name}的密钥无效或没有权限。`, fix: { action: 'fix_model', label: '去管理中心修复模型' } };
    if (/超时|timeout|ECONN|网络/i.test(msg)) return { text: '连接模型服务超时，可能是网络问题。', fix: { action: 'retry', label: '再试一次' } };
    if (/^[^A-Za-z]*$/.test(msg) && msg) return { text: msg, fix: null };
    return { text: '启动没有成功。', fix: { action: 'retry', label: '再试一次' }, detail: msg };
  }
  return { materialAllocation, cutText, reviseScope, reviseScopeInfo, reviseScopeOptions, reviseFeedback, clarifyEstimate, clarifyRules, planText, applyClarify, CLARIFY, fileStatus, checkUpload, uploadError, materialsNote, materialShare, charsText, MATERIALS, ACCEPT, plan, rework, explain, summary, estimatedNote, pageCount, slidesAsk, usable, chat, cnyRate, usdRate, spentCny, confirmText, OUTPUTS, FX, CNY_PER_USD: FX, MAX_OUTPUT, TIER_TEXT, EXPECT };
});
