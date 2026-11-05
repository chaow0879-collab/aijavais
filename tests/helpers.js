'use strict';
/*
 * 集成测试公共工具：启动隔离的服务实例（临时数据目录），用真实流程完成“首次设置密码 / 登录”，
 * 之后所有请求自动携带登录会话 Cookie。没有任何测试后门：设置码从服务写出的 data/setup-code.txt 读取。
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TEST_PASSWORD = 'test-password-123456';
const SERVER = path.join(__dirname, '..', 'server.js');
const cookies = new Map(); // port -> "aij_session=..."
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

/* opts: { headers, host, cookie（字符串；false 表示不带会话） } */
function call(port, method, url, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { host: opts.host || 'localhost', ...(opts.headers || {}) };
    const ck = opts.cookie === false ? null : (opts.cookie || cookies.get(port));
    if (ck && !headers.cookie) headers.cookie = ck;
    if (data) { headers['content-type'] = headers['content-type'] || 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, res => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', c => b += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* 非 JSON */ } resolve({ status: res.statusCode, headers: res.headers, json: j, text: b }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const authHeaders = port => (cookies.get(port) ? { cookie: cookies.get(port) } : {});
const cookieFrom = r => { const sc = r.headers['set-cookie']; return sc && sc[0] ? sc[0].split(';')[0] : null; };

async function ensureLogin(port, dir, password = TEST_PASSWORD) {
  const st = (await call(port, 'GET', '/api/auth/status', undefined, { cookie: false })).json;
  let r;
  if (!st.setup) {
    const m = /([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(fs.readFileSync(path.join(dir, 'setup-code.txt'), 'utf8'));
    r = await call(port, 'POST', '/api/auth/setup', { code: m[1], password }, { cookie: false });
  } else r = await call(port, 'POST', '/api/auth/login', { password }, { cookie: false });
  if (r.status !== 200) throw new Error('测试登录失败：' + r.text);
  const c = cookieFrom(r);
  cookies.set(port, c);
  return c;
}

/*
 * 启动服务。opts: { env, dir, preConfig（启动前写入 config.json）, login（默认 true） }
 * 返回 { port, dir, child, cookie, call, kill（等待退出，保留数据目录）, stop（退出并删除数据目录） }
 */
async function boot({ env = {}, dir, preConfig, login = true } = {}) {
  const port = await freePort();
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'aij-t-'));
  if (preConfig) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(preConfig)); }
  const e = { ...process.env, PORT: String(port), HOST: '127.0.0.1', AIJ_DATA_DIR: dir, ...env };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'ADMIN_TOKEN', 'INGEST_TOKEN', 'INGEST_AGENTS', 'AIJ_ENV', 'TRUST_PROXY', 'AIJ_LOCAL_INGEST', 'CLAUDE_MODEL']) if (!(k in env)) delete e[k];
  const child = spawn(process.execPath, ['--no-warnings', SERVER], { env: e, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { up = (await call(port, 'GET', '/api/auth/status', undefined, { cookie: false })).status > 0; } catch { /* 等待启动 */ }
    if (!up) await sleep(100);
  }
  if (!up) { child.kill(); throw new Error('服务未能启动'); }
  if (login) await ensureLogin(port, dir);
  const kill = () => new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); child.kill('SIGTERM'); });
  return {
    port, dir, child, cookie: cookies.get(port),
    call: (m, u, b, o) => call(port, m, u, b, o),
    kill: async () => { await kill(); cookies.delete(port); },
    stop: async () => { await kill(); cookies.delete(port); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/* 订阅 SSE ms 毫秒，返回 { status, evs } */
function sse(port, ms, { cookie, headers = {}, host = 'localhost' } = {}) {
  return new Promise(resolve => {
    const evs = []; let status = 0;
    const h = { host, ...headers };
    const ck = cookie === false ? null : (cookie || cookies.get(port));
    if (ck) h.cookie = ck;
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: h }, res => {
      status = res.statusCode; let buf = ''; res.setEncoding('utf8');
      res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const m = buf.slice(0, i).match(/^data: (.*)$/m); buf = buf.slice(i + 2); if (m) try { evs.push(JSON.parse(m[1])); } catch { /* 忽略 */ } } });
    });
    req.on('error', () => {});
    setTimeout(() => { req.destroy(); resolve({ status, evs }); }, ms);
  });
}

/* 只读打开某个实例的数据库（WAL 模式下可与运行中的服务并发读取） */
function dbAll(dir, sql, ...params) {
  require('../lib/db'); // 屏蔽 node:sqlite 实验特性提示
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(path.join(dir, 'aijavais.db'), { readOnly: true });
  try { return d.prepare(sql).all(...params); } finally { d.close(); }
}
const dbDocs = (dir, table, where = '1=1', ...params) => dbAll(dir, `SELECT data FROM ${table} WHERE ${where}`, ...params).map(r => JSON.parse(r.data));

module.exports = { dbAll, dbDocs, TEST_PASSWORD, call, boot, sse, ensureLogin, authHeaders, cookieFrom, freePort, sleep, cookies };
