'use strict';
// #14 package 5: the three synthetic industry projects through REAL Chromium,
// the real server, HTTP and SQLite. Only the model provider is a local MOCK.
// Asserts the human-in-the-loop flow: estimate -> explicit consent -> one call
// -> editable draft with tool suggestions shown as NOT granted -> human edits
// -> explicit save confirmation -> workspace; never auto-saved, run or granted.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const H = require('../helpers');
const INDUSTRIES = ['software-development', 'enterprise-organization', 'cross-domain-research']
  .map(id => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'industry', id + '.json'), 'utf8')));
(async () => {
  let app, browser, current = INDUSTRIES[0], draftCalls = 0;
  const mock = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      const data = JSON.parse(body), isDraft = data.messages.at(-1).content.startsWith('Design a team');
      if (isDraft) draftCalls++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: isDraft ? JSON.stringify(current.draftReply) : '好' } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 60 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  try {
    const port = mock.address().port;
    app = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + port } });
    const added = await app.call('POST', '/api/models', { providerId: 'ollama', modelId: 'MOCK-industry-ui', displayName: '行业草案测试模型', baseUrl: 'http://127.0.0.1:' + port + '/v1', pricingMode: 'paid_api', capabilities: ['reasoning', 'writing', 'coding', 'data_analysis'] });
    const id = added.json.connection.connectionId;
    assert.equal((await app.call('POST', '/api/models/' + id + '/test', {})).json.ok, true);
    const options = { headless: true };
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    browser = await chromium.launch(options);
    const base = 'http://localhost:' + app.port;
    const context = await browser.newContext({ viewport: { width: 1360, height: 950 } });
    await context.addCookies([{ name: 'aij_session', value: app.cookie.split('=').slice(1).join('='), url: base }]);
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
    const summary = [];
    for (const [index, fx] of INDUSTRIES.entries()) {
      current = fx; const callsBefore = draftCalls;
      await page.goto(base + '/project-intake.html'); await page.fill('#description', fx.description); await page.click('#next');
      await page.click('#ai-draft-open'); await page.selectOption('#ai-model', id);
      await page.fill('#ai-max-cost', '1'); await page.fill('#ai-input-rate', '2'); await page.fill('#ai-output-rate', '4');
      assert.equal(await page.isEnabled('#ai-generate'), false, 'no call before estimate + consent');
      await page.click('#ai-estimate'); await page.waitForFunction(() => document.querySelector('#ai-estimate-text').textContent.includes('当前上限可覆盖'));
      assert.equal(draftCalls, callsBefore, 'estimate sends nothing');
      await page.check('#ai-consent'); await page.click('#ai-generate'); await page.waitForSelector('#ai-roles .ai-role-name');
      assert.equal(draftCalls, callsBefore + 1, 'exactly one model call');
      assert.equal(await page.locator('.ai-role-name').count(), fx.expect.roleIds.length);
      assert.equal(await page.locator('.ai-step-title').count(), fx.expect.stepIds.length);
      const perms = await page.textContent('#ai-tool-permissions');
      assert.match(perms, /未授予任何权限/);
      for (const tool of fx.draftReply.tools) assert.ok(perms.includes(tool + '［'), fx.id + ' tool listed ' + tool);
      assert.match(await page.textContent('#ai-usage'), /未与厂商账单核对|费用：未知/);
      assert.equal((await app.call('GET', '/api/v2/projects')).json.projects.length, index, 'never auto-saved');
      // Human edits, then explicit confirmation.
      const e = fx.humanEdits;
      await page.fill('#ai-project-name', e.projectName);
      await page.fill('#ai-role-' + e.renameRole.roleId, e.renameRole.name);
      await page.fill('#ai-required-tools', e.keepTools.join('\n'));
      for (const roleId of fx.expect.roleIds) await page.selectOption('#ai-model-' + roleId, id);
      assert.equal(await page.isEnabled('#ai-save'), false, 'save needs explicit confirmation');
      await page.check('#ai-save-confirm');
      if (process.env.UI_SHOTS) { fs.mkdirSync(process.env.UI_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.UI_SHOTS, 'industry-' + fx.id + '.png'), fullPage: true }); }
      await page.click('#ai-save'); await page.waitForURL(/workspace\.html\?project=/);
      const projectId = new URL(page.url()).searchParams.get('project');
      const saved = (await app.call('GET', '/api/v2/projects/' + projectId)).json;
      assert.equal(saved.project.name, e.projectName); assert.equal(saved.project.roles.find(r => r.roleId === e.renameRole.roleId).name, e.renameRole.name);
      assert.deepEqual(saved.project.requiredToolIds, e.keepTools); assert.deepEqual(saved.runs, [], 'saving never starts a run');
      assert.equal(saved.project.allowedTools, undefined);
      // Workspace: tool grant boxes start unticked.
      await page.waitForSelector('[data-project-tool]', { state: 'attached' });
      assert.equal(await page.locator('[data-project-tool]:checked').count(), 0, 'no tool pre-granted in the workspace');
      assert.equal(draftCalls, callsBefore + 1, 'saving/viewing never calls the model');
      summary.push({ industry: fx.industry, roles: fx.expect.roleIds.length, steps: fx.expect.stepIds.length, projectId, draftCalls: draftCalls - callsBefore });
    }
    assert.deepEqual(errors, []);
    console.log('PASS industry Chromium E2E (local MOCK model, no paid API, no tools executed): ' + JSON.stringify(summary));
  } finally {
    if (browser) await browser.close(); if (app) await app.stop(); mock.closeAllConnections(); await new Promise(r => mock.close(r));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
