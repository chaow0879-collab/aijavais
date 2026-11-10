'use strict';
/* B7e/B7g 简单模式（默认）：用户只填 做什么 / 要什么成果 / 预算，一键智能配置并开始，直接进入执行进度。
 * 规则见 public/smart-plan.js；服务端的预算、就绪与审批门禁不变。选择预算档位 = 对本次运行的显式批准，
 * 每次点击都重新提交，不从上一次继承。页面上只显示中文，不显示原始 JSON 或技术字段。 */
(() => {
  const $ = id => document.getElementById(id);
  const S = { models: [], picks: {}, plan: null, runId: null, timer: null, format: 'md', outputLabel: '文字', busy: false };
  const OUT = window.SmartPlan.OUTPUTS, STATUS = { pending: '等待中', running: '进行中', done: '已完成', quality_failed: '质量检查没通过', failed: '失败', cancelled: '已取消', skipped: '已跳过' };
  const DL = { md: '下载文字稿', docx: '下载 Word 文档', xlsx: '下载 Excel 表格', pptx: '下载演示文稿' };
  const el = (tag, props = {}, kids = []) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n[k] = v; } n.append(...kids); return n; };
  async function api(path, method = 'GET', body) {
    const res = await fetch(path, { method, credentials: 'same-origin', headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { location.assign('/login.html?next=/workspace.html'); throw Error('请重新登录'); }
    if (!res.ok) throw Object.assign(Error(data.error || '请求失败'), { code: data.code, status: res.status });
    return data;
  }
  const budget = () => { const v = document.querySelector('input[name=s-budget]:checked')?.value; return v === 'custom' ? Number($('s-budget-custom').value) : Number(v); };
  const output = () => document.querySelector('input[name=s-output]:checked')?.value || 'text';
  function build() {
    $('s-output').replaceChildren(...Object.entries(OUT).map(([k, o], i) => el('label', {}, [el('input', { type: 'radio', name: 's-output', value: k, checked: i === 1 }), o.label])));
    const tiers = window.SmartPlan.BUDGETS.map((b, i) => el('label', {}, [el('input', { type: 'radio', name: 's-budget', value: String(b), checked: i === 1 }), '¥' + b]));
    tiers.push(el('label', {}, [el('input', { type: 'radio', name: 's-budget', value: 'custom' }), '自定义 ¥', el('input', { id: 's-budget-custom', type: 'number', min: '0.1', step: '0.1', value: '10', style: 'width:80px', ariaLabel: '自定义预算（元）' })]));
    $('s-budget').replaceChildren(...tiers);
    for (const id of ['s-output', 's-budget', 's-goal']) $(id).addEventListener('input', () => { S.picks = {}; preview(false); });
  }
  async function loadModels() { S.models = (await api('/api/models')).models || []; $('ws-guide').hidden = window.SmartPlan.usable(S.models).length > 0; }
  function showError(box, info, retry) {
    box.replaceChildren(el('div', { text: info.text }));
    const fix = info.fix;
    if (fix && (fix.action === 'add_model' || fix.action === 'fix_model')) box.append(el('a', { className: 'fixbtn', href: '/admin.html', text: fix.label }));
    else if (fix && fix.action === 'set_budget') box.append(el('button', { type: 'button', className: 'fixbtn', text: fix.label, onclick: () => { setBudget(fix.budgetCny); box.hidden = true; retry && retry(); } }));
    else if (fix && retry) box.append(el('button', { type: 'button', className: 'fixbtn', text: fix.label, onclick: () => { box.hidden = true; retry(); } }));
    if (info.detail) box.append(el('details', {}, [el('summary', { text: '给管理员看的详细信息' }), el('div', { text: info.detail })]));
    box.hidden = false; box.scrollIntoView({ block: 'center' });
  }
  function setBudget(cny) {
    const r = document.querySelector(`input[name=s-budget][value="${cny}"]`);
    if (r) r.checked = true; else { document.querySelector('input[name=s-budget][value=custom]').checked = true; $('s-budget-custom').value = String(cny); }
    preview(false);
  }
  function estimateText(p) {
    if (!p || !p.ok) return '';
    const e = p.estimate;
    if (e.free) return '所选模型在本机运行，不产生费用。';
    return `最多花 ¥${e.cny}。预计约 ${e.calls} 次对话、约 ${e.chars} 字。` + (e.unknownPrice ? '模型价格未知，按保守单价估算、到上限就停，不会超支。' : '');
  }
  function renderSwap(p) {
    const box = $('s-swap'); box.replaceChildren();
    for (const r of p.roles) if (r.candidates.length > 1) box.append(el('button', { type: 'button', className: 'small', text: '换一个' + r.spec.name, onclick: () => {
      const i = r.candidates.indexOf(r.model.connectionId); S.picks[r.spec.roleId] = r.candidates[(i + 1) % r.candidates.length]; preview(true);
    } }));
  }
  function preview(show) {
    S.plan = window.SmartPlan.plan({ models: S.models, goal: $('s-goal').value, output: output(), budgetCny: budget(), picks: S.picks });
    $('s-estimate').textContent = estimateText(S.plan);
    if (show || !$('s-plan').hidden) {
      $('s-plan').hidden = !S.plan.roles.length;
      $('s-plan-team').textContent = S.plan.summary ? '智能分配：' + S.plan.summary : '';
      if (S.plan.roles.length) renderSwap(S.plan);
    }
    return S.plan;
  }
  async function go() {
    if (S.busy) return;
    $('s-error').hidden = true;
    await loadModels();
    const p = preview(false);
    if (!p.ok) return showError($('s-error'), p.problems[0], go);
    S.busy = true; $('s-go').disabled = true;
    try {
      $('s-busy').textContent = '正在创建任务…';
      const project = (await api('/api/v2/projects', 'POST', p.project)).project;
      // 开始前确认要用的模型能连通（真实调用一次、最多 32 个输出字，费用极少）；已通过测试的不再重复
      for (const r of p.roles) {
        const m = S.models.find(x => x.connectionId === r.model.connectionId);
        if (m && m.status === 'available') continue;
        $('s-busy').textContent = '正在检查「' + window.ModelHints.platformLabel(r.model) + '」能否连接…';
        const t = await api('/api/providers/' + encodeURIComponent(r.model.connectionId) + '/test', 'POST', { approvePaid: true });
        if (!t.ok) throw Object.assign(Error(t.error || ''), { code: 'model_unverified', modelName: window.ModelHints.platformLabel(r.model) });
        if (m) m.status = 'available';
      }
      $('s-busy').textContent = '正在开始执行…';
      const run = (await api('/api/v2/projects/' + encodeURIComponent(project.projectId) + '/runs', 'POST', p.approval)).run;
      S.runId = run.runId; S.projectId = project.projectId; S.format = p.format; S.outputLabel = p.outputLabel;
      showProgress(p);
    } catch (e) {
      showError($('s-error'), window.SmartPlan.explain(e, { modelName: e.modelName }), go);
    } finally { S.busy = false; $('s-go').disabled = false; $('s-busy').textContent = ''; }
  }
  function showProgress(p) {
    $('simple').hidden = true; $('s-progress').hidden = false;
    $('s-team').textContent = '团队：' + p.summary;
    $('s-download').textContent = DL[S.format] || '下载成果';
    $('s-result').hidden = true; $('s-run-error').hidden = true; $('s-steps').replaceChildren();
    history.replaceState(null, '', '/workspace.html?run=' + encodeURIComponent(S.runId));
    scrollTo(0, 0);
    clearInterval(S.timer); poll(); S.timer = setInterval(poll, 2000);
  }
  async function poll() {
    let run;
    try { run = (await api('/api/v2/runs/' + encodeURIComponent(S.runId))).run; } catch { $('s-state').textContent = '暂时连不上服务器，正在重试…'; return; }
    const steps = run.steps || [];
    $('s-steps').replaceChildren(...steps.map(st => el('li', { className: st.status }, [el('strong', { text: st.title }), ' · ' + (STATUS[st.status] || '进行中')])));
    if (!steps.length) $('s-steps').replaceChildren(el('li', { className: 'running', text: '准备中…' }));
    const active = run.status === 'running' || run.executionActive;
    $('s-state').textContent = active ? '正在执行，请稍候。每一步完成后这里会自动更新。' : run.status === 'failed' ? '任务没有完成。' : run.status === 'cancelled' ? '任务已取消。' : run.status === 'approved' ? '已确认完成。' : '已完成，请查看成果。';
    if (active) return;
    clearInterval(S.timer);
    if (run.status === 'failed' || run.status === 'cancelled') {
      const bad = steps.find(st => st.status === 'failed' || st.status === 'quality_failed');
      showError($('s-run-error'), window.SmartPlan.explain({ message: bad && bad.error || '' }), () => { $('s-progress').hidden = true; $('simple').hidden = false; go(); });
      return;
    }
    const last = [...steps].reverse().find(st => typeof st.output === 'string' && st.output.trim());
    if (last) { $('s-final').textContent = last.output; $('s-result').hidden = false; }
    $('s-accept').hidden = run.status !== 'review_required';
  }
  async function download() {
    const res = await fetch('/api/v2/runs/' + encodeURIComponent(S.runId) + '/export', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format: S.format }) });
    if (!res.ok) { showError($('s-run-error'), { text: '成果文件暂时生成不了，请稍后再试。', fix: { action: 'retry', label: '再试一次' } }, download); return; }
    const blob = await res.blob(), a = el('a', { href: URL.createObjectURL(blob), download: (S.outputLabel || '成果') + '.' + S.format });
    document.body.append(a); a.click(); a.remove();
  }
  function reset() {
    clearInterval(S.timer); S.runId = null; S.picks = {};
    $('s-progress').hidden = true; $('simple').hidden = false; $('s-error').hidden = true; $('s-plan').hidden = true;
    history.replaceState(null, '', '/workspace.html');
  }
  window.AIJSimple = { reset };
  addEventListener('DOMContentLoaded', async () => {
    build();
    $('s-go').addEventListener('click', go);
    $('s-preview').addEventListener('click', async () => { $('s-error').hidden = true; await loadModels(); const p = preview(true); if (!p.ok) showError($('s-error'), p.problems[0], () => preview(true)); });
    $('s-advanced').addEventListener('click', () => { document.body.dataset.mode = 'advanced'; });
    $('s-back').addEventListener('click', () => { document.body.dataset.mode = 'simple'; });
    $('s-adjust').addEventListener('click', () => { location.assign('/workspace.html?project=' + encodeURIComponent(S.projectId || '')); });
    $('s-new').addEventListener('click', reset);
    $('s-download').addEventListener('click', download);
    $('s-accept').addEventListener('click', async () => { await api('/api/v2/runs/' + encodeURIComponent(S.runId) + '/review', 'POST', { decision: 'approve', feedback: '用户在简单模式确认成果' }); poll(); });
    const q = new URLSearchParams(location.search);
    if (q.get('project')) document.body.dataset.mode = 'advanced';
    try { await loadModels(); preview(false); } catch { /* 页面其余部分仍可用 */ }
    if (q.get('run')) { S.runId = q.get('run'); try { const run = (await api('/api/v2/runs/' + encodeURIComponent(S.runId))).run; S.projectId = run.projectId; $('simple').hidden = true; $('s-progress').hidden = false; $('s-team').textContent = ''; poll(); S.timer = setInterval(poll, 2000); } catch { reset(); } }
  });
})();
