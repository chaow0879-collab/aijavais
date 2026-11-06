'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.resolve(__dirname, '../..');
const BUSINESS_SHA = '58c52f0084997f669eea763edc7b58e11d3ef4f4';
const TEST_BASE_SHA = '099b9c3e99a5708bd582109d3d05e8fdff4a148c';
const OUT = process.env.QA_GAPS_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'productqa-gaps-evidence-'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function redact(text) {
  return String(text).replace(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/g, '[SETUP_CODE_REDACTED]')
    .replace(/aij_session=[^\s;"']+/g, 'aij_session=[REDACTED]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]');
}
function write(name, data) {
  const file = path.join(OUT, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.isBuffer(data) ? data : typeof data === 'string' ? redact(data) : JSON.stringify(data, null, 2));
  return file;
}
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
async function until(check, label, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await sleep(25); }
  throw Error('Timed out waiting for ' + label);
}
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
});
function sqlSnapshot(dir) {
  const db = new DatabaseSync(path.join(dir, 'projects.sqlite'), { readOnly: true });
  try {
    return {
      integrity: db.prepare('PRAGMA quick_check').get().quick_check,
      schema: db.prepare('PRAGMA user_version').get().user_version,
      requests: db.prepare('SELECT owner_id,kind,request_id,params_hash,state,ledger_id,dispatched_at,settled_at FROM model_requests ORDER BY request_id').all(),
      usage: db.prepare("SELECT doc FROM system_usage WHERE json_extract(doc,'$.kind')='intake_draft' ORDER BY rowid").all().map(row => JSON.parse(row.doc)),
      projects: db.prepare('SELECT count(*) AS n FROM projects').get().n,
    };
  } finally { db.close(); }
}
function draft() {
  return { goal: '独立补测用合成任务，非专业成果', roles: [
    { roleId: 'planner', name: '需求整理', duty: '提出待确认问题', boundary: '不批准费用或执行', standard: '假设清楚', requiredCapabilities: ['writing'] },
    { roleId: 'review', name: '独立复核', duty: '核对证据', boundary: '不替用户验收', standard: '逐项核对', requiredCapabilities: ['writing'] },
  ], steps: [
    { stepId: 's1', roleId: 'planner', title: '梳理输入', prompt: '列出缺失信息', deliverable: '输入表', quality: '可核对', handoff: 'previous' },
    { stepId: 's2', roleId: 'review', title: '审核输入', prompt: '审核前序结果', deliverable: '审核表', quality: '有证据', handoff: 'all' },
  ], deliverables: ['合成方案'], acceptance: ['人工确认'], tools: [], skills: [], humanDecisions: ['确认事实和预算'] };
}
class Provider {
  constructor() { this.mode = 'ok'; this.calls = []; this.probes = 0; this.active = 0; this.peak = 0; this.held = new Set(); }
  async start() {
    this.server = http.createServer((req, res) => {
      let raw = ''; req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        let payload; try { payload = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
        const prompt = payload.messages?.at(-1)?.content || '';
        const isDraft = prompt.startsWith('Design a team');
        if (!isDraft) { this.probes++; this.reply(res, 'QA probe response'); return; }
        const entry = { index: this.calls.length + 1, at: Date.now(), mode: this.mode, path: req.url, promptSha256: hash(prompt), requestBytes: Buffer.byteLength(raw), closedAt: null };
        this.calls.push(entry); this.active++; this.peak = Math.max(this.peak, this.active);
        res.once('close', () => { entry.closedAt = Date.now(); this.active--; this.held.delete(res); });
        if (this.mode.startsWith('error-')) {
          const status = Number(this.mode.slice(6)); res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'QA synthetic provider ' + status } }));
        } else if (this.mode === 'hold') {
          res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': QA held stream\n\n'); this.held.add(res);
        } else this.reply(res, JSON.stringify(draft()));
      });
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    this.port = this.server.address().port; return this;
  }
  reply(res, text) {
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 60 } }) + '\n\ndata: [DONE]\n\n');
  }
  release() { for (const res of [...this.held]) { this.held.delete(res); this.reply(res, JSON.stringify(draft())); } }
  async stop() { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); }
}
class App {
  constructor(provider, label) {
    this.provider = provider; this.label = label;
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-productqa-gaps-'));
    this.events = []; this.serverLog = ''; this.terminations = [];
  }
  async start(fault = '') {
    this.port = await freePort(); this.origin = 'http://127.0.0.1:' + this.port;
    const env = {};
    // Preserve runtime/proxy/CA selectors, and exclude all inherited API keys.
    for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'NODE_PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) if (process.env[key] !== undefined) env[key] = process.env[key];
    Object.assign(env, { PORT: String(this.port), HOST: '127.0.0.1', AIJ_DATA_DIR: this.dir,
      LOCAL_MODEL_TARGETS: '127.0.0.1:' + this.provider.port,
      QA_GAPS_TEST_PROCESS: '1', QA_GAPS_FAULT: fault });
    const args = ['--no-warnings'];
    if (fault) args.push('--require', path.join(__dirname, 'fault-preload.cjs'));
    args.push(path.join(ROOT, 'server.js'));
    this.child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [this.child.stdout, this.child.stderr]) stream.on('data', bytes => { this.serverLog += redact(bytes.toString()); });
    this.child.once('error', error => { this.spawnError = error; });
    await until(async () => {
      if (this.spawnError) throw this.spawnError;
      if (this.child.exitCode !== null) throw Error('Isolated server exited before ready: ' + this.serverLog);
      try { return (await this.call('GET', '/api/auth/status', undefined, false)).status === 200; } catch { return false; }
    }, 'isolated server readiness');
    const auth = await this.call('GET', '/api/auth/status', undefined, false);
    let login;
    if (!auth.json.setup) {
      const code = fs.readFileSync(path.join(this.dir, 'setup-code.txt'), 'utf8').match(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/)?.[0];
      login = await this.call('POST', '/api/auth/setup', { code, password: 'qa-gaps-synthetic-password-2026' }, false, false);
    } else login = await this.call('POST', '/api/auth/login', { password: 'qa-gaps-synthetic-password-2026' }, false, false);
    if (login.status !== 200) throw Error('Fixture login failed: ' + login.status);
    this.cookie = login.cookie; return this;
  }
  async call(method, route, body, authenticated = true, capture = true) {
    const start = Date.now();
    const headers = authenticated && this.cookie ? { cookie: this.cookie } : {};
    if (body !== undefined) { headers['content-type'] = 'application/json'; headers.origin = this.origin; }
    const response = await fetch(this.origin + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90000) });
    const raw = await response.text(); let json; try { json = JSON.parse(raw); } catch { json = null; }
    const result = { status: response.status, json, text: raw, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    if (capture && !route.startsWith('/api/auth/')) this.events.push({ at: start, durationMs: Date.now() - start, method, route, requestId: body?.requestId, status: result.status, body: json });
    return result;
  }
  async register() {
    const response = await this.call('POST', '/api/models', { providerId: 'ollama', modelId: 'QA-GAPS-LOCAL-HTTP', displayName: '独立产品补测 · 本地模拟收费语义', pricingMode: 'paid_api', capabilities: ['writing', 'reasoning'], baseUrl: 'http://127.0.0.1:' + this.provider.port + '/v1' });
    if (response.status !== 200) throw Error('Register fixture model failed: ' + response.text);
    this.mid = response.json.connection.connectionId;
    const probe = await this.call('POST', '/api/models/' + this.mid + '/test', { approvePaid: true, price: { inputPerMillion: 2, outputPerMillion: 4, currency: 'USD' }, maxCost: 1 });
    if (probe.status !== 200 || !probe.json.ok) throw Error('Probe fixture model failed: ' + probe.text);
  }
  input(requestId, changes = {}) { return { requestId, connectionId: this.mid, description: '请为新办公点决策提出可审核方案，城市、租金、预算尚待确认。', approvePaid: true, maxTokens: 32000, maxOutputTokens: 2048, maxCost: 1, price: { inputPerMillion: 2, outputPerMillion: 4, currency: 'USD' }, ...changes }; }
  async terminate(signal = 'SIGTERM') {
    const child = this.child; if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once('exit', (code, actualSignal) => resolve({ code, signal: actualSignal })));
    const at = Date.now(); child.kill(signal);
    let guard; const result = await Promise.race([ended, new Promise(resolve => { guard = setTimeout(() => resolve(null), 7000); })]);
    clearTimeout(guard);
    if (!result) { child.kill('SIGKILL'); this.terminations.push({ requested: signal, forced: true, ...(await ended), elapsedMs: Date.now() - at }); }
    else this.terminations.push({ requested: signal, forced: false, ...result, elapsedMs: Date.now() - at });
    this.cookie = null;
  }
  evidence(extra = {}) { return { label: this.label, businessSha: BUSINESS_SHA, testBaseSha: TEST_BASE_SHA, model: 'LOOPBACK_HTTP_MOCK; paid_api is simulated policy only', calls: this.provider.calls, probes: this.provider.probes, peakProviderHttp: this.provider.peak, http: this.events, terminations: this.terminations, ...extra }; }
  save(extra = {}) { write(this.label + '/evidence.json', this.evidence(extra)); write(this.label + '/server.log', this.serverLog); }
  async cleanup(extra = {}) { await this.terminate(); this.save(extra); fs.rmSync(this.dir, { recursive: true, force: true }); }
}
function manifest() {
  const files = [];
  function visit(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, item.name); if (item.isDirectory()) visit(full); else if (item.name !== 'SHA256SUMS.json') { const bytes = fs.readFileSync(full); files.push({ file: path.relative(OUT, full), bytes: bytes.length, sha256: hash(bytes) }); } } }
  visit(OUT); write('SHA256SUMS.json', files); return files;
}
module.exports = { ROOT, OUT, BUSINESS_SHA, TEST_BASE_SHA, Provider, App, write, until, sleep, sqlSnapshot, hash, manifest };
