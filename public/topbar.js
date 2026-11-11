'use strict';
/* B5-1 统一顶栏：任务中心、实时大屏、模型设置、能力中心、智能立项都用同一套。
 * 固定四个入口：我的任务 / ＋ 新建任务 / 实时大屏 / 模型设置，外加“运行中 N”徽标（点开列出运行中的任务，点一项直达进度页）。
 * 数据来自管理员接口 /api/v2/tasks；只读大屏会话拿不到这个接口，顶栏就不出现，大屏的脱敏行为不变。
 * 用法：<script src="/topbar.js" defer></script>；body[data-topbar=overlay] 时浮在右上角（大屏用）。 */
(() => {
  const $ = id => document.getElementById(id);
  const el = (tag, props = {}, kids = []) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (k === 'dataset') Object.assign(n.dataset, v); else n[k] = v; } n.append(...kids); return n; };
  const CSS = `
  .aij-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 14px;background:#0b1622;border-bottom:1px solid #22384f;font:14px/1.4 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#e7f0f8;position:relative;z-index:50}
  .aij-top a,.aij-top button{color:#cfe3f3;text-decoration:none;border:1px solid #2a4560;background:#10202f;border-radius:999px;padding:6px 12px;font:inherit;cursor:pointer;white-space:nowrap}
  .aij-top a:hover,.aij-top button:hover{border-color:#4fb3ff}
  .aij-top a[aria-current=page]{background:#173049;border-color:#4fb3ff;color:#fff}
  .aij-top .aij-new{background:#1f9d55;border-color:#1f9d55;color:#fff;font-weight:700}
  .aij-top .aij-brand{font-weight:800;letter-spacing:.04em;margin-right:6px;color:#fff;border:0;background:none;padding:0}
  .aij-top .aij-run{position:relative}
  .aij-top .aij-run>button{background:#2b1f05;border-color:#d99a00;color:#ffd666}
  .aij-top .aij-run>button.idle{background:#10202f;border-color:#2a4560;color:#9fb6c9}
  .aij-top .aij-menu{position:absolute;right:0;top:calc(100% + 6px);min-width:260px;max-width:min(360px,90vw);background:#0f1d2b;border:1px solid #2a4560;border-radius:10px;padding:6px;box-shadow:0 8px 24px rgba(0,0,0,.4)}
  .aij-top .aij-menu a{display:block;border:0;border-radius:8px;padding:8px 10px;white-space:normal}
  .aij-top .aij-menu a:hover{background:#173049}
  .aij-top .aij-menu small{display:block;color:#8fa6ba}
  .aij-top .aij-sp{flex:1}
  body[data-topbar=overlay] .aij-top{position:fixed;top:8px;right:8px;left:auto;border:1px solid #22384f;border-radius:12px;background:rgba(11,22,34,.92);max-width:calc(100vw - 16px)}
  @media (max-width:640px){.aij-top{padding:8px}.aij-top a,.aij-top button{padding:6px 9px}.aij-top .aij-brand{display:none}.aij-top .aij-sp{display:none}}`;
  const here = location.pathname === '/' ? '/workspace.html' : location.pathname;
  const isNew = new URLSearchParams(location.search).get('new') === '1';
  let bar = null, last = null;
  function render(data) {
    const running = data.tasks.filter(t => t.group === 'running').sort((a, b) => b.updatedAt - a.updatedAt);
    const btn = el('button', { type: 'button', id: 'aij-running', className: running.length ? '' : 'idle', ariaHasPopup: 'true', ariaExpanded: 'false', text: '运行中 ' + running.length });
    const menu = el('div', { className: 'aij-menu', id: 'aij-running-menu', hidden: true, role: 'menu' });
    menu.append(...(running.length ? running.map(t => el('a', { role: 'menuitem', href: '/workspace.html?run=' + encodeURIComponent(t.runId), dataset: { runId: t.runId } }, [t.name,
      el('small', { text: '第 ' + Math.min(t.stepsDone + 1, t.stepsTotal || 1) + '/' + (t.stepsTotal || 1) + ' 步' + (t.currentRole ? ' · ' + t.currentRole + '正在做' : '') })]))
      : [el('a', { role: 'menuitem', href: '/workspace.html', text: '现在没有运行中的任务，去看看我的任务' })]));
    btn.addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.ariaExpanded = String(!menu.hidden); });
    const link = (href, text, extra = {}) => el('a', { href, text, ...extra, ...((href === here && !isNew && href !== '/workspace.html?new=1') || (href === '/workspace.html?new=1' && isNew) ? { ariaCurrent: 'page' } : {}) });
    const next = el('nav', { className: 'aij-top', id: 'aij-topbar', ariaLabel: '主导航' }, [
      el('span', { className: 'aij-brand', text: 'AIJAVAIS' }),
      link('/workspace.html', '我的任务', { id: 'aij-home' }),
      link('/workspace.html?new=1', '＋ 新建任务', { id: 'aij-new', className: 'aij-new' }),
      link('/panel.html', '实时大屏', { id: 'aij-panel' }),
      link('/admin.html', '模型设置', { id: 'aij-models' }),
      el('span', { className: 'aij-sp' }),
      el('span', { className: 'aij-run' }, [btn, menu])]);
    if (bar) bar.replaceWith(next); else document.body.prepend(next);
    bar = next;
  }
  async function refresh() {
    try {
      const res = await fetch('/api/v2/tasks', { credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (!res.ok) { if (bar && (res.status === 401 || res.status === 403)) { bar.remove(); bar = null; } return; } // 只读大屏 / 未登录：不显示
      const data = await res.json(); last = data;
      const open = bar && !$('aij-running-menu')?.hidden;
      render(data);
      if (open) { $('aij-running-menu').hidden = false; $('aij-running').ariaExpanded = 'true'; }
      dispatchEvent(new CustomEvent('aij:tasks', { detail: data }));
    } catch { /* 网络抖动：下次再试 */ }
  }
  window.AIJTopbar = { refresh, get data() { return last; } };
  addEventListener('DOMContentLoaded', () => {
    document.head.append(el('style', { text: CSS }));
    document.addEventListener('click', () => { const m = $('aij-running-menu'); if (m && !m.hidden) { m.hidden = true; $('aij-running').ariaExpanded = 'false'; } });
    refresh(); setInterval(refresh, 5000);
  });
})();
