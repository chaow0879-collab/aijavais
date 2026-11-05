'use strict';
/*
 * 旧版 JSON 数据 → SQLite（只执行一次）。
 * 步骤：
 *   1. 把旧文件移入 data/backups/pre-v2-<时间>/（目录 0700，文件 0600）；明文的 credentials.json 先用主密钥加密成 credentials.json.enc 再删除原文件。
 *   2. 在一个事务里导入：设置、上报凭证、模型连接、加密凭证、团队、历史任务。
 *   3. 事务成功后写入 meta.legacy_import；任一步失败则回滚，旧文件原样保留，服务带错误退出（不会出现“一半新一半旧”）。
 * 返回 { skipped } 或 { imported, backup, legacyProviders }（legacyProviders 为更早版本 config.providers，交给模型注册中心迁移）。
 */
const fs = require('fs');
const path = require('path');

const FILES = ['config.json', 'models.json', 'credentials.json', 'teams.json', 'tasks.json'];

function importLegacy({ dir, db, vault }) {
  if (db.meta('legacy_import')) return { skipped: true };
  const present = FILES.filter(n => fs.existsSync(path.join(dir, n)));
  if (!present.length) { db.meta('legacy_import', { at: Date.now(), files: [] }); return { skipped: true, fresh: true }; }
  const read = n => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; } };
  const data = Object.fromEntries(present.map(n => [n, read(n)]));
  const imported = { settings: 0, ingestTokens: 0, connections: 0, credentials: 0, teams: 0, tasks: 0 };
  let legacyProviders = [];
  db.tx(() => {
    const cfg = data['config.json'];
    if (cfg && typeof cfg === 'object') {
      if (cfg.settings && typeof cfg.settings === 'object') { db.setSetting('settings', cfg.settings); imported.settings = 1; }
      if (Array.isArray(cfg.ingestTokens)) { db.setSetting('ingestTokens', cfg.ingestTokens); imported.ingestTokens = cfg.ingestTokens.length; }
      if (Array.isArray(cfg.providers)) legacyProviders = cfg.providers;
    }
    const m = data['models.json'];
    for (const c of (m && Array.isArray(m.connections) ? m.connections : [])) {
      if (!c || !c.connectionId) continue;
      db.putDoc('model_connections', 'connection_id', c.connectionId, c);
      imported.connections++;
    }
    const cr = data['credentials.json'];
    for (const [id, k] of Object.entries(cr && typeof cr === 'object' ? cr : {})) {
      db.run('INSERT INTO credentials (connection_id, enc, updated_at) VALUES (?, ?, ?) ON CONFLICT(connection_id) DO UPDATE SET enc = excluded.enc, updated_at = excluded.updated_at', id, vault.encrypt(k || {}), Date.now());
      imported.credentials++;
    }
    const tm = data['teams.json'];
    for (const t of (tm && Array.isArray(tm.teams) ? tm.teams : [])) {
      if (!t || !t.teamId) continue;
      db.putDoc('teams', 'team_id', t.teamId, t);
      imported.teams++;
    }
    const ts = data['tasks.json'];
    for (const t of (Array.isArray(ts) ? ts : [])) {
      if (!t || !t.id) continue;
      if (t.status === 'running') { t.status = 'interrupted'; t.error = '升级到 V2 时任务未完成，已标记中断'; }
      db.putDoc('tasks', 'task_id', String(t.id), t, { kind: t.kind || 'internal', status: t.status || 'unknown', title: String(t.title || '') });
      imported.tasks++;
    }
  });
  /* 导入成功后再移动旧文件（失败时旧文件保持原样） */
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(dir, 'backups', 'pre-v2-' + stamp);
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const n of present) {
    const src = path.join(dir, n);
    if (n === 'credentials.json') {
      fs.writeFileSync(path.join(backup, 'credentials.json.enc'), vault.encrypt(data[n] || {}), { mode: 0o600 });
      fs.unlinkSync(src);
    } else {
      fs.copyFileSync(src, path.join(backup, n));
      try { fs.chmodSync(path.join(backup, n), 0o600); } catch { /* 忽略 */ }
      fs.unlinkSync(src);
    }
  }
  db.meta('legacy_import', { at: Date.now(), files: present, backup: path.relative(dir, backup), imported });
  return { imported, backup, legacyProviders };
}

module.exports = { importLegacy, LEGACY_FILES: FILES };
