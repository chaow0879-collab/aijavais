'use strict';
/* Shared harness for the QA-B9 scripts (ProductQA, independent of tests/ui/b9-smart.e2e.js).
 * Real server.js + SQLite + real Chromium + LOCAL MOCK OpenAI-compatible model. E3. No paid calls. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const H = require('../helpers');

const FX = process.env.QA_FX || path.join(__dirname, 'fx');
const PASSW = 'xiaowang-pass-2026';
const clean = t => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
const BRAND = ['AIJAVAIS', 'Word', 'Excel', 'PPT', 'PDF', 'TXT', 'MD', 'CSV', 'MB', 'HALOFLUX'];
const eng = (t, names = []) => { let x = String(t); for (const w of [...BRAND, ...names].sort((a, b) => b.length - a.length)) x = x.split(w).join(' '); return [...new Set(x.match(/[A-Za-z][A-Za-z_]{2,}/g) || [])]; };
const TECH = /Token|token|USD|美元|\$|API|JSON|provider|capability|null|undefined|模型设置|管理中心|能力中心|智能立项|高级设置|管理后台|价格|单价|密钥|Key\b|local-writer|priced-writer|本地写手|收费写手/;

function makeLogger(OUT) {
  const rows = []; const shots = [];
  const rec = (id, ok, note) => { rows.push({ id, ok, note }); console.log((ok === null ? 'NOTE ' : ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + String(note).slice(0, 560)); };
  return { rows, shots, rec, done: (extra = {}) => { fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ rows, shots, ...extra }, null, 2)); console.log(`DONE rows=${rows.length} fail=${rows.filter(r => r.ok === false).length}`); } };
}

/* mock model: records prompts; clarify JSON for "你是任务助理"; deck JSON for PPT review steps; cites file names found in the prompt */
async function startMock() {
  const state = { bodies: [], clars: [], mode: 'ok', calls: 0, deckPages: 5 };
  const CLAR = goal => JSON.stringify({ understanding: '我理解你要的是一份' + (goal.includes('PPT') ? 'PPT 演示' : '经营小结') + '，重点讲复购和周末客流。', questions: [{ question: '主要给谁看？', options: ['老板', '合伙人', '店员'] }, { question: '想要多长？', options: ['一页', '三页', '五页'] }, { question: '语气偏哪种？', options: ['正式', '轻松'] }], plan: { draft: '根据资料写出初稿', review: '核对数字和出处并定稿' } });
  const deck = n => JSON.stringify({ slides: Array.from({ length: n }, (_, i) => i === 0 ? { layout: 'cover', title: '小店经营小结', subtitle: '三月' } : i === n - 1 ? { layout: 'summary', title: '总结', bullets: ['复购 38%', '周末占 61%'] } : { layout: 'bullets', title: '要点 ' + i, bullets: ['内容 ' + i + 'a', '内容 ' + i + 'b'] }) });
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/models$/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'local-writer' }, { id: 'priced-writer' }] })); }
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const j = JSON.parse(b || '{}'); const all = JSON.stringify(j.messages || ''); const real = j.max_tokens > 32; state.calls += real ? 1 : 0;
      const isClar = all.includes('你是任务助理'); const review = /审核上一步|Previous version of the deliverable/.test(all) || /审核岗位|审核员/.test(all) && /只输出一个 JSON 对象/.test(all);
      if (real) (isClar ? state.clars : state.bodies).push(all);
      let text = '好';
      if (real && isClar) text = state.mode === 'badjson' || all.includes('BADJSON') ? '好的！请问你要给谁看？' : CLAR(all);
      else if (real) {
        const names = [...new Set([...all.matchAll(/\[资料\] ([^（\\\n]+)/g)].map(m => m[1].trim()))];
        const cite = names.length ? '（出处：' + names.join('、') + '）' : '';
        const ans = /答：([^\\]+)/.exec(all); const asked = ans ? '面向' + ans[1] + '。' : '';
        const isPpt = /演示文稿|PPT/.test(all) && /JSON 对象/.test(all);
        const edit = /Previous version of the deliverable/.test(all);
        if (isPpt && review) { let n = state.deckPages; if (edit) { if (/新增一页|加一页/.test(all)) n = state.deckPages + 1; else if (/删除第 ?\d* ?页|删除第 [0-9二三四五]+ 页/.test(all)) n = Math.max(2, state.deckPages - 1); state.deckPages = n; } text = deck(n); }
        else text = (edit ? '【修改版】' : '') + '三月经营小结：复购率 38%，周末客流占 61%。' + asked + cite + (edit ? '（本次修改：' + /修改意见：([^\\]+)/.exec(all)?.[1] + '）' : '');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 300, completion_tokens: 400 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { srv, state, port: srv.address().port };
}

async function boot(OUT) {
  fs.mkdirSync(OUT, { recursive: true });
  const mock = await startMock();
  const app = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mock.port } });
  const base = 'http://localhost:' + app.port;
  const browser = await chromium.launch({ headless: true, env: { ...process.env, LANG: 'C.UTF-8' } });
  const api = (m, u, b) => app.call(m, u, b);
  const mk = async extra => (await api('POST', '/api/models', { providerId: 'ollama', baseUrl: `http://127.0.0.1:${mock.port}/v1`, ...extra })).json.connection.connectionId;
  const localId = await mk({ modelId: 'local-writer', displayName: '本地写手', pricingMode: 'local', capabilities: ['writing', 'reasoning', 'chinese', 'data_analysis'] }); await api('POST', '/api/models/' + localId + '/test', {});
  const paidId = await mk({ modelId: 'priced-writer', displayName: '收费写手', pricingMode: 'paid_api', capabilities: ['writing', 'reasoning', 'chinese', 'data_analysis'], price: { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 1 } }); await api('POST', '/api/models/' + paidId + '/test', { approvePaid: true }); await api('POST', '/api/models/' + paidId + '/disable', {});
  const adminCtx = async () => { const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true }); await c.addCookies([{ name: 'aij_session', value: H.cookies.get(app.port).split('=')[1], domain: 'localhost', path: '/' }]); return c; };
  const loginAs = async (name, pw = PASSW) => { const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true }); const p = await c.newPage(); await p.goto(base + '/login.html'); await p.fill('#un', name); await p.fill('#upw', pw); await p.click('#userBtn'); await p.waitForURL(/workspace\.html/); await p.waitForTimeout(900); return p; };
  const mkUser = async (name, cap) => (await api('POST', '/api/v2/users', { username: name, password: PASSW, monthlyCapCny: cap })).json.user.userId;
  const close = async () => { await browser.close(); await app.stop(); mock.srv.close(); };
  return { app, base, browser, api, mock, state: mock.state, localId, paidId, adminCtx, loginAs, mkUser, close };
}

const buf = (name, mime = 'application/octet-stream') => ({ name, mimeType: mime, buffer: fs.readFileSync(path.join(FX, name)) });
module.exports = { fs, path, H, FX, PASSW, clean, eng, TECH, makeLogger, boot, buf };
