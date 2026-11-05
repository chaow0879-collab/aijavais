'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
function call(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* 非 JSON */ } resolve({ status: res.statusCode, json: j, text: b }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
/* 收集 SSE 事件 ms 毫秒 */
function collectSSE(port, ms) {
  return new Promise(resolve => {
    const evs = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, res => {
      let buf = '';
      res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); const m = blk.match(/^data: (.*)$/m); if (m) { try { evs.push(JSON.parse(m[1])); } catch { /* 忽略 */ } } } });
    });
    setTimeout(() => { req.destroy(); resolve(evs); }, ms);
  });
}
async function startServer(extraEnv = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-'));
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', AIJ_DATA_DIR: dir, ...extraEnv };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'ADMIN_TOKEN']) if (!(k in extraEnv)) delete env[k];
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await call(port, 'GET', '/api/state')).status === 200) break; } catch { /* 等待启动 */ } await new Promise(r => setTimeout(r, 100)); }
  return { port, dir, stop: () => new Promise(r => { child.once('exit', () => { fs.rmSync(dir, { recursive: true, force: true }); r(); }); child.kill('SIGTERM'); }) };
}

test('服务接口：供应商校验、密钥绑定、配置不回传令牌、事件来源标记', async t => {
  const S = await startServer();
  t.after(S.stop);
  const post = (u, b) => call(S.port, 'POST', u, b);
  const count = async () => (await call(S.port, 'GET', '/api/config')).json.providers.length;

  // 配置接口不再回传管理令牌
  const cfg = await call(S.port, 'GET', '/api/config');
  assert.equal(cfg.status, 200);
  assert.ok(!('token' in cfg.json), '/api/config 不得包含 token');

  // 校验失败：400，且不留下任何半成品
  const cases = [
    [{ label: 'x', envKey: 'ADMIN_TOKEN', baseUrl: 'https://api.openai.com/v1' }, 'envKey 不在白名单'],
    [{ label: 'x', envKey: 'PATH', baseUrl: 'https://api.openai.com/v1' }, 'envKey 不在白名单'],
    [{ label: 'x', baseUrl: 'http://169.254.169.254/latest' }, '元数据地址 / http'],
    [{ label: 'x', baseUrl: 'http://api.openai.com/v1' }, '远程 http'],
    [{ label: 'x', baseUrl: 'https://user:pw@api.openai.com/v1' }, '内嵌凭据'],
    [{ label: 'x', baseUrl: 'https://api.openai.com:8443/v1' }, '非 443 端口'],
    [{ label: 'x', envKey: 'OPENAI_API_KEY', baseUrl: 'https://evil.example.com/v1' }, '官方密钥发往第三方主机'],
    [{ label: 'x', envKey: 'ANTHROPIC_API_KEY', baseUrl: 'https://api.openai.com/v1' }, '官方密钥张冠李戴'],
  ];
  for (const [body, why] of cases) {
    const r = await post('/api/providers', body);
    assert.equal(r.status, 400, why + ' 应被拒绝：' + r.text);
  }
  assert.equal(await count(), 0, '失败的请求不得创建供应商');

  // 合法：官方预设、自带 Key 的第三方、AIJ_ 自定义环境变量
  assert.equal((await post('/api/providers', { label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', model: 'm' })).status, 200);
  const third = await post('/api/providers', { label: 'Gateway', type: 'openai', baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-test-abcdefghijkl', model: 'm' });
  assert.equal(third.status, 200);
  assert.equal((await post('/api/providers', { label: 'Gw2', baseUrl: 'https://gw2.example.com/v1', envKey: 'AIJ_GW2_KEY', model: 'm' })).status, 200);
  assert.equal(await count(), 3);

  // 已保存的 Key 不会自动转发到新主机
  const id = third.json.provider.id;
  const move = await post('/api/providers', { id, label: 'Gateway', baseUrl: 'https://other.example.com/v1', model: 'm' });
  assert.equal(move.status, 400, move.text);
  assert.match(move.json.error, /重新填写 API Key/);
  assert.equal((await post('/api/providers', { id, label: 'Gateway', baseUrl: 'https://other.example.com/v1', apiKey: 'sk-new-abcdefghijkl', model: 'm' })).status, 200);
  assert.ok(!JSON.stringify((await call(S.port, 'GET', '/api/config')).json).includes('sk-new-abcdefghijkl'), '配置接口不回传完整密钥');

  // 连接测试同样受 SSRF 防护：https://localhost 解析到回环，被拒绝，且错误信息不含密钥
  const lh = await post('/api/providers', { label: 'Loop', baseUrl: 'https://localhost/v1', apiKey: 'sk-loop-abcdefghijkl', model: 'm' });
  assert.equal(lh.status, 200);
  const tr = await post(`/api/providers/${lh.json.provider.id}/test`, {});
  assert.equal(tr.json.ok, false);
  assert.match(tr.json.error, /被拒绝/);
  assert.ok(!tr.text.includes('sk-loop-abcdefghijkl'));

  // 事件来源：外部上报强制 external，忽略客户端声称的 source；演示强制 demo
  const pending = collectSSE(S.port, 900);
  await new Promise(r => setTimeout(r, 200));
  const ev = await post('/api/event', { agent: 'hook-x', status: 'start', task: 't', source: 'server', verification: 'observed' });
  assert.equal(ev.status, 200); assert.ok(ev.json.eventId);
  await post('/api/demo', { seconds: 6 });
  const evs = (await pending).filter(e => e.type === 'event');
  const ext = evs.find(e => e.agentId === 'hook-x');
  assert.equal(ext.source, 'external');
  assert.ok(ext.eventId && ext.eventType === 'task_start' && ext.timestamp && ext.v === 1, JSON.stringify(ext));
  assert.ok(evs.filter(e => String(e.agentId).startsWith('demo-')).every(e => e.source === 'demo'));
  assert.equal((await post('/api/event', { agent: 'x', eventType: 'bogus' })).status, 400);
});
