'use strict';
/*
 * 成果存储（Artifact Manager 最小实现，纯内存）。
 * 用途：超过消息正文上限的长输入 / 长草稿 / 长审核意见，完整存为成果，消息只携带预览 + artifactRefs，
 * 接收方按 ID 取回全文 —— 不再静默截断。
 * 隔离：成果按 taskId 存放，只能在本任务内按 ID 读取。
 * 上限：单个成果、单任务总量超限时 put 返回错误（调用方必须让任务失败，而不是带着残缺内容继续）。
 */
const crypto = require('crypto');

const LIMITS = Object.freeze({ maxArtifactChars: 1000000, maxTaskChars: 4000000, maxPerTask: 100 });
const ID_RE = /^art_[a-f0-9]{12}$/;

class ArtifactStore {
  constructor(limits = {}) {
    this.limits = { ...LIMITS, ...limits };
    this.tasks = new Map(); // taskId -> { items: Map, chars }
  }

  put(taskId, { kind = 'text', text, producer = null, label = '' } = {}) {
    if (typeof taskId !== 'string' || !taskId) return { ok: false, error: '缺少 taskId' };
    if (typeof text !== 'string') return { ok: false, error: '成果内容必须是字符串' };
    if (text.length > this.limits.maxArtifactChars) return { ok: false, error: '单个成果超过 ' + this.limits.maxArtifactChars + ' 字符上限' };
    let t = this.tasks.get(taskId);
    if (!t) { t = { items: new Map(), chars: 0 }; this.tasks.set(taskId, t); }
    if (t.items.size >= this.limits.maxPerTask) return { ok: false, error: '本任务成果数量已达上限' };
    if (t.chars + text.length > this.limits.maxTaskChars) return { ok: false, error: '本任务成果总量超过 ' + this.limits.maxTaskChars + ' 字符上限' };
    const artifactId = 'art_' + crypto.randomBytes(6).toString('hex');
    const sha256 = crypto.createHash('sha256').update(text).digest('hex');
    const item = { artifactId, taskId, kind: String(kind).slice(0, 20), label: String(label).slice(0, 60), producer, chars: text.length, sha256, createdAt: Date.now(), text };
    t.items.set(artifactId, item);
    t.chars += text.length;
    return { ok: true, artifact: { ...item } };
  }

  get(taskId, artifactId) {
    if (!ID_RE.test(String(artifactId))) return null;
    const it = this.tasks.get(taskId)?.items.get(artifactId);
    return it ? { ...it } : null;
  }

  /* 列表不含正文 */
  list(taskId) {
    const t = this.tasks.get(taskId);
    return t ? [...t.items.values()].map(({ text, ...meta }) => meta) : [];
  }

  drop(taskId) { this.tasks.delete(taskId); }
}

module.exports = { ArtifactStore, ARTIFACT_LIMITS: LIMITS, ARTIFACT_ID_RE: ID_RE };
