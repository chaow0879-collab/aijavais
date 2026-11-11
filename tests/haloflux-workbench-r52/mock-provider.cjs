'use strict';
// Local OpenAI-compatible MOCK provider + real server boot for R52 E3 tests. Every reply is
// labelled "R52 MOCK" so no output can be mistaken for a real model (evidence E3_FAKE only).
const http = require('node:http');
const H = require('../helpers');

async function bootWithMock({ dir, holdSteps = false } = {}) {
  const state = { calls: 0, held: [], hold: holdSteps };
  const provider = http.createServer((req, res) => {
    let input = ''; req.on('data', c => { input += c; }); req.on('end', () => {
      state.calls++;
      let last = '';
      try { last = JSON.parse(input).messages.at(-1).content; } catch { last = ''; }
      const step = (/本步骤：([^\n]+)/.exec(last) || [])[1] || '步骤';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const content = '# R52 MOCK 输出：' + step + '\n\n这是本地 Mock 模型的占位输出（E3_FAKE），不是真实 AI 的专业成果。\n\n- 待确认：所有事实与数据\n';
      const send = () => res.end('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 50 } }) + '\n\ndata: [DONE]\n\n');
      if (state.hold) { res.write(': pending\n\n'); state.held.push(send); } else send();
    });
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  const env = { LOCAL_MODEL_TARGETS: '127.0.0.1:' + provider.address().port };
  let app = await H.boot({ env, dir });
  const added = await app.call('POST', '/api/models', { providerId: 'ollama', modelId: 'R52-MOCK', displayName: 'R52 MOCK（本地假模型）',
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, pricingMode: 'local', capabilities: ['reasoning', 'writing', 'coding', 'data_analysis', 'research', 'vision'] });
  if (added.status !== 200 && added.status !== 201) throw new Error('model add failed ' + added.text);
  const model = added.json.connection.connectionId;
  const probe = await app.call('POST', '/api/models/' + model + '/test', {});
  if (!probe.json || probe.json.ok !== true) throw new Error('mock probe failed ' + probe.text);
  state.calls = 0;
  return {
    state, model, env, get app() { return app; },
    release() { const h = state.held.splice(0); for (const f of h) f(); },
    async restart({ hard = false } = {}) {
      const d = app.dir;
      if (hard) { const child = app.child; await new Promise(r => { if (child.exitCode !== null || child.signalCode) return r(); child.once('exit', r); child.kill('SIGKILL'); }); }
      else await app.kill();
      app = await H.boot({ dir: d, env });
    },
    async stop() { try { await app.stop(); } catch { /* already stopped */ } provider.closeAllConnections(); await new Promise(r => provider.close(r)); }
  };
}
async function finish(app, runId, until = s => !['running', 'queued'].includes(s)) {
  for (let i = 0; i < 400; i++) { const r = await app.call('GET', '/api/v2/runs/' + runId); if (until(r.json.run.status)) return r.json.run; await H.sleep(25); }
  throw new Error('run did not settle');
}
module.exports = { bootWithMock, finish };
