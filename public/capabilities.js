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
          c.reason ? node('p', { class: 'hint', text: '当前原因：' + c.reason }) : null,
          c.howTo ? node('p', { class: 'hint', text: '如何启用：' + c.howTo }) : null,
          c.alternative ? node('p', { class: 'hint', text: '替代方案：' + c.alternative }) : null,
          c.note ? node('p', { class: 'hint', text: c.note }) : null,
          c.usesTools?.length ? node('p', { class: 'hint', text: '引用工具：' + c.usesTools.join('、') }) : null]));
      }
      target.append(node('div', { class: 'card' }, [node('h2', { text: KIND[kind] + '（' + items.length + '）' }), items.length ? grid : node('p', { class: 'hint', text: kind === 'mcp' ? '尚未连接 MCP Server（基础功能不需要）。' : '无' })]));
    }
  }
  async function mcp() {
    const r = await api('/api/v2/mcp');
    const target = $('mcp-servers'); target.replaceChildren();
    if (!r.servers.length) target.append(node('p', { class: 'hint', text: '还没有接入任何 MCP Server。基础功能不受影响。' }));
    const toolOptions = [];
    for (const s of r.servers) {
      const t = s.lastTest;
      const status = !s.enabled ? ['已停用', 'warn'] : !t ? ['未测试', 'warn'] : t.available ? ['连接成功', 'ok'] : ['连接失败', 'bad'];
      const where = s.transport === 'http' ? '远程 · ' + s.host + (s.hasToken ? ' · 已保存令牌' : '') : '本机程序 · ' + s.program + '（服务器配置文件管理）';
      const actions = node('div', { class: 'meta' }, [
        node('button', { type: 'button', text: '测试连接', onclick: () => act(async () => { const x = await api('/api/v2/mcp/servers/' + encodeURIComponent(s.serverId) + '/test', 'POST', {}); $('mcp-note').textContent = s.serverId + '：' + (x.state.available ? '连接成功，发现 ' + x.state.tools + ' 个工具' : '失败 — ' + (x.state.hint || x.state.error)); }) }),
        node('button', { type: 'button', text: s.enabled ? '停用' : '启用', onclick: () => act(() => api('/api/v2/mcp/servers/' + encodeURIComponent(s.serverId) + '/' + (s.enabled ? 'disable' : 'enable'), 'POST', {})) }),
        s.removable ? node('button', { type: 'button', text: '移除', onclick: () => act(async () => { if (confirm('移除远程 MCP「' + s.name + '」？保存的令牌会一并删除。')) await api('/api/v2/mcp/servers/' + encodeURIComponent(s.serverId), 'DELETE'); }) }) : null]);
      target.append(node('div', { class: 'item' }, [node('span', { class: 'pill ' + status[1], text: status[0] }), node('div', {}, [node('strong', { text: s.name + '（' + s.serverId + '）' }), node('div', { class: 'hint', text: where + ' · ' + s.tools + ' 个工具' }),
        t && !t.available && s.enabled ? node('div', { class: 'hint', text: '原因：' + (t.error || t.code) + (t.hint ? ' — ' + t.hint : '') }) : null, actions])]));
    }
    $('catalog-note').textContent = r.catalogNote;
    const cat = $('mcp-catalog'); cat.replaceChildren();
    for (const c of r.catalog) cat.append(node('div', { class: 'cap' }, [node('strong', { text: c.name }),
      node('div', { class: 'meta' }, [node('span', { class: 'pill', text: c.category }), node('span', { class: 'pill', text: c.transport === 'http' ? '远程' : '本机程序' }),
        c.free === true ? node('span', { class: 'pill', text: '免费' }) : null, c.needsApiKey ? node('span', { class: 'pill warn', text: '需要 API Key' }) : null, c.network ? node('span', { class: 'pill warn', text: '会联网' }) : null]),
      node('p', { text: c.description }), node('p', { class: 'hint', text: '所需权限：' + c.permissions.join('、') }), node('p', { class: 'hint', text: '安装/连接：' + c.install }),
      c.configExample ? node('pre', { text: '服务器配置文件 servers 中的一项：\n' + JSON.stringify(c.configExample, null, 2) }) : null,
      c.source ? node('a', { href: c.source, target: '_blank', rel: 'noopener', text: '来源与许可证' }) : null]));
    const logs = $('mcp-logs'); logs.replaceChildren();
    if (!r.logs.length) logs.append(node('p', { class: 'hint', text: '暂无记录。' }));
    for (const l of r.logs) logs.append(node('div', { class: 'item' }, [node('span', { class: 'pill ' + (l.status === 'done' ? 'ok' : 'bad'), text: l.status === 'done' ? '成功' : '失败' }),
      node('div', { class: 'hint', text: new Date(l.at).toLocaleString() + ' · ' + l.serverId + ' · ' + (l.action === 'call' ? '调用 ' + l.toolId : '连接测试') + (l.durationMs != null ? ' · ' + l.durationMs + ' ms' : '') + (l.code ? ' · ' + l.code : '') + (l.error ? ' · ' + l.error : '') })]));
    const caps = await api('/api/v2/capabilities');
    for (const c of caps.capabilities.filter(c => c.kind === 'mcp')) toolOptions.push(c);
    $('mcp-try').hidden = !toolOptions.length;
    const sel = $('try-tool'); const keep = sel.value; sel.replaceChildren(...toolOptions.map(c => node('option', { value: c.id, text: c.id + ' — ' + (c.description || c.name) })));
    if (keep) sel.value = keep;
  }
  async function act(fn) { try { await fn(); } catch (e) { $('mcp-note').textContent = e.message; } await mcp().catch(e => { $('mcp-note').textContent = e.message; }); }
  $('add-server').addEventListener('click', () => act(async () => {
    const id = $('add-id').value.trim();
    await api('/api/v2/mcp/servers', 'POST', { id, name: $('add-name').value.trim() || id, url: $('add-url').value.trim(), ...($('add-token').value ? { token: $('add-token').value } : {}) });
    $('add-token').value = '';
    const x = await api('/api/v2/mcp/servers/' + encodeURIComponent(id) + '/test', 'POST', {});
    $('add-note').textContent = x.state.available ? '已添加，连接成功，发现 ' + x.state.tools + ' 个工具。' : '已添加，但连接失败：' + (x.state.hint || x.state.error);
  }));
  $('try-run').addEventListener('click', async () => {
    const out = $('try-result'); out.hidden = false;
    let args; try { args = JSON.parse($('try-args').value || '{}'); } catch { out.textContent = '参数不是有效的 JSON'; return; }
    const toolId = $('try-tool').value;
    try {
      // The server issues a single-use confirmation bound to this tool and these arguments; the user must read the risks first.
      const prep = await api('/api/v2/tools/call/prepare', 'POST', { toolId, args });
      if (prep.risk !== 'read' && !confirm('即将真实调用工具「' + toolId + '」一次。\n\n' + (prep.warnings || []).join('\n') + '\n\n确定继续吗？')) { out.textContent = '已取消，未调用。'; return; }
      const r = await api('/api/v2/tools/call', 'POST', { toolId, args, confirmationId: prep.confirmationId, allowedTools: [toolId] }); out.textContent = JSON.stringify(r.result, null, 2);
    }
    catch (e) { out.textContent = '调用失败：' + e.message; }
    await mcp().catch(() => {});
  });
  const showError = e => { $('ready-summary').textContent = e.message; };
  $('tab-ready').addEventListener('click', () => tabs('ready'));
  $('tab-caps').addEventListener('click', () => { tabs('caps'); caps().catch(showError); });
  $('tab-mcp').addEventListener('click', () => { tabs('mcp'); mcp().catch(e => { $('mcp-note').textContent = e.message; }); });
  $('run-check').addEventListener('click', () => check().catch(showError));
  $('copy-list').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(listText()); $('copy-note').textContent = '已复制。'; }
    catch { const pre = node('pre', { text: listText() }); $('missing').append(pre); $('copy-note').textContent = '浏览器不允许自动复制，请手动选择下方文字。'; }
  });
  let tab = 'ready'; try { tab = localStorage.getItem('aij-cap-tab') || 'ready'; } catch { /* optional */ }
  tabs(['ready', 'caps', 'mcp'].includes(tab) ? tab : 'ready');
  check().catch(showError); caps().catch(showError); if (tab === 'mcp') mcp().catch(e => { $('mcp-note').textContent = e.message; });
})();
