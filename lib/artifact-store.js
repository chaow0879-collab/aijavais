'use strict';
/*
 * 持久化成果库（Artifact Manager）。
 *
 * 存储：文件写在 data/artifacts/<taskId>/<artifactId>/v<版本>.<扩展名>；索引在数据库 artifacts / artifact_versions 表。
 * 一致性：先写临时文件 → 计算 SHA-256 → 原子改名 → 再写数据库（事务）；数据库失败则删除刚写的文件。
 *         启动时 verify() 可检查数据库记录与磁盘文件是否一致（缺失 / 哈希不符会被标记，不会静默忽略）。
 * 版本：每次修改生成新版本，记录父版本、创建者、说明；回退 = 以旧版本内容生成新版本（历史不被覆盖）。
 * 审核：每个版本有审核状态 draft / in_review / approved / changes_requested / rejected。
 * 隔离：所有读取都要求 taskId 匹配；跨任务引用一律视为不存在。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const EX = require('./extract');
const { diffText } = require('./diff');

const ID_RE = /^art_[a-f0-9]{12}$/;
const REVIEW = ['draft', 'in_review', 'approved', 'changes_requested', 'rejected'];
const MAX_FILE = 100 * 1024 * 1024;
const safeName = n => String(n || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file';

class ArtifactStore {
  constructor({ db, dir, onEvent = () => {} }) {
    this.db = db; this.dir = dir; this.onEvent = onEvent;
    fs.mkdirSync(dir, { recursive: true });
    this._textCache = new Map(); // `${id}@${v}` -> 提取结果（最近 50 个）
  }
  _file(taskId, artifactId, version, ext) { return path.join(this.dir, taskId, artifactId, `v${version}${ext ? '.' + ext : ''}`); }
  _writeFile(file, buf) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /*
   * 新建成果。input: { name, buffer | text, createdBy: { type: 'agent'|'user'|'tool'|'system', id, roleId }, stepId, note, source（可重建的结构化来源，如幻灯片 JSON） }
   */
  create(taskId, input) {
    if (!taskId) throw new Error('缺少 taskId');
    const name = safeName(input.name);
    const buf = input.buffer ? Buffer.from(input.buffer) : Buffer.from(String(input.text ?? ''), 'utf8');
    if (buf.length > MAX_FILE) throw new Error('文件超过 100MB 上限');
    const artifactId = 'art_' + crypto.randomBytes(6).toString('hex');
    const now = Date.now();
    const meta = { artifactId, taskId, name, kind: EX.kindOf(name), mime: EX.mimeOf(name), currentVersion: 1, reviewStatus: 'draft', createdBy: input.createdBy || { type: 'system' }, stepId: input.stepId || null, createdAt: now, updatedAt: now, deliverable: !!input.deliverable };
    const ver = this._version(taskId, artifactId, 1, name, buf, { createdBy: meta.createdBy, note: input.note || '创建', source: input.source, parentVersion: null, stepId: input.stepId });
    const file = this._file(taskId, artifactId, 1, EX.extOf(name));
    this._writeFile(file, buf);
    this._putVersionTx(meta, ver, file);
    this.onEvent({ type: 'artifact_created', taskId, artifactId, version: 1, name, size: buf.length, createdBy: meta.createdBy, stepId: meta.stepId });
    return { ...meta, version: ver };
  }
  _putVersionTx(meta, ver, file) {
    try {
      this.db.tx(() => {
        this.db.putDoc('artifacts', 'artifact_id', meta.artifactId, meta, { task_id: meta.taskId });
        this._putVersion(ver);
      });
    } catch (e) { try { fs.unlinkSync(file); } catch { /* 已不存在 */ } throw e; }
  }
  _putVersion(ver) {
    const now = Date.now();
    this.db.run('INSERT INTO artifact_versions (artifact_id, version, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(artifact_id, version) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
      ver.artifactId, ver.version, JSON.stringify(ver), ver.createdAt || now, now);
  }
  _version(taskId, artifactId, version, name, buf, { createdBy, note, source, parentVersion, stepId }) {
    return {
      artifactId, taskId, version, name, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      createdBy: createdBy || { type: 'system' }, note: String(note || '').slice(0, 300), parentVersion, stepId: stepId || null,
      source: source === undefined ? null : source, reviewStatus: 'draft', reviews: [], createdAt: Date.now(),
    };
  }

  /* 新版本（修订）。input 同 create，可改名（扩展名必须一致） */
  addVersion(taskId, artifactId, input) {
    const meta = this.get(taskId, artifactId);
    if (!meta) throw new Error('成果不存在或不属于该任务');
    const name = input.name ? safeName(input.name) : meta.name;
    if (EX.extOf(name) !== EX.extOf(meta.name)) throw new Error('新版本的文件类型必须与原文件一致');
    const buf = input.buffer ? Buffer.from(input.buffer) : Buffer.from(String(input.text ?? ''), 'utf8');
    if (buf.length > MAX_FILE) throw new Error('文件超过 100MB 上限');
    const v = meta.currentVersion + 1;
    const ver = this._version(taskId, artifactId, v, name, buf, { createdBy: input.createdBy, note: input.note || '修订', source: input.source, parentVersion: input.parentVersion || meta.currentVersion, stepId: input.stepId });
    const file = this._file(taskId, artifactId, v, EX.extOf(name));
    this._writeFile(file, buf);
    const next = { ...stripVersions(meta), name, currentVersion: v, reviewStatus: 'draft', updatedAt: Date.now() };
    this._putVersionTx(next, ver, file);
    this.onEvent({ type: 'artifact_version', taskId, artifactId, version: v, name, size: buf.length, createdBy: ver.createdBy, stepId: ver.stepId, note: ver.note });
    return { ...next, version: ver };
  }

  get(taskId, artifactId) {
    if (!ID_RE.test(String(artifactId))) return null;
    const meta = this.db.getDoc('artifacts', 'artifact_id', artifactId);
    if (!meta || meta.taskId !== taskId) return null;
    meta.versions = this.db.all('SELECT data FROM artifact_versions WHERE artifact_id = ? ORDER BY version', artifactId).map(r => { const v = JSON.parse(r.data); delete v.source; return v; });
    return meta;
  }
  /* 不限定任务的读取，只供已鉴权的管理员接口使用 */
  getAny(artifactId) {
    if (!ID_RE.test(String(artifactId))) return null;
    const meta = this.db.getDoc('artifacts', 'artifact_id', artifactId);
    return meta ? this.get(meta.taskId, artifactId) : null;
  }
  getVersion(taskId, artifactId, version) {
    const meta = this.db.getDoc('artifacts', 'artifact_id', artifactId);
    if (!meta || meta.taskId !== taskId) return null;
    const v = version ? Number(version) : meta.currentVersion;
    const r = this.db.get('SELECT data FROM artifact_versions WHERE artifact_id = ? AND version = ?', artifactId, v);
    return r ? JSON.parse(r.data) : null;
  }
  list(taskId) { return this.db.listDocs('artifacts', 'task_id = ?', [taskId]); }
  listAll(limit = 500) { return this.db.listDocs('artifacts', '', [], 'updated_at DESC', limit); }

  /* 读取原始字节，并校验 SHA-256（不一致直接报错，不返回被篡改的内容） */
  read(taskId, artifactId, version) {
    const ver = this.getVersion(taskId, artifactId, version);
    if (!ver) throw new Error('成果或版本不存在');
    const file = this._file(taskId, artifactId, ver.version, EX.extOf(ver.name));
    if (!fs.existsSync(file)) throw new Error(`成果文件缺失：${artifactId} v${ver.version}`);
    const buf = fs.readFileSync(file);
    const h = crypto.createHash('sha256').update(buf).digest('hex');
    if (h !== ver.sha256) throw new Error(`成果文件校验失败（SHA-256 不一致）：${artifactId} v${ver.version}`);
    return { buffer: buf, version: ver };
  }
  async extracted(taskId, artifactId, version) {
    const { buffer, version: ver } = this.read(taskId, artifactId, version);
    const key = `${artifactId}@${ver.version}`;
    if (this._textCache.has(key)) return this._textCache.get(key);
    const r = await EX.extract(buffer, ver.name);
    this._textCache.set(key, r);
    if (this._textCache.size > 50) this._textCache.delete(this._textCache.keys().next().value);
    return r;
  }
  /* 按需读取：页（幻灯片 / 工作表 / PDF 页）或字符区间 */
  async readText(taskId, artifactId, { version, page, offset, limit } = {}) {
    const r = await this.extracted(taskId, artifactId, version);
    if (page && r.pages) {
      const p = r.pages.find(x => x.index === Number(page));
      if (!p) return { error: `没有第 ${page} 页（共 ${r.pages.length} 页）`, pages: r.pages.length };
      return { kind: r.kind, page: p.index, title: p.title, ...EX.slice(p.text + (p.notes ? '\n（备注）' + p.notes : ''), { offset, limit }), pages: r.pages.length, shapes: p.shapes };
    }
    return { kind: r.kind, ...EX.slice(r.text, { offset, limit }), pages: r.pages ? r.pages.length : undefined, meta: r.meta };
  }
  getSource(taskId, artifactId, version) {
    const ver = this.getVersion(taskId, artifactId, version);
    return ver ? ver.source : null;
  }

  async diff(taskId, artifactId, from, to) {
    const meta = this.get(taskId, artifactId);
    if (!meta) throw new Error('成果不存在');
    const a = await this.extracted(taskId, artifactId, from || Math.max(1, meta.currentVersion - 1));
    const b = await this.extracted(taskId, artifactId, to || meta.currentVersion);
    return { from: from || Math.max(1, meta.currentVersion - 1), to: to || meta.currentVersion, ...diffText(a.text, b.text) };
  }

  /* 设置某个版本的审核状态，并记录审核意见引用 */
  setReview(taskId, artifactId, version, status, review = null) {
    if (!REVIEW.includes(status)) throw new Error('未知审核状态');
    const meta = this.db.getDoc('artifacts', 'artifact_id', artifactId);
    if (!meta || meta.taskId !== taskId) throw new Error('成果不存在');
    const ver = this.getVersion(taskId, artifactId, version);
    if (!ver) throw new Error('版本不存在');
    ver.reviewStatus = status;
    if (review) ver.reviews = [...(ver.reviews || []), { reviewId: review.reviewId, verdict: review.verdict, by: review.by, at: Date.now() }].slice(-20);
    this.db.tx(() => {
      this._putVersion(ver);
      if (ver.version === meta.currentVersion) { meta.reviewStatus = status; meta.updatedAt = Date.now(); this.db.putDoc('artifacts', 'artifact_id', artifactId, meta, { task_id: taskId }); }
    });
    this.onEvent({ type: 'artifact_review', taskId, artifactId, version: ver.version, status, reviewId: review && review.reviewId });
    return ver;
  }
  markDeliverable(taskId, artifactId, on = true) {
    const meta = this.db.getDoc('artifacts', 'artifact_id', artifactId);
    if (!meta || meta.taskId !== taskId) throw new Error('成果不存在');
    meta.deliverable = !!on; meta.updatedAt = Date.now();
    this.db.putDoc('artifacts', 'artifact_id', artifactId, meta, { task_id: taskId });
    return meta;
  }

  /* 回退：以旧版本内容生成新版本 */
  restore(taskId, artifactId, version, by) {
    const { buffer, version: old } = this.read(taskId, artifactId, version);
    return this.addVersion(taskId, artifactId, { buffer, createdBy: by || { type: 'user' }, note: `回退到 v${old.version}`, parentVersion: old.version, source: this.getSource(taskId, artifactId, old.version) });
  }

  /* 一致性检查：数据库中的每个版本都必须有对应文件且哈希一致 */
  verify() {
    const problems = [];
    for (const r of this.db.all('SELECT data FROM artifact_versions')) {
      const v = JSON.parse(r.data);
      const file = this._file(v.taskId, v.artifactId, v.version, EX.extOf(v.name));
      if (!fs.existsSync(file)) { problems.push({ artifactId: v.artifactId, version: v.version, problem: 'missing' }); continue; }
      const h = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (h !== v.sha256) problems.push({ artifactId: v.artifactId, version: v.version, problem: 'hash_mismatch' });
    }
    return problems;
  }
}
const stripVersions = m => { const { versions, ...rest } = m; return rest; };

module.exports = { ArtifactStore, ARTIFACT_ID_RE: ID_RE, REVIEW_STATUSES: REVIEW, safeName };
