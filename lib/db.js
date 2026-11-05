'use strict';
/*
 * 持久化数据库（SQLite，Node 内置 node:sqlite，零原生依赖）。
 *
 * 设计：每张业务表 = 若干索引列 + 一个 JSON 文档列（data）。
 *   - 索引列用于查询与约束（task_id、status、时间），文档列保存完整对象，结构演进不必频繁改表。
 *   - 这种“键列 + JSON 文本”的写法在 MySQL 上同样可用（TEXT / JSON 列），为将来的 MySQL 适配保留可能。
 * WAL 模式 + busy_timeout，支持读写并发；事务可嵌套（SAVEPOINT）。
 * 迁移：MIGRATIONS 按版本号顺序执行，已执行的版本记录在 schema_migrations 中。
 */
const fs = require('fs');
const path = require('path');

/* node:sqlite 在 Node 22 中仍标记为实验特性，只屏蔽这一条提示，其它警告照常输出 */
const _emit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  const msg = typeof w === 'string' ? w : (w && w.message) || '';
  if (/SQLite is an experimental feature/.test(msg)) return;
  return _emit.call(process, w, ...rest);
};
const { DatabaseSync } = require('node:sqlite');

const doc = (extra = '') => `data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL${extra}`;
const MIGRATIONS = [
  {
    version: 1, name: 'v2 初始结构',
    sql: `
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS model_connections (connection_id TEXT PRIMARY KEY, ${doc()});
      CREATE TABLE IF NOT EXISTS credentials (connection_id TEXT PRIMARY KEY, enc TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS teams (team_id TEXT PRIMARY KEY, ${doc()});
      CREATE TABLE IF NOT EXISTS roles (role_id TEXT PRIMARY KEY, builtin INTEGER NOT NULL DEFAULT 0, ${doc()});
      CREATE TABLE IF NOT EXISTS skills (skill_id TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, builtin INTEGER NOT NULL DEFAULT 0, ${doc()}, PRIMARY KEY (skill_id, version));
      CREATE TABLE IF NOT EXISTS mcp_servers (server_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, ${doc()});
      CREATE TABLE IF NOT EXISTS tool_settings (tool_id TEXT PRIMARY KEY, ${doc()});
      CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', ${doc()});
      CREATE INDEX IF NOT EXISTS tasks_kind_status ON tasks (kind, status);
      CREATE INDEX IF NOT EXISTS tasks_created ON tasks (created_at);
      CREATE TABLE IF NOT EXISTS steps (step_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, ${doc()});
      CREATE INDEX IF NOT EXISTS steps_task ON steps (task_id);
      CREATE TABLE IF NOT EXISTS agent_instances (instance_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, ${doc()});
      CREATE INDEX IF NOT EXISTS agents_task ON agent_instances (task_id);
      CREATE TABLE IF NOT EXISTS messages (message_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, ${doc()});
      CREATE INDEX IF NOT EXISTS messages_task ON messages (task_id, created_at);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, event_type TEXT NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_task ON events (task_id, seq);
      CREATE TABLE IF NOT EXISTS tool_calls (call_id TEXT PRIMARY KEY, task_id TEXT, step_id TEXT, status TEXT NOT NULL, tool_id TEXT NOT NULL, ${doc()});
      CREATE INDEX IF NOT EXISTS tool_calls_task ON tool_calls (task_id, created_at);
      CREATE TABLE IF NOT EXISTS artifacts (artifact_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, ${doc()});
      CREATE INDEX IF NOT EXISTS artifacts_task ON artifacts (task_id);
      CREATE TABLE IF NOT EXISTS artifact_versions (artifact_id TEXT NOT NULL, version INTEGER NOT NULL, ${doc()}, PRIMARY KEY (artifact_id, version));
      CREATE TABLE IF NOT EXISTS reviews (review_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, ${doc()});
      CREATE INDEX IF NOT EXISTS reviews_task ON reviews (task_id);
      CREATE TABLE IF NOT EXISTS ledger (entry_id TEXT PRIMARY KEY, task_id TEXT, step_id TEXT, connection_id TEXT, kind TEXT NOT NULL, ${doc()});
      CREATE INDEX IF NOT EXISTS ledger_task ON ledger (task_id, created_at);
      CREATE INDEX IF NOT EXISTS ledger_conn ON ledger (connection_id, created_at);
      CREATE TABLE IF NOT EXISTS approvals (approval_id TEXT PRIMARY KEY, task_id TEXT, status TEXT NOT NULL, ${doc()});
      CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status, created_at);
      CREATE TABLE IF NOT EXISTS facts (fact_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, ${doc()});
      CREATE INDEX IF NOT EXISTS facts_task ON facts (task_id);
    `,
  },
];

function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fresh = !fs.existsSync(file);
  const raw = new DatabaseSync(file);
  if (fresh) { try { fs.chmodSync(file, 0o600); } catch { /* Windows 等平台忽略 */ } }
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  const cache = new Map();
  const stmt = sql => { let s = cache.get(sql); if (!s) { s = raw.prepare(sql); cache.set(sql, s); } return s; };
  let depth = 0, sp = 0;
  const api = {
    raw, file,
    exec: sql => raw.exec(sql),
    get: (sql, ...p) => stmt(sql).get(...p),
    all: (sql, ...p) => stmt(sql).all(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    /* 事务：嵌套时使用 SAVEPOINT；出错整体回滚 */
    tx(fn) {
      const name = depth ? `sp${++sp}` : null;
      raw.exec(name ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
      depth++;
      try {
        const r = fn();
        depth--;
        raw.exec(name ? `RELEASE ${name}` : 'COMMIT');
        return r;
      } catch (e) {
        depth--;
        try { raw.exec(name ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK'); } catch { /* 已回滚 */ }
        throw e;
      }
    },
    close: () => { try { raw.close(); } catch { /* 已关闭 */ } },

    /* ---------- 元数据 / 设置 ---------- */
    meta(key, value) {
      if (value === undefined) { const r = api.get('SELECT value FROM meta WHERE key = ?', key); return r ? JSON.parse(r.value) : undefined; }
      api.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
      return value;
    },
    setting(key, dflt) { const r = api.get('SELECT value FROM settings WHERE key = ?', key); return r ? JSON.parse(r.value) : dflt; },
    setSetting(key, value) { api.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', key, JSON.stringify(value), Date.now()); },

    /* ---------- 文档表通用读写 ---------- */
    getDoc(table, keyCol, id) { const r = api.get(`SELECT data FROM ${table} WHERE ${keyCol} = ?`, id); return r ? JSON.parse(r.data) : null; },
    /* cols：额外索引列 { status: 'running', task_id: 't1' } */
    putDoc(table, keyCol, id, data, cols = {}) {
      const now = Date.now();
      const names = Object.keys(cols);
      const ex = api.get(`SELECT created_at FROM ${table} WHERE ${keyCol} = ?`, id);
      const created = ex ? ex.created_at : (data && Number.isFinite(data.createdAt) ? data.createdAt : now);
      const all = [keyCol, ...names, 'data', 'created_at', 'updated_at'];
      const sql = `INSERT INTO ${table} (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')}) ON CONFLICT(${keyCol}) DO UPDATE SET ${[...names, 'data', 'updated_at'].map(n => `${n} = excluded.${n}`).join(', ')}`;
      api.run(sql, id, ...names.map(n => cols[n]), JSON.stringify(data), created, now);
    },
    delDoc(table, keyCol, id) { return api.run(`DELETE FROM ${table} WHERE ${keyCol} = ?`, id).changes; },
    listDocs(table, where = '', params = [], order = 'created_at ASC', limit = 10000) {
      return api.all(`SELECT data FROM ${table} ${where ? 'WHERE ' + where : ''} ORDER BY ${order} LIMIT ${Number(limit) | 0}`, ...params).map(r => JSON.parse(r.data));
    },
  };
  migrate(api);
  return api;
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const done = new Set(db.all('SELECT version FROM schema_migrations').map(r => r.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    db.tx(() => {
      db.exec(m.sql);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, Date.now());
    });
  }
  return db.all('SELECT version, name, applied_at FROM schema_migrations ORDER BY version');
}

/* 在线备份：VACUUM INTO 生成一致的快照文件 */
function backupDb(db, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.unlinkSync(target);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  try { fs.chmodSync(target, 0o600); } catch { /* 忽略 */ }
  return target;
}

module.exports = { openDb, migrate, backupDb, MIGRATIONS };
