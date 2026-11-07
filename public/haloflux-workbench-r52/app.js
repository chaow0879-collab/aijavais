/* AIJAVAIS R52 workbench controller. Talks only to EXISTING read/write product APIs that the
 * backend already guards (models list, intake plan, project save, run start/review/export, run
 * view). It never decides execution: start/review/rework requests are proposals the server
 * accepts or refuses, and the refusal is shown verbatim. All user/AI text goes in via textContent. */
(function () {
  'use strict';
  const C = window.R52Contract, P = window.R52Planner, E = window.R52Editor, J = window.R52Projector, A = window.R52Acceptance, H = window.R52Halo, D = window.R52Demo;
  const $ = id => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  const POLL = Math.max(100, Math.min(5000, Number(qs.get('poll')) || 800));
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const S = { backend: false, models: [], tools: null, toolIdMap: {}, plan: null, projector: J.createProjector({}), artifacts: [], runId: null, runStatus: null, projectId: null,
    savedDigest: null, marks: {}, staticHalo: reduce, timer: null, demoTimer: null, lastHalo: '', unknownRunCost: false, failures: 0 };

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
    S.tools = null; S.toolIdMap = {};
    if (S.backend) {
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
      $('plan-summary').textContent = '目标：' + p.goal + (p.domain ? '｜领域：' + p.domain : '｜领域待你确认') + '｜风险：' + ({ low: '低', medium: '中', high: '高' }[p.risk] || p.risk) + '｜' + p.roles.length + ' 个岗位、' + p.steps.length + ' 个步骤';
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
      removeTool: () => ({ op: 'removeTool', step_id: d.step, tool_id: d.tool }), removeCheck: () => ({ op: 'editAcceptance', remove: d.id })
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
  async function startRun() {
    if (S.starting) return;
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
    S.runId = runId; S.artifacts = []; S.snapSig = null; S.seenAt = Date.now(); S.projector = J.createProjector({ mode: 'LIVE', connection: 'connected', staleMs: Math.max(POLL * 6, 5000), seenAt: S.seenAt });
    S.marks = loadMarks('v2:' + runId);
    poll();
  }
  async function poll() {
    if (!S.runId) return;
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
  function renderOutputs(st) {
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
    const ok = JSON.stringify([st.phase, st.mode, S.artifacts, S.marks, S.runStatus, !!S.runId, S.plan && S.plan.steps.map(x => x.step_id + x.title), S.plan && S.plan.acceptance]);
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
  setInterval(() => renderAll(), 1000); // staleness only; never advances state
  detect().then(() => { renderAll(); const run = qs.get('run'); if (run && /^[\w-]{1,80}$/.test(run) && S.backend) follow(run); });
  window.__r52 = { state: () => S.projector.state(), plan: () => S.plan };
})();
