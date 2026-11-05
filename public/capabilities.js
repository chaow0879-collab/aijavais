'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const node = (tag, props = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'text') n.textContent = v == null ? '' : String(v); else if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); }
    for (const c of [].concat(children)) if (c) n.append(c);
    return n;
  };
  async function api(path, method = 'GET', body) {
    const res = await fetch(path, { method, credentials: 'same-origin', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { location.assign('/login.html?next=/capabilities.html'); throw Error('请先登录'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Error(data.error || '请求失败（HTTP ' + res.status + '）');
    return data;
  }
  const STATUS = { ok: ['正常', 'ok'], warn: ['需注意', 'warn'], missing: ['缺失', 'missing'] };
  const LEVEL = { required: '必须配置', recommended: '建议配置', optional: '按需配置' };
  const CAP_STATUS = { available: ['可用', 'ok'], needs_setup: ['需要配置', 'warn'], not_implemented: ['尚未实现', 'bad'] };
  const KIND = { builtin: '内置工具', mcp: 'MCP 工具', skill: 'Skill 工作流程', external: '外部服务', planned: '尚未实现' };
  let last = null;

  function tabs(name) {
    for (const t of ['ready', 'caps', 'mcp']) { $('tab-' + t).setAttribute('aria-selected', String(t === name)); $('panel-' + t).hidden = t !== name; }
    try { localStorage.setItem('aij-cap-tab', name); } catch { /* optional */ }
  }
  async function check() {
    const chosen = [...document.querySelectorAll('[data-scenario]:checked')].map(x => x.value);
    const r = await api('/api/v2/readiness?scenarios=' + encodeURIComponent(chosen.join(',') || 'basic'));
    last = r;
    if (!$('scenarios').children.length) {
      for (const [id, label] of Object.entries(r.scenarioNames)) {
        const box = node('input', { type: 'checkbox', value: id }); box.dataset.scenario = '1'; box.checked = r.scenarios.includes(id);
        box.addEventListener('change', () => check().catch(showError));
        $('scenarios').append(node('label', {}, [box, node('span', { text: label })]));
      }
    }
    $('ready-summary').textContent = r.ready ? '必须配置的项目已全部就绪。' : '还有 ' + r.missing.required.length + ' 项必须配置。';
    const missing = $('missing'); missing.replaceChildren();
    for (const level of ['required', 'recommended', 'optional']) {
      const list = r.missing[level];
      const box = node('div', { class: 'group-' + level }, [node('h3', { text: LEVEL[level] + '（' + list.length + '）' })]);
      if (!list.length) box.append(node('p', { class: 'hint', text: '无' }));
      for (const i of list) box.append(node('div', { class: 'item' }, [node('strong', { text: i.label }), node('div', {}, [node('div', { text: i.detail }), node('div', { class: 'hint', text: '怎么做：' + (i.howTo || '—') })])]));
      missing.append(box);
    }
    const checks = $('checks'); checks.replaceChildren();
    for (const i of r.items) {
      const [label, cls] = STATUS[i.status];
      checks.append(node('div', { class: 'item' }, [node('span', { class: 'pill ' + cls, text: label }), node('div', {}, [node('strong', { text: i.label + ' · ' + LEVEL[i.level] }), node('div', { class: 'hint', text: i.detail })])]));
    }
  }
  function listText() {
    if (!last) return '';
    const lines = ['《AIJAVAIS 当前缺失配置清单》', '生成时间：' + new Date(last.generatedAt).toLocaleString(), '使用场景：' + last.scenarios.map(s => last.scenarioNames[s]).join('；'), ''];
    for (const level of ['required', 'recommended', 'optional']) {
      lines.push('【' + LEVEL[level] + '】');
      if (!last.missing[level].length) lines.push('（无）');
      last.missing[level].forEach((i, n) => lines.push(`${n + 1}. ${i.label}：${i.detail}\n   怎么做：${i.howTo || '—'}`));
      lines.push('');
    }
    return lines.join('\n');
  }
  async function caps() {
    const r = await api('/api/v2/capabilities');
    const target = $('caps'); target.replaceChildren();
    for (const kind of ['builtin', 'mcp', 'skill', 'external', 'planned']) {
      const items = r.capabilities.filter(c => c.kind === kind);
      const grid = node('div', { class: 'grid' });
      for (const c of items) {
        const [label, cls] = CAP_STATUS[c.status] || ['未知', 'warn'];
        const meta = node('div', { class: 'meta' }, [node('span', { class: 'pill ' + cls, text: label }), node('span', { class: 'pill', text: c.category || KIND[kind] }),
          c.free === true ? node('span', { class: 'pill', text: '免费' }) : c.free === false ? node('span', { class: 'pill warn', text: '可能收费' }) : null,
          c.needsApiKey ? node('span', { class: 'pill warn', text: '需要 API Key' }) : null]);
        grid.append(node('div', { class: 'cap' }, [node('strong', { text: c.name }), meta, node('p', { text: c.description || '' }),
          c.permissions?.length ? node('p', { class: 'hint', text: '所需权限：' + c.permissions.join('、') }) : null,
          c.howTo ? node('p', { class: 'hint', text: '如何启用：' + c.howTo }) : null,
          c.alternative ? node('p', { class: 'hint', text: '替代方案：' + c.alternative }) : null,
          c.note ? node('p', { class: 'hint', text: c.note }) : null,
          c.usesTools?.length ? node('p', { class: 'hint', text: '引用工具：' + c.usesTools.join('、') }) : null]));
      }
      target.append(node('div', { class: 'card' }, [node('h2', { text: KIND[kind] + '（' + items.length + '）' }), items.length ? grid : node('p', { class: 'hint', text: kind === 'mcp' ? '尚未连接 MCP Server（基础功能不需要）。' : '无' })]));
    }
  }
  async function mcp() {
    $('mcp-note').textContent = '正在连接…';
    const r = await api('/api/v2/tools/discover', 'POST', {});
    const target = $('mcp-servers'); target.replaceChildren();
    if (!r.servers.length) target.append(node('p', { class: 'hint', text: '服务器上没有配置 MCP Server。基础功能不受影响；如需外部工具，请联系服务器管理员按部署文档添加。' }));
    for (const s of r.servers) target.append(node('div', { class: 'item' }, [node('span', { class: 'pill ' + (s.available ? 'ok' : 'bad'), text: s.available ? '连接成功' : '连接失败' }),
      node('div', {}, [node('strong', { text: s.serverId }), node('div', { class: 'hint', text: s.available ? '发现 ' + s.tools + ' 个工具' : '原因：' + (s.error || s.code) })])]));
    $('mcp-note').textContent = '已完成实际连接测试。';
    await caps();
  }
  const showError = e => { $('ready-summary').textContent = e.message; };
  $('tab-ready').addEventListener('click', () => tabs('ready'));
  $('tab-caps').addEventListener('click', () => { tabs('caps'); caps().catch(showError); });
  $('tab-mcp').addEventListener('click', () => tabs('mcp'));
  $('run-check').addEventListener('click', () => check().catch(showError));
  $('mcp-discover').addEventListener('click', () => mcp().catch(e => { $('mcp-note').textContent = e.message; }));
  $('copy-list').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(listText()); $('copy-note').textContent = '已复制。'; }
    catch { const pre = node('pre', { text: listText() }); $('missing').append(pre); $('copy-note').textContent = '浏览器不允许自动复制，请手动选择下方文字。'; }
  });
  let tab = 'ready'; try { tab = localStorage.getItem('aij-cap-tab') || 'ready'; } catch { /* optional */ }
  tabs(['ready', 'caps', 'mcp'].includes(tab) ? tab : 'ready');
  check().catch(showError); caps().catch(showError);
})();
