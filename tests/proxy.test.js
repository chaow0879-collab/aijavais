'use strict';
// Real local sockets, fake provider/proxy. These tests never contact a paid API.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const SEC = require('../lib/security');
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const stop = s => new Promise(r => { s.closeAllConnections?.(); s.close(r); });
function publicPolicy(proxy, extra = {}) {
  return { ...SEC.policyFromEnv({ HTTPS_PROXY: proxy, NO_PROXY: '*' }), lookup: async () => [{ address: '8.8.8.8', family: 4 }], ...extra };
}
function childRequest(proxy, url, ca) {
  const script = `const S=require(${JSON.stringify(require.resolve('../lib/security'))});
    const p=S.policyFromEnv({HTTPS_PROXY:process.argv[1],NO_PROXY:'*'});
    p.lookup=async()=>[{address:'8.8.8.8',family:4}];
    S.pinnedFetch(process.argv[2],{headers:{authorization:'Bearer test-only-key'},signal:AbortSignal.timeout(4000)},p)
    .then(async r=>{console.log(JSON.stringify({status:r.status,text:await r.text()}))})
    .catch(e=>{console.error(e.message);process.exitCode=1});`;
  const env = { ...process.env };
  if (ca) env.NODE_EXTRA_CA_CERTS = ca;
  else delete env.NODE_EXTRA_CA_CERTS;
  return new Promise(resolve => {
    const c = spawn(process.execPath, ['-e', script, proxy, url], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    c.stdout.on('data', b => stdout += b); c.stderr.on('data', b => stderr += b);
    c.once('close', code => resolve({ code, stdout, stderr }));
  });
}

test('proxy: public targets use configured CONNECT despite NO_PROXY; proxy refusal never falls back', async t => {
  const seen = [];
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => { seen.push(req.url); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  const port = await listen(proxy); t.after(() => stop(proxy));
  const p = publicPolicy('http://127.0.0.1:' + port);
  await assert.rejects(SEC.pinnedFetch('https://provider.test/v1', {}, p), /CONNECT.*403/);
  assert.deepEqual(seen, ['provider.test:443']);
});

test('proxy: SSRF classification happens before CONNECT; explicit local targets remain DNS-pinned direct', async t => {
  let connects = 0;
  const proxy = http.createServer(); proxy.on('connect', (_req, socket) => { connects++; socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  const pp = await listen(proxy); t.after(() => stop(proxy));
  const p = publicPolicy('http://127.0.0.1:' + pp, { lookup: async () => [{address:'169.254.169.254',family:4}] });
  await assert.rejects(SEC.pinnedFetch('https://provider.test/v1', {}, p), /被拒绝/);
  const local = http.createServer((_req, res) => res.end('local-model'));
  const lp = await listen(local); t.after(() => stop(local));
  const localPolicy = SEC.policyFromEnv({ HTTPS_PROXY:'http://127.0.0.1:'+pp, LOCAL_MODEL_TARGETS:'127.0.0.1:'+lp });
  const r = await SEC.pinnedFetch('http://127.0.0.1:'+lp+'/', {}, localPolicy);
  assert.equal(await r.text(), 'local-model'); assert.equal(connects, 0);
});

test('proxy: stalled CONNECT is abortable and malformed proxy URLs fail closed', async t => {
  const sockets = new Set();
  const proxy = http.createServer(); proxy.on('connect', (_req, socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const pp = await listen(proxy); t.after(async () => { for (const s of sockets) s.destroy(); await stop(proxy); });
  const p = publicPolicy('http://127.0.0.1:'+pp);
  await assert.rejects(SEC.pinnedFetch('https://provider.test/', { signal:AbortSignal.timeout(80) }, p), /timeout|aborted|取消/i);
  await assert.rejects(SEC.pinnedFetch('https://provider.test/', {}, {...p, httpsProxy:'socks5://127.0.0.1:9999'}), /HTTPS_PROXY/);
});

test('proxy: delegated DNS is explicit, requires proxy plus approved hostname, and never delegates IP/local targets', async () => {
  let lookups = 0;
  const unavailable = async () => { lookups++; throw new Error('no local DNS'); };
  const make = env => ({...SEC.policyFromEnv(env),lookup:unavailable,dnsTimeoutMs:100});
  const base = {HTTPS_PROXY:'http://proxy:8080',AIJ_PROXY_DNS:'delegate'};
  const allowed = make({...base,ALLOWED_BASE_HOSTS:'provider.example'});
  assert.equal((await SEC.resolveTarget('https://provider.example/v1',allowed)).proxyDnsDelegated,true);
  assert.equal((await SEC.resolveTarget('https://api.openai.com/v1',make(base))).proxyDnsDelegated,true);
  assert.equal(lookups,0);
  assert.equal((await SEC.resolveTarget('https://provider.example',make(base))).ok,false,'unlisted custom hostname cannot delegate');
  assert.equal((await SEC.resolveTarget('https://provider.example',make({AIJ_PROXY_DNS:'delegate',ALLOWED_BASE_HOSTS:'provider.example'}))).ok,false,'no proxy means strict DNS');
  assert.equal((await SEC.resolveTarget('https://provider.example',make({HTTPS_PROXY:'http://proxy:8080',ALLOWED_BASE_HOSTS:'provider.example'}))).ok,false,'default remains strict DNS');
  for(const host of ['127.0.0.1','169.254.169.254','[::1]','localhost','model.local']) {
    assert.equal((await SEC.resolveTarget('https://'+host,make({...base,ALLOWED_BASE_HOSTS:host}))).ok,false,host);
  }
  const local = make({...base,LOCAL_MODEL_TARGETS:'provider.example:8443',ALLOWED_BASE_HOSTS:'provider.example'});
  assert.equal((await SEC.resolveTarget('http://provider.example:8443',local)).ok,false,'explicit local models require real pinned DNS');
});

test('proxy: verified TLS tunnel preserves target Host/auth, rejects redirects and untrusted certificates', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-proxy-tls-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=provider.test','-addext','subjectAltName=DNS:provider.test'], {stdio:'ignore'});
  const seen = [], sockets = new Set();
  const target = https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)}, (req,res) => {
    seen.push({host:req.headers.host, auth:req.headers.authorization});
    if (req.url === '/redirect') {res.writeHead(302, {location:'https://other.test/'});return res.end();}
    res.end('verified-local-fake-provider');
  });
  const targetPort = await listen(target); t.after(() => stop(target));
  const proxy = http.createServer();
  proxy.on('connect', (req, socket, head) => {
    assert.match(req.url, /^(provider|wrong)\.test:443$/);
    sockets.add(socket); socket.on('close',()=>sockets.delete(socket));
    const upstream = net.connect(targetPort,'127.0.0.1',()=>{
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    sockets.add(upstream); upstream.on('close',()=>sockets.delete(upstream));
    socket.on('error',()=>upstream.destroy()); upstream.on('error',()=>socket.destroy());
  });
  const proxyPort = await listen(proxy); t.after(async()=>{for(const s of sockets)s.destroy();await stop(proxy);});
  const proxyUrl = 'http://127.0.0.1:'+proxyPort;
  const good = await childRequest(proxyUrl, 'https://provider.test/v1', cert);
  assert.equal(good.code,0,good.stderr);
  assert.deepEqual(JSON.parse(good.stdout),{status:200,text:'verified-local-fake-provider'});
  assert.deepEqual(seen,[{host:'provider.test',auth:'Bearer test-only-key'}]);
  const redirect = await childRequest(proxyUrl, 'https://provider.test/redirect', cert);
  assert.equal(redirect.code,1); assert.match(redirect.stderr,/重定向/);
  const untrusted = await childRequest(proxyUrl,'https://provider.test/v1');
  assert.equal(untrusted.code,1);assert.match(untrusted.stderr,/TLS.*CERT|TLS.*SELF_SIGNED/);
  const wrongHost = await childRequest(proxyUrl,'https://wrong.test/v1',cert);
  assert.equal(wrongHost.code,1);assert.match(wrongHost.stderr,/TLS.*ALTNAME/);
});
