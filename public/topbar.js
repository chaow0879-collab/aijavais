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
  .aij-top .aij-watch{color:#9fb6c9;white-space:nowrap}.aij-top select{background:#10202f;color:#e7f0f8;border:1px solid #2a4560;border-radius:8px;padding:5px 8px;font:inherit;max-width:180px}
  body[data-topbar=overlay] .aij-top{position:fixed;top:6px;right:8px;left:auto;gap:5px;padding:4px 6px;font-size:12px;border:1px solid #22384f;border-radius:10px;background:rgba(11,22,34,.9);max-width:calc(100vw - 16px)}
  body[data-topbar=overlay] .aij-top a,body[data-topbar=overlay] .aij-top button{padding:3px 8px}
  body[data-topbar=overlay] .aij-top .aij-brand,body[data-topbar=overlay] .aij-top .aij-sp{display:none}
  body[data-topbar=overlay] .aij-top select{padding:2px 6px;max-width:140px}
  @media (max-width:640px){.aij-top{padding:8px}.aij-top a,.aij-top button{padding:6px 9px}.aij-top .aij-brand{display:none}.aij-top .aij-sp{display:none}}`;
  const here = location.pathname === '/' ? '/workspace.html' : location.pathname;
  const isNew = new URLSearchParams(location.search).get('new') === '1';
  let bar = null, last = null;
  /* B5-F2：导航链接只建一次，之后每 5 秒只就地更新徽标、下拉和“看哪个任务”。
   * 以前每次刷新都整条替换，鼠标按下与松开之间被替换的话，这次点击就丢了（“点了没反应”）。 */
  let btn = null, menu = null, watchBox = null;
  function build() {
    btn = el('button', { type: 'button', id: 'aij-running', className: 'idle', ariaHasPopup: 'true', ariaExpanded: 'false', text: '运行中 0' });
    menu = el('div', { className: 'aij-menu', id: 'aij-running-menu', hidden: true, role: 'menu' });
    btn.addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.ariaExpanded = String(!menu.hidden); });
    menu.addEventListener('click', e => e.stopPropagation());
    watchBox = el('span', { className: 'aij-watchbox', id: 'aij-watchbox' });
    const link = (href, text, extra = {}) => el('a', { href, text, ...extra, ...((href === here && !isNew && href !== '/workspace.html?new=1') || (href === '/workspace.html?new=1' && isNew) ? { ariaCurrent: 'page' } : {}) });
    bar = el('nav', { className: 'aij-top', id: 'aij-topbar', ariaLabel: '主导航' }, [
      el('span', { className: 'aij-brand', text: 'AIJAVAIS' }),
      link('/workspace.html', '我的任务', { id: 'aij-home' }),
      link('/workspace.html?new=1', '＋ 新建任务', { id: 'aij-new', className: 'aij-new' }),
      link('/panel.html', '实时大屏', { id: 'aij-panel' }),
      link('/admin.html', '模型设置', { id: 'aij-models' }),
      el('span', { className: 'aij-sp' }),
      el('span', { className: 'aij-run' }, [btn, menu]), watchBox]);
    document.body.prepend(bar);
  }
  function render(data) {
    if (!bar) build();
    const running = data.tasks.filter(t => t.group === 'running').sort((a, b) => b.updatedAt - a.updatedAt);
    btn.textContent = '运行中 ' + running.length; btn.className = running.length ? '' : 'idle';
    menu.replaceChildren(...(running.length ? running.map(t => el('a', { role: 'menuitem', href: '/workspace.html?run=' + encodeURIComponent(t.runId), dataset: { runId: t.runId } }, [t.name,
      el('small', { text: '第 ' + Math.min(t.stepsDone + 1, t.stepsTotal || 1) + '/' + (t.stepsTotal || 1) + ' 步' + (t.currentRole ? ' · ' + t.currentRole + '正在做' : '') })]))
      : [el('a', { role: 'menuitem', href: '/workspace.html', text: '现在没有运行中的任务，去看看我的任务' })]));
    if (!watchBox.contains(document.activeElement)) watchBox.replaceChildren(...watchPicker(running));
  }
  /* 大屏专用“看哪个任务”：默认最新运行中的任务；显示它在第几步、谁在做，并可一键进它的进度页 */
  let watching = null;
  function watchPicker(running) {
    if (document.body.dataset.topbar !== 'overlay' || !running.length) return [];
    if (!running.some(t => t.runId === watching)) watching = running[0].runId;
    const t = running.find(x => x.runId === watching);
    const sel = el('select', { id: 'aij-watch', ariaLabel: '看哪个任务', onchange: e => { watching = e.target.value; if (last) { watchBox.replaceChildren(); render(last); } } },
      running.map(x => el('option', { value: x.runId, text: x.name, selected: x.runId === watching })));
    const info = el('a', { id: 'aij-watch-info', href: '/workspace.html?run=' + encodeURIComponent(t.runId), text: '第 ' + Math.min(t.stepsDone + 1, t.stepsTotal || 1) + '/' + (t.stepsTotal || 1) + ' 步' + (t.currentRole ? ' · ' + t.currentRole + '正在做' : '') + ' · 看进度' });
    return [el('label', { className: 'aij-watch' }, ['看哪个任务 ', sel]), info];
  }
  async function refresh() {
    try {
      const res = await fetch('/api/v2/tasks', { credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (!res.ok) { if (bar && (res.status === 401 || res.status === 403)) { bar.remove(); bar = null; } return; } // 只读大屏 / 未登录：不显示
      const data = await res.json(); last = data;
      render(data);
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
