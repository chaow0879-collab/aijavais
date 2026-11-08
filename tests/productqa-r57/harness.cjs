'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const SUBJECT_ROOT = process.env.QA57_BUSINESS_ROOT || ROOT;
const BUSINESS_SHA = '049a3376a2d08042fcac1833b324bc87b0137ba1';
const TEST_BASE_SHA = '049a3376a2d08042fcac1833b324bc87b0137ba1';
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
class App {
  constructor(provider, label) {
    this.provider = provider; this.label = label;
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-productqa-gaps-'));
    this.events = []; this.serverLog = ''; this.terminations = [];
  }
  async start() {
    this.port = await freePort(); this.origin = 'http://127.0.0.1:' + this.port;
    const env = {};
    // Preserve runtime/proxy/CA selectors, and exclude all inherited API keys.
    for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'NODE_PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) if (process.env[key] !== undefined) env[key] = process.env[key];
    Object.assign(env, { PORT: String(this.port), HOST: '127.0.0.1', AIJ_DATA_DIR: this.dir,
      LOCAL_MODEL_TARGETS: '127.0.0.1:' + this.provider.port,
      QA_GAPS_TEST_PROCESS: '1', AIJ_ENABLE_CODE_EXECUTION: '0' });
    const args = ['--no-warnings'];
    args.push(path.join(SUBJECT_ROOT, 'server.js'));
    this.child = spawn(process.execPath, args, { cwd: SUBJECT_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
module.exports = { ROOT, SUBJECT_ROOT, OUT, BUSINESS_SHA, TEST_BASE_SHA, App, write, until, sleep, hash, manifest };
