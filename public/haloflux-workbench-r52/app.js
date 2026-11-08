/* AIJAVAIS R52 workbench controller. Talks only to EXISTING read/write product APIs that the
 * backend already guards (models list, intake plan, project save, run start/review/export, run
 * view). It never decides execution: start/review/rework requests are proposals the server
 * accepts or refuses, and the refusal is shown verbatim. All user/AI text goes in via textContent. */
(function () {
  'use strict';
  const C = window.R52Contract, P = window.R52Planner, E = window.R52Editor, J = window.R52Projector, A = window.R52Acceptance, H = window.R52Halo, D = window.R52Demo, L = window.R54Live;
  const $ = id => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  const POLL = Math.max(100, Math.min(5000, Number(qs.get('poll')) || 800));
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const S = { backend: false, models: [], tools: null, toolIdMap: {}, plan: null, projector: J.createProjector({}), artifacts: [], runId: null, runStatus: null, projectId: null,
    savedDigest: null, marks: {}, staticHalo: reduce, timer: null, demoTimer: null, lastHalo: '', unknownRunCost: false, failures: 0,
    // R54: contract 'r53' (universal backend) or 'v2' (older servers); server facts for the current run.
    contract: null, ids: L.requestIds(Date.now().toString(36) + Math.random().toString(36).slice(2, 8)), projectVersion: null, startGen: 0, run: null, wb: { cursor: 0 },
    crit: {}, critSaved: null, critSavedId: null };
  const r53 = () => S.contract === 'r53';
  function refused(r, what) { const e = L.explain(r.status, r.json); say((what ? what + '：' : '') + e.human + '［' + e.code + '］', 'warn'); return e; }

  function node(tag, attrs, kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') n.textContent = v; else if (k === 'dataset') Object.assign(n.dataset, v); else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of [].concat(kids || [])) if (c) n.appendChild(c);
    return n;
  }
  function say(msg, kind) { $('feedback').textContent = msg; $('feedback').dataset.kind = kind || 'info'; }
  async function api(path, method, body) {
    const res = await fetch(path, { method: method || 'GET', credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch { json = null; }
    return { status: res.status, ok: res.ok, json };
  }
  const serverError = r => (r.json && (r.json.error || r.json.message) ? String(r.json.error || r.json.message) : 'HTTP ' + r.status) + (r.json && r.json.code ? '（' + r.json.code + '）' : '');

  /* ---------------- backend detection ---------------- */
  async function detect() {
    try {
      const r = await api('/api/models');
      if (r.ok && r.json && Array.isArray(r.json.models)) { S.backend = true; S.models = r.json.models; }
    } catch { S.backend = false; }
    $('backend-badge').textContent = S.backend ? '后端：已连接（' + S.models.length + ' 个模型连接）' : '后端：离线（只能看方案和演示）';
    $('backend-badge').className = 'badge ' + (S.backend ? 'good' : 'warn');
  }

  /* ---------------- plan ---------------- */
  function inputs() { return { goal: $('goal').value, domain: $('domain').value, audience: $('audience').value, successCriteria: $('success').value, constraints: $('constraints').value }; }
  async function makeTeam() {
    const inp = inputs();
    let r = P.plan({ ...inp, models: S.models });
    if (!r.ok) { say(r.error, 'warn'); $('goal').focus(); return; }
    S.tools = null; S.toolIdMap = {}; S.contract = null;
    if (S.backend) {
      // R54: prefer the R53 universal backend (server plan, per-role grants, criteria, acceptance).
      try {
        const ur = await api('/api/v2/universal/plan', 'POST', L.planRequest(inp));
        if (ur.status === 200) {
          S.contract = 'r53'; S.plan = L.fromServerPlan(ur.json, r.plan, S.models); S.projectId = null; S.projectVersion = null; S.savedDigest = null;
          say('服务器生成了团队草案（PLAN_SIMULATED，离线规则，未调用 AI）。你可以直接修改，然后逐岗批准。', 'ok');
          S.lastOut = null; renderPlan(); renderAuth(); renderAll(); $('plan-card').hidden = false; $('auth-card').hidden = false; return;
        }
        if (ur.status !== 404) refused(ur, '服务器方案接口拒绝，改用离线草案');
      } catch { /* fall through to the older V2 path */ }
      S.contract = 'v2';
      // Server truth for tools (existing intake API, no model call). Failure keeps "unchecked", never "available".
      try {
        const sr = await api('/api/v2/intake/plan', 'POST', { templateId: 'universal', description: inp.goal, audience: inp.audience,
          universal: { domain: inp.domain, successCriteria: inp.successCriteria, constraints: inp.constraints, outputs: [] } });
        if (sr.ok && sr.json && Array.isArray(sr.json.toolCheck)) {
          S.tools = P.serverTools(sr.json.toolCheck);
          for (const [k, v] of Object.entries(S.tools)) if (v.toolId) S.toolIdMap[k] = v.toolId;
          r = P.plan({ ...inp, models: S.models, tools: S.tools });
        }
      } catch { /* offline tool status stays "unchecked" */ }
    }
    S.plan = r.plan; S.projectId = null; S.savedDigest = null;
    say('已生成团队草案（SIMULATED，未调用模型）。你可以直接修改。', 'ok');
    S.lastOut = null; renderPlan(); renderAuth(); renderAll();
    $('plan-card').hidden = false; $('auth-card').hidden = false;
  }
  function edit(action) {
    try { S.plan = E.apply(S.plan, action, { models: S.models }); renderPlan(); renderAuth(); renderAll(); return true; }
    catch (e) { say(e.message, 'warn'); return false; }
  }
  function keepFocus(fn) {
    const a = document.activeElement, key = a && a.dataset && a.dataset.fkey;
    fn();
    if (key) { const n = document.querySelector('[data-fkey="' + CSS.escape(key) + '"]'); if (n) n.focus(); }
  }
  const FIELD = { domain: 'domain', successCriteria: 'success', audience: 'audience', constraints: 'constraints' };
  function renderPlan() {
    const p = S.plan; if (!p) return;
    keepFocus(() => {
      $('plan-label').textContent = p.label + (p.edited ? ' · 已编辑' : '');
      $('plan-summary').textContent = '目标：' + p.goal + (p.domain ? '｜领域：' + p.domain : '｜领域待你确认') + '｜风险：' + ({ low: '低', medium: '中', high: '高', unknown: '见服务器快照' }[p.risk] || '—') + '｜' + p.roles.length + ' 个岗位、' + p.steps.length + ' 个步骤';
      $('confidence').replaceChildren(node('p', {}, [node('span', { class: 'badge ' + (p.confidence.level === 'low' ? 'block' : p.confidence.level === 'medium' ? 'warn' : 'good'), id: 'confidence-level', 'data-level': p.confidence.level,
        text: '理解程度：' + ({ high: '较高', medium: '一般', low: '低' }[p.confidence.level]) + '（' + p.confidence.score + '/100）' })]),
        node('ul', { class: 'sub' }, p.confidence.reasons.map(t => node('li', { text: t }))));
      $('cannot').replaceChildren(...(p.cannot_do.length ? p.cannot_do.map(c => node('li', { 'data-cannot': c.id, text: c.text })) : [node('li', { class: 'sub', text: '没有识别到必须由真人完成的事项；仍请你把关最终成果。' })]));
      const clar = p.clarifications.filter(c => c.blocking);
      $('clarify').replaceChildren(...(clar.length ? [node('h3', { text: '请补充（补充后点“生成我的 AI 团队”重新生成）' }), node('ul', { class: 'list' }, clar.map(c => node('li', { 'data-clarify': c.id }, [node('span', { text: c.question + ' ' }), FIELD[c.id] ? node('button', { class: 'small', 'data-goto': FIELD[c.id], text: '去填写' }) : null])))] : []));
      $('blocks').replaceChildren(...p.blocks.map(b => node('span', { class: 'badge ' + b.severity, 'data-block': b.code, title: b.text, text: b.text })));
      $('roles').replaceChildren(...p.roles.map(roleCard));
      $('steps').replaceChildren(...p.steps.map(stepCard));
      $('acceptance').replaceChildren(...p.acceptance.map(c => node('li', { 'data-check': c.id }, [node('span', { text: c.text + (c.source === 'user' ? '（你的标准）' : '') }), node('button', { class: 'small', 'data-op': 'removeCheck', 'data-id': c.id, 'data-fkey': 'rmc-' + c.id, 'aria-label': '删除验收标准：' + c.text, text: '删除' })])));
    });
  }
  function roleCard(r) {
    const models = S.models;
    const sel = node('select', { 'data-op': 'setModel', 'data-role': r.role_id, 'data-fkey': 'model-' + r.role_id, 'aria-label': r.name + ' 使用的模型' },
      [node('option', { value: '', text: '不分配模型' })].concat(models.map(m => node('option', { value: m.connectionId, selected: r.model && r.model.connection_id === m.connectionId, text: (m.displayName || m.connectionId) + ' · ' + (m.pricingMode || '?') + (m.status !== 'available' ? '（' + m.status + '）' : '') }))));
    const field = (key, label, max) => node('div', {}, [node('label', { class: 'lbl', for: 'r-' + key + '-' + r.role_id, text: label }),
      node('input', { type: 'text', id: 'r-' + key + '-' + r.role_id, value: r[key], maxlength: max, 'data-op': 'editRole', 'data-role': r.role_id, 'data-key': key, 'data-fkey': 'r-' + key + '-' + r.role_id })]);
    return node('li', { 'data-rolecard': r.role_id, 'data-origin': r.origin }, [
      node('div', { class: 'role-head' }, [node('strong', { text: r.name }), node('span', { class: 'mstatus', 'data-status': r.model ? r.model.status : 'none', text: r.model ? r.model.reason : '' }),
        node('button', { class: 'small', 'data-op': 'removeRole', 'data-role': r.role_id, 'data-fkey': 'rm-' + r.role_id, 'aria-label': '删除岗位 ' + r.name, text: '删除' })]),
      node('div', { class: 'grid2' }, [field('name', '名称', 50), field('duty', '职责', 400), field('boundary', '不能做什么（边界）', 400), field('standard', '验收标准', 400)]),
      node('label', { class: 'lbl', text: '模型' }), sel]);
  }
  function stepCard(s, i) {
    const roleSel = node('select', { 'data-op': 'stepRole', 'data-step': s.step_id, 'data-fkey': 'sr-' + s.step_id, 'aria-label': '步骤“' + s.title + '”由哪个岗位负责' },
      S.plan.roles.map(r => node('option', { value: r.role_id, selected: r.role_id === s.role_id, text: r.name })));
    const inp = (key, label, max) => node('input', { type: 'text', value: s[key], maxlength: max, 'aria-label': label, 'data-op': 'editStep', 'data-step': s.step_id, 'data-key': key, 'data-fkey': 's-' + key + '-' + s.step_id });
    return node('li', { 'data-stepcard': s.step_id, class: 'step' }, [
      node('span', { class: 'num', text: String(i + 1) }),
      node('div', {}, [inp('title', '步骤名称', 120), node('label', { class: 'lbl', text: '成果' }), inp('deliverable', '成果', 200), node('label', { class: 'lbl', text: '检查标准' }), inp('quality', '检查标准', 400),
        node('label', { class: 'lbl', text: '负责岗位' }), roleSel,
        r53() ? node('label', { class: 'lbl', text: '步骤类型' }) : null,
        r53() ? node('select', { 'data-op': 'stepKind', 'data-step': s.step_id, 'data-fkey': 'sk-' + s.step_id, 'aria-label': '步骤“' + s.title + '”的类型' },
          [node('option', { value: 'work', selected: s.kind !== 'peer_review', text: '工作' }), node('option', { value: 'peer_review', selected: s.kind === 'peer_review', text: '独立复核（复核其他岗位的成果）' })]) : null,
        node('div', {}, s.tools.map(t => node('span', { class: 'tool badge', 'data-status': t.status, 'data-tool': t.tool_id }, [node('span', { text: t.tool_id + '：' + ({ available: '可用', unchecked: '未核对', unknown: '平台没有', needs_setup: '需配置' }[t.status] || t.status) + ' ' }),
          node('button', { class: 'small', 'data-op': 'removeTool', 'data-step': s.step_id, 'data-tool': t.tool_id, 'data-fkey': 'rt-' + s.step_id + '-' + t.tool_id, 'aria-label': '从步骤移除工具 ' + t.tool_id, text: '移除' })])))]),
      node('div', { class: 'row', style: 'flex-direction:column' }, [
        node('button', { class: 'small', 'data-op': 'up', 'data-step': s.step_id, 'data-fkey': 'up-' + s.step_id, 'aria-label': '上移步骤 ' + s.title, disabled: i === 0, text: '↑' }),
        node('button', { class: 'small', 'data-op': 'down', 'data-step': s.step_id, 'data-fkey': 'down-' + s.step_id, 'aria-label': '下移步骤 ' + s.title, disabled: i === S.plan.steps.length - 1, text: '↓' }),
        node('button', { class: 'small', 'data-op': 'removeStep', 'data-step': s.step_id, 'data-fkey': 'rs-' + s.step_id, 'aria-label': '删除步骤 ' + s.title, text: '删' })])]);
  }
  function onPlanEvent(ev) {
    const t = ev.target, op = t.dataset && t.dataset.op;
    if (!op || !S.plan) return;
    if (ev.type === 'click' && t.tagName !== 'BUTTON') return;
    if (ev.type === 'change' && t.tagName === 'BUTTON') return;
    const d = t.dataset;
    const map = {
      removeRole: () => ({ op: 'removeRole', role_id: d.role }), editRole: () => ({ op: 'editRole', role_id: d.role, [d.key]: t.value }), setModel: () => ({ op: 'setModel', role_id: d.role, connection_id: t.value || null }),
      up: () => ({ op: 'moveStep', step_id: d.step, delta: -1 }), down: () => ({ op: 'moveStep', step_id: d.step, delta: 1 }), removeStep: () => ({ op: 'removeStep', step_id: d.step }),
      editStep: () => ({ op: 'editStep', step_id: d.step, [d.key]: t.value }), stepRole: () => ({ op: 'editStep', step_id: d.step, role_id: t.value }),
      removeTool: () => ({ op: 'removeTool', step_id: d.step, tool_id: d.tool }), removeCheck: () => ({ op: 'editAcceptance', remove: d.id }),
      stepKind: () => ({ op: 'editStep', step_id: d.step, kind: t.value })
    };
    if (!map[op]) return;
    if (!edit(map[op]())) renderPlan(); // restore the last valid values on refusal
  }

  /* ---------------- authorization ---------------- */
  function renderAuth() {
    const p = S.plan; if (!p) return;
    const perm = p.permissions;
    $('ops').replaceChildren(...P.OPS.map(o => node('label', { class: 'row', style: 'margin:4px 0' }, [node('input', { type: 'checkbox', 'data-opid': o.id, checked: perm.allowed_ops.includes(o.id), disabled: !!o.never }),
      node('span', { text: o.label + (o.never ? '（永远不允许 AI 团队做）' : '') })])));
    $('max-cost').value = perm.max_cost_usd; $('max-tokens').value = perm.max_tokens;
    const paid = p.roles.filter(r => r.model && r.model.status === 'paid_needs_approval');
    const ids = [...new Set(paid.map(r => r.model.connection_id))];
    $('paid-box').replaceChildren(...(ids.length ? [node('p', { class: 'banner', text: '收费或计费未知的模型：' + ids.join('、') + '。需要你批准付费、填写单价（美元/百万 Token）和正数费用上限，服务器会按上限保守预留。' }),
      node('label', { class: 'row' }, [node('input', { type: 'checkbox', id: 'approve-paid', checked: perm.approve_paid }), node('span', { text: '我批准本次运行使用收费模型' })]),
      ...ids.map(id => node('div', { class: 'grid2', 'data-price': id }, [node('input', { type: 'number', min: 0, step: '0.01', 'data-price-in': id, 'aria-label': id + ' 输入单价', placeholder: id + ' 输入单价', value: perm.prices[id] ? perm.prices[id].inputPerMillion : '' }),
        node('input', { type: 'number', min: 0, step: '0.01', 'data-price-out': id, 'aria-label': id + ' 输出单价', placeholder: id + ' 输出单价', value: perm.prices[id] ? perm.prices[id].outputPerMillion : '' })]))] : []));
    $('confirm-auth').checked = perm.confirmed;
    $('r53-auth').hidden = !r53(); $('ops-box').hidden = r53(); if (r53()) $('paid-box').replaceChildren();
    if (r53()) {
      const st = S.projector.state();
      $('role-grants').replaceChildren(...p.roles.map(r => {
        const rs = L.roleStatus(p, r, st), g = (perm.roles || {})[r.role_id] || {};
        return node('li', { 'data-grant-role': r.role_id, 'data-role-status': rs.status, 'data-unknown-cost': String(rs.unknown_cost) }, [
          node('div', { class: 'role-head' }, [node('strong', { text: r.name }),
            node('span', { class: 'badge ' + ({ approved: 'good', blocked: 'block', pending: 'warn' }[rs.status] || 'info'), text: { approved: '已批准 approved', blocked: '受阻 blocked', pending: '待批准' }[rs.status] }),
            rs.unknown_cost ? node('span', { class: 'badge warn', text: '费用未知 unknown_cost' }) : null]),
          node('p', { class: 'sub', text: '模型：' + (r.model && (r.model.display_name || r.model.connection_id) || '无') + '（' + (r.model && r.model.pricing_mode || '—') + '）｜' + rs.reason }),
          node('div', { class: 'row' }, [
            node('label', { class: 'row' }, [node('input', { type: 'checkbox', 'data-grant': r.role_id, checked: g.approved === true, disabled: rs.status === 'blocked', 'aria-label': '批准岗位 ' + r.name }), node('span', { text: '批准此岗位' })]),
            node('label', { class: 'row' }, [node('span', { class: 'sub', text: 'Token 上限' }), node('input', { type: 'number', min: 1000, max: 1000000, step: 1000, value: g.max_tokens || 100000, 'data-grant-tokens': r.role_id, 'aria-label': r.name + ' Token 上限', style: 'width:130px' })])])]);
      }));
    }
    const rr = E.runRequest(p, S.toolIdMap);
    const active = !!S.runId && (S.starting || ['running', 'queued', null, undefined].includes(S.runStatus));
    $('start-run').disabled = !rr.ok || !S.backend || active || !!S.starting;
    $('save-project').disabled = !S.backend;
    $('run-refusal').textContent = !S.backend ? '离线模式：没有连接后端，不能保存或开始工作。' : active ? '当前任务仍在进行中；结束或取消后才能再次开始。' : rr.ok ? '' : '暂不能开始：' + rr.reason;
    $('start-run').dataset.reason = rr.ok ? '' : rr.code;
  }
  function onAuthChange(ev) {
    if (!S.plan) return;
    const t = ev.target;
    if (t.id === 'confirm-auth') { S.plan = E.confirm(S.plan, t.checked); renderPlan(); renderAuth(); renderAll(); return; }
    let action = null;
    if (t.dataset.grant) action = { op: 'setRoleGrant', role_id: t.dataset.grant, approved: t.checked };
    else if (t.dataset.grantTokens) action = { op: 'setRoleGrant', role_id: t.dataset.grantTokens, max_tokens: t.value };
    if (action) { if (!edit(action)) renderAuth(); return; }
    if (t.dataset.opid) action = { op: 'setPermissions', allowed_ops: [...document.querySelectorAll('[data-opid]')].filter(x => x.checked).map(x => x.dataset.opid) };
    else if (t.id === 'max-cost') action = { op: 'setPermissions', max_cost_usd: t.value };
    else if (t.id === 'max-tokens') action = { op: 'setPermissions', max_tokens: t.value };
    else if (t.id === 'approve-paid') action = { op: 'setPermissions', approve_paid: t.checked };
    else if (t.dataset.priceIn !== undefined || t.dataset.priceOut !== undefined) {
      const prices = {};
      for (const box of document.querySelectorAll('[data-price]')) {
        const id = box.dataset.price, i = box.querySelector('[data-price-in]').value, o = box.querySelector('[data-price-out]').value;
        if (i !== '' && o !== '') prices[id] = { inputPerMillion: Number(i), outputPerMillion: Number(o) };
      }
      action = { op: 'setPermissions', prices };
    }
    if (action && !edit(action)) renderAuth();
  }
  async function saveProject() {
    if (!S.backend || !S.plan) return null;
    if (r53()) return saveUniversal();
    let body;
    try { body = E.toProject(S.plan, S.toolIdMap); } catch (e) { say(e.message, 'warn'); return null; }
    const digest = JSON.stringify(body);
    if (S.projectId && S.savedDigest === digest) return S.projectId;
    const r = await api('/api/v2/projects', 'POST', body);
    if (r.status !== 201) { say('服务器没有保存：' + serverError(r), 'warn'); return null; }
    S.projectId = r.json.project.projectId; S.savedDigest = digest;
    say('已保存为项目（未运行、未调用模型）。也可以在“项目工作台”里查看。', 'ok');
    return S.projectId;
  }
  async function saveUniversal() {
    if (S.plan.readOnly) { say('这是服务器上已运行任务的快照，不能另存为新方案；请重新生成团队。', 'warn'); return null; }
    const v = E.validate(S.plan); if (!v.ok) { say(v.errors.join('；'), 'warn'); return null; }
    const body = L.toUniversalProject(S.plan), digest = JSON.stringify(body);
    if (S.projectId && S.savedDigest === digest) return S.projectId;
    const r = S.projectId ? await api('/api/v2/projects/' + encodeURIComponent(S.projectId), 'PUT', { ...body, expectedVersion: S.projectVersion })
      : await api('/api/v2/universal/projects', 'POST', { project: body });
    if (!(r.status === 201 || r.status === 200)) { refused(r, '服务器没有保存'); return null; }
    S.projectId = r.json.project.projectId; S.projectVersion = r.json.project.version; S.savedDigest = digest;
    say('已保存到服务器（第 ' + S.projectVersion + ' 版；未运行、未调用模型）。', 'ok');
    return S.projectId;
  }
  async function startUniversal() {
    const rr = E.runRequest(S.plan, S.toolIdMap);
    if (!rr.ok) { $('run-refusal').textContent = '暂不能开始：' + rr.reason; return; }
    const pid = await saveUniversal(); if (!pid) return;
    // Same content + same generation = same request ID: a retry after a network drop cannot dispatch twice.
    const body = L.approvalBody(S.plan, S.ids('start', { pid, v: S.projectVersion, gen: S.startGen }));
    let r;
    try { r = await api('/api/v2/universal/projects/' + encodeURIComponent(pid) + '/runs', 'POST', body); }
    catch { say('网络中断：不确定服务器是否已收到。再次点击会用同一个请求编号，服务器不会重复派发。', 'warn'); return; }
    if (r.status !== 202) { const e = refused(r, '服务器拒绝开始，没有派发任何工作'); $('run-refusal').textContent = '服务器拒绝开始：' + e.human + '［' + e.code + '］'; return; }
    const run = r.json.run || {};
    if (run.duplicate) { if (run.runId) { follow(run.runId); say('这是重复请求：服务器没有重新派发，已显示原来的任务。', 'info'); } else say('这是重复请求：服务器没有重新派发（状态 ' + run.state + '）。', 'warn'); return; }
    S.startGen++; follow(run.runId);
    say('服务器已接受逐岗授权并开始工作。HALOFLUX 只显示服务器记录的事件。', 'ok');
  }
  async function startRun() {
    if (S.starting) return;
    if (r53()) { S.starting = true; renderAuth(); try { await startUniversal(); } finally { S.starting = false; renderAuth(); } return; }
    const rr = E.runRequest(S.plan, S.toolIdMap);
    if (!rr.ok) { $('run-refusal').textContent = '暂不能开始：' + rr.reason; return; }
    S.starting = true; renderAuth();
    try {
      const pid = await saveProject(); if (!pid) return;
      const r = await api('/api/v2/projects/' + encodeURIComponent(pid) + '/runs', 'POST', rr.body);
      if (r.status !== 202) { $('run-refusal').textContent = '服务器拒绝开始：' + serverError(r); say('服务器拒绝开始，没有派发任何工作', 'warn'); return; }
      S.runStatus = null; follow(r.json.run.runId);
      say('服务器已接受授权并开始工作。HALOFLUX 只显示服务器记录的事件。', 'ok');
      if (getComputedStyle($('side')).position !== 'sticky') $('halo-h').scrollIntoView({ block: 'start' });
      else $('side').scrollTop = 0;
    } finally { S.starting = false; renderAuth(); }
  }

  /* ---------------- events / HALOFLUX ---------------- */
  function stopFeeds() { clearTimeout(S.timer); S.timer = null; clearInterval(S.demoTimer); S.demoTimer = null; }
  function follow(runId) {
    stopFeeds();
    if (r53()) {
      S.runId = runId; S.artifacts = []; S.run = null; S.wb = { cursor: 0 }; S.crit = {}; S.critSaved = null; S.critSavedId = null; S.runStatus = null;
      S.projector = J.createProjector({ mode: 'LIVE', connection: 'connected', staleMs: Math.max(POLL * 6, 5000) });
      try { history.replaceState(null, '', location.pathname + '?run=' + encodeURIComponent(runId) + (qs.get('poll') ? '&poll=' + qs.get('poll') : '')); } catch { /* cosmetic */ }
      if (getComputedStyle($('side')).position !== 'sticky') $('halo-h').scrollIntoView({ block: 'start' }); else $('side').scrollTop = 0;
      poll(); return;
    }
    S.runId = runId; S.artifacts = []; S.snapSig = null; S.seenAt = Date.now(); S.projector = J.createProjector({ mode: 'LIVE', connection: 'connected', staleMs: Math.max(POLL * 6, 5000), seenAt: S.seenAt });
    S.marks = loadMarks('v2:' + runId);
    poll();
  }
  async function pollUniversal() {
    try {
      // Incremental, cursor-based pull of the server's stable per-work sequence; overlap is de-duplicated.
      // Events first, then the run view, so the status that gates buttons is never older than the events.
      const last = await L.pull(async (after, limit) => {
        const w = await api('/api/v2/universal/runs/' + encodeURIComponent(S.runId) + '/workbench?after=' + after + '&limit=' + limit);
        if (!w.ok) throw Object.assign(new Error('workbench'), { r: w });
        return w.json;
      }, S.projector, S.wb);
      const r = await api('/api/v2/universal/runs/' + encodeURIComponent(S.runId));
      if (!r.ok) throw Object.assign(new Error('run'), { r });
      S.run = r.json.run; S.runStatus = S.run.status; S.unknownRunCost = !!(S.run.cost && S.run.cost.unknown);
      S.artifacts = (last.artifacts || []).map(C.validateArtifact).filter(x => x.ok).map(x => x.artifact);
      S.projector.setConnection('connected'); S.failures = 0;
      await loadSavedCriteria();
    } catch (e) {
      if (e && e.r && e.r.status === 401) { S.failures = 99; say('登录已失效，请重新登录后刷新页面。', 'warn'); }
      else S.failures++;
      S.projector.setConnection('disconnected');
    }
    renderAll();
    const authKey = S.runStatus + '|' + (S.run && S.run.round) + '|' + JSON.stringify(S.projector.state().cost_by_role);
    if (S.plan && authKey !== S.authStatus) { S.authStatus = authKey; renderAuth(); }
    const active = S.run && S.run.executionActive;
    if (S.failures === 99) return;
    if (active || S.failures || ['running', 'queued'].includes(S.runStatus)) S.timer = setTimeout(poll, S.failures ? Math.min(POLL * 2 ** S.failures, 10000) : POLL);
  }
  async function loadSavedCriteria() {
    const a = L.savedCriteria(S.run);
    if (!a || a.artifactId === S.critSavedId) { if (!a) { S.critSaved = null; S.critSavedId = null; } return; }
    const r = await fetch('/api/v2/runs/' + encodeURIComponent(S.runId) + '/artifacts/' + encodeURIComponent(a.artifactId) + '/download', { credentials: 'same-origin' });
    if (!r.ok) return;
    let data = null; try { data = await r.json(); } catch { data = null; }
    if (!data || !Array.isArray(data.checks)) return;
    S.critSavedId = a.artifactId; S.critSaved = { round: data.round, checks: data.checks };
    S.crit = Object.fromEntries(data.checks.map(c => [c.criterionId, { status: c.status, note: c.note || '' }]));
  }
  async function poll() {
    if (!S.runId) return;
    if (r53()) return pollUniversal();
    try {
      const r = await api('/api/v2/runs/' + encodeURIComponent(S.runId));
      if (!r.ok) throw new Error(serverError(r));
      const v = C.fromV2Run(r.json.run);
      if (!v.ok) throw new Error(v.error);
      // A V2 run view is a complete server snapshot: rebuild the projection from it every time
      // (incremental de-dup/ordering is for append-only R53 streams). "Delay" = snapshot unchanged.
      const sig = v.events.map(e => e.event_id).join(',');
      if (sig !== S.snapSig) { S.snapSig = sig; S.seenAt = Date.now(); }
      S.projector = J.createProjector({ mode: 'LIVE', connection: 'connected', staleMs: Math.max(POLL * 6, 5000), seenAt: S.seenAt });
      S.failures = 0;
      S.projector.ingest(v.events); S.artifacts = v.artifacts; S.runStatus = v.status; S.unknownRunCost = v.unknownRunCost;
    } catch { S.failures++; S.projector.setConnection('disconnected'); }
    renderAll();
    if (S.plan && S.runStatus !== S.authStatus) { S.authStatus = S.runStatus; renderAuth(); }
    const settled = ['approved', 'cancelled', 'failed', 'review_required', 'interrupted'].includes(S.runStatus);
    if (!settled || S.failures) S.timer = setTimeout(poll, S.failures ? Math.min(POLL * 2 ** S.failures, 10000) : POLL);
  }
  function demo() {
    if (!S.plan) { say('先生成团队，再看演示', 'warn'); return; }
    stopFeeds(); S.runId = null; S.artifacts = [];
    S.projector = J.createProjector({ mode: 'DEMO', connection: 'none', staleMs: 1e9 });
    const evs = D.demoEvents(S.plan, Date.now());
    let i = 0;
    S.projector.setMode('DEMO');
    renderAll();
    S.demoTimer = setInterval(() => { if (i >= evs.length) { clearInterval(S.demoTimer); return; } S.projector.ingest([evs[i++]]); renderAll(); }, Math.max(150, Math.min(900, Number(qs.get('demo')) || 700)));
  }
  async function importEvents(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch { say('事件文件不是有效的 JSON', 'warn'); return; }
    const events = Array.isArray(data) ? data : data && Array.isArray(data.events) ? data.events : null;
    if (!events) { say('事件文件需要 events 列表', 'warn'); return; }
    stopFeeds(); S.runId = null;
    S.projector = J.createProjector({ mode: 'REPLAY', connection: 'none', staleMs: 1e12 });
    const res = S.projector.ingest(events.slice(0, 5000));
    S.artifacts = (data && Array.isArray(data.artifacts) ? data.artifacts : []).map(C.validateArtifact).filter(x => x.ok).map(x => x.artifact);
    S.marks = loadMarks(S.projector.workId || 'import');
    say('已导入 ' + res.applied + ' 条事件（重复 ' + res.duplicates + '、冲突 ' + res.conflicts + '、拒绝 ' + res.rejected + '、待补 ' + res.buffered + '）', res.rejected || res.conflicts ? 'warn' : 'ok');
    renderAll();
  }
  function renderHalo(st) {
    const roles = S.plan ? S.plan.roles : [];
    const key = JSON.stringify([st.mode, st.phase, st.busy, st.stale, st.connection, st.gaps, Object.values(st.roles).map(r => [r.role_id, r.state, r.since_event_id]), st.edges.length, roles.map(r => r.role_id + r.name), S.staticHalo]);
    if (key === S.lastHalo) return;
    S.lastHalo = key;
    H.render($('halo'), roles, st, { static: S.staticHalo });
    const d = H.describe(roles, st);
    $('halo-head').textContent = d.head;
    $('halo-list').replaceChildren(...d.rows.map(r => node('li', { 'data-haloitem': r.id, 'data-state': r.state, text: r.name + '：' + r.text + (r.source_event_id ? '（来源事件 ' + r.source_event_id + '）' : '（没有事件）') + (r.inPlan ? '' : '（不在当前方案中）') })));
    const banners = [];
    if (st.mode === 'DEMO') banners.push(node('div', { class: 'banner', id: 'demo-banner', text: 'DEMO 演示：这些是根据你的方案生成的演示事件，不是真实工作，不产生费用和成果。' }));
    if (st.connection === 'disconnected') banners.push(node('div', { class: 'banner bad', id: 'disconnected-banner', text: '与服务器的连接中断：显示的是最后一次收到的状态，不代表 AI 仍在工作。正在重连…' }));
    else if (st.stale) banners.push(node('div', { class: 'banner', id: 'stale-banner', text: '长时间没有收到新事件：状态可能已延迟，光环已停止动画。' }));
    if (st.gaps.length) banners.push(node('div', { class: 'banner', id: 'gap-banner', text: '缺少事件 #' + st.gaps.map(g => g.from + (g.to > g.from ? '–' + g.to : '')).join(', ') + '：之后的 ' + st.buffered + ' 条事件暂不显示，等补齐后再按顺序更新。' }));
    if (st.mode === 'IDLE') banners.push(node('div', { class: 'banner', id: 'idle-banner', text: 'IDLE：还没有任何真实工作事件，所以光环不会显示忙碌。' }));
    $('halo-banner').replaceChildren(...banners);
    $('halo-static').setAttribute('aria-pressed', String(S.staticHalo)); $('halo-static').textContent = S.staticHalo ? '恢复动画' : '静态显示';
    $('event-log').replaceChildren(...st.log.slice(-300).map(e => node('tr', { 'data-event': e.event_id, 'data-retracted': e.retracted ? 'true' : null, 'data-causality': e.causality }, [
      node('td', { text: String(e.seq) }), node('td', { text: (C.TYPES[e.type] ? C.TYPES[e.type].label : '未识别：' + e.type) + (e.retracted ? '（已撤回）' : '') + (e.detail ? ' · ' + e.detail : '') }),
      node('td', { text: e.role_id || '—' }), node('td', { text: e.event_id + ' · ' + e.source + ' · ' + e.evidence }),
      node('td', { text: (e.parent_event_id || '—') + (e.causality !== 'ok' ? ' ⚠ ' + ({ missing_parent: '父事件缺失', parent_after_child: '父事件在后' }[e.causality]) : '') })])));
    $('event-issues').textContent = st.issues.length ? '问题：' + st.issues.slice(-10).map(i => i.kind + (i.event_id ? '@' + i.event_id : '') + (i.detail ? '（' + i.detail + '）' : '')).join('；') : '';
  }
  function renderCost(st) {
    const c = st.cost, kids = [];
    if (st.mode === 'DEMO') kids.push(node('p', { class: 'sub', text: '演示不会产生费用，也没有费用记录。' }));
    else if (!c.entries && !S.unknownRunCost) kids.push(node('p', { class: 'sub', id: 'cost-none', text: S.runId ? '还没有费用记录。' : '尚未运行，没有费用。' }));
    else {
      const unknown = c.total_usd === null || S.unknownRunCost;
      kids.push(node('p', { id: 'cost-total', 'data-total': unknown ? 'unknown' : String(c.total_usd) }, [node('span', { text: '合计：' }), node('b', { text: unknown ? '未知（不是 0）' : '$' + c.total_usd.toFixed(4) })]));
      kids.push(node('ul', { class: 'sub' }, [node('li', { text: '已结算：$' + c.known_usd.toFixed(4) + '（本地/免费连接记 0，不是厂商账单）' }),
        c.upper_bound_usd ? node('li', { text: '按上限保守计入（实际用量未知）：$' + c.upper_bound_usd.toFixed(4) }) : null,
        c.reserved_usd ? node('li', { text: '预留中：$' + c.reserved_usd.toFixed(4) }) : null,
        c.unknown_count ? node('li', { text: c.unknown_count + ' 笔费用未知；平台不会把它们当作 0' }) : null,
        S.unknownRunCost ? node('li', { text: '运行中断或预留未结算：费用需人工核对' }) : null].filter(Boolean)));
    }
    $('cost').replaceChildren(...kids);
  }
  function renderOutputsR53(st) {
    const run = S.run, v = A.view({ plan: S.plan, projection: st, artifacts: S.artifacts, marks: {} });
    $('r53-out').hidden = false; $('review-box').hidden = true; $('marks-note').hidden = true; $('checks').hidden = true;
    const meta = new Map((run && run.artifacts || []).map(a => [a.artifactId, a]));
    const files = v.files.filter(f => { const m = meta.get(f.artifact_id); return m && ['universal_delivery', 'human_criteria'].includes(m.producer); });
    $('files').replaceChildren(...(files.length ? files.map(f => { const m = meta.get(f.artifact_id), current = run && m.round === run.round;
      return node('li', { 'data-file': f.artifact_id, 'data-mock': 'false', 'data-round': String(m.round), 'data-current': String(current), 'data-producer': m.producer }, [
        node('span', {}, [node('strong', { text: f.filename }), node('span', { class: 'sub', text: ' · 第 ' + m.round + ' 轮' + (current ? '（当前）' : '（旧轮次，不能验收）') + ' · ' + f.kind + (f.bytes != null ? ' · ' + f.bytes + ' 字节' : '') + (f.sha256 ? ' · sha256 ' + f.sha256.slice(0, 12) + '…' : '') })]),
        node('span', { class: 'badge ' + (m.producer === 'human_criteria' ? 'info' : 'good'), text: m.producer === 'human_criteria' ? '你的逐项检查记录' : '服务器生成的交付文件 · 专业质量未验证' }),
        node('a', { href: f.download_url, download: f.filename, 'data-download': f.artifact_id, text: '下载' })]); })
      : [node('li', { class: 'sub', text: '还没有交付文件。任务交付后，点“生成 Word/Excel/演示交付”由服务器从实际产出生成文件。没有文件时不会显示“已完成”。' })]));
    const accepted = run && run.status === 'approved';
    const cur = run ? L.deliveries(run, S.artifacts).filter(a => a.current) : [];
    let status = v.status, headline = v.headline;
    if (accepted && st.phase !== 'accepted') { status = 'accepted_pending_event'; headline = '服务器显示已验收，正在同步事件…'; }
    $('out-headline').textContent = headline; $('out-headline').dataset.status = status;
    if (!run) { $('round-info').textContent = '还没有运行。'; $('reviews').replaceChildren(); }
    else {
      $('round-info').textContent = '第 ' + run.round + ' 轮｜状态：' + run.status + (run.executionActive ? '（进行中）' : '') + '｜证据：' + (run.evidence || 'E3') + '｜专业质量：未验证（NOT_VERIFIED）｜厂商账单：' + (run.cost && run.cost.usd === null ? '未知' : '$' + run.cost.usd) + (run.cost && Number.isFinite(run.cost.estimatedUpperBound) ? '｜本地估算上界 $' + run.cost.estimatedUpperBound : '');
      $('reviews').replaceChildren(...(run.reviews || []).map(rv => node('li', { 'data-review-round': String(rv.round), 'data-decision': rv.decision }, [node('span', { text: '第 ' + rv.round + ' 轮 · ' + (rv.decision === 'approve' ? '验收通过' : '返工') + '：' + (rv.feedback || '') +
        (rv.acceptance ? '｜文件 ' + String(rv.acceptance.sha256 || '').slice(0, 12) + '…｜人工审查：' + (rv.acceptance.expertVerification || '—') + '｜专业质量：' + (rv.acceptance.professionalQuality || 'NOT_VERIFIED') : '') })])));
    }
    const settledReview = run && run.status === 'review_required' && !run.executionActive;
    for (const f of ['docx', 'xlsx', 'pptx']) $('deliver-' + f).disabled = !settledReview;
    $('cancel-run').disabled = !(run && (run.executionActive || ['running', 'queued', 'review_required'].includes(run.status)));
    const standards = run && run.projectSnapshot ? run.projectSnapshot.standards : [];
    $('r53-checks').replaceChildren(...standards.map((t, i) => { const id = 'criterion-' + (i + 1), c = S.crit[id] || { status: 'unverified', note: '' };
      return node('li', { 'data-crit': id, 'data-crit-status': c.status }, [node('span', { text: t + ' ' }),
        node('select', { 'data-crit-status-for': id, 'aria-label': '检查结果：' + t, disabled: !settledReview }, [['unverified', '未核实'], ['passed', '通过'], ['failed', '不通过']].map(([v2, l]) => node('option', { value: v2, selected: c.status === v2, text: l }))),
        node('input', { type: 'text', 'data-crit-note-for': id, value: c.note || '', maxlength: 2000, placeholder: '说明（可选）', 'aria-label': '检查说明：' + t, disabled: !settledReview })]); }));
    const saved = S.critSaved;
    const dirty = saved ? JSON.stringify(Object.fromEntries(saved.checks.map(c => [c.criterionId, { status: c.status, note: c.note || '' }]))) !== JSON.stringify(Object.fromEntries(standards.map((_, i) => ['criterion-' + (i + 1), S.crit['criterion-' + (i + 1)] || { status: 'unverified', note: '' }]))) : Object.keys(S.crit).length > 0;
    $('criteria-saved').textContent = saved ? '服务器已保存第 ' + saved.round + ' 轮的检查结果' + (dirty ? '；你有未保存的修改' : '') : (dirty ? '尚未保存到服务器' : '服务器上还没有逐项检查记录（验收时将以你的批量确认代替）');
    $('criteria-saved').dataset.dirty = String(dirty);
    $('save-criteria').disabled = !settledReview;
    const prevFile = $('accept-file').value;
    $('accept-file').replaceChildren(...(cur.length ? cur.map(a => node('option', { value: a.artifact_id, selected: a.artifact_id === prevFile, text: a.filename + ' · 第 ' + a.round + ' 轮 · sha256 ' + a.sha256.slice(0, 12) + '…' })) : [node('option', { value: '', text: '当前轮次还没有交付文件' })]));
    $('ack-cost-box').hidden = !(run && run.cost && run.cost.unknown);
    $('expert-box').hidden = !(run && run.projectSnapshot && run.projectSnapshot.planning && run.projectSnapshot.planning.expertReviewRequired);
    $('accept-r53').disabled = !(settledReview && cur.length);
    const prevFrom = $('rework-from').value;
    $('rework-from').replaceChildren(node('option', { value: '', text: '整轮重做（从第一步开始）' }), ...((run && run.projectSnapshot ? run.projectSnapshot.steps : []).map((x, i) => node('option', { value: x.stepId, selected: x.stepId === prevFrom, text: '从第 ' + (i + 1) + ' 步“' + x.title + '”开始' }))));
    $('rework-r53').disabled = !settledReview;
    $('accept').dataset.status = status;
  }
  function renderOutputs(st) {
    if (r53()) return renderOutputsR53(st);
    $('r53-out').hidden = true; $('review-box').hidden = false; $('marks-note').hidden = false; $('checks').hidden = false;
    const v = A.view({ plan: S.plan, projection: st, artifacts: S.artifacts, marks: S.marks });
    $('out-headline').textContent = v.headline; $('out-headline').dataset.status = v.status;
    $('files').replaceChildren(...(v.files.length ? v.files.map(f => node('li', { 'data-file': f.artifact_id, 'data-mock': String(f.mock) }, [
      node('span', {}, [node('strong', { text: f.filename }), node('span', { class: 'sub', text: ' · ' + f.kind + (f.bytes != null ? ' · ' + f.bytes + ' 字节' : '') + (f.sha256 ? ' · sha256 ' + f.sha256.slice(0, 12) + '…' : '') })]),
      node('span', { class: 'badge ' + (f.mock ? 'sim' : 'good'), text: f.label }),
      f.downloadable ? node('a', { href: f.download_url, download: f.filename, 'data-download': f.artifact_id, text: '下载' }) : node('span', { class: 'sub', text: '不可下载' })])) : [node('li', { class: 'sub', text: '还没有成果文件。没有文件时不会显示“已完成”。' })]));
    $('marks-note').textContent = v.marks_note;
    $('checks').replaceChildren(...v.checks.map(c => node('li', { 'data-checkmark': c.id }, [node('span', { text: c.text + ' ' }),
      node('select', { 'data-mark': c.id, 'aria-label': '人工检查结果：' + c.text }, A.MARKS.map(m => node('option', { value: m, selected: c.mark === m, text: { unverified: '人工未验', verified: '人工已验', failed: '不合格' }[m] })))])));
    const live = !!S.runId;
    $('accept').disabled = !(live && v.can_accept); $('rework').disabled = !(live && v.can_rework);
    for (const f of ['docx', 'xlsx', 'pptx']) $('export-' + f).disabled = !(live && ['review_required', 'approved'].includes(S.runStatus));
    const picked = new Set([...document.querySelectorAll('[data-rework-step]')].filter(x => x.checked).map(x => x.dataset.reworkStep));
    $('rework-steps').replaceChildren(...(S.plan ? S.plan.steps.map(s => node('label', { class: 'badge' }, [node('input', { type: 'checkbox', 'data-rework-step': s.step_id, checked: picked.has(s.step_id) }), node('span', { text: ' ' + s.title })])) : []));
    $('accept').dataset.status = v.status;
  }
  function renderAll() {
    const st = S.projector.state();
    $('mode-badge').textContent = st.mode + (st.evidence.length ? ' · ' + st.evidence.join('/') : '');
    $('mode-badge').className = 'badge ' + (st.mode === 'DEMO' ? 'sim' : st.mode === 'IDLE' ? 'info' : 'good');
    renderHalo(st);
    const ck = JSON.stringify([st.mode, st.cost, S.unknownRunCost, !!S.runId]);
    if (ck !== S.lastCost) { S.lastCost = ck; renderCost(st); }
    const ok = JSON.stringify([st.phase, st.mode, S.artifacts, S.marks, S.runStatus, !!S.runId, S.plan && S.plan.steps.map(x => x.step_id + x.title), S.plan && S.plan.acceptance, S.contract,
      S.run && [S.run.status, S.run.round, S.run.executionActive, (S.run.reviews || []).length, (S.run.artifacts || []).length, S.run.cost], S.crit, S.critSavedId]);
    if (ok !== S.lastOut) { S.lastOut = ok; renderOutputs(st); }
  }
  function loadMarks(key) { try { return JSON.parse(localStorage.getItem('r52-marks:' + key) || '{}') || {}; } catch { return {}; } }
  function saveMarks() { try { localStorage.setItem('r52-marks:' + (S.runId ? 'v2:' + S.runId : S.projector.workId || 'import'), JSON.stringify(S.marks)); } catch { /* per-viewer convenience only */ } }

  async function review(decision) {
    if (!S.runId) return;
    let body;
    if (decision === 'approve') body = { decision, feedback: '用户在 R52 工作台验收通过' };
    else {
      const steps = [...document.querySelectorAll('[data-rework-step]')].filter(x => x.checked).map(x => x.dataset.reworkStep);
      const fb = A.reworkFeedback(S.plan, steps, $('rework-note').value);
      if (!fb.ok) { say(fb.reason, 'warn'); return; }
      const rr = E.runRequest(S.plan, S.toolIdMap);
      if (!rr.ok) { say('返工是一次新的授权：' + rr.reason, 'warn'); return; }
      body = { decision, feedback: fb.feedback, ...rr.body };
      say(fb.note, 'info');
    }
    const r = await api('/api/v2/runs/' + encodeURIComponent(S.runId) + '/review', 'POST', body);
    if (!r.ok) { say('服务器拒绝：' + serverError(r), 'warn'); return; }
    S.runStatus = r.json.run.status;
    say(decision === 'approve' ? '已验收，记录已写入服务器' : '已提交返工，这是一次新的授权', 'ok');
    clearTimeout(S.timer); poll();
  }
  async function exportFile(format) {
    if (!S.runId) return;
    const res = await fetch('/api/v2/runs/' + encodeURIComponent(S.runId) + '/export', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format }) });
    if (!res.ok) { let j = null; try { j = await res.json(); } catch { j = null; } say('导出失败：' + serverError({ status: res.status, json: j }), 'warn'); return; }
    say('已由服务器生成 ' + format.toUpperCase() + ' 文件，可在下方下载', 'ok');
    clearTimeout(S.timer); poll();
  }

  async function r53Action(path, body, what, okText) {
    if (!S.runId) return null;
    let r;
    try { r = await api('/api/v2/universal/runs/' + encodeURIComponent(S.runId) + path, 'POST', body); }
    catch { say('网络中断：不确定服务器是否收到。再次点击会用同一个请求编号，服务器不会重复执行。', 'warn'); return null; }
    if (!r.ok) { refused(r, what); return null; }
    if (r.json && (r.json.run && r.json.run.duplicate || r.json.artifact && r.json.artifact.duplicate)) say('重复请求：服务器没有重复执行，显示原有结果。', 'info'); else say(okText, 'ok');
    clearTimeout(S.timer); await poll();
    return r.json;
  }
  const deliver = f => r53Action('/deliver', { requestId: S.ids('deliver', { run: S.runId, round: S.run && S.run.round, f }), format: f }, '生成交付文件失败', '服务器已从实际产出生成 ' + f.toUpperCase() + ' 文件（标记为未经专业验证）。');
  function saveCriteria() {
    if (!S.run) return;
    const body = L.criteriaBody(S.run, S.crit, S.ids('criteria', { run: S.runId, round: S.run.round, c: S.crit }));
    return r53Action('/criteria', body, '保存检查结果失败', '逐项检查已保存到服务器（第 ' + S.run.round + ' 轮）。');
  }
  function acceptR53() {
    const id = $('accept-file').value, a = L.deliveries(S.run, S.artifacts).find(x => x.artifact_id === id && x.current);
    if (!a) { say('请选择当前轮次的交付文件', 'warn'); return; }
    return r53Action('/accept', L.acceptBody(a, { confirmCriteria: $('ack-criteria').checked, acknowledgeSimulation: $('ack-sim').checked, acknowledgeUnknownCost: $('ack-cost').checked, expertReviewNote: $('expert-note').value }),
      '服务器拒绝验收', '已验收：服务器记录了你对当前轮次文件的确认（专业质量仍为未验证）。');
  }
  function reworkR53() {
    if (!S.plan) return;
    const rr = E.runRequest(S.plan, S.toolIdMap);
    if (!rr.ok) { say('返工是一次新的授权，请先在“授权与预算”里重新批准各岗位并确认：' + rr.reason, 'warn'); return; }
    const from = $('rework-from').value || null, fb = $('rework-note-r53').value;
    const b = L.reworkBody(S.plan, { requestId: S.ids('rework', { run: S.runId, round: S.run && S.run.round, from, fb }), feedback: fb, fromStepId: from });
    if (!b.ok) { say(b.reason, 'warn'); return; }
    return r53Action('/rework', b.body, '服务器拒绝返工', from ? '已从所选步骤开始返工（之前步骤复用已有成果）。' : '已开始整轮返工。');
  }
  const cancelR53 = () => r53Action('/cancel', {}, '取消失败', '已请求取消。已发生的费用仍以账本为准。');
  /* ---------------- wiring ---------------- */
  $('make-team').addEventListener('click', () => { makeTeam().catch(e => say('生成失败：' + e.message, 'warn')); });
  $('goal').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('make-team').click(); });
  for (const id of ['roles', 'steps', 'acceptance']) { $(id).addEventListener('click', onPlanEvent); $(id).addEventListener('change', onPlanEvent); }
  $('clarify').addEventListener('click', e => { const id = e.target.dataset && e.target.dataset.goto; if (!id) return; $('more').open = true; $(id).focus(); });
  $('add-role').addEventListener('click', () => { if (edit({ op: 'addRole', name: $('new-role-name').value, duty: $('new-role-duty').value || undefined })) { $('new-role-name').value = ''; $('new-role-duty').value = ''; say('已添加岗位', 'ok'); } });
  $('add-check').addEventListener('click', () => { if (edit({ op: 'editAcceptance', add: $('new-check').value })) $('new-check').value = ''; });
  $('auth-card').addEventListener('change', onAuthChange);
  $('save-project').addEventListener('click', () => { saveProject().catch(e => say(e.message, 'warn')); });
  $('start-run').addEventListener('click', () => { startRun().catch(e => say(e.message, 'warn')); });
  $('halo-static').addEventListener('click', () => { S.staticHalo = !S.staticHalo; renderAll(); });
  $('demo').addEventListener('click', demo);
  $('import-events').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; if (f) importEvents(f); e.target.value = ''; });
  $('checks').addEventListener('change', e => { const id = e.target.dataset.mark; if (!id) return; S.marks[id] = e.target.value; saveMarks(); renderAll(); });
  $('accept').addEventListener('click', () => review('approve'));
  $('rework').addEventListener('click', () => review('rework'));
  for (const f of ['docx', 'xlsx', 'pptx']) $('export-' + f).addEventListener('click', () => exportFile(f));
  for (const f of ['docx', 'xlsx', 'pptx']) $('deliver-' + f).addEventListener('click', () => deliver(f));
  $('save-criteria').addEventListener('click', () => saveCriteria());
  $('accept-r53').addEventListener('click', () => acceptR53());
  $('rework-r53').addEventListener('click', () => reworkR53());
  $('cancel-run').addEventListener('click', () => cancelR53());
  $('r53-checks').addEventListener('change', e => {
    const id = e.target.dataset.critStatusFor || e.target.dataset.critNoteFor; if (!id) return;
    const c = { ...(S.crit[id] || { status: 'unverified', note: '' }) };
    if (e.target.dataset.critStatusFor) c.status = e.target.value; else c.note = e.target.value;
    S.crit = { ...S.crit, [id]: c }; renderAll();
  });
  setInterval(() => renderAll(), 1000); // staleness only; never advances state
  detect().then(async () => {
    renderAll();
    const run = qs.get('run');
    if (!(run && /^[\w-]{1,80}$/.test(run) && S.backend)) return;
    // Refresh / reconnect: rebuild everything from the server (plan snapshot, events, files, criteria).
    const r = await api('/api/v2/universal/runs/' + encodeURIComponent(run)).catch(() => null);
    if (r && r.ok && r.json && r.json.run) {
      S.contract = 'r53';
      if (!S.plan) { S.plan = L.planFromSnapshot(r.json.run); if (S.plan) { renderPlan(); renderAuth(); $('plan-card').hidden = false; $('auth-card').hidden = false; } }
      say('已从服务器恢复任务 ' + run + '（第 ' + r.json.run.round + ' 轮）。', 'ok');
    } else S.contract = 'v2';
    follow(run);
  });
  window.__r52 = { state: () => S.projector.state(), plan: () => S.plan, contract: () => S.contract, run: () => S.run };
})();
