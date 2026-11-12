'use strict';
/* B8 前后台分离：页面先问一次“现在是谁登录”（管理员 / 使用者），写到 body[data-role]。
 * 使用者看不到任何后台入口（.admin-only 在角色确认为管理员之前一律隐藏）；真正的门禁在服务器（后台页面和接口对使用者返回 403）。 */
(() => {
  const style = document.createElement('style');
  style.textContent = 'body:not([data-role=admin]) .admin-only{display:none!important}body:not([data-role=user]) .user-only{display:none!important}';
  document.head.append(style);
  window.AIJRole = fetch('/api/auth/status', { credentials: 'same-origin', headers: { accept: 'application/json' } })
    .then(r => r.json()).then(s => (s && s.kind) || null).catch(() => null);
  const apply = kind => { document.body.dataset.role = kind === 'user' ? 'user' : kind === 'admin' ? 'admin' : 'none'; };
  window.AIJRole.then(kind => { if (document.body) apply(kind); else addEventListener('DOMContentLoaded', () => apply(kind)); });
})();
