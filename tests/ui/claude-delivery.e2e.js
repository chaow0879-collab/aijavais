'use strict';
// #17 M4 + #19 in REAL Chromium against the REAL server (HTTP, auth, SQLite).
// Part 1 (#19 QA-GAPS-UX-01): three non-cooperative in-flight draft requests are
//   cancelled, the fourth is refused with 429 before dispatch. The page must not
//   show the third request's cost as "本次" for the fourth request, while the
//   third request's unknown / may-still-bill facts stay visible and labelled.
//   Positive controls: a cancelled dispatched request shows its own unknown cost;
//   an HTTP 202 settlement failure keeps cost unknown + manual reconciliation.
// Part 2 (#17 M4): workspace delivery-check card for A software / B organization /
//   C research, including the generated SVG opened in Chromium.
// Only local MOCK model servers; no paid API, no external tools.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright');
const H = require('../helpers');
const FX = require('../claude-delivery-fixtures.cjs');
const SHOTS = process.env.UI_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'aij-claude-delivery-shots-'));
const PRELOAD = path.join(__dirname, '..', 'claude-delivery-noncoop-preload.cjs');
const shot = async (page, name) => { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'claude-delivery-' + name + '.png'), fullPage: true }); };

function provider(outputs = {}) {
  const state = { draft: 0, held: [], hold: true };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      const data = JSON.parse(body), all = data.messages.map(m => m.content).join('\n'), isDraft = data.messages.at(-1).content.startsWith('Design a team');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const finish = content => res.end('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
      if (isDraft) {
        state.draft++;
        if (state.hold) { res.write(': pending\n\n'); state.held.push(() => finish(JSON.stringify(require('../fixtures/ai-draft.cjs')()))); return; }
        return finish(JSON.stringify(require('../fixtures/ai-draft.cjs')()));
      }
      const m = /\[\[OUT:([\w-]+)\]\]/.exec(all);
      finish(m ? JSON.stringify(outputs[m[1]]) : '好');
    });
  });
  return { server, state, listen: () => new Promise(r => server.listen(0, '127.0.0.1', r)), close: async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}
async function launch() {
  const options = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  return chromium.launch(options);
}
async function pageFor(browser, app) {
  const base = 'http://localhost:' + app.port;
  const context = await browser.newContext({ viewport: { width: 1360, height: 950 } });
  await context.addCookies([{ name: 'aij_session', value: app.cookie.split('=').slice(1).join('='), url: base }]);
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  return { page, base, errors };
}

async function part19(browser) {
  const P = provider(); await P.listen();
  const app = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + P.server.address().port, NODE_OPTIONS: '--require ' + PRELOAD } });
  try {
    const added = await app.call('POST', '/api/models', { providerId: 'ollama', modelId: 'MOCK-noncoop', displayName: '非合作测试模型', baseUrl: 'http://127.0.0.1:' + P.server.address().port + '/v1', pricingMode: 'paid_api', capabilities: ['reasoning', 'writing'] });
    const id = added.json.connection.connectionId;
    assert.equal((await app.call('POST', '/api/models/' + id + '/test', {})).json.ok, true);
    const { page, base, errors } = await pageFor(browser, app);
    await page.goto(base + '/project-intake.html'); await page.fill('#description', '为一个跨领域新项目设计团队，用于验证费用提示归属。'); await page.click('#next');
    await page.click('#ai-draft-open'); await page.selectOption('#ai-model', id);
    await page.fill('#ai-max-cost', '1'); await page.fill('#ai-input-rate', '2'); await page.fill('#ai-output-rate', '4');
    await page.click('#ai-estimate'); await page.waitForFunction(() => document.querySelector('#ai-estimate-text').textContent.includes('当前上限可覆盖'));
    const ids = [];
    for (let i = 1; i <= 3; i++) {
      await page.check('#ai-consent'); await page.click('#ai-generate');
      for (let k = 0; k < 200 && P.state.draft < i; k++) await H.sleep(10);
      assert.equal(P.state.draft, i, 'request ' + i + ' reached the provider');
      const current = await page.getAttribute('#ai-current-request', 'data-request-id'); ids.push(current);
      if (i > 1) {
        // While request i is pending, request i-1's usage is shown only as a labelled previous request.
        assert.equal(await page.locator('#ai-usage').count(), 0, 'no "本次用量" for a request that has no usage yet');
        assert.equal(await page.getAttribute('#ai-usage-previous', 'data-request-id'), ids[i - 2]);
      }
      await page.click('#ai-cancel');
      await page.waitForFunction(() => /供应商调用尚未确认结束/.test(document.querySelector('#ai-message').textContent), null, { timeout: 8000 });
      // Positive control: a dispatched, cancelled, still-running request keeps ITS unknown cost.
      assert.equal(await page.getAttribute('#ai-usage', 'data-request-id'), current);
      const own = await page.textContent('#ai-usage');
      assert.match(own, /费用：未知，不能视为零/); assert.match(own, /可能仍计费/);
      assert.equal(await page.locator('#ai-usage-previous').count(), 0);
    }
    const status = (await app.call('GET', '/api/v2/intake/ai-draft/status')).json;
    assert.equal(status.activeSlots, 3); assert.equal(status.underlyingInFlight, 3); assert.equal(status.outstandingAfterResponse, 3);
    // Fourth request: refused with 429 before any claim or dispatch.
    const resp = page.waitForResponse(r => r.url().endsWith('/api/v2/intake/ai-draft') && r.request().method() === 'POST');
    await page.check('#ai-consent'); await page.click('#ai-generate');
    const r4 = await resp; assert.equal(r4.status(), 429); assert.equal((await r4.json()).code, 'draft_busy');
    await page.waitForFunction(() => /本次未发送请求、未产生费用/.test(document.querySelector('#ai-message').textContent));
    await shot(page, '19-fourth-429');
    const fourth = await page.getAttribute('#ai-current-request', 'data-request-id');
    assert.notEqual(fourth, ids[2]);
    assert.match(await page.textContent('#ai-current-request'), /未发送请求，本次费用为0/);
    assert.equal(await page.locator('#ai-usage').count(), 0, 'QA-GAPS-UX-01: no stale "本次用量" for the refused request');
    assert.equal(await page.getAttribute('#ai-usage-previous', 'data-request-id'), ids[2], 'third request facts are attributed to the third request');
    const prev = await page.textContent('#ai-usage-previous');
    assert.match(prev, /上一请求（ID [0-9a-f]{8}，与本次请求无关）/); assert.match(prev, /费用未知，不能视为零/); assert.match(prev, /可能仍计费/);
    const card = await page.textContent('#ai-team-card');
    assert.doesNotMatch(card, /本次用量/, 'no contradictory "本次用量" anywhere on the card');
    assert.equal(P.state.draft, 3, 'fourth request never reached the provider');
    const rows = (await app.call('GET', '/api/v2/usage/system')).json.usage.filter(u => u.kind === 'intake_draft');
    assert.equal(rows.length, 3, 'no claim/ledger row for the refused request');
    assert.ok(rows.every(u => u.status === 'reserved' && (u.cost === null || u.cost === undefined)), 'third-party unknown costs stay unknown');
    // Providers finally end: capacity returns; late settlement keeps facts for those IDs.
    P.state.hold = false; for (const f of P.state.held.splice(0)) f();
    for (let k = 0; k < 300 && (await app.call('GET', '/api/v2/intake/ai-draft/status')).json.activeSlots; k++) await H.sleep(20);
    assert.equal((await app.call('GET', '/api/v2/intake/ai-draft/status')).json.activeSlots, 0);
    // Positive control: HTTP 202 settlement failure keeps cost unknown + manual reconciliation for THIS request.
    const db = new DatabaseSync(path.join(app.dir, 'projects.sqlite'));
    db.exec("CREATE TRIGGER deny_settle BEFORE UPDATE OF state ON model_requests WHEN NEW.state IN ('completed','failed') BEGIN SELECT RAISE(ABORT,'MOCK settlement disk failure'); END;");
    const resp5 = page.waitForResponse(r => r.url().endsWith('/api/v2/intake/ai-draft') && r.request().method() === 'POST');
    await page.check('#ai-consent'); await page.click('#ai-generate');
    const r5 = await resp5; db.exec('DROP TRIGGER deny_settle'); db.close();
    assert.equal(r5.status(), 202);
    await page.waitForSelector('#ai-usage');
    const fifth = await page.getAttribute('#ai-current-request', 'data-request-id');
    assert.equal(await page.getAttribute('#ai-usage', 'data-request-id'), fifth);
    assert.match(await page.textContent('#ai-usage'), /费用未知，需要人工核对/); assert.equal(await page.locator('#ai-usage-previous').count(), 0);
    assert.equal(P.state.draft, 4, 'exactly one new call; no automatic retries');
    await shot(page, '19-202-unknown');
    assert.deepEqual(errors, []);
    return { requests: P.state.draft, ledgerRowsAfter429: rows.length, statusAt429: status, fourthRequestId: fourth.slice(0, 8), previousShownFor: ids[2].slice(0, 8) };
  } finally { await app.stop(); await P.close(); }
}

async function partDelivery(browser) {
  const badOrg = FX.organization(); badOrg.orgChart.nodes[0].parentId = 'prod';
  const xssOrg = FX.organization(); xssOrg.orgChart.nodes[1].name = '<img src=x onerror="window.__xss=1">';
  const outputs = { software: FX.software(), placeholder: FX.placeholderSoftware(), organization: xssOrg, badorg: badOrg, research: FX.research() };
  const P = provider(outputs); await P.listen();
  const app = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + P.server.address().port, AIJ_ENABLE_CODE_EXECUTION: '1' } });
  const summary = {};
  try {
    const added = await app.call('POST', '/api/models', { providerId: 'ollama', modelId: 'MOCK-delivery-ui', displayName: '交付测试模型', baseUrl: 'http://127.0.0.1:' + P.server.address().port + '/v1', pricingMode: 'local', capabilities: ['reasoning', 'writing', 'coding'] });
    const model = added.json.connection.connectionId;
    assert.equal((await app.call('POST', '/api/models/' + model + '/test', {})).json.ok, true);
    const { page, base, errors } = await pageFor(browser, app);
    for (const key of Object.keys(outputs)) {
      const created = await app.call('POST', '/api/v2/projects', { name: '交付检查-' + key, description: '合成交付检查项目 ' + key,
        roles: [{ roleId: 'maker', name: '成果制作', duty: '输出结构化成果', standard: '可复核', connectionId: model }],
        steps: [{ stepId: 'make', roleId: 'maker', title: '生成结构化成果', prompt: '[[OUT:' + key + ']] 输出约定JSON' }] });
      const pid = created.json.project.projectId;
      const run = await app.call('POST', '/api/v2/projects/' + pid + '/runs', { maxTokens: 50000, maxOutputTokens: 4000, maxCost: 0 });
      for (let k = 0; k < 200; k++) { const r = await app.call('GET', '/api/v2/runs/' + run.json.run.runId); if (r.json.run.status === 'review_required') break; await H.sleep(20); }
      await page.goto(base + '/workspace.html?project=' + pid); await page.click('#tab-run');
      await page.waitForFunction(() => /尚未运行交付检查/.test(document.querySelector('#delivery-summary')?.textContent || ''));
      if (key === 'software' || key === 'placeholder') await page.check('#delivery-smoke');
      await page.click('#delivery-check'); await page.waitForSelector('#delivery-table');
      const kindRow = page.locator('#delivery-table tr[data-delivery-kind]:not([data-delivery-kind=file])').first();
      const usable = await kindRow.getAttribute('data-usable');
      const expert = await kindRow.locator('[data-state=not_run]').last().textContent();
      assert.match(expert, /领域专家评审：未进行（NOT_RUN）/);
      summary[key] = usable;
      await shot(page, 'workspace-' + key);
      if (key === 'software') assert.ok(['runnable_verified', 'not_run'].includes(usable), usable);
      if (key === 'placeholder') assert.equal(usable, 'mock_placeholder');
      if (key === 'badorg') { assert.equal(usable, 'failed'); assert.match(await kindRow.textContent(), /汇报关系环/); assert.equal(await page.locator('[data-generated]').count(), 0); }
      if (key === 'research') { assert.equal(usable, 'evidence_gaps'); assert.match(await kindRow.textContent(), /已核实0/); }
      if (key === 'organization') {
        assert.equal(usable, 'graph_validated');
        const href = await page.getAttribute('[data-generated="org-chart.svg"]', 'href');
        // The download endpoint serves an attachment; fetch the real bytes with the session, then render them as an SVG document.
        const resp = await page.context().request.get(new URL(href, base).href);
        assert.equal(resp.status(), 200); assert.equal(resp.headers()['content-type'], 'image/svg+xml'); assert.match(resp.headers()['content-disposition'], /attachment/);
        const svgBytes = await resp.body(); fs.writeFileSync(path.join(SHOTS, 'org-chart.svg'), svgBytes);
        const svgPage = await page.context().newPage();
        await svgPage.goto('data:image/svg+xml;base64,' + svgBytes.toString('base64'));
        assert.equal(await svgPage.locator('g[data-node-id]').count(), 8, 'all 8 org nodes render in Chromium');
        assert.equal(await svgPage.evaluate(() => window.__xss), undefined, 'escaped name never executes'); assert.equal(await svgPage.locator('img').count(), 0);
        await svgPage.screenshot({ path: path.join(SHOTS, 'claude-delivery-org-chart-svg.png') }); await svgPage.close();
      }
      // The workspace never claims domain-expert review, and reloading shows the persisted manifest.
      await page.reload(); await page.click('#tab-run'); await page.waitForSelector('#delivery-table');
      assert.equal(await page.locator('#delivery-table tr[data-delivery-kind]:not([data-delivery-kind=file])').first().getAttribute('data-usable'), usable);
    }
    assert.equal(await page.evaluate(() => window.__xss), undefined); assert.deepEqual(errors, []);
    return summary;
  } finally { await app.stop(); await P.close(); }
}

(async () => {
  const browser = await launch();
  try {
    const p19 = await part19(browser);
    console.log('PASS #19 QA-GAPS-UX-01 Chromium: ' + JSON.stringify(p19));
    const delivery = await partDelivery(browser);
    console.log('PASS #17 M4 workspace delivery Chromium: ' + JSON.stringify(delivery) + ' shots=' + SHOTS);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
