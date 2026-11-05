'use strict';
/*
 * 凭证加密（AES-256-GCM）。API Key 在数据库里只以密文存在。
 * 主密钥来源（优先级）：
 *   1. 环境变量 AIJ_MASTER_KEY（任意长度口令，经 scrypt 派生为 32 字节）——适合容器部署，把密钥与数据卷分开保存
 *   2. data/master.key（首次启动自动生成的 32 字节随机密钥，权限 0600）
 * 作用边界：数据库文件或数据库备份单独泄露时不暴露 API Key；若攻击者同时拿到 master.key（或环境变量），仍可解密。
 * 丢失主密钥 = 已保存的 API Key 无法解密（需要重新填写），备份时请同时妥善保存主密钥。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class Vault {
  constructor({ dir, env = process.env }) {
    if (env.AIJ_MASTER_KEY) {
      if (String(env.AIJ_MASTER_KEY).length < 16) throw new Error('AIJ_MASTER_KEY 至少 16 个字符');
      this.key = crypto.scryptSync(String(env.AIJ_MASTER_KEY), 'aijavais-vault-v1', 32);
      this.source = 'env';
    } else {
      const f = path.join(dir, 'master.key');
      if (fs.existsSync(f)) this.key = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64');
      else {
        fs.mkdirSync(dir, { recursive: true });
        this.key = crypto.randomBytes(32);
        fs.writeFileSync(f, this.key.toString('base64') + '\n', { mode: 0o600 });
      }
      if (this.key.length !== 32) throw new Error('data/master.key 格式不正确');
      this.source = 'file';
    }
    this.kid = crypto.createHash('sha256').update(this.key).digest('hex').slice(0, 8); // 密钥指纹（不泄露密钥）
  }
  encrypt(obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return `v1:${this.kid}:` + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }
  decrypt(s) {
    const m = /^v1:([a-f0-9]{8}):(.+)$/.exec(String(s || ''));
    if (!m) throw new Error('密文格式不正确');
    if (m[1] !== this.kid) throw new Error('主密钥不匹配（master.key 或 AIJ_MASTER_KEY 已更换）');
    const b = Buffer.from(m[2], 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
  }
}

module.exports = { Vault };
