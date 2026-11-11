'use strict';
// R54 E3 harness: boots the CURRENT checkout (HTTP + auth + SQLite) with a local MOCK model.
// C1 consolidation: the historical overlay onto the frozen R53 backend (397b46c) now lives only on the
// frozen relay ref claude/relay-r57-final (tools/universal-workflow-r53/run-r54-integrated.cjs there);
// the product suite runs these unchanged R54 assertions against this exact tree, as that runner did in memory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..', '..');
const R53_SHA = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return 'WORKING_TREE'; } })();
const OWNED = ['public/haloflux-workbench-r52', 'public/project-intake', 'public/project-intake.html'];

let cached = null;
function materialize() {
  if (cached) return cached;
  const files = [];
  const walk = d => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else files.push(path.relative(ROOT, p)); } };
  for (const rel of OWNED) { const p = path.join(ROOT, rel); if (fs.statSync(p).isDirectory()) walk(p); else files.push(rel); }
  cached = { dir: ROOT, r53: R53_SHA, overlaid: files.sort(), changedVsR53: [] };
  return cached;
}
// Boot the overlay server with a local MOCK provider. mode: ok | hang | unknown (no usage reported).
async function bootR53({ dir } = {}) {
  const o = materialize();
  const H = require(path.join(o.dir, 'tests', 'helpers.js'));
  const state = { calls: 0, mode: 'ok', held: [], prompts: [] };
  const provider = http.createServer((req, res) => {
    let raw = ''; req.on('data', b => { raw += b; }); req.on('end', () => {
      let prompt = ''; try { prompt = JSON.parse(raw).messages.at(-1).content; } catch { prompt = ''; }
      state.calls++; state.prompts.push(prompt.slice(0, 200));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = () => {
        const content = JSON.stringify({ sections: [{ heading: 'R54 MOCK 输出', body: '本地 Mock 模型的占位输出（E3_FAKE），不是专业成果。' + prompt.slice(0, 120) }], rows: [['来源', '值'], ['R54 MOCK', state.calls]], slides: [{ title: 'R54 MOCK', bullets: ['未经专业验证'] }] });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n');
        if (state.mode !== 'unknown') res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 30 } }) + '\n\n');
        res.end('data: [DONE]\n\n');
      };
      if (state.mode === 'hang') { res.write(': waiting\n\n'); state.held.push(send); } else send();
    });
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  const env = { LOCAL_MODEL_TARGETS: '127.0.0.1:' + provider.address().port };
  let app = await H.boot({ env, dir });
  const added = await app.call('POST', '/api/models', { providerId: 'ollama', modelId: 'R54-MOCK', displayName: 'R54 本地 MOCK', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, pricingMode: 'local',
    capabilities: ['reasoning', 'writing', 'coding', 'research', 'data_analysis', 'vision'] });
  if (added.status !== 200) throw new Error('mock model add failed: ' + added.text);
  const model = added.json.connection.connectionId;
  if ((await app.call('POST', '/api/models/' + model + '/test', {})).json.ok !== true) throw new Error('mock probe failed');
  state.calls = 0; state.prompts = [];
  return {
    H, overlay: o, state, model, env, get app() { return app; },
    release() { for (const f of state.held.splice(0)) f(); },
    async restart({ hard = false } = {}) {
      const d = app.dir;
      if (hard) { const c = app.child; await new Promise(r => { if (c.exitCode !== null || c.signalCode) return r(); c.once('exit', r); c.kill('SIGKILL'); }); } else await app.kill();
      app = await H.boot({ dir: d, env });
    },
    async stop() { for (const f of state.held.splice(0)) { try { f(); } catch { /* closed */ } } try { await app.stop(); } catch { /* stopped */ } provider.closeAllConnections(); await new Promise(r => provider.close(r)); }
  };
}
async function settled(f, runId) {
  for (let i = 0; i < 400; i++) { const r = await f.app.call('GET', '/api/v2/universal/runs/' + runId); if (!r.json.run.executionActive) return r.json.run; await f.H.sleep(20); }
  throw new Error('run did not settle');
}
module.exports = { materialize, bootR53, settled, R53_SHA, OWNED };
