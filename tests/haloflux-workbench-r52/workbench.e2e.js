'use strict';
// R52 (#35) real Chromium + real server (HTTP, auth, SQLite). Part A uses no model at all; part B uses a
// local MOCK model (E3_FAKE). No real provider, no paid model: nothing here is E4 or E5.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const H = require('../helpers');
const F = require('./fixtures.cjs');
const { bootWithMock } = require('./mock-provider.cjs');

const SHOTS = process.env.UI_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'aij-r52-ui-'));
fs.mkdirSync(SHOTS, { recursive: true });
const evidence = { level: 'E2/E3_FAKE (real Chromium + real server; part B local MOCK model)', blind: {}, checks: [] };
const ok = (name, data) => { evidence.checks.push({ name, result: 'PASS', ...(data || {}) }); console.log('PASS', name); };
const PAGE = '/haloflux-workbench-r52/index.html';

async function newPage(browser, app, opts = {}) {
  const base = 'http://localhost:' + app.port;
  const context = await browser.newContext({ viewport: { width: 1360, height: 950 }, acceptDownloads: true, ...opts });
  await context.addCookies([{ name: 'aij_session', value: app.cookie.split('=').slice(1).join('='), url: base }]);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::/.test(m.text())) errors.push(m.text()); });
  await page.goto(base + PAGE + (opts.query || '?poll=150&demo=150'));
  await page.waitForFunction(() => !/检测中/.test(document.getElementById('backend-badge').textContent));
  return { page, context, errors, base };
}
async function makeTeam(page, b) {
  await page.fill('#goal', b.goal);
  if (!(await page.locator('#more').evaluate(d => d.open))) await page.click('#more summary');
  await page.fill('#domain', b.domain || ''); await page.fill('#success', b.success || '');
  await page.click('#make-team');
  await page.waitForFunction(g => (document.getElementById('plan-summary').textContent || '').includes(g.slice(0, 40)), b.goal);
}
const roleNames = page => page.locator('[data-rolecard] .role-head strong').allTextContents();

async function partA(browser) {
  const app = await H.boot();
  try {
    const { page, context, errors } = await newPage(browser, app);
    // IDLE: no events -> nothing busy.
    assert.equal(await page.getAttribute('#halo', 'data-mode'), 'IDLE'); assert.equal(await page.getAttribute('#halo', 'data-busy'), 'false');
    assert.ok(await page.locator('#idle-banner').count());
    ok('idle-without-events');
    // Keyboard-only: Tab into the goal, type, Ctrl+Enter.
    await page.focus('#goal'); await page.keyboard.type('帮我弄一下这个事情吧'); await page.keyboard.press('Control+Enter');
    await page.waitForSelector('[data-rolecard]');
    assert.equal(await page.getAttribute('#confidence-level', 'data-level'), 'low');
    assert.ok(await page.locator('[data-cannot="low_confidence"]').count()); assert.ok(await page.locator('[data-block="NEEDS_CLARIFICATION"]').count());
    await page.click('[data-clarify="domain"] button'); assert.equal(await page.evaluate(() => document.activeElement.id), 'domain');
    ok('low-confidence-and-clarification');
    // Blind unfamiliar / cross-domain tasks through the real page.
    const sigs = new Set();
    for (const b of F.BLIND) {
      await makeTeam(page, b);
      const names = await roleNames(page);
      assert.ok(names.length >= 4, b.key); assert.ok(names.some(n => n.includes(b.domain)), b.key + ' lead role named by user domain');
      for (const k of b.expect.cannot || []) assert.ok(await page.locator('[data-cannot="' + k + '"]').count(), b.key + ' cannot ' + k);
      if (b.expect.highRisk) assert.ok(await page.locator('[data-block="HUMAN_EXPERT_REQUIRED"]').count(), b.key);
      assert.equal(await page.getAttribute('#start-run', 'data-reason'), 'NO_MODEL', 'no model configured -> cannot start');
      assert.ok(await page.isDisabled('#start-run'));
      sigs.add(names.join('|'));
      evidence.blind[b.key] = { roles: names, label: await page.textContent('#plan-label') };
      if (['racing-pigeons', 'dive-first-aid'].includes(b.key)) await page.screenshot({ path: path.join(SHOTS, 'r52-blind-' + b.key + '.png'), fullPage: true });
    }
    assert.equal(sigs.size, F.BLIND.length, 'each blind task yields a different team');
    ok('blind-tasks-distinct-teams', { count: F.BLIND.length });
    // Editing with the keyboard: rename a role, move a step with Enter, focus stays on the control.
    const b = F.BLIND[2];
    await makeTeam(page, b);
    const firstRole = await page.getAttribute('[data-rolecard] >> nth=0', 'data-rolecard');
    await page.fill('#r-name-' + firstRole, '冰雕节总协调人'); await page.press('#r-name-' + firstRole, 'Tab');
    await page.waitForFunction(id => document.querySelector('[data-rolecard="' + id + '"] strong').textContent === '冰雕节总协调人', firstRole);
    assert.match(await page.textContent('#halo-list'), /冰雕节总协调人：待命（没有事件）/);
    const steps0 = await page.locator('[data-stepcard]').evaluateAll(n => n.map(x => x.dataset.stepcard));
    await page.focus('[data-op="down"][data-step="' + steps0[0] + '"]'); await page.keyboard.press('Enter');
    const steps1 = await page.locator('[data-stepcard]').evaluateAll(n => n.map(x => x.dataset.stepcard));
    assert.deepEqual(steps1.slice(0, 2), [steps0[1], steps0[0]]);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.fkey), 'down-' + steps0[0], 'focus stays on the moved control');
    await page.click('#add-role-box summary');
    await page.fill('#new-role-name', '<img src=x onerror=window.__xss=1>'); await page.click('#add-role');
    await page.waitForSelector('[data-rolecard="custom-1"]');
    assert.equal(await page.evaluate(() => window.__xss), undefined); assert.equal(await page.locator('[data-rolecard] img').count(), 0);
    assert.ok(await page.isDisabled('[data-opid="external_publish"]'));
    await page.check('#confirm-auth'); await page.fill('#max-cost', '1'); await page.press('#max-cost', 'Tab');
    assert.equal(await page.isChecked('#confirm-auth'), false, 'editing caps revokes the confirmation');
    ok('keyboard-editing-and-xss');
    // DEMO is labelled and never counts as work or cost.
    await page.click('#demo');
    await page.waitForFunction(() => document.getElementById('halo').dataset.mode === 'DEMO' && document.querySelectorAll('[data-haloitem][data-state="completed"]').length > 0);
    assert.ok(await page.locator('#demo-banner').count()); assert.match(await page.textContent('#cost'), /演示不会产生费用/);
    assert.match(await page.textContent('#mode-badge'), /DEMO/);
    await page.screenshot({ path: path.join(SHOTS, 'r52-demo.png'), fullPage: false });
    ok('demo-labelled');
    // R53 fixture bundles: gapped feed holds later events; full feed projects retraction, unknown types, unknown cost, fixture file.
    const roles = await page.locator('[data-rolecard]').evaluateAll(n => n.map(x => x.dataset.rolecard));
    const gapFile = path.join(SHOTS, 'r53-bundle-gap.json'), fullFile = path.join(SHOTS, 'r53-bundle-full.json');
    fs.writeFileSync(gapFile, JSON.stringify(F.bundle(roles, { gap: true }))); fs.writeFileSync(fullFile, JSON.stringify(F.bundle(roles)));
    await page.setInputFiles('#import-events', gapFile);
    await page.waitForSelector('#gap-banner'); assert.match(await page.textContent('#gap-banner'), /缺少事件 #10/);
    assert.equal(await page.getAttribute('#halo', 'data-busy'), 'false', 'gapped feed never looks busy');
    await page.setInputFiles('#import-events', fullFile);
    await page.waitForFunction(() => document.getElementById('halo').dataset.phase === 'delivered');
    assert.equal(await page.locator('#gap-banner').count(), 0);
    assert.ok(await page.locator('[data-event="r53w-e13"][data-retracted="true"]').count());
    assert.match(await page.textContent('[data-event="r53w-e9"]'), /未识别/);
    assert.equal(await page.getAttribute('#cost-total', 'data-total'), 'unknown'); assert.match(await page.textContent('#cost-total'), /未知（不是 0）/);
    assert.match(await page.textContent('[data-file="art-final"]'), /FIXTURE 样例文件/);
    assert.ok(await page.locator('.edge[data-cause-event="r53w-e6"]').count(), 'hand-off beam names its source event');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-download="art-final"]')]);
    const svgPath = path.join(SHOTS, 'fixture-final.svg'); await dl.saveAs(svgPath); assert.match(fs.readFileSync(svgPath, 'utf8'), /R52 FIXTURE/);
    assert.ok(await page.isDisabled('#accept'), 'fixture replay can never be accepted as work');
    assert.notEqual(await page.getAttribute('#out-headline', 'data-status'), 'accepted');
    await page.screenshot({ path: path.join(SHOTS, 'r52-fixture-replay.png'), fullPage: true });
    ok('fixture-replay-order-gap-retraction-unknown-cost');
    // Static toggle stops motion.
    await page.click('#halo-static'); assert.match(await page.getAttribute('#halo', 'class'), /static/);
    assert.equal(await page.locator('#halo .ring-a').evaluate(n => getComputedStyle(n).animationName), 'none');
    ok('static-toggle');
    assert.deepEqual(errors, []); await context.close();
    // Reduced motion and a phone-sized screen.
    const rm = await newPage(browser, app, { reducedMotion: 'reduce', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await makeTeam(rm.page, F.BLIND[6]);
    assert.match(await rm.page.getAttribute('#halo', 'class'), /static/);
    assert.ok(await rm.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll on a phone');
    const st = await rm.page.locator('[data-stepcard]').evaluateAll(n => n.map(x => x.dataset.stepcard));
    await rm.page.tap('[data-op="down"][data-step="' + st[0] + '"]');
    assert.equal(await rm.page.getAttribute('[data-stepcard] >> nth=1', 'data-stepcard'), st[0]);
    await rm.page.screenshot({ path: path.join(SHOTS, 'r52-phone.png'), fullPage: true });
    assert.deepEqual(rm.errors, []); await rm.context.close();
    ok('reduced-motion-and-phone');
  } finally { await app.stop(); }
}

async function partB(browser) {
  const f = await bootWithMock();
  try {
    const { page, context, errors } = await newPage(browser, f.app);
    const b = F.BLIND[3];
    await makeTeam(page, b);
    assert.match(await page.textContent('#backend-badge'), /1 个模型连接/);
    // Only the tools the server says are usable remain; the rest are removed by the user.
    for (;;) {
      const t = page.locator('.tool:not([data-status="available"]) button').first();
      if (!(await t.count())) break;
      await t.click();
    }
    assert.ok(await page.isDisabled('#start-run')); assert.equal(await page.getAttribute('#start-run', 'data-reason'), 'NOT_AUTHORIZED');
    assert.equal(f.state.calls, 0);
    await page.check('#confirm-auth');
    await page.waitForFunction(() => !document.getElementById('start-run').disabled);
    f.state.hold = true;
    await page.click('#start-run');
    await page.waitForFunction(() => document.getElementById('halo').dataset.busy === 'true');
    assert.equal(await page.getAttribute('#halo', 'data-mode'), 'LIVE'); assert.ok(await page.locator('#halo [data-state="working"]').count());
    assert.match(await page.getAttribute('#halo [data-state="working"]', 'data-source-event'), /^v2:/);
    assert.ok(await page.isDisabled('#start-run'), 'no second dispatch while the run is active');
    assert.match(await page.textContent('#run-refusal'), /仍在进行中/);
    await page.screenshot({ path: path.join(SHOTS, 'r52-live-working.png'), fullPage: false });
    ok('live-busy-only-from-server-events');
    // Connection loss: last known state, no motion; then reconnect.
    await page.route('**/api/v2/runs/**', r => r.abort());
    await page.waitForSelector('#disconnected-banner');
    assert.equal(await page.getAttribute('#halo', 'data-busy'), 'false');
    await page.unroute('**/api/v2/runs/**');
    await page.waitForFunction(() => !document.getElementById('disconnected-banner'));
    ok('disconnect-and-reconnect');
    f.state.hold = false; f.release();
    await page.waitForFunction(() => document.getElementById('halo').dataset.phase === 'delivered', null, { timeout: 20000 });
    const steps = await page.locator('[data-stepcard]').count();
    assert.equal(f.state.calls, steps, 'one mock call per step');
    assert.match(await page.textContent('#cost-total'), /\$0\.0000/);
    assert.ok(await page.locator('.edge').count() >= 1);
    // Real export → download → independent parse when python-docx is present.
    await page.waitForFunction(() => !document.getElementById('export-docx').disabled);
    await page.click('#export-docx');
    await page.waitForSelector('[data-file][data-mock="false"] >> text=.docx');
    const docxId = await page.locator('[data-file][data-mock="false"]', { hasText: '.docx' }).first().getAttribute('data-file');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-download="' + docxId + '"]')]);
    const docx = path.join(SHOTS, 'r52-deliverable.docx'); await dl.saveAs(docx);
    assert.equal(fs.readFileSync(docx).subarray(0, 2).toString(), 'PK');
    const parsed = spawnSync('python3', ['-c', 'import sys,docx;print("\\n".join(p.text for p in docx.Document(sys.argv[1]).paragraphs))', docx], { encoding: 'utf8' });
    evidence.docxParse = parsed.status === 0 ? { status: 'PARSED', mockLabel: /R52 MOCK/.test(parsed.stdout) } : { status: 'NOT_RUN', reason: (parsed.stderr || '').slice(0, 120) };
    if (parsed.status === 0) assert.match(parsed.stdout, /R52 MOCK/);
    assert.notEqual(await page.getAttribute('#out-headline', 'data-status'), 'accepted', 'not completed before acceptance');
    // A failed check blocks acceptance; marking verified enables it.
    const firstCheck = await page.getAttribute('[data-checkmark] >> nth=0', 'data-checkmark');
    await page.selectOption('[data-mark="' + firstCheck + '"]', 'failed'); assert.ok(await page.isDisabled('#accept'));
    await page.selectOption('[data-mark="' + firstCheck + '"]', 'verified');
    await page.waitForFunction(() => !document.getElementById('accept').disabled);
    await page.click('#accept');
    await page.waitForFunction(() => document.getElementById('out-headline').dataset.status === 'accepted', null, { timeout: 8000 })
      .catch(async e => { throw new Error(e.message + ' | feedback=' + await page.textContent('#feedback') + ' | headline=' + await page.textContent('#out-headline') + ' | phase=' + await page.getAttribute('#halo', 'data-phase')); });
    assert.match(await page.textContent('#out-headline'), /已完成/);
    await page.screenshot({ path: path.join(SHOTS, 'r52-accepted.png'), fullPage: true });
    ok('export-download-acceptance', { mockCalls: f.state.calls, docx: evidence.docxParse.status });
    assert.deepEqual(errors, []); await context.close();
  } finally { await f.stop(); }
}

(async () => {
  let browser;
  try {
    const options = { headless: true };
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    browser = await chromium.launch(options);
    await partA(browser);
    await partB(browser);
    evidence.result = 'PASS'; evidence.screenshots = fs.readdirSync(SHOTS).filter(n => n.endsWith('.png'));
    fs.writeFileSync(path.join(SHOTS, 'r52-ui-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('R52 UI E2E PASS', evidence.checks.length, 'checks; evidence in', SHOTS);
  } catch (e) {
    console.error('R52 UI E2E FAIL', e && e.stack || e);
    process.exitCode = 1;
  } finally { if (browser) await browser.close(); }
})();
