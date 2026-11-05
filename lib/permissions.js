'use strict';
/*
 * 人工团队角色与权限边界（第三阶段只建立数据结构与判定函数；完整的多用户登录与界面在后续阶段）。
 *
 * 角色：系统管理员 / 团队管理员 / 项目负责人 / 普通员工 / 审核人员 / 访客。
 * 判定：can(user, action, resource) —— user = { userId, role, teamIds? }，resource = { ownerId?, teamId? }。
 * 原则：默认拒绝；“查看全部”与“查看自己的”分开；团队管理员只管理自己团队的资源；人工审批由 review.approve 控制。
 */
const ROLES = Object.freeze({
  system_admin: { name: '系统管理员' },
  team_admin: { name: '团队管理员' },
  project_lead: { name: '项目负责人' },
  member: { name: '普通员工' },
  reviewer: { name: '审核人员' },
  guest: { name: '访客' },
});

/* 作用域：all 全部；team 本团队；own 自己创建的；- 无权限 */
const MATRIX = Object.freeze({
  //                    system_admin team_admin project_lead member reviewer guest
  'model.manage':      ['all', '-', '-', '-', '-', '-'],
  'model.use':         ['all', 'team', 'team', 'team', 'team', '-'],
  'team.manage':       ['all', 'team', '-', '-', '-', '-'],
  'team.view':         ['all', 'team', 'team', 'team', 'team', 'team'],
  'task.create':       ['all', 'team', 'team', 'team', '-', '-'],
  'task.view':         ['all', 'team', 'team', 'own', 'team', 'own'],
  'task.cancel':       ['all', 'team', 'team', 'own', '-', '-'],
  'artifact.view':     ['all', 'team', 'team', 'own', 'team', 'own'],
  'review.approve':    ['all', 'team', 'team', '-', 'team', '-'],
  'events.view':       ['all', 'team', 'team', 'team', 'team', 'team'],
  'events.ingest':     ['all', '-', '-', '-', '-', '-'],
  'audit.view':        ['all', 'team', '-', '-', '-', '-'],
});
const ORDER = Object.keys(ROLES);

function scopeOf(role, action) {
  const row = MATRIX[action];
  const i = ORDER.indexOf(role);
  if (!row || i < 0) return '-';
  return row[i];
}

function can(user, action, resource = {}) {
  if (!user || !ROLES[user.role]) return false;
  const scope = scopeOf(user.role, action);
  if (scope === 'all') return true;
  if (scope === 'team') {
    if (!resource.teamId) return !resource.ownerId || resource.ownerId === user.userId;
    return Array.isArray(user.teamIds) && user.teamIds.includes(resource.teamId);
  }
  if (scope === 'own') return !!resource.ownerId && resource.ownerId === user.userId;
  return false;
}

/* 当前单管理员部署：本机 / 管理令牌主体映射为系统管理员 */
function userFromPrincipal(p) {
  if (!p) return null;
  if (p.kind === 'local' || p.kind === 'admin') return { userId: p.id, role: 'system_admin', teamIds: [] };
  if (p.kind === 'viewer') return { userId: 'viewer', role: 'guest', teamIds: [] };
  return null;
}

module.exports = { ROLES, MATRIX, can, scopeOf, userFromPrincipal };
