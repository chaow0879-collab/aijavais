'use strict';
/* B7e/B7g 简单模式（默认）：用户只填 做什么 / 要什么成果 / 什么时候要（可选），一键智能配置。
 * 系统估算费用，弹一次确认框（只写人民币）；点“确认开始”就是本次运行的显式批准，每次都重新确认、不继承。
 * 规则见 public/smart-plan.js；服务端的预算、Token、审批与就绪门禁全部不变。页面只显示中文，不显示原始 JSON。 */
(() => {
  const $ = id => document.getElementById(id);
  const S = { models: [], capCny: 5, picks: {}, plan: null, runId: null, projectId: null, timer: null, format: 'docx', outputLabel: 'Word 文档', busy: false, choice: 'quality' };
  const OUT = window.SmartPlan.OUTPUTS, STATUS = { pending: '等待中', running: '进行中', done: '已完成', quality_failed: '质量检查没通过', failed: '没有完成', cancelled: '已取消', skipped: '已跳过' };
  const DL = { md: '下载文字稿', docx: '下载 Word 文档', xlsx: '下载 Excel 表格', pptx: '下载演示文稿' };
  const el = (tag, props = {}, kids = []) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n[k] = v; } n.append(...kids); return n; };
  async function api(path, method = 'GET', body) {
    const res = await fetch(path, { method, credentials: 'same-origin', headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { location.assign('/login.html?next=/workspace.html'); throw Error('请重新登录'); }
    if (!res.ok) throw Object.assign(Error(data.error || '请求失败'), { code: data.code, status: res.status });
    return data;
  }
  const output = () => document.querySelector('input[name=s-output]:checked')?.value || 'word';
  function build() {
    $('s-output').replaceChildren(...Object.entries(OUT).map(([k, o]) => el('label', {}, [el('input', { type: 'radio', name: 's-output', value: k, checked: k === 'word' }), o.label])));
    for (const id of ['s-output', 's-goal', 's-deadline']) $(id).addEventListener('input', () => { S.picks = {}; if (!$('s-plan').hidden) preview(true); });
  }
  async function loadModels() {
    const [m, c] = await Promise.all([api('/api/models'), api('/api/config').catch(() => null)]);
    S.models = m.models || [];
    if (c && c.settings && Number(c.settings.simpleRunCapCny) > 0) S.capCny = Number(c.settings.simpleRunCapCny);
    $('ws-guide').hidden = window.SmartPlan.chat(S.models).length > 0;
  }
  function showError(box, info, retry) {
    box.replaceChildren(el('div', { text: info.text }));
    const fix = info.fix;
    if (fix && (fix.action === 'add_model' || fix.action === 'fix_model')) box.append(el('a', { className: 'fixbtn', href: '/admin.html', text: fix.label }));
    else if (fix && retry) box.append(el('button', { type: 'button', className: 'fixbtn', text: fix.label, onclick: () => { box.hidden = true; retry(); } }));
    if (info.detail) box.append(el('details', {}, [el('summary', { text: '给管理员看的详细信息' }), el('div', { text: info.detail })]));
    box.hidden = false; box.scrollIntoView({ block: 'center' });
  }
  function makePlan(choice) {
    return window.SmartPlan.plan({ models: S.models, goal: $('s-goal').value, output: output(), deadline: $('s-deadline').value, capCny: S.capCny, picks: S.picks, choice: choice || S.choice });
  }
  function renderSwap(p) {
    const box = $('s-swap'); box.replaceChildren();
    for (const r of p.roles) if (r.candidates.length > 1) box.append(el('button', { type: 'button', className: 'small', text: '换一个' + r.spec.name, onclick: () => {
      const i = r.candidates.indexOf(r.model.connectionId); S.picks[r.spec.roleId] = r.candidates[(i + 1) % r.candidates.length]; preview(true);
    } }));
  }
  function skippedText(p) { return p.skipped && p.skipped.length ? '这些模型的价格未知，按规定不调用，已换成其它模型：' + p.skipped.join('、') + '。' : ''; }
  function preview(show) {
    S.plan = makePlan();
    if (show) {
      $('s-plan').hidden = !S.plan.ok;
      $('s-plan-team').textContent = S.plan.ok ? '智能分配：' + S.plan.summary : '';
      $('s-plan-note').textContent = S.plan.ok ? S.plan.confirmText + (S.plan.options.saving ? ' 预计超过单次上限 ¥' + S.plan.capCny + '，开始前会请你选择。' : '') + ' ' + skippedText(S.plan) : '';
      if (S.plan.ok) renderSwap(S.plan);
    }
    return S.plan;
  }
  /* 确认框：只有人民币；超过单次上限时给“效果优先 / 省钱”两个选项，默认效果优先，不静默降级 */
  function confirm(p) {
    return new Promise(resolve => {
      const dlg = $('s-confirm'), body = $('s-confirm-body'); body.replaceChildren();
      const opts = p.options.saving ? [p.options.quality, p.options.saving] : [p.options.quality];
      if (opts.length > 1) {
        body.append(el('p', { text: '按现在的分配，预计会超过单次上限 ¥' + p.capCny.toFixed(2) + '。请选一个：' }));
        for (const o of opts) body.append(el('label', { className: 'choice' }, [el('input', { type: 'radio', name: 's-choice', value: o.kind, checked: o.kind === 'quality' }),
          el('span', { text: (o.kind === 'quality' ? '效果优先 约¥' + o.estimateCny.toFixed(2) : '省钱 约¥' + o.estimateCny.toFixed(2) + '（效果可能稍差）') + '，最多 ¥' + o.maxCny.toFixed(2) + (o.overCap ? '，可能中途停下' : '') + '。' + o.summary })]));
      } else body.append(el('p', { className: 'team', text: p.confirmText }), el('p', { text: '团队：' + p.summary }));
      const skip = skippedText(p); if (skip) body.append(el('p', { className: 'hint', text: skip }));
      body.append(el('p', { className: 'hint', text: '开始前会先检查要用的模型能否连接（真实调用一次，费用极少）。' }));
      const done = ok => { dlg.close(); resolve(ok ? (document.querySelector('input[name=s-choice]:checked')?.value || 'quality') : null); };
      $('s-confirm-ok').onclick = () => done(true); $('s-confirm-cancel').onclick = () => done(false);
      dlg.addEventListener('cancel', () => resolve(null), { once: true });
      dlg.showModal();
    });
  }
  async function go() {
    if (S.busy) return;
    $('s-error').hidden = true;
    await loadModels();
    const first = preview(false);
    if (!first.ok) return showError($('s-error'), first.problems[0], go);
    const choice = await confirm(first);
    if (!choice) return;
    S.choice = choice;
    const p = makePlan(choice);
    S.busy = true; $('s-go').disabled = true;
    try {
      $('s-busy').textContent = '正在创建任务…';
      const project = (await api('/api/v2/projects', 'POST', p.project)).project;
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
      window.AIJWorkspace?.refreshProjects();
    } catch (e) {
      showError($('s-error'), window.SmartPlan.explain(e, { modelName: e.modelName }), go);
    } finally { S.busy = false; $('s-go').disabled = false; $('s-busy').textContent = ''; }
  }
  function showProgress(p) {
    $('simple').hidden = true; $('s-progress').hidden = false;
    $('s-team').textContent = p ? '团队：' + p.summary + '。' + p.confirmText : '';
    $('s-download').textContent = DL[S.format] || '下载成果';
    $('s-result').hidden = true; $('s-run-error').hidden = true; $('s-stop').hidden = true; $('s-steps').replaceChildren();
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
    $('s-state').textContent = active ? '正在执行，请稍候。每一步完成后这里会自动更新。' : run.status === 'failed' ? '任务没有全部完成。' : run.status === 'cancelled' ? '任务已取消。' : run.status === 'approved' ? '已确认完成。' : '已完成，请查看成果。';
    if (active) return;
    clearInterval(S.timer);
    const last = [...steps].reverse().find(st => st.status === 'done' && typeof st.output === 'string' && st.output.trim());
    if (last) { $('s-final').textContent = last.output; $('s-result').hidden = false; }
    $('s-accept').hidden = run.status !== 'review_required';
    if (run.status === 'failed' || run.status === 'cancelled') {
      const bad = steps.find(st => st.status === 'failed' || st.status === 'quality_failed');
      const info = window.SmartPlan.explain({ message: bad && bad.error || '' });
      if (info.budgetStop) {
        // 钱用完：停下来，不自动降级；已完成的部分可以下载
        const total = (run.projectSnapshot && run.projectSnapshot.steps || []).length || steps.length, doneN = steps.filter(st => st.status === 'done').length;
        $('s-stop-text').textContent = `已完成 ${doneN}/${total} 步，花了约 ${(c => c > 0 && c < 0.01 ? '不到 ¥0.01' : '¥' + c.toFixed(2))(window.SmartPlan.spentCny(run.usage && run.usage.cost))}（估算，以厂商账单为准）。这次确认的金额已经用完，任务已停下，没有超支。`;
        $('s-stop-download').hidden = !last; $('s-stop').hidden = false;
        $('s-result').hidden = true; $('s-stop').scrollIntoView({ block: 'center' });
        return;
      }
      showError($('s-run-error'), info, () => { $('s-progress').hidden = true; $('simple').hidden = false; go(); });
    }
  }
  async function download() {
    const res = await fetch('/api/v2/runs/' + encodeURIComponent(S.runId) + '/export', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format: S.format }) });
    if (!res.ok) { showError($('s-run-error'), { text: '成果文件暂时生成不了，请稍后再试。', fix: { action: 'retry', label: '再试一次' } }, download); return; }
    const blob = await res.blob(), a = el('a', { href: URL.createObjectURL(blob), download: (S.outputLabel || '成果') + '.' + S.format });
    document.body.append(a); a.click(); a.remove();
  }
  function reset() {
    clearInterval(S.timer); S.runId = null; S.picks = {}; S.choice = 'quality';
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
    $('s-stop-download').addEventListener('click', download);
    $('s-accept').addEventListener('click', async () => { await api('/api/v2/runs/' + encodeURIComponent(S.runId) + '/review', 'POST', { decision: 'approve', feedback: '用户在简单模式确认成果' }); poll(); });
    const q = new URLSearchParams(location.search);
    if (q.get('project')) document.body.dataset.mode = 'advanced';
    try { await loadModels(); } catch { /* 页面其余部分仍可用 */ }
    if (q.get('run')) { S.runId = q.get('run'); try { const run = (await api('/api/v2/runs/' + encodeURIComponent(S.runId))).run; S.projectId = run.projectId; showProgress(null); } catch { reset(); } }
  });
})();
