'use strict';
/* B7g 智能分配（规则化，不额外调用模型）。Pure: no network, no storage; browser + Node.
 * Input: the user's three answers (做什么 / 要什么成果 / 预算档位) and the registered model list.
 * Output: a V2 project body, a per-run approval, and human-language text. The server's budget and
 * readiness gates are unchanged; this module only fills their inputs.
 *
 * Money: vendor prices are unknown to the platform. Each model gets a deliberately HIGH conservative
 * USD rate by name tier (an over-estimate, labelled as such), so the approved USD cap is enforced
 * against a cost that should be higher than the real bill ("费用未知，按上限封顶"). It is never a bill. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./model-hints.js') : root.ModelHints);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SmartPlan = api;
})(typeof self !== 'undefined' ? self : this, function (Hints) {
  const CNY_PER_USD = 7.3; // conservative: a higher CNY/USD rate gives a smaller USD cap
  const RATES = Object.freeze({ // USD per million tokens, conservative upper bounds by name tier
    low: Object.freeze({ inputPerMillion: 1, outputPerMillion: 4, currency: 'USD' }),
    mid: Object.freeze({ inputPerMillion: 4, outputPerMillion: 16, currency: 'USD' }),
    high: Object.freeze({ inputPerMillion: 10, outputPerMillion: 40, currency: 'USD' }),
  });
  const TIER_TEXT = { low: '便宜快速', mid: '均衡', high: '擅长分析推理' };
  const BUDGETS = [1, 5, 20];
  const MAX_OUTPUT = 2048;
  const OUTPUTS = Object.freeze({
    text: { label: '文字', format: 'md', ask: '用清晰的中文分段写出完整内容。' },
    word: { label: 'Word 文档', format: 'docx', ask: '写成一份结构清晰的文档：有标题、分节小标题和正文。' },
    excel: { label: 'Excel 表格', format: 'xlsx', ask: '整理成表格：第一行是列名，之后每行一条记录，列之间用竖线 | 分隔。' },
    ppt: { label: 'PPT 演示', format: 'pptx', ask: '写成演示文稿提纲：每页一个标题，下面 3–5 条要点。' },
    analysis: { label: '表格分析', format: 'xlsx', ask: '给出分析结论和关键数字，并把数据整理成表格：第一行是列名，列之间用竖线 | 分隔。' },
  });
  const bytes = s => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(String(s)).length : Buffer.byteLength(String(s)));
  const isLocal = m => m.pricingMode === 'local';
  function usable(models) {
    return (models || []).filter(m => m && m.enabled !== false && m.status !== 'disabled' && !Hints.nonChatReason(m.modelId));
  }
  function rateOf(m) { return isLocal(m) ? null : RATES[Hints.tierOf(m.modelId)]; }
  function rank(list, order) {
    const pos = t => order.indexOf(t);
    return [...list].sort((a, b) => (a.status === 'error') - (b.status === 'error') || pos(Hints.tierOf(a.modelId)) - pos(Hints.tierOf(b.modelId)) || String(a.modelId).localeCompare(String(b.modelId)));
  }
  // Reservation bound the engine will compute for one call (input bytes + 256 + max output tokens).
  function callBound(m, inputBytes) {
    const r = rateOf(m);
    return r ? ((inputBytes + 256) * r.inputPerMillion + MAX_OUTPUT * r.outputPerMillion) / 1e6 : 0;
  }
  function roleSet(output) {
    const analysis = output === 'analysis';
    return [
      { roleId: 'drafter', name: analysis ? '分析员' : '起草员', duty: analysis ? '分析需求与数据，写出分析初稿' : '根据需求写出完整初稿', boundary: '只负责初稿，不自我审核', standard: '内容完整、结构清晰、不编造事实', prefer: ['low', 'mid', 'high'] },
      { roleId: 'reviewer', name: '审核员', duty: '审核初稿并修订成最终成果', boundary: '只审核和修订，不改变任务目标', standard: '指出并修正错误与遗漏，输出可直接使用的终稿', prefer: ['high', 'mid', 'low'] },
    ];
  }
  /* plan({ models, goal, output, budgetCny, picks }) -> { ok, problems, roles, project, approval, estimate, summary }
   * picks: { drafter?: connectionId, reviewer?: connectionId } chosen with "换一个". */
  function plan({ models, goal, output = 'text', budgetCny = 5, picks = {} } = {}) {
    const problems = [], out = OUTPUTS[output] || OUTPUTS.text, text = String(goal || '').trim();
    const pool = usable(models);
    if (!text) problems.push({ code: 'goal_missing', text: '请先用一句话说说想做什么。' });
    if (!pool.length) problems.push({ code: 'no_model', text: '还没有可用的模型。请先添加一个模型（填一次密钥即可）。', fix: { action: 'add_model', label: '去添加模型' } });
    const cny = Number(budgetCny);
    if (!(cny > 0)) problems.push({ code: 'budget_zero', text: '预算为 0 时无法调用收费模型。', fix: { action: 'set_budget', budgetCny: 1, label: '把预算设为 ¥1' } });
    if (problems.length) return { ok: false, problems, roles: [], summary: '' };
    const usd = Math.floor(cny / CNY_PER_USD * 10000) / 10000;
    const specs = roleSet(output), roles = [];
    const draftIn = bytes(text) + 1800, reviewIn = bytes(text) + 1800 + MAX_OUTPUT * 4;
    for (const spec of specs) {
      let candidates = rank(pool, spec.prefer);
      if (spec.roleId === 'reviewer' && roles[0]) { // cross-vendor review when another provider exists
        const other = candidates.filter(m => m.providerId !== roles[0].model.providerId);
        if (other.length) candidates = [...other, ...candidates.filter(m => !other.includes(m))];
      }
      const picked = candidates.find(m => m.connectionId === picks[spec.roleId]) || candidates[0];
      roles.push({ spec, model: picked, candidates: candidates.map(m => m.connectionId) });
    }
    // Downgrade the reviewer (then the drafter) until one draft + one review fits the approved cap.
    const total = () => callBound(roles[0].model, draftIn) + callBound(roles[1].model, reviewIn);
    for (const i of [1, 0]) {
      if (total() <= usd) break;
      if (picks[roles[i].spec.roleId]) continue; // never silently override the user's own choice
      const inB = i ? reviewIn : draftIn, byId = new Map(pool.map(m => [m.connectionId, m]));
      const order = roles[i].candidates.map(id => byId.get(id)); // keeps the cross-vendor preference
      const cheaper = order.filter(m => callBound(m, inB) < callBound(roles[i].model, inB)).sort((x, y) => callBound(x, inB) - callBound(y, inB) || order.indexOf(x) - order.indexOf(y))[0];
      if (cheaper) roles[i].model = cheaper;
    }
    if (total() > usd) {
      const need = BUDGETS.find(b => b > cny && callBound(roles[0].model, draftIn) + callBound(roles[1].model, reviewIn) <= Math.floor(b / CNY_PER_USD * 10000) / 10000) || 20;
      return { ok: false, roles, summary: summary(roles), problems: [{ code: 'budget_low', text: `预算 ¥${cny} 不够完成一次起草加一次审核（按保守单价估算）。`, fix: { action: 'set_budget', budgetCny: need, label: `把预算设为 ¥${need}` } }] };
    }
    const prices = {};
    for (const r of roles) { const rate = rateOf(r.model); if (rate) prices[r.model.connectionId] = { ...rate }; }
    const avg = total() / 2;
    const calls = avg > 0 ? Math.floor(usd / avg) : null;
    const project = {
      name: text.replace(/\s+/g, ' ').slice(0, 30),
      description: text + '\n\n想要的成果：' + out.label,
      standards: ['使用中文', '不编造事实或数据'],
      deliverables: [out.label],
      maxReworks: 0,
      roles: roles.map(r => ({ roleId: r.spec.roleId, name: r.spec.name, duty: r.spec.duty, boundary: r.spec.boundary, standard: r.spec.standard, connectionId: r.model.connectionId, requiredCapabilities: [] })),
      steps: [
        { stepId: 'draft', roleId: 'drafter', title: '写出初稿', prompt: '任务：' + text + '\n' + out.ask, checks: [{ type: 'minLength', value: 20 }] },
        { stepId: 'review', roleId: 'reviewer', title: '审核并定稿', prompt: '审核上一步的初稿，修正错误与遗漏。只输出修订后的完整最终成果，不要附加审核过程。' + out.ask, checks: [{ type: 'minLength', value: 20 }], handoff: 'previous' },
      ],
    };
    const approval = { approvePaid: Object.keys(prices).length > 0, maxCost: usd, maxTokens: 200000, maxOutputTokens: MAX_OUTPUT, prices, allowedTools: [], approveExternalTools: false };
    return { ok: true, problems: [], roles, project, approval, format: out.format, outputLabel: out.label,
      estimate: { cny, usd, calls, chars: calls === null ? null : calls * 800, unknownPrice: roles.some(r => !isLocal(r.model) && r.model.pricingMode !== 'free_tier'), free: !Object.keys(prices).length },
      summary: summary(roles) };
  }
  function summary(roles) {
    return roles.map((r, i) => {
      const why = [TIER_TEXT[Hints.tierOf(r.model.modelId)]];
      if (i === 1 && roles[0].model.providerId !== r.model.providerId) why.push('与起草不同厂商，交叉审核');
      return r.spec.name + ' → ' + Hints.platformLabel(r.model) + '（' + why.join('，') + '）';
    }).join('｜');
  }
  /* Server gate errors -> plain Chinese + a one-click fix. Never shows the raw message to ordinary users. */
  function explain(err, ctx = {}) {
    const code = err && err.code, msg = String(err && err.message || '');
    const name = ctx.modelName ? `「${ctx.modelName}」` : '所选模型';
    if (code === 'budget_required' || /positive maxCost/i.test(msg)) return { text: '预算为 0，无法调用收费模型。', fix: { action: 'set_budget', budgetCny: 1, label: '把预算设为 ¥1' } };
    if (code === 'cost_budget_exceeded' || code === 'token_budget_exceeded') return { text: '预算不够完成这一步。', fix: { action: 'set_budget', budgetCny: 5, label: '把预算提高到 ¥5' } };
    if (code === 'paid_approval_required' || code === 'probe_approval_required') return { text: '需要你确认本次可能产生费用。', fix: { action: 'approve', label: '确认预算并开始' } };
    if (code === 'price_required' || /rates are required|价格 ?JSON|价格表/i.test(msg)) return { text: '缺少模型单价，无法计算费用上限。', fix: { action: 'conservative_prices', label: '按保守单价自动填写' } };
    if (code === 'model_unverified' || /connection test|not ready|未配置 API Key|Key/i.test(msg)) return { text: `${name}还不能用：没有密钥或连接测试没通过。`, fix: { action: 'fix_model', label: '去管理中心修复模型' } };
    if (code === 'model_missing') return { text: '有岗位还没有分配模型。', fix: { action: 'auto_assign', label: '自动分配模型' } };
    if (code === 'capability_missing') return { text: `${name}没有登记这个岗位需要的能力。`, fix: { action: 'add_caps', label: '为模型补充能力' } };
    if (code === 'concurrency_limit') return { text: '同时最多运行 3 个任务，请等前面的任务结束后再试。', fix: null };
    if (code === 'model_changed') return { text: '模型设置刚被修改过，需要重新开始一次。', fix: { action: 'retry', label: '重新开始' } };
    if (/HTTP 401|HTTP 403|invalid api key|Incorrect API key/i.test(msg)) return { text: `${name}的密钥无效或没有权限。`, fix: { action: 'fix_model', label: '去管理中心修复模型' } };
    if (/超时|timeout|ECONN|网络/i.test(msg)) return { text: '连接模型服务超时，可能是网络问题。', fix: { action: 'retry', label: '再试一次' } };
    if (/^[^A-Za-z]*$/.test(msg) && msg) return { text: msg, fix: null }; // already plain Chinese from this page's own checks
    return { text: '启动没有成功。', fix: { action: 'retry', label: '再试一次' }, detail: msg };
  }
  // Execution-check issues -> a Chinese checklist with fixes (replaces raw JSON).
  function checklist(issues, models) {
    const byRole = ctx => ctx;
    return (issues || []).map(i => {
      const caps = /capabilities? (.+)$/.exec(i.message || '');
      if (i.code === 'capability_missing') return { code: i.code, roleId: i.roleId, missing: caps ? caps[1].split(/,\s*/) : [], text: '' };
      return { code: i.code, roleId: i.roleId, text: explain({ code: i.code, message: i.message }).text, fix: explain({ code: i.code, message: i.message }).fix };
    }).map(byRole);
  }
  return { plan, explain, checklist, summary, usable, OUTPUTS, RATES, BUDGETS, CNY_PER_USD, MAX_OUTPUT, TIER_TEXT };
});
