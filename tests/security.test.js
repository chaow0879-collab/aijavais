'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const SEC = require('../lib/security');

const policy = (o = {}) => ({ allowedHosts: [], extraPorts: new Set(), localTargets: new Set(), lookup: null, ...o });

test('classifyIp：IPv4 / IPv6 / 映射 / 内嵌地址', () => {
  const table = {
    public: ['8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808'],
    loopback: ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1'],
    private: ['10.0.0.1', '172.16.5.5', '172.31.255.255', '192.168.1.1', 'fd00::1', 'fc00::1', '::ffff:10.0.0.1'],
    blocked: ['169.254.169.254', '0.0.0.0', '100.100.100.200', '224.0.0.1', '255.255.255.255', '192.0.2.1', '::', 'fe80::1',
      'ff02::1', '2001:db8::1', '2001::1', '::1.2.3.4', '64:ff9b::7f00:1', '2002:7f00:1::1', '::ffff:169.254.169.254', 'fec0::1'],
    invalid: ['not-an-ip', '1.2.3'],
  };
  for (const [want, ips] of Object.entries(table)) for (const ip of ips) assert.equal(SEC.classifyIp(ip), want, `${ip} 应为 ${want}`);
});

test('envKey：白名单与官方主机一一绑定（无任何例外）', () => {
  assert.ok(SEC.isAllowedEnvKey('OPENAI_API_KEY') && SEC.isAllowedEnvKey('AIJ_MY_PROXY_KEY') && SEC.isAllowedEnvKey(''));
  for (const bad of ['ADMIN_TOKEN', 'PATH', 'HOME', 'AIJ_KEY', 'aij_x_key', 'AIJ_X_KEY_']) assert.equal(SEC.isAllowedEnvKey(bad), false, bad);
  assert.ok(SEC.envKeyHostOk('OPENAI_API_KEY', 'api.openai.com'));
  assert.equal(SEC.envKeyHostOk('OPENAI_API_KEY', 'evil.example.com'), false);
  assert.equal(SEC.envKeyHostOk('ANTHROPIC_API_KEY', 'api.openai.com'), false);
  assert.ok(SEC.envKeyHostOk('AIJ_MY_PROXY_KEY', 'gateway.example.com'));
  assert.equal(SEC.envKeyHostOk.length, 2, '签名不再接受白名单策略参数');
});

test('checkBaseUrlSyntax：协议、凭据、端口、白名单只收紧不放行', () => {
  const ok = u => SEC.checkBaseUrlSyntax(u, policy()).ok;
  assert.ok(ok('https://api.openai.com/v1'));
  assert.equal(ok('http://api.openai.com/v1'), false, '远程 http 拒绝');
  assert.equal(ok('ftp://x.com'), false);
  assert.equal(ok('https://user:pw@api.openai.com/v1'), false, '内嵌凭据');
  assert.equal(ok('https://api.openai.com/v1?x=1'), false, '查询参数');
  assert.equal(ok('https://api.openai.com:8443/v1'), false, '非 443 端口');
  assert.ok(SEC.checkBaseUrlSyntax('https://api.openai.com:8443/v1', policy({ extraPorts: new Set([8443]) })).ok);
  assert.equal(ok('not a url'), false);
  // 白名单：未列出的主机拒绝；列出的主机仍不能用 http
  const strict = policy({ allowedHosts: ['gw.example.com'] });
  assert.equal(SEC.checkBaseUrlSyntax('https://other.example.com', strict).ok, false);
  assert.ok(SEC.checkBaseUrlSyntax('https://gw.example.com', strict).ok);
  assert.equal(SEC.checkBaseUrlSyntax('http://gw.example.com', strict).ok, false, '白名单不绕过 https');
  assert.equal(SEC.checkBaseUrlSyntax('https://gw.example.com:9443', strict).ok, false, '白名单不绕过端口');
  // 本地模型必须显式声明精确的 host:port
  assert.equal(ok('http://localhost:11434/v1'), false);
  const local = policy({ localTargets: new Set(['localhost:11434']) });
  assert.ok(SEC.checkBaseUrlSyntax('http://localhost:11434/v1', local).local);
  assert.equal(SEC.checkBaseUrlSyntax('http://localhost:11435/v1', local).ok, false, '端口必须精确匹配');
});

test('resolveTarget：所有主机（含官方 / 白名单）都做 DNS 分类', async () => {
  const lk = map => async h => map[h] || [];
  const A = a => [{ address: a, family: a.includes(':') ? 6 : 4 }];
  assert.ok((await SEC.resolveTarget('https://api.openai.com/v1', policy({ lookup: lk({ 'api.openai.com': A('104.18.1.1') }) }))).ok);
  const r1 = await SEC.resolveTarget('https://api.openai.com/v1', policy({ lookup: lk({ 'api.openai.com': A('10.0.0.5') }) }));
  assert.equal(r1.ok, false, '官方主机解析到内网也必须拒绝');
  const strict = policy({ allowedHosts: ['gw.example.com'], lookup: lk({ 'gw.example.com': A('127.0.0.1') }) });
  assert.equal((await SEC.resolveTarget('https://gw.example.com', strict)).ok, false, '白名单主机解析到回环必须拒绝');
  const mixed = policy({ lookup: lk({ 'm.example.com': [...A('8.8.8.8'), ...A('192.168.0.9')] }) });
  assert.equal((await SEC.resolveTarget('https://m.example.com', mixed)).ok, false, '任一地址不安全即拒绝');
  assert.equal((await SEC.resolveTarget('https://2130706433/', policy())).ok, false, '十进制 IP 写法归一化后被拒绝');
  assert.equal((await SEC.resolveTarget('https://[::ffff:7f00:1]/', policy())).ok, false, '映射回环');
  assert.equal((await SEC.resolveTarget('https://nx.example.com', policy({ lookup: async () => { throw new Error('NX'); } }))).ok, false);
  // 本地目标：只能是回环 / 私网，元数据地址永远禁止，公网地址也不算“本地”
  const lt = new Set(['llm.local:8080']);
  assert.ok((await SEC.resolveTarget('http://llm.local:8080/v1', policy({ localTargets: lt, lookup: lk({ 'llm.local': A('192.168.1.20') }) }))).ok);
  assert.equal((await SEC.resolveTarget('http://llm.local:8080/v1', policy({ localTargets: lt, lookup: lk({ 'llm.local': A('169.254.169.254') }) }))).ok, false);
  assert.equal((await SEC.resolveTarget('http://llm.local:8080/v1', policy({ localTargets: lt, lookup: lk({ 'llm.local': A('8.8.8.8') }) }))).ok, false);
});

test('pinnedFetch：固定到校验过的 IP、只解析一次、保留 Host、不跟随重定向', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url });
    if (req.url === '/redir') { res.writeHead(302, { location: 'http://169.254.169.254/' }); return res.end(); }
    if (req.url === '/slow') return; // 不响应，用于测试取消
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"a":1}\n\n'); res.end('data: [DONE]\n\n');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    let lookups = 0;
    const pol = policy({ localTargets: new Set([`rebind.test:${port}`]), lookup: async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }]; } });
    const res = await SEC.pinnedFetch(`http://rebind.test:${port}/v1/chat`, { method: 'POST', body: '{"x":1}', headers: { 'content-type': 'application/json' } }, pol);
    assert.equal(res.status, 200);
    const chunks = []; const reader = res.body.getReader(); const dec = new TextDecoder();
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(dec.decode(value)); }
    assert.match(chunks.join(''), /\[DONE\]/);
    assert.equal(lookups, 1, '一次请求只做一次 DNS 解析（连接固定到该结果）');
    assert.equal(seen[0].host, `rebind.test:${port}`, 'Host 头保留原主机名');
    await assert.rejects(SEC.pinnedFetch(`http://rebind.test:${port}/redir`, { method: 'GET' }, pol), /重定向/);
    await assert.rejects(SEC.pinnedFetch(`http://127.0.0.1:${port}/`, { method: 'GET' }, policy()), /被拒绝/, '未声明的本地目标被拒绝');
    const ac = new AbortController(); setTimeout(() => ac.abort(new Error('stop')), 50);
    await assert.rejects(SEC.pinnedFetch(`http://rebind.test:${port}/slow`, { method: 'GET', signal: ac.signal }, pol), /stop/);
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

test('scrubSecrets：已知密钥与常见密钥形态不进入事件 / 日志', () => {
  const s = SEC.scrubSecrets('Incorrect API key provided: sk-abcdefgh12345678. Authorization: Bearer abcdef1234567890 custom-secret-xyz', ['custom-secret-xyz']);
  assert.ok(!/sk-abcdefgh|abcdef1234567890|custom-secret-xyz/.test(s), s);
  assert.equal(SEC.scrubSecrets('普通错误：HTTP 429'), '普通错误：HTTP 429');
});

test('AuthThrottle / RateLimiter', () => {
  const th = new SEC.AuthThrottle({ max: 3, windowMs: 1000, lockMs: 5000 });
  for (let i = 0; i < 3; i++) th.fail('ip', 1000 + i);
  assert.ok(th.locked('ip', 1100)); assert.equal(th.locked('ip', 7000), false);
  const rl = new SEC.RateLimiter(10, 2);
  const t0 = Date.now() + 1;
  assert.ok(rl.take(t0) && rl.take(t0)); assert.equal(rl.take(t0), false, '突发用尽后拒绝'); assert.ok(rl.take(t0 + 150), '按速率补充后放行');
});
