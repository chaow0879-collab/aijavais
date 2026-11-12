'use strict';
/* B7e/B7g 简单模式（默认）：用户只填 做什么 / 要什么成果 / 什么时候要（可选），一键智能配置。
 * 系统估算费用，弹一次确认框（只写人民币）；点“确认开始”就是本次运行的显式批准，每次都重新确认、不继承。
 * 规则见 public/smart-plan.js；服务端的预算、Token、审批与就绪门禁全部不变。页面只显示中文，不显示原始 JSON。 */
(() => {
  const $ = id => document.getElementById(id);
  const S = { models: [], excluded: new Set(), capCny: 5, picks: {}, plan: null, runId: null, projectId: null, snapshot: null, timer: null, format: 'docx', outputLabel: 'Word 文档', busy: false, choice: 'quality' };
  const OUT = window.SmartPlan.OUTPUTS, STATUS = { pending: '等待中', running: '进行中', done: '已完成', quality_failed: '质量检查没通过', failed: '没有完成', cancelled: '已取消', skipped: '已跳过' };
  /* O11：累计花费（估算，人民币；不足 1 分显示“不到 ¥0.01”） */
  const spentText = usd => { const c = window.SmartPlan.spentCny(usd); return c > 0 && c < 0.01 ? '不到 ¥0.01' : '¥' + c.toFixed(2); };
  const DL = { md: '下载文字稿', docx: '下载 Word 文档', xlsx: '下载 Excel 表格', pptx: '下载演示文稿' };
  const el = (tag, props = {}, kids = []) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n[k] = v; } n.append(...kids); return n; };
  async function api(path, method = 'GET', body) {
    const res = await fetch(path, { method, credentials: 'same-origin', headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { location.assign('/login.html?next=/workspace.html&expired=1'); throw Error('请重新登录'); }
    if (!res.ok) throw Object.assign(Error(data.error || '请求失败'), { code: data.code, status: res.status });
    return data;
  }
  const output = () => document.querySelector('input[name=s-output]:checked')?.value || 'word';
  /* ---------- B9a 原始资料：拖拽/点击上传，多选；复用 /api/v2/projects/:id/files 与 lib/file-extract.js ----------
   * 第一次加资料时先建一个“草稿”任务来存放文件；点开始时用同一个任务（PUT 写入完整配置），资料原样交给每个岗位。 */
  const DRAFT_KEY = 'aij.b9.draft';
  S.files = []; S.draft = null; S.queue = Promise.resolve(); S.draftReq = null; S.maxFileBytes = 8 * 1024 * 1024;
  let fileSeq = 0;
  const doneFiles = () => S.files.filter(f => f.state === 'done').map(f => f.file);
  const remember = id => { try { id ? sessionStorage.setItem(DRAFT_KEY, id) : sessionStorage.removeItem(DRAFT_KEY); } catch { /* 无痕模式：只是刷新后不恢复 */ } };
  function ensureDraft() {
    if (S.draft) return Promise.resolve(S.draft);
    S.draftReq = S.draftReq || api('/api/v2/projects', 'POST', { name: '新任务（正在准备资料）', description: '还没开始的新任务，正在上传资料。',
      roles: [{ roleId: 'drafter', name: '起草员', duty: '根据需求写出完整初稿' }], steps: [{ stepId: 'draft', roleId: 'drafter', title: '写出初稿' }], materials: { mode: 'all' } })
      .then(d => { S.draft = { projectId: d.project.projectId, version: d.project.version }; remember(S.draft.projectId); return S.draft; })
      .finally(() => { S.draftReq = null; });
    return S.draftReq;
  }
  const fileBase64 = file => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = () => reject(Error('无法读取这个文件')); r.readAsDataURL(file); });
  function asEntry(file) { const st = window.SmartPlan.fileStatus(file); return { key: ++fileSeq, name: file.filename, state: 'done', file, text: st.text, warn: !st.ok }; }
  const DRAFT_NAME = '新任务（正在准备资料）';
  function renderFiles() {
    $('s-draft-row').hidden = !S.draft; $('s-draft-del').textContent = '放弃这个草稿（连同资料一起删除）'; S.delArmed = false;
    $('s-file-list').replaceChildren(...S.files.map(f => el('li', { className: 'file-' + f.state }, [
      el('span', { className: 'fname', text: f.name }),
      el('span', { className: 'fstate ' + (f.state === 'busy' ? 'busy' : f.state === 'error' ? 'bad' : f.warn ? 'warn' : ''), text: f.text }),
      el('button', { type: 'button', className: 'small', text: f.state === 'error' ? '移除' : '删除', disabled: f.state === 'busy', title: '删除 ' + f.name, onclick: () => removeFile(f) })])));
  }
  async function removeFile(f) {
    if (f.state === 'done') {
      try { await api('/api/v2/projects/' + encodeURIComponent(S.draft.projectId) + '/files/' + encodeURIComponent(f.file.fileId), 'DELETE'); }
      catch { f.text = '删除没有成功，请再试一次'; f.warn = true; renderFiles(); return; }
    }
    S.files = S.files.filter(x => x !== f); renderFiles(); materialsChanged();
  }
  async function upload(entry, file) {
    try {
      const d = await ensureDraft();
      const data = await api('/api/v2/projects/' + encodeURIComponent(d.projectId) + '/files', 'POST', { filename: file.name, contentBase64: await fileBase64(file) });
      Object.assign(entry, asEntry(data.file), { key: entry.key });
    } catch (e) { entry.state = 'error'; entry.text = window.SmartPlan.uploadError(e, file.name); }
    renderFiles(); materialsChanged();
  }
  function addFiles(list) {
    for (const file of Array.from(list || [])) {
      const bad = window.SmartPlan.checkUpload(file, { maxFileBytes: S.maxFileBytes });
      const entry = { key: ++fileSeq, name: file.name, state: bad ? 'error' : 'busy', text: bad || '正在读取…' };
      S.files.push(entry);
      if (!bad) S.queue = S.queue.then(() => upload(entry, file));
    }
    renderFiles();
  }
  function materialsChanged() { if (!$('s-plan').hidden) preview(true); showAuto(); }
  function clearDraft() { S.draft = null; S.files = []; remember(null); renderFiles(); }
  /* AUD-FEB8-01：放弃草稿 = 删除这个还没开始的任务和它的资料（点两次，防误删） */
  async function discardDraft() {
    if (!S.draft) return;
    if (!S.delArmed) { S.delArmed = true; $('s-draft-del').textContent = '确定删除？再点一次'; return; }
    try { await api('/api/v2/projects/' + encodeURIComponent(S.draft.projectId), 'DELETE'); clearDraft(); $('s-busy').textContent = '草稿和资料已删除。'; window.AIJWorkspace?.refreshProjects(); }
    catch { $('s-draft-del').textContent = '删除没有成功，请再试一次'; S.delArmed = false; }
  }
  /* 用一个已有任务的资料（调整团队、刷新页面后恢复草稿） */
  async function useProjectFiles(projectId, { onlyDraft = false } = {}) {
    const d = await api('/api/v2/projects/' + encodeURIComponent(projectId));
    if (onlyDraft && (d.runs || []).length) return false;
    const files = (await api('/api/v2/projects/' + encodeURIComponent(projectId) + '/files')).files || [];
    if (!files.length && !onlyDraft) return false;
    S.draft = { projectId, version: d.project.version }; S.files = files.map(asEntry); remember(projectId); renderFiles(); materialsChanged();
    return true;
  }
  function bindDrop() {
    const zone = $('s-drop'), input = $('s-files');
    zone.addEventListener('click', e => { if (e.target !== input) input.click(); });
    zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); addFiles(e.dataTransfer && e.dataTransfer.files); });
    // 文件没拖准时，浏览器不要直接打开它
    for (const t of ['dragover', 'drop']) addEventListener(t, e => { if (!zone.contains(e.target)) e.preventDefault(); });
  }
  function build() {
    $('s-output').replaceChildren(...Object.entries(OUT).map(([k, o]) => el('label', {}, [el('input', { type: 'radio', name: 's-output', value: k, checked: k === 'word' }), o.label])));
    for (const id of ['s-output', 's-goal', 's-deadline']) $(id).addEventListener('input', () => { S.picks = {}; if (!$('s-plan').hidden) preview(true); showAuto(); });
    $('s-budget-cny').addEventListener('input', () => { $('s-budget-warn').hidden = true; S.budgetAck = null; if (!$('s-plan').hidden) preview(true); });
  }
  /* B8：使用者账号不读后台接口：可用模型（只含管理员已测通的）、单次上限和本月额度都来自 /api/v2/me */
  const isUser = async () => (await (window.AIJRole || Promise.resolve(null))) === 'user';
  async function loadModels() {
    if (await isUser()) {
      const me = await api('/api/v2/me');
      S.models = me.models || []; S.me = me.me;
      if (me.settings && Number(me.settings.simpleRunCapCny) > 0) S.capCny = Number(me.settings.simpleRunCapCny);
      $('ws-guide').hidden = window.SmartPlan.chat(S.models).length > 0;
      return;
    }
    const [m, c] = await Promise.all([api('/api/models'), api('/api/config').catch(() => null)]);
    S.models = m.models || [];
    if (c && c.settings && Number(c.settings.simpleRunCapCny) > 0) S.capCny = Number(c.settings.simpleRunCapCny);
    $('ws-guide').hidden = window.SmartPlan.chat(S.models).length > 0;
  }
  /* B5-2：普通用户不被赶去管理中心。模型不能用时，在当前页一键换成其它可用模型；
   * 只有一个可用模型都没有时，才提示“请管理员添加模型”。 */
  const pool = () => S.models.filter(m => !S.excluded.has(m.connectionId));
  /* QA-B8-01：使用者看不到后台、密钥、管理中心这些字；模型的问题统一说“请联系管理员” */
  const forUser = text => document.body.dataset.role !== 'user' || !/密钥|管理中心|添加一个模型/.test(text) ? text
    : /还没有可用的模型/.test(text) ? '管理员还没有准备好可用的模型，现在还不能开始任务，请联系管理员。' : '所选的模型现在不能用，请联系管理员检查。';
  function showError(box, info, retry, ctx = {}) {
    box.replaceChildren(el('div', { text: forUser(info.text) }));
    const fix = info.fix;
    if (fix && fix.action === 'fix_model') {
      const others = window.SmartPlan.usable(pool()).filter(m => m.connectionId !== ctx.connectionId);
      if (ctx.connectionId && others.length && retry) box.append(el('button', { type: 'button', className: 'fixbtn', text: '自动换成其它可用模型', onclick: () => { S.excluded.add(ctx.connectionId); for (const k of Object.keys(S.picks)) if (S.picks[k] === ctx.connectionId) delete S.picks[k]; box.hidden = true; retry(); } }));
      else box.append(el('div', { className: 'hint', text: '没有其它可用的模型了，请管理员添加模型。' }));
    } else if (fix && fix.action === 'add_model') box.append(document.body.dataset.role === 'user' ? el('div', { className: 'hint', text: '请联系管理员添加模型。' }) : el('a', { className: 'fixbtn', href: '/admin.html', text: fix.label })); // 一个模型都没有：只能先添加
    else if (fix && retry) box.append(el('button', { type: 'button', className: 'fixbtn', text: fix.label, onclick: () => { box.hidden = true; retry(); } }));
    if (info.detail) box.append(el('details', {}, [el('summary', { text: '给管理员看的详细信息' }), el('div', { text: info.detail })]));
    box.hidden = false; box.scrollIntoView({ block: 'center' });
  }
  /* B5-F2：可选预算（人民币）。空着=自动；填了就按它做上限（不超过管理员的单次上限），引擎门禁不变 */
  const budget = () => $('s-budget-cny').value.trim() === '' ? null : $('s-budget-cny').value.trim(); // validated in SmartPlan.plan (0/负数/文字 -> 提示)
  function makePlan(choice) {
    return window.SmartPlan.plan({ models: pool(), goal: $('s-goal').value, output: output(), deadline: $('s-deadline').value, capCny: S.capCny, picks: S.picks, choice: choice || S.choice, budgetCny: budget(), materials: doneFiles() });
  }
  function showAuto() {
    const p = window.SmartPlan.plan({ models: pool(), goal: $('s-goal').value || '写一份文字成果', output: output(), capCny: S.capCny, picks: S.picks, materials: doneFiles() });
    $('s-budget-auto').textContent = !p.ok ? '自动：添加模型后会自动估算' : p.chosen.free ? '自动：本机模型，不花钱' : '自动：约 ¥' + p.suggestedCny.toFixed(2) + '（建议金额）';
    // B9b：点开始之前就说清楚：会先花多少钱读懂需求、提问，确认后才正式开始
    const est = p.ok ? window.SmartPlan.clarifyEstimate({ model: p.roles[0].model, goal: $('s-goal').value, deadline: $('s-deadline').value, materials: doneFiles() }) : null;
    $('s-clar-note').textContent = !p.ok ? '' : !est ? '点开始后，会先根据你的需求列出几个问题和计划，确认后才正式开始。'
      : est.free ? '点开始后，会先读懂需求、问你几个问题（本机模型，不花钱），确认后才正式开始。'
      : '点开始后，会先花不超过 ¥' + est.maxCny.toFixed(2) + ' 读懂需求、问你几个问题，确认后才正式开始。';
  }
  /* ---------- B9b 先问清楚再动手：一次便宜的调用（服务端走 system_usage 预留和结算），失败或没有模型就用规则版 ---------- */
  const yuanText = usd => { const c = window.SmartPlan.spentCny(usd); return c > 0 && c < 0.01 ? '不到 ¥0.01' : '约 ¥' + c.toFixed(2); };
  async function clarifyStep(first) {
    const goal = $('s-goal').value.trim(), deadline = $('s-deadline').value.trim(), mats = doneFiles();
    const sig = JSON.stringify([goal, output(), deadline, mats.map(f => f.fileId), first.roles[0].model.connectionId]);
    if (S.clar && S.clar.sig === sig) return S.clar; // 同样的需求不重复花钱
    const rules = window.SmartPlan.clarifyRules({ goal, output: output(), deadline, materials: mats });
    const est = window.SmartPlan.clarifyEstimate({ model: first.roles[0].model, goal, deadline, materials: mats });
    let clar = null, note = '', spentUsd = 0;
    if (!est) note = '这次是按规则列出的问题，没有调用模型。';
    else {
      $('s-busy').textContent = '正在读懂你的需求…';
      try {
        // 慢的时候不让用户干等：20 秒没回来就用规则版（服务端照样按实际结算、记账）
        const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
        const res = await fetch('/api/v2/intake/clarify', { method: 'POST', credentials: 'same-origin', signal: ctl.signal, headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ goal, output: OUT[output()].label, deadline, connectionId: first.roles[0].model.connectionId, approvePaid: est.approvePaid, maxCost: est.maxCostUsd, ...(S.draft ? { projectId: S.draft.projectId } : {}) }) });
        if (res.status === 401) { location.assign('/login.html?next=/workspace.html&expired=1'); throw Error('请重新登录'); }
        const data = await res.json().catch(() => ({})); clearTimeout(timer);
        const u = data.usage || {};
        spentUsd = u.cost === null || u.cost === undefined ? (data.requestSent ? Number(u.costUpperBound) || est.maxCostUsd : 0) : Number(u.cost) || 0;
        const spent = est.free ? '（本机模型，不花钱）' : data.requestSent ? '这一步花了' + (u.cost === null || u.cost === undefined ? '不超过 ¥' + est.maxCny.toFixed(2) : yuanText(u.cost)) + '（已计入）。' : '';
        if (data.clarify && (data.ok || data.code === 'usage_unsettled')) { clar = data.clarify; note = est.free ? '理解需求用的是本机模型，不花钱。' : '理解需求' + spent; }
        else if (data.code === 'monthly_quota_exhausted' || data.code === 'monthly_quota_exceeded') note = '本月额度不够，这次按规则列出问题，没有调用模型。';
        else note = (data.requestSent ? '模型这次的回答不合格，已改用按规则列出的问题；' + (est.free ? '' : spent) : '这次没能调用模型，已改用按规则列出的问题，没有花钱。');
      } catch (e) {
        if (e.message === '请重新登录') throw e;
        // 超时：请求可能已经发出，费用以记账为准（不超过上限）
        note = e.name === 'AbortError' ? '模型这次回答太慢，已改用按规则列出的问题' + (est.free ? '。' : '；这一步的费用不超过 ¥' + est.maxCny.toFixed(2) + '（已计入）。') : '暂时连不上，已改用按规则列出的问题，没有花钱。';
        if (e.name === 'AbortError' && !est.free) spentUsd = est.maxCostUsd;
      }
      finally { $('s-busy').textContent = ''; }
      if (!est.free && spentUsd > 0) await loadModels().catch(() => {}); // 使用者：刷新本月剩余额度
    }
    S.clar = { sig, clar: clar || rules, note, spentUsd };
    return S.clar;
  }
  /* 确认框顶部：我理解你要的是…… / 最多 3 个问题（可点选项 + 其它 + 跳过）/ 人话计划 */
  function renderClarify(body, p, c) {
    const box = el('section', { className: 'clar', id: 's-clarify' }, [el('h3', { text: '我理解你要的是' }), el('p', { id: 's-clar-understanding', text: c.clar.understanding.replace(/^我理解你要的是[：:，,]?/, '') })]);
    const qs = el('div', { id: 's-clar-questions' });
    c.clar.questions.forEach((q, i) => {
      const other = el('input', { className: 'other', id: 's-clar-other-' + i, maxLength: 200, placeholder: '其它，请写一下', hidden: true });
      const chips = el('div', { className: 'chips', role: 'radiogroup' }, [...q.options, '其它'].map((o, k) => el('label', {}, [el('input', { type: 'radio', name: 's-clar-q' + i, value: k === q.options.length ? '__other' : o,
        onchange: () => { other.hidden = k !== q.options.length; if (!other.hidden) other.focus(); } }), o])));
      qs.append(el('div', { className: 'q', text: (i + 1) + '. ' + q.question }), chips, other);
    });
    if (c.clar.questions.length) {
      S.clarSkipped = false;
      const skip = el('button', { type: 'button', className: 'small skip', id: 's-clar-skip', text: '跳过，按你的理解来', onclick: () => {
        S.clarSkipped = !S.clarSkipped; qs.hidden = S.clarSkipped; skip.textContent = S.clarSkipped ? '我还是想回答问题' : '跳过，按你的理解来'; } });
      box.append(el('h3', { text: '开始前想确认几件事（不选就按常见做法）' }), qs, skip);
    } else S.clarSkipped = false;
    box.append(el('p', { id: 's-clar-plan', text: '计划：' + window.SmartPlan.planText(p, c.clar) + '。' }));
    if (c.note) box.append(el('p', { className: 'hint', id: 's-clar-cost', text: c.note }));
    body.append(box);
  }
  function clarifyAnswers() {
    const c = S.clar && S.clar.clar; if (!c) return { answers: [], skipped: false };
    return { skipped: !!S.clarSkipped, answers: c.questions.map((q, i) => { const v = document.querySelector('input[name=s-clar-q' + i + ']:checked')?.value || '';
      return v === '__other' ? ($('s-clar-other-' + i)?.value || '').trim().slice(0, 200) : v; }) };
  }
  /* 填的金额比建议金额低：一句人话 + 两个按钮，用户选了“就用这个金额”才继续 */
  function budgetCheck(p) {
    if (!p.underBudget || (!p.belowMin && S.budgetAck === p.budgetCny)) return true;
    // 低于第一步所需：不能开始，也不悄悄抬高，只给“改成建议金额”
    $('s-budget-keep').hidden = p.belowMin;
    $('s-budget-warn-text').textContent = p.belowMin
      ? '这个金额连第一步都不够（第一步最少约 ¥' + p.minCny.toFixed(2) + '），开始后会马上停下，所以先不开始。建议金额约 ¥' + p.suggestedCny.toFixed(2) + '。'
      : '预算可能不够，做到一半会停下（已完成的部分仍可下载）。建议金额约 ¥' + p.suggestedCny.toFixed(2) + '，你填的是 ¥' + p.chosen.maxCny.toFixed(2) + '。';
    $('s-budget-suggest').onclick = () => { $('s-budget-cny').value = p.suggestedCny.toFixed(2); $('s-budget-warn').hidden = true; S.budgetAck = null; if (!$('s-plan').hidden) preview(true); };
    $('s-budget-keep').onclick = () => { S.budgetAck = p.budgetCny; $('s-budget-warn').hidden = true; go(); };
    $('s-budget-warn').hidden = false; $('s-budget-warn').scrollIntoView({ block: 'center' });
    return false;
  }
  function renderSwap(p) {
    const box = $('s-swap'); box.replaceChildren();
    for (const r of p.roles) if (r.candidates.length > 1) box.append(el('button', { type: 'button', className: 'small', text: '换一个' + r.spec.name, onclick: () => {
      const i = r.candidates.indexOf(r.model.connectionId); S.picks[r.spec.roleId] = r.candidates[(i + 1) % r.candidates.length]; preview(true);
    } }));
  }
  /* QA-B8 P3-1：使用者看不到模型名，只看岗位和档次（“起草员（均衡）”）；模型属于后台信息 */
  const isUserPage = () => document.body.dataset.role === 'user';
  const team = s => (!isUserPage() ? s : String(s || '').replace(/ → [^（｜]+/g, ''));
  const estNote = s => (!isUserPage() || !s ? s : String(s).replace(/^[\s\S]*? 还没有官方单价/, '所选模型还没有官方单价'));
  function skippedText(p) { if (isUserPage() && p.skipped && p.skipped.length) return '有些模型没有登记价格，按规定不调用，已自动换成其它模型。';
    return p.skipped && p.skipped.length ? '这些模型所在的平台没有登记价格，按规定不调用，已换成其它模型：' + p.skipped.join('、') + '。' : ''; }
  function preview(show) {
    S.plan = makePlan();
    if (show) {
      $('s-plan').hidden = !S.plan.ok;
      $('s-plan-team').textContent = S.plan.ok ? '智能分配：' + team(S.plan.summary) : '';
      $('s-plan-note').textContent = S.plan.ok ? [S.plan.confirmText + (S.plan.options.saving ? ' 预计超过单次上限 ¥' + S.plan.capCny + '，开始前会请你选择。' : ''), S.plan.materialsNote, estNote(S.plan.estimatedNote), skippedText(S.plan)].filter(Boolean).join(' ') : '';
      if (S.plan.ok) renderSwap(S.plan);
    }
    return S.plan;
  }
  /* 确认框：只有人民币；超过单次上限时给“效果优先 / 省钱”两个选项，默认效果优先，不静默降级 */
  function confirm(p) {
    return new Promise(resolve => {
      const dlg = $('s-confirm'), body = $('s-confirm-body'); body.replaceChildren();
      if (p.clarify && !p.isRework) renderClarify(body, p, p.clarify);
      const opts = p.options.saving ? [p.options.quality, p.options.saving] : [p.options.quality];
      if (opts.length > 1) {
        body.append(el('p', { text: '按现在的分配，预计会超过单次上限 ¥' + p.capCny.toFixed(2) + '。请选一个：' }));
        for (const o of opts) body.append(el('label', { className: 'choice' }, [el('input', { type: 'radio', name: 's-choice', value: o.kind, checked: o.kind === 'quality' }),
          el('span', { text: (o.kind === 'quality' ? '效果优先 约¥' + o.estimateCny.toFixed(2) : '省钱 约¥' + o.estimateCny.toFixed(2) + '（效果可能稍差）') + (p.estimatedNote ? '，估计上限 ¥' : '，最多 ¥') + o.maxCny.toFixed(2) + (o.overCap ? '，可能中途停下' : '') + '。' + o.summary })]));
      } else body.append(el('p', { className: 'team', text: p.confirmText }), el('p', { text: '团队：' + team(p.summary) }));
      if (p.budgetCny != null && !p.isRework) body.append(el('p', { className: 'hint', id: 's-confirm-budget', text: p.budgetClipped ? '你填的 ¥' + p.budgetCny.toFixed(2) + ' 超过了单次上限 ¥' + p.capCny.toFixed(2) + '，按 ¥' + p.capCny.toFixed(2) + ' 计算。' : '上限按你填的金额：¥' + p.chosen.maxCny.toFixed(2) + (p.underBudget ? '（比建议金额低，可能做到一半会停下）' : '') + '。' }));
      if (p.materialsNote && !p.isRework) body.append(el('p', { className: 'hint', id: 's-confirm-materials', text: p.materialsNote }));
      const skip = skippedText(p); if (skip) body.append(el('p', { className: 'hint', text: skip }));
      if (p.estimatedNote) body.append(el('p', { className: 'hint', id: 's-confirm-estimated', text: estNote(p.estimatedNote) }));
      body.append(el('p', { className: 'hint', id: 's-confirm-spent', text: '这个任务累计已花约 ' + (p.isRework ? spentText(S.spentUsd) : spentText(p.clarify ? p.clarify.spentUsd : 0)) + '（估算，以厂商账单为准）。' }));
      if (S.me && S.me.kind === 'user') body.append(el('p', { className: 'hint', id: 's-confirm-quota', text: '你本月额度还剩 ¥' + (Number(S.me.month.remainingCny) || 0).toFixed(2) + '（每月上限 ¥' + (Number(S.me.month.capCny) || 0).toFixed(2) + '，由管理员设置）。' }));
      // QA-B8-02: the rework sentence belongs to a rework only; a user's models are already tested, so no connection-check sentence
      if (p.isRework) body.append(el('p', { className: 'hint', text: '只重做“审核并定稿”这一步，沿用已完成的初稿。' + (p.scopeText ? '会在上一版的基础上修改（' + p.scopeText + '），改完是新的一版，旧版本保留。' : '') }),
        ...(S.reworksLeft > 0 ? [el('p', { className: 'hint', id: 's-confirm-left', text: '确认后这个任务还可以再修改 ' + (S.reworksLeft - 1) + ' 次。' })] : []));
      else if (!(S.me && S.me.kind === 'user')) body.append(el('p', { className: 'hint', text: '开始前会先检查要用的模型能否连接（真实调用一次，费用极少）。' }));
      $('s-confirm-title').textContent = p.isRework ? '确认修改' : '确认开始';
      const done = ok => { if (ok && p.clarify && !p.isRework) S.clarAnswers = clarifyAnswers(); dlg.close(); resolve(ok ? (document.querySelector('input[name=s-choice]:checked')?.value || 'quality') : null); };
      $('s-confirm-ok').onclick = () => done(true); $('s-confirm-cancel').onclick = () => done(false);
      dlg.addEventListener('cancel', () => resolve(null), { once: true });
      dlg.showModal();
    });
  }
  /* B8：使用者每月有人民币上限。先在页面上用人话拦下来（不创建任务）；服务器开始运行前还会再查一次，以服务器为准 */
  function quotaProblem(p) {
    if (!S.me || S.me.kind !== 'user' || !p.approval || !(p.approval.approvePaid || p.chosen.maxCny > 0)) return null;
    const left = Number(S.me.month.remainingCny) || 0;
    if (left <= 0) return '本月额度已用完，请联系管理员';
    if (p.chosen.maxCny > left + 1e-9) return '本月额度只剩 ¥' + left.toFixed(2) + '，这次最多要花 ¥' + p.chosen.maxCny.toFixed(2) + '。请把预算改到 ¥' + left.toFixed(2) + ' 以内，或联系管理员';
    return null;
  }
  async function go() {
    if (S.busy) return;
    $('s-error').hidden = true;
    if (S.files.some(f => f.state === 'busy')) { $('s-busy').textContent = '资料还在读取，读完就开始…'; await S.queue; $('s-busy').textContent = ''; }
    await loadModels();
    const first = preview(false);
    if (!first.ok) return showError($('s-error'), first.problems[0], go);
    if (!budgetCheck(first)) return;
    // QA-B8 P3-5: say "quota not enough" before the confirmation, not after the user confirmed an amount it cannot cover
    // (only when no option of the dialog fits; if the 省钱 option fits, the dialog still lets the user pick it)
    const q0 = quotaProblem(first), saving = first.options && first.options.saving;
    if (q0 && !(saving && !quotaProblem({ ...first, chosen: saving }))) return showError($('s-error'), { text: q0, fix: null });
    let clar;
    try { clar = await clarifyStep(first); } catch { return; } // 只有登录过期会到这里（已跳转）
    const choice = await confirm({ ...first, clarify: clar });
    if (!choice) return;
    S.choice = choice;
    const p = makePlan(choice);
    p.project = window.SmartPlan.applyClarify(p.project, clar.clar, S.clarAnswers); // 澄清答案并入项目说明
    const q1 = quotaProblem(p);
    if (q1) return showError($('s-error'), { text: q1, fix: null });
    S.busy = true; $('s-go').disabled = true;
    try {
      $('s-busy').textContent = '正在创建任务…';
      // B9a：有资料时用存放资料的同一个任务（带版本号写入完整配置），否则新建
      const project = S.draft ? (await api('/api/v2/projects/' + encodeURIComponent(S.draft.projectId), 'PUT', { ...p.project, expectedVersion: S.draft.version })).project
        : (await api('/api/v2/projects', 'POST', p.project)).project;
      if (S.draft) S.draft.version = project.version;
      for (const r of p.roles) {
        const m = S.models.find(x => x.connectionId === r.model.connectionId);
        if (m && m.status === 'available') continue;
        $('s-busy').textContent = '正在检查「' + window.ModelHints.platformLabel(r.model) + '」能否连接…';
        const t = await api('/api/providers/' + encodeURIComponent(r.model.connectionId) + '/test', 'POST', { approvePaid: true });
        if (!t.ok) throw Object.assign(Error(t.error || ''), { code: 'model_unverified', modelName: window.ModelHints.platformLabel(r.model), connectionId: r.model.connectionId });
        if (m) m.status = 'available';
      }
      $('s-busy').textContent = '正在开始执行…';
      const run = (await api('/api/v2/projects/' + encodeURIComponent(project.projectId) + '/runs', 'POST', p.approval)).run;
      S.runId = run.runId; S.projectId = project.projectId; S.format = p.format; S.outputLabel = p.outputLabel;
      clearDraft(); S.clar = null;
      showProgress(p);
      window.AIJWorkspace?.refreshProjects();
    } catch (e) {
      showError($('s-error'), window.SmartPlan.explain(e, { modelName: e.modelName }), go, { connectionId: e.connectionId });
    } finally { S.busy = false; $('s-go').disabled = false; $('s-busy').textContent = ''; }
  }
  function showProgress(p) {
    $('simple').hidden = true; $('s-progress').hidden = false;
    $('s-team').textContent = p ? '团队：' + team(p.summary) + '。' + p.confirmText : '';
    $('s-download').textContent = DL[S.format] || '下载成果'; $('s-download').hidden = false;
    $('s-result').hidden = true; $('s-run-error').hidden = true; $('s-stop').hidden = true; $('s-steps').replaceChildren();
    history.replaceState(null, '', '/workspace.html?run=' + encodeURIComponent(S.runId));
    scrollTo(0, 0);
    clearInterval(S.timer); poll(); S.timer = setInterval(poll, 2000);
  }
  async function poll() {
    let run;
    try { run = (await api('/api/v2/runs/' + encodeURIComponent(S.runId))).run; } catch { $('s-state').textContent = '暂时连不上服务器，正在重试…'; return; }
    const steps = run.steps || [];
    S.snapshot = run.projectSnapshot || S.snapshot; S.projectId = run.projectId || S.projectId;
    S.spentUsd = run.usage && run.usage.cost || 0;
    $('s-spent').textContent = '这个任务累计已花约 ' + spentText(S.spentUsd) + '（估算，以厂商账单为准）。';
    $('s-steps').replaceChildren(...steps.map(st => el('li', { className: st.status }, [el('strong', { text: st.title }), ' · ' + (STATUS[st.status] || '进行中')])));
    if (!steps.length) $('s-steps').replaceChildren(el('li', { className: 'running', text: '准备中…' }));
    const active = run.status === 'running' || run.executionActive;
    $('s-state').textContent = active ? '正在执行，请稍候。每一步完成后这里会自动更新。' : run.status === 'failed' ? '任务没有全部完成。' : run.status === 'cancelled' ? '任务已取消。' : run.status === 'approved' ? '已确认完成。' : '已完成，请查看成果。';
    if (active) return;
    clearInterval(S.timer);
    const last = [...steps].reverse().find(st => st.status === 'done' && typeof st.output === 'string' && st.output.trim());
    // B5-F3 (2): a fresh result (e.g. after 重新生成) brings the download back at once; deckPreview hides it again only if the deck is unusable
    if (last) { $('s-final').textContent = readable(last.output); $('s-result').hidden = false; $('s-download').hidden = false; if (S.format === 'pptx' && run.status !== 'failed' && run.status !== 'cancelled') deckPreview(); }
    $('s-accept').hidden = $('s-rework').hidden = run.status !== 'review_required';
    // B9c：等你审核时，成果下方直接是对话框（说一句要怎么改）；版本和修改记录一直可看可下载
    $('s-rework-box').hidden = run.status !== 'review_required' || !last;
    if (last) loadVersions();
    if (run.status === 'failed' || run.status === 'cancelled') {
      const bad = steps.find(st => st.status === 'failed' || st.status === 'quality_failed');
      const info = window.SmartPlan.explain({ message: bad && bad.error || '' });
      if (info.budgetStop || info.overrun) {
        // 钱用完：停下来，不自动降级；已完成的部分可以下载
        const total = (run.projectSnapshot && run.projectSnapshot.steps || []).length || steps.length, doneN = steps.filter(st => st.status === 'done').length;
        $('s-stop-text').textContent = `已完成 ${doneN}/${total} 步，花了约 ${spentText(run.usage && run.usage.cost)}（估算，以厂商账单为准）。${info.text}下一步：可以先下载已完成的部分；如需做完，可请管理员提高单次上限后再新建一次。`;
        $('s-stop-download').hidden = !last; $('s-stop').hidden = false;
        $('s-result').hidden = true; $('s-stop').scrollIntoView({ block: 'center' });
        return;
      }
      // B5-F3 (1): a PPT whose final page step was refused by the quality check (apology / empty reply) is the
      // same case as a cover-only deck: say so first, never offer a download, offer 重新生成
      if (S.format === 'pptx' && run.status === 'failed' && bad && (bad.status === 'quality_failed' || /empty or oversized output/i.test(bad.error || ''))) {
        $('s-result').hidden = true;
        return unusableDeck('这次 PPT 没能生成合格的页面：模型的回复是空的、太短、超长或者是道歉，不是演示稿内容。', { failed: true });
      }
      showError($('s-run-error'), info, () => { $('s-progress').hidden = true; $('simple').hidden = false; go(); });
    }
  }
  /* ---------- B9c 版本：每次修改生成新版本，旧版本保留，可查看、可下载 ---------- */
  async function loadVersions() {
    let d; try { d = await api('/api/v2/runs/' + encodeURIComponent(S.runId) + '/versions'); } catch { return; }
    S.versions = d.versions || []; S.reworksLeft = d.reworksLeft;
    const cur = S.versions.find(v => v.current) || S.versions.at(-1); S.lastText = cur ? cur.text : '';
    $('s-versions-box').hidden = !S.versions.length;
    $('s-versions').replaceChildren(...S.versions.map(v => el('li', { className: v.current ? 'current' : '' }, [
      el('span', { className: 'vname', text: '第 ' + v.version + ' 版' + (v.current ? '（当前）' : '') }),
      el('span', { className: 'vmsg', text: v.message ? '你说：' + v.message : '最初的成果' }),
      el('button', { type: 'button', className: 'small', text: '查看', onclick: () => viewVersion(v) }),
      el('button', { type: 'button', className: 'small', text: '下载', onclick: () => download(v.current ? undefined : v.artifactId) })])));
    $('s-chat-left').textContent = S.reworksLeft > 0 ? '这个任务还可以修改 ' + S.reworksLeft + ' 次。' : '已经修改到这个任务的上限，不能再改了；可以下载现在的版本，或新建一个任务。';
    $('s-rework-go').disabled = !(S.reworksLeft > 0);
  }
  function viewVersion(v) {
    $('s-viewing').hidden = v.current; $('s-viewing').textContent = v.current ? '' : '正在看第 ' + v.version + ' 版（旧版本）。上面的成果框已换成这一版；点“当前”那一版的“查看”可以切回来。';
    if (v.current && S.format === 'pptx') { deckPreview(); return; }
    $('s-final').textContent = readable(v.text); $('s-final').scrollIntoView({ block: 'nearest' });
  }
  async function download(artifactId) {
    if (typeof artifactId !== 'string') artifactId = undefined; // 点击事件不是版本号
    const res = await fetch('/api/v2/runs/' + encodeURIComponent(S.runId) + '/export', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format: S.format, ...(artifactId ? { artifactId } : {}) }) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (err.code === 'pptx_unusable') return unusableDeck(err.error);
      showError($('s-run-error'), { text: '成果文件暂时生成不了，请稍后再试。', fix: { action: 'retry', label: '再试一次' } }, download); return;
    }
    const v = artifactId && (S.versions || []).find(x => x.artifactId === artifactId);
    const blob = await res.blob(), a = el('a', { href: URL.createObjectURL(blob), download: (S.outputLabel || '成果') + (v ? '-第' + v.version + '版' : '') + '.' + S.format });
    document.body.append(a); a.click(); a.remove();
  }
  /* QA-B7-01：简单模式里返工——用人话写修改意见，再确认一次人民币（本轮的显式批准），不进高级设置 */
  async function rework() {
    $('s-run-error').hidden = true;
    await loadModels();
    let materials = [];
    try { if (S.projectId) materials = (await api('/api/v2/projects/' + encodeURIComponent(S.projectId) + '/files')).files || []; } catch { /* 估算按无资料；引擎仍按实际预留 */ }
    const said = $('s-rework-text').value.trim();
    const r = window.SmartPlan.rework({ models: S.models, snapshot: S.snapshot, feedback: said, capCny: S.capCny, materials, previousChars: (S.lastText || '').length });
    if (!r.ok) return showError($('s-run-error'), r.problems[0], rework);
    if (!(S.reworksLeft > 0) && S.versions) return showError($('s-run-error'), { text: '已经修改到这个任务的上限，不能再改了；可以下载现在的版本，或新建一个任务。', fix: null });
    // B9c：系统判断要改的范围，带上之前的修改对话；在上一版的基础上只改相关部分（引擎把上一版交给审核岗位）
    r.approval.feedback = window.SmartPlan.reviseFeedback({ message: said, history: (S.versions || []).map(v => v.message).filter(Boolean) });
    r.approval.message = said;
    r.scopeText = window.SmartPlan.reviseScope(said);
    const qr = quotaProblem(r); if (qr) return showError($('s-run-error'), { text: qr, fix: null }); // QA-B8 P3-5
    if (!(await confirm({ ...r, isRework: true }))) return;
    $('s-result').hidden = true; $('s-run-error').hidden = true; $('s-state').textContent = '正在按你的意见修改…';
    try {
      await api('/api/v2/runs/' + encodeURIComponent(S.runId) + '/review', 'POST', r.approval);
      $('s-rework-box').hidden = true; $('s-rework-text').value = '';
      $('s-team').textContent = '正在按你的意见修改。' + r.confirmText;
      clearInterval(S.timer); poll(); S.timer = setInterval(poll, 2000);
    } catch (e) { $('s-result').hidden = false; showError($('s-run-error'), window.SmartPlan.explain(e), rework); }
  }
  /* 调整团队：回到简单表单（同样的需求、同样的团队），用“换一个”调整后重新开始；不进高级设置 */
  function adjust() {
    const snap = S.snapshot, pid = S.projectId; reset();
    if (!snap) return;
    if (pid) useProjectFiles(pid).catch(() => {}); // 有资料就沿用同一个任务的资料
    $('s-goal').value = String(snap.description || '').split('\n\n想要的成果')[0];
    const label = ((/想要的成果：(.+)/.exec(snap.description || '') || [])[1] || '').split('\n')[0];
    const key = Object.keys(OUT).find(k => OUT[k].label === label); if (key) document.querySelector(`input[name=s-output][value=${key}]`).checked = true;
    for (const r of snap.roles || []) S.picks[r.roleId] = r.connectionId;
    loadModels().then(() => preview(true)).catch(() => {});
    $('s-plan').scrollIntoView({ block: 'center' });
  }
  function reset() {
    clearInterval(S.timer); S.runId = null; S.picks = {}; S.choice = 'quality'; clearDraft();
    $('home').hidden = true; $('s-progress').hidden = true; $('simple').hidden = false; $('s-error').hidden = true; $('s-plan').hidden = true;
    history.replaceState(null, '', '/workspace.html?new=1');
  }
  /* B5-1 我的任务：一句话汇总 + 按“进行中 / 等你审核 / 已停下 / 已完成 / 草稿”分组的卡片，点卡片进该任务的进度页。
   * 数据来自管理员接口 /api/v2/tasks（顶栏每 5 秒刷新一次并广播 aij:tasks）。 */
  const GROUPS = [['running', '进行中'], ['review', '等你审核'], ['stopped', '已停下'], ['done', '已完成'], ['draft', '草稿']];
  const GTEXT = Object.fromEntries(GROUPS);
  let TASKS = null;
  // AUD-FEB8-01：使用者（以及新建任务页留下的草稿）点草稿卡片 = 回到新建任务页继续，资料都在
  const taskHref = t => t.runId ? '/workspace.html?run=' + encodeURIComponent(t.runId)
    : (document.body.dataset.role === 'user' || t.name === DRAFT_NAME) ? '/workspace.html?draft=' + encodeURIComponent(t.projectId) : '/workspace.html?project=' + encodeURIComponent(t.projectId);
  const when = ts => { const d = Date.now() - ts; return d < 60e3 ? '刚刚' : d < 3600e3 ? Math.floor(d / 60e3) + ' 分钟前' : d < 86400e3 ? Math.floor(d / 3600e3) + ' 小时前' : new Date(ts).toLocaleDateString('zh-CN'); };
  const progressText = t => { if (!t.runId) return '还没开始'; const total = t.stepsTotal || 1; return t.group === 'running' ? '第 ' + Math.min(t.stepsDone + 1, total) + '/' + total + ' 步' + (t.currentRole ? ' · ' + t.currentRole + '正在做' : '') : '完成 ' + t.stepsDone + '/' + total + ' 步'; };
  const running = () => (TASKS ? TASKS.tasks.filter(t => t.group === 'running').sort((a, b) => b.updatedAt - a.updatedAt) : []);
  function card(t) {
    const a = el('a', { className: 'tcard ' + t.group, href: taskHref(t) }, [el('strong', { text: t.name }),
      el('div', { className: 'meta' }, [el('span', { className: 'tag', text: GTEXT[t.group] }), progressText(t)]),
      el('div', { className: 'meta', text: '已花约 ' + spentText(t.costUsd) + ' · ' + when(t.updatedAt) + (t.downloadable && t.group !== 'running' ? ' · 有成果可下载' : '') })]);
    a.dataset.projectId = t.projectId; if (t.runId) a.dataset.runId = t.runId;
    return a;
  }
  function renderHome() {
    const empty = !TASKS || !TASKS.tasks.length;
    $('home-empty').hidden = !empty; $('home-sum').hidden = empty; $('home-groups').hidden = empty;
    $('home-guide').hidden = !(empty && !window.SmartPlan.chat(S.models).length);
    if (!TASKS) return;
    const c = TASKS.counts;
    $('home-sum').textContent = '正在运行 ' + c.running + ' 个（最多同时 ' + TASKS.maxConcurrent + ' 个）· 等你审核 ' + c.review + ' 个 · 已完成 ' + c.done + ' 个' + (c.stopped ? ' · 已停下 ' + c.stopped + ' 个' : '') + (c.draft ? ' · 草稿 ' + c.draft + ' 个' : '');
    $('home-groups').replaceChildren(...GROUPS.map(([g, name]) => { const list = TASKS.tasks.filter(t => t.group === g).sort((a, b) => b.updatedAt - a.updatedAt); return list.length ? el('section', { className: 'tgroup' }, [el('h3', { text: name + '（' + list.length + '）' }), el('div', { className: 'tcards' }, list.map(card))]) : null; }).filter(Boolean));
  }
  function renderRunNav() {
    const list = running(), i = list.findIndex(t => t.runId === S.runId), go = t => location.assign(taskHref(t));
    const others = list.filter(t => t.runId !== S.runId);
    $('s-prev').hidden = $('s-next').hidden = !others.length;
    if (!others.length) return;
    const n = list.length, prev = i >= 0 ? list[(i - 1 + n) % n] : others[others.length - 1], next = i >= 0 ? list[(i + 1) % n] : others[0];
    $('s-prev').onclick = () => go(prev); $('s-next').onclick = () => go(next);
    const mine = TASKS.tasks.find(t => t.runId === S.runId);
    if (mine && !$('s-team').textContent) $('s-team').textContent = '任务：' + mine.name;
  }
  function onTasks(data) {
    if (!data || !Array.isArray(data.tasks)) return;
    TASKS = data; renderHome();
    if (!$('s-progress').hidden) renderRunNav();
  }
  addEventListener('aij:tasks', e => onTasks(e.detail));
  /* B5-F2 F：首页右侧“实时动态”小卡——大屏同一条真实事件流（/api/events），点标题进完整大屏 */
  const LIVE_TEXT = { model_start: '开始调用模型', model_done: '模型完成', model_error: '模型出错', handoff: '交接给下一岗位', task_start: '任务开始', task_done: '任务完成',
    task_error: '任务出错', tool_start: '开始用工具', tool_done: '工具完成', review: '审核', planning: '规划', file_change: '生成文件', test_start: '开始检查', test_result: '检查结果', activity: '动态' };
  const liveItems = [];
  addEventListener('aij:event', e => {
    const v = e.detail; if (!v || v.type !== 'event' || !LIVE_TEXT[v.eventType]) return;
    const when = new Date(v.t || v.timestamp || Date.now()), hh = n => String(n).padStart(2, '0');
    liveItems.unshift({ time: hh(when.getHours()) + ':' + hh(when.getMinutes()) + ':' + hh(when.getSeconds()), who: String(v.label || v.agent || '').slice(0, 24) + (v.role ? ' · ' + String(v.role).slice(0, 12) : ''),
      what: LIVE_TEXT[v.eventType] + (v.source === 'demo' ? '（演示）' : ''), cls: /error/.test(v.eventType) ? 'err' : /done/.test(v.eventType) ? 'ok' : '' });
    liveItems.splice(12);
    $('home-live-list').replaceChildren(...liveItems.map(x => el('li', {}, [el('span', { className: 't', text: x.time }), el('span', { className: 'k ' + x.cls, text: x.what }), el('span', { text: x.who })])));
  });
  /* 从进度页链接直接打开时，按任务当初选的成果格式下载 */
  function restoreFormat(run) {
    const label = ((/想要的成果：(.+)/.exec(run.projectSnapshot && run.projectSnapshot.description || '') || [])[1] || '').split('\n')[0];
    const o = Object.values(OUT).find(x => x.label === label); if (o) { S.format = o.format; S.outputLabel = o.label; }
  }
  /* B5-F2：PPT 的最终输出是幻灯片 JSON——页面上显示成人能读的提纲，不显示原始 JSON */
  /* QA-F2-2：PPT 预览用服务端同一套解析（和下载的 PPT 一致：每页标题 + 要点，不含提示语和 Markdown 符号）
   * QA-F2-1：解析不出合格页面时明确告诉用户，不把空壳当成果，并提供“重新生成” */
  async function deckPreview() {
    let d; try { d = await api('/api/v2/runs/' + encodeURIComponent(S.runId) + '/deck'); } catch { return; }
    if (!d.usable) return unusableDeck('这次 PPT 没能生成合格的页面：' + d.reason + '。');
    // B5-F3 (3): say plainly when the reply had no page structure and how it was paged
    let note = $('s-deck-notice'); if (!note) { note = el('p', { id: 's-deck-notice', className: 'hint', role: 'status' }); $('s-final').before(note); }
    note.textContent = d.notice || ''; note.hidden = !d.notice;
    $('s-final').textContent = d.slides.map((s, i) => {
      const pts = [s.subtitle, s.quote, ...s.bullets, ...s.cards.map(c => c.title + (c.text ? '：' + c.text : '')), ...s.steps.map(c => c.title + (c.text ? '：' + c.text : '')),
        ...[s.left, s.right].filter(Boolean).flatMap(c => [c.title + '：', ...c.bullets.map(b => '  ' + b)])].filter(Boolean);
      return '第 ' + (i + 1) + ' 页　' + s.title + '\n' + pts.map(p => '　· ' + p).join('\n');
    }).join('\n\n');
  }
  function unusableDeck(message, { failed = false } = {}) {
    $('s-download').hidden = true;
    // 等你审核的运行：返工重做审核步骤；已失败的运行不能返工：回到同一目标和团队，重新确认费用后再开始
    const box = $('s-run-error'); box.replaceChildren(el('div', { text: (message || '这次 PPT 没能生成合格的页面。') + ' 没有把空白文件当成成果。' + (failed ? '可以点“重新生成”，用同样的需求和团队再做一次（开始前会再请你确认费用）。' : '可以点“重新生成”，让审核岗位按幻灯片格式重做一遍（会再请你确认一次费用）。') }));
    box.append(el('button', { type: 'button', className: 'fixbtn', id: 's-regenerate', text: '重新生成', onclick: () => { box.hidden = true;
      if (failed) { adjust(); return; }
      $('s-rework-box').hidden = false; $('s-rework-text').value = '上次没有生成合格的演示稿页面，请严格按要求的幻灯片 JSON 格式重新输出完整的演示稿，每页都要有标题和要点。'; $('s-rework-text').focus(); } }));
    box.hidden = false; box.scrollIntoView({ block: 'center' });
  }
  /* 非 PPT 的文字预览：去掉 Markdown 符号（#、**、`），列表符号换成“·” */
  const plain = t => String(t).split('\n').map(l => l.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]*)`/g, '$1')
    .replace(/^(\s*)[-*+]\s+/, '$1· ').replace(/^\s*([-*_])(\s*\1){2,}\s*$/, '')).join('\n').replace(/\n{3,}/g, '\n\n');
  function readable(text) {
    try {
      const j = JSON.parse(String(text).replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, ''));
      if (!j || !Array.isArray(j.slides)) return plain(text);
      return j.slides.map((s, i) => {
        const pts = [...(s.subtitle ? [s.subtitle] : []), ...(s.quote ? [s.quote] : []), ...(s.bullets || []), ...(s.cards || []).map(c => (c.title || '') + (c.text ? '：' + c.text : '')),
          ...(s.steps || []).map(c => (c.title || '') + (c.text ? '：' + c.text : '')), ...['left', 'right'].filter(k => s[k]).flatMap(k => [(s[k].title || '') + '：', ...(s[k].bullets || []).map(b => '  ' + b)])];
        return '第 ' + (i + 1) + ' 页　' + (s.title || '') + '\n' + pts.filter(Boolean).map(p => '　· ' + p).join('\n');
      }).join('\n\n');
    } catch { return plain(text); }
  }
  window.AIJSimple = { reset };
  addEventListener('DOMContentLoaded', async () => {
    build(); bindDrop(); $('s-draft-del').addEventListener('click', discardDraft);
    $('s-go').addEventListener('click', go);
    $('s-preview').addEventListener('click', async () => { $('s-error').hidden = true; await loadModels(); const p = preview(true); if (!p.ok) showError($('s-error'), p.problems[0], () => preview(true)); });
    $('s-advanced').addEventListener('click', () => { document.body.dataset.mode = 'advanced'; });
    $('s-back').addEventListener('click', () => { document.body.dataset.mode = 'simple'; });
    $('s-adjust').addEventListener('click', adjust);
    $('s-rework').addEventListener('click', () => { $('s-rework-box').hidden = false; $('s-rework-text').focus(); });
    $('s-rework-cancel').addEventListener('click', () => { $('s-rework-box').hidden = true; });
    $('s-rework-go').addEventListener('click', rework);
    $('s-new').addEventListener('click', reset);
    $('s-download').addEventListener('click', download);
    $('s-stop-download').addEventListener('click', download);
    $('s-accept').addEventListener('click', async () => { await api('/api/v2/runs/' + encodeURIComponent(S.runId) + '/review', 'POST', { decision: 'approve', feedback: '用户在简单模式确认成果' }); poll(); });
    const q = new URLSearchParams(location.search), user = await isUser();
    if (q.get('project') && !user) document.body.dataset.mode = 'advanced'; // B8：使用者只有简单模式，没有后台式的高级配置
    try { await loadModels(); showAuto(); } catch { /* 页面其余部分仍可用 */ }
    // B9a：刷新页面后恢复还没开始的草稿里的资料
    let kept = null; try { kept = sessionStorage.getItem(DRAFT_KEY); } catch { /* 无痕模式 */ }
    if (q.get('draft')) kept = q.get('draft'); // 从“我的任务”的草稿卡片进来
    const gone = () => { remember(null); if (q.get('draft')) { $('s-busy').textContent = '这个草稿已经不在了（可能已删除，或超过 30 天没动被自动清理），请重新新建任务。'; } };
    if (kept && !q.get('run') && !q.get('project')) useProjectFiles(kept, { onlyDraft: true }).then(okd => { if (!okd) gone(); }).catch(gone);
    if (q.get('run')) { S.runId = q.get('run'); try { const run = (await api('/api/v2/runs/' + encodeURIComponent(S.runId))).run; S.projectId = run.projectId; restoreFormat(run); showProgress(null); } catch { reset(); } }
    else if ((user || !q.get('project')) && q.get('new') !== '1' && !q.get('draft')) {
      // B5-F2：默认落点永远是“我的任务”（顶栏“我的任务”在任何页面点了都显示任务列表）；
      // 一个任务都没有时显示空状态：一句引导 + 大号“＋ 新建任务”（首屏可见，不用滚动）
      $('simple').hidden = true; $('home').hidden = false;
      try { onTasks(await api('/api/v2/tasks')); } catch { TASKS = null; renderHome(); }
    }
    try { if (!TASKS) onTasks(await api('/api/v2/tasks')); else renderRunNav(); } catch { /* 顶栏会继续刷新 */ }
  });
})();
