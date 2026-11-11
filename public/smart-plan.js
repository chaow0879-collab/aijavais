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
  function cost(roles, goal) {
    const goalTok = Math.ceil(String(goal).length * 1.2);
    const steps = [
      { m: roles[0].model, inTok: EXPECT.systemTokens + goalTok, outTok: EXPECT.draftOut, inBytes: EXPECT.systemBytes + bytes(goal) },
      { m: roles[1].model, inTok: EXPECT.systemTokens + goalTok + EXPECT.draftOut, outTok: EXPECT.reviewOut, inBytes: EXPECT.systemBytes + bytes(goal) + MAX_OUTPUT * 4 },
    ];
    let estimate = 0, reserveNeed = 0;
    steps.forEach((s, i) => {
      const r = cnyRate(s.m);
      const expected = (s.inTok * r.input + s.outTok * r.output) / 1e6;
      const bound = ((s.inBytes + 256) * r.input + (MAX_OUTPUT + (thinkingHost(s.m) ? MAX_OUTPUT / 2 : 0)) * r.output) / 1e6;
      reserveNeed = Math.max(reserveNeed, (i ? estimate : 0) + bound);
      estimate += expected;
    });
    return { estimate: yuan(estimate), needed: yuan10(Math.max(3 * estimate, reserveNeed)) };
  }
  function option(roles, goal, capCny, kind, budgetCny = null) {
    const c = cost(roles, goal), free = roles.every(r => isLocal(r.model));
    // B5-F2：用户自己填了人民币上限就按它（不超过管理员设的单次上限）；没填就“自动”= 需要的金额与单次上限取小
    const fixed = budgetCny != null && !free;
    const maxCny = free ? 0 : fixed ? Math.max(0.1, Math.min(capCny, yuan10(budgetCny))) : Math.max(0.1, Math.min(capCny, c.needed));
    return { kind, roles, summary: summary(roles), estimateCny: free ? 0 : Math.max(0.01, c.estimate), maxCny, neededCny: c.needed, autoCny: free ? 0 : Math.max(0.1, Math.min(capCny, c.needed)),
      overCap: !free && !fixed && c.needed > capCny, underBudget: fixed && maxCny < c.needed, userBudget: fixed, free };
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
  function plan({ models, goal, output = 'word', deadline = '', capCny = 5, picks = {}, choice = 'quality', budgetCny = null } = {}) {
    const budget = Number(budgetCny) > 0 && Number.isFinite(Number(budgetCny)) ? Number(budgetCny) : null;
    const problems = [], out = OUTPUTS[output] || OUTPUTS.text, text = String(goal || '').trim();
    const chats = chat(models), pool = usable(models);
    const skipped = chats.filter(m => !cnyRate(m)).map(m => Hints.platformLabel(m));
    if (!text) problems.push({ code: 'goal_missing', text: '请先用一句话说说想做什么。' });
    if (!chats.length) problems.push({ code: 'no_model', text: '还没有可用的模型。请先添加一个模型（填一次密钥即可）。', fix: { action: 'add_model', label: '去添加模型' } });
    // B5-2: known platforms always get a price (official or a conservative estimated ceiling), so this only
    // happens when every model is on a platform without any registered price. Never send the user to edit prices.
    else if (!pool.length) problems.push({ code: 'no_priced_model', text: '现在的模型都来自没有登记价格的平台，按规定不调用：' + skipped.join('、') + '。请管理员添加已登记价格平台的模型。' });
    if (problems.length) return { ok: false, problems, skipped, roles: [], summary: '', options: {} };
    const cap = Math.max(0.1, Number(capCny) || 5), specs = roleSet(output);
    const quality = option(assign(pool, specs, picks, false), text, cap, 'quality', budget);
    const options = { quality };
    if (quality.overCap) {
      const saving = option(assign(pool, specs, picks, true), text, cap, 'saving');
      if (saving.summary !== quality.summary) options.saving = saving;
    }
    const chosen = options[choice] || quality;
    const prices = {};
    for (const r of chosen.roles) { const u = usdRate(r.model); if (u) prices[r.model.connectionId] = u; }
    const project = {
      name: text.replace(/\s+/g, ' ').slice(0, 30),
      description: text + '\n\n想要的成果：' + out.label + (String(deadline || '').trim() ? '\n希望完成时间：' + String(deadline).trim() : ''),
      standards: ['使用中文', '不编造事实或数据'], deliverables: [out.label], maxReworks: 3,
      roles: chosen.roles.map(r => ({ roleId: r.spec.roleId, name: r.spec.name, duty: r.spec.duty, boundary: r.spec.boundary, standard: r.spec.standard, connectionId: r.model.connectionId, requiredCapabilities: [] })),
      steps: [
        { stepId: 'draft', roleId: 'drafter', title: '写出初稿', prompt: '任务：' + text + '\n' + out.ask, checks: [{ type: 'minLength', value: 20 }] },
        { stepId: 'review', roleId: 'reviewer', title: '审核并定稿', prompt: output === 'ppt' ? slidesAsk(text) : '审核上一步的初稿，修正错误与遗漏。只输出修订后的完整最终成果，不要附加审核过程。' + out.ask, checks: [{ type: 'minLength', value: 20 }], handoff: 'previous' },
      ],
    };
    const approval = { approvePaid: Object.keys(prices).length > 0, maxCost: Math.floor(chosen.maxCny / FX * 10000) / 10000, maxTokens: 200000, maxOutputTokens: MAX_OUTPUT, prices, allowedTools: [], approveExternalTools: false };
    return { ok: true, problems: [], skipped, options, chosen, roles: chosen.roles, summary: chosen.summary, project, approval, format: out.format, outputLabel: out.label, confirmText: confirmText(chosen, chosen.roles.some(r => estimated(r.model))), estimatedNote: estimatedNote(chosen.roles.map(r => r.model)), capCny: cap,
      budgetCny: budget, suggestedCny: chosen.autoCny, underBudget: !!chosen.underBudget, budgetClipped: budget != null && budget > cap };
  }
  /* QA-B7-01 返工：只重做"审核并定稿"这一步（沿用已完成的初稿），按审核员单价重新估算，再确认一次人民币。
   * 每轮返工都是新的显式批准，不继承上一次。snapshot = run.projectSnapshot. */
  function rework({ models, snapshot, feedback = '', capCny = 5 } = {}) {
    const byId = new Map((models || []).map(m => [m.connectionId, m]));
    const roles = (snapshot && snapshot.roles) || [], reviewer = roles.find(r => r.roleId === 'reviewer') || roles[roles.length - 1];
    const text = String(feedback || '').trim();
    if (!text) return { ok: false, problems: [{ code: 'feedback_missing', text: '请先用一句话说说哪里不满意、想怎么改。' }] };
    const missing = roles.map(r => byId.get(r.connectionId)).filter(m => !m || !cnyRate(m));
    if (!reviewer || missing.length) return { ok: false, problems: [{ code: 'no_priced_model', text: '这个任务用到的模型现在没有登记价格或已被移除，按规定不调用。请点“＋ 新建任务”重新开始。' }] };
    const m = byId.get(reviewer.connectionId), r = cnyRate(m), goal = String(snapshot.description || '');
    const inTok = EXPECT.systemTokens + Math.ceil((goal.length + text.length) * 1.2) + EXPECT.draftOut, outTok = EXPECT.reviewOut;
    const est = (inTok * r.input + outTok * r.output) / 1e6;
    const bound = ((EXPECT.systemBytes + bytes(goal) + bytes(text) + MAX_OUTPUT * 4 + 256) * r.input + (MAX_OUTPUT + (thinkingHost(m) ? MAX_OUTPUT / 2 : 0)) * r.output) / 1e6;
    const cap = Math.max(0.1, Number(capCny) || 5), free = isLocal(m);
    const needed = yuan10(Math.max(3 * est, bound)), maxCny = free ? 0 : Math.max(0.1, Math.min(cap, needed));
    const option = { kind: 'quality', roles: [], summary: reviewer.name + ' → ' + Hints.platformLabel(m), estimateCny: free ? 0 : Math.max(0.01, yuan(est)), maxCny, neededCny: needed, overCap: !free && needed > cap, free };
    const prices = {};
    for (const role of roles) { const u = usdRate(byId.get(role.connectionId)); if (u) prices[role.connectionId] = u; }
    const approval = { decision: 'rework', feedback: text, fromStepId: 'review', approvePaid: Object.keys(prices).length > 0, maxCost: Math.floor(maxCny / FX * 10000) / 10000, maxTokens: 200000, maxOutputTokens: MAX_OUTPUT, prices, allowedTools: [], approveExternalTools: false };
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
    if (code === 'concurrency_limit') return { text: '同时最多运行 3 个任务，请等前面的任务结束后再试。', fix: null };
    if (code === 'model_changed') return { text: '模型设置刚被修改过，需要重新开始一次。', fix: { action: 'retry', label: '重新开始' } };
    if (/exceeded the conservative reservation/i.test(msg)) return { text: '模型这次实际用得比预计多，任务已停下，后面的步骤不会再花钱。多用的那一点费用已经产生，无法撤回。', fix: null, overrun: true };
    if (/HTTP 401|HTTP 403|invalid api key|Incorrect API key/i.test(msg)) return { text: `${name}的密钥无效或没有权限。`, fix: { action: 'fix_model', label: '去管理中心修复模型' } };
    if (/超时|timeout|ECONN|网络/i.test(msg)) return { text: '连接模型服务超时，可能是网络问题。', fix: { action: 'retry', label: '再试一次' } };
    if (/^[^A-Za-z]*$/.test(msg) && msg) return { text: msg, fix: null };
    return { text: '启动没有成功。', fix: { action: 'retry', label: '再试一次' }, detail: msg };
  }
  return { plan, rework, explain, summary, estimatedNote, pageCount, slidesAsk, usable, chat, cnyRate, usdRate, spentCny, confirmText, OUTPUTS, FX, CNY_PER_USD: FX, MAX_OUTPUT, TIER_TEXT, EXPECT };
});
