'use strict';
// R54 (#37) real Chromium against the REAL R53 backend (397b46c overlay, HTTP + auth + SQLite) with a
// local MOCK model: E3_FAKE only. No paid model, no Secrets, nothing here is E4/E5.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { bootR53, R53_SHA } = require('./overlay.cjs');
const F = require('../haloflux-workbench-r52/fixtures.cjs');

const SHOTS = process.env.UI_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'aij-r54-ui-'));
fs.mkdirSync(SHOTS, { recursive: true });
const evidence = { level: 'E3_FAKE (real Chromium + real R53 backend ' + R53_SHA + ' + local MOCK model)', r53: R53_SHA, blind: {}, checks: [] };
const ok = (name, data) => { evidence.checks.push({ name, result: 'PASS', ...(data || {}) }); console.log('PASS', name); };
const PAGE = '/haloflux-workbench-r52/index.html?poll=150';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

async function open(browser, f, opts = {}) {
  const base = 'http://localhost:' + f.app.port;
  const context = await browser.newContext({ viewport: { width: 1360, height: 950 }, acceptDownloads: true, ...opts });
  if (!opts.noCookie) await context.addCookies([{ name: 'aij_session', value: f.app.cookie.split('=').slice(1).join('='), url: base }]);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::/.test(m.text())) errors.push(m.text()); });
  return { page, context, errors, base };
}
async function ready(page) { await page.waitForFunction(() => !/检测中/.test(document.getElementById('backend-badge').textContent)); }
async function makeTeam(page, b) {
  await page.fill('#goal', b.goal);
  if (!(await page.locator('#more').evaluate(d => d.open))) await page.click('#more summary');
  await page.fill('#domain', b.domain || ''); await page.fill('#success', b.success || '');
  await page.click('#make-team');
  await page.waitForFunction(g => (document.getElementById('plan-summary').textContent || '').includes(g.slice(0, 30)) && document.querySelectorAll('[data-grant-role]').length > 0, b.goal);
}
async function grantAll(page) {
  for (const cb of await page.locator('[data-grant]').all()) if (!(await cb.isChecked())) await cb.check();
  await page.check('#confirm-auth');
  await page.waitForFunction(() => !document.getElementById('start-run').disabled);
}
const until = (page, fn, arg, ms = 20000) => page.waitForFunction(fn, arg, { timeout: ms });

(async () => {
  let browser, f; var current = null; // eslint-disable-line no-var
  try {
    const options = { headless: true };
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    browser = await chromium.launch(options);
    f = await bootR53();
    // Unauthenticated users never see the workbench.
    const anon = await open(browser, f, { noCookie: true });
    await anon.page.goto(anon.base + PAGE); assert.match(anon.page.url(), /login\.html/);
    await anon.context.close(); ok('unauthenticated-redirect');

    const { page, context, errors, base } = await open(browser, f); current = page;
    await page.goto(base + PAGE); await ready(page);
    // Blind goals through the live R53 plan API in the real page.
    const sigs = new Set();
    for (const b of F.BLIND) {
      await makeTeam(page, b);
      assert.equal(await page.evaluate(() => window.__r52.contract()), 'r53');
      assert.match(await page.textContent('#plan-label'), /PLAN_SIMULATED/);
      assert.equal(await page.getAttribute('#start-run', 'data-reason'), 'ROLE_NOT_APPROVED');
      const names = await page.locator('[data-grant-role] strong').allTextContents();
      sigs.add(names.join('|')); evidence.blind[b.key] = names;
    }
    assert.ok(sigs.size >= 6, 'distinct server teams: ' + sigs.size); assert.equal(f.state.calls, 0);
    ok('blind-goals-live-plan', { teams: sigs.size });

    // Full journey with the server's hold switch so "working" is observable.
    const b = F.BLIND[3];
    await makeTeam(page, { ...b, goal: b.goal + '<img src=x onerror=window.__xss=1>' });
    const firstStep = await page.getAttribute('[data-stepcard] >> nth=0', 'data-stepcard');
    // Keyboard: approve the first role with Space, then the rest.
    await page.focus('[data-grant] >> nth=0'); await page.keyboard.press('Space');
    assert.equal(await page.getAttribute('[data-grant-role] >> nth=0', 'data-role-status'), 'approved');
    await grantAll(page);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    // Any team edit revokes every per-role approval.
    await page.selectOption('[data-op="stepKind"][data-step="' + firstStep + '"]', 'work');
    assert.ok(await page.isDisabled('#start-run')); assert.equal(await page.locator('[data-role-status="approved"]').count(), 0);
    await grantAll(page);
    f.state.mode = 'hang';
    await page.click('#start-run');
    await until(page, () => document.getElementById('halo').dataset.busy === 'true');
    assert.match(page.url(), /\?run=run_/); const runId = new URL(page.url()).searchParams.get('run');
    assert.equal(await page.getAttribute('#halo', 'data-mode'), 'LIVE');
    // The provider is holding: the server recorded only agent_started (dispatch attempt), never work_started
    // (no first output yet), so the node honestly says "started", not "working".
    assert.match(await page.getAttribute('#halo [data-state="started"]', 'data-source-event'), /.+/);
    assert.equal(await page.locator('#halo [data-state="working"]').count(), 0);
    assert.ok(await page.isDisabled('#start-run'));
    await page.locator('section[aria-labelledby="halo-h"]').screenshot({ path: path.join(SHOTS, 'r54-live-started.png') });
    ok('live-started-not-faked-as-working');
    // Refresh while working: everything is rebuilt from the server (plan snapshot, events, round).
    await page.reload(); await ready(page);
    await until(page, () => window.__r52.contract() === 'r53' && document.getElementById('halo').dataset.mode === 'LIVE' && document.querySelectorAll('[data-grant-role]').length > 0);
    assert.match(await page.textContent('#feedback'), /已从服务器恢复任务/);
    assert.match(await page.textContent('#plan-label'), /SERVER_SNAPSHOT/);
    ok('refresh-recovery');
    // Network interruption on the event feed: last known state, not busy; then reconnect.
    await page.route('**/workbench?**', r => r.abort());
    await page.waitForSelector('#disconnected-banner'); assert.equal(await page.getAttribute('#halo', 'data-busy'), 'false');
    await page.unroute('**/workbench?**');
    await until(page, () => !document.getElementById('disconnected-banner'));
    ok('network-interruption');
    f.state.mode = 'ok'; f.release();
    await until(page, () => document.getElementById('halo').dataset.phase === 'delivered' && window.__r52.run() && window.__r52.run().status === 'review_required' && !document.getElementById('deliver-docx').disabled);
    assert.match(await page.textContent('#cost'), /未知（不是 0）/, 'vendor bill unknown is never shown as $0');
    assert.ok(await page.locator('[data-unknown-cost="true"]').count() >= 1, 'per-role unknown_cost tag');
    // Deliver round 1, download and compare with the server SHA-256.
    await page.click('#deliver-docx');
    await page.waitForSelector('[data-producer="universal_delivery"][data-round="1"]');
    const id1 = await page.getAttribute('[data-producer="universal_delivery"][data-round="1"]', 'data-file');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-download="' + id1 + '"]')]);
    const p1 = path.join(SHOTS, 'r54-round1.docx'); await dl.saveAs(p1);
    const server1 = (await f.app.call('GET', '/api/v2/universal/runs/' + runId)).json.run.artifacts.find(a => a.artifactId === id1);
    assert.equal(sha(fs.readFileSync(p1)), server1.sha256); assert.equal(fs.readFileSync(p1).subarray(0, 2).toString(), 'PK');
    ok('deliver-and-download-sha', { sha256: server1.sha256 });
    // Criterion failed -> saved on the server -> acceptance refused with a plain explanation.
    await page.selectOption('[data-crit-status-for="criterion-1"]', 'failed'); await page.fill('[data-crit-note-for="criterion-1"]', '编号不一致'); await page.press('[data-crit-note-for="criterion-1"]', 'Tab');
    assert.match(await page.textContent('#criteria-saved'), /尚未保存|未保存/);
    await page.click('#save-criteria'); await until(page, () => /服务器已保存第 1 轮/.test(document.getElementById('criteria-saved').textContent));
    await page.check('#ack-criteria'); await page.check('#ack-sim'); await page.click('#accept-r53');
    await until(page, () => /criteria_not_passed/.test(document.getElementById('feedback').textContent));
    assert.match(await page.textContent('#feedback'), /未通过或未核实/);
    // Reload: saved criteria come back from the server, not from local storage.
    await page.reload(); await ready(page); await until(page, () => /服务器已保存第 1 轮/.test(document.getElementById('criteria-saved').textContent));
    assert.equal(await page.inputValue('[data-crit-status-for="criterion-1"]'), 'failed');
    ok('server-criteria-block-acceptance');
    // Targeted rework from step 3 = a new authorization.
    const callsBefore = f.state.calls;
    const fromStep = await page.locator('#rework-from option').nth(3).getAttribute('value');
    await page.selectOption('#rework-from', fromStep); await page.fill('#rework-note-r53', '请统一档案编号格式');
    await page.click('#rework-r53'); assert.match(await page.textContent('#feedback'), /新的授权/);
    await grantAll(page);
    await page.selectOption('#rework-from', fromStep); await page.click('#rework-r53');
    await until(page, () => window.__r52.run() && window.__r52.run().round === 2 && window.__r52.run().status === 'review_required' && !window.__r52.run().executionActive);
    const stepCount = await page.locator('[data-stepcard]').count();
    assert.equal(f.state.calls - callsBefore, stepCount - 2, 'only the steps from the chosen one re-ran');
    assert.ok(await page.locator('[data-review-round="1"][data-decision="rework"]').count());
    assert.match(await page.textContent('[data-file="' + id1 + '"]'), /旧轮次，不能验收/);
    await page.click('#deliver-docx'); await page.waitForSelector('[data-producer="universal_delivery"][data-round="2"]');
    for (const sel of await page.locator('[data-crit-status-for]').all()) await sel.selectOption('passed');
    await page.click('#save-criteria'); await until(page, () => /服务器已保存第 2 轮/.test(document.getElementById('criteria-saved').textContent) && document.getElementById('criteria-saved').dataset.dirty === 'false');
    assert.match(await page.textContent('#accept-file'), /第 2 轮/); assert.doesNotMatch(await page.textContent('#accept-file'), /第 1 轮/);
    await page.check('#ack-criteria'); await page.check('#ack-sim'); await page.click('#accept-r53');
    await until(page, () => document.getElementById('halo').dataset.phase === 'accepted' && document.getElementById('out-headline').dataset.status === 'accepted');
    assert.match(await page.textContent('#out-headline'), /已完成/); assert.match(await page.textContent('#round-info'), /专业质量：未验证/);
    assert.match(await page.textContent('#reviews'), /专业质量：NOT_VERIFIED/);
    await page.locator('section[aria-labelledby="out-h"]').screenshot({ path: path.join(SHOTS, 'r54-accepted-outputs.png') });
    await page.locator('section[aria-labelledby="halo-h"]').screenshot({ path: path.join(SHOTS, 'r54-accepted-halo.png') });
    await page.locator('#auth-card').screenshot({ path: path.join(SHOTS, 'r54-role-grants.png') });
    ok('targeted-rework-and-acceptance', { mockCalls: f.state.calls });
    assert.deepEqual(errors.filter(e => !/409|403/.test(e)), []); await context.close();

    // Cancel mid-run and unknown usage acknowledgement.
    const c = await open(browser, f); await c.page.goto(c.base + PAGE); await ready(c.page);
    await makeTeam(c.page, F.BLIND[2]); await grantAll(c.page);
    f.state.mode = 'hang'; await c.page.click('#start-run');
    await until(c.page, () => document.getElementById('halo').dataset.busy === 'true' && !document.getElementById('cancel-run').disabled);
    await c.page.click('#cancel-run'); f.state.mode = 'ok'; f.release();
    await until(c.page, () => document.getElementById('halo').dataset.phase === 'cancelled');
    assert.equal(await c.page.getAttribute('#halo', 'data-busy'), 'false'); assert.equal(await c.page.locator('#halo [data-state="working"], #halo [data-state="started"]').count(), 0);
    assert.notEqual(await c.page.getAttribute('#out-headline', 'data-status'), 'accepted');
    ok('cancel-mid-run');
    f.state.mode = 'unknown';
    await makeTeam(c.page, F.BLIND[0]); await grantAll(c.page); await c.page.click('#start-run');
    await until(c.page, () => window.__r52.run() && window.__r52.run().status === 'review_required' && !document.getElementById('deliver-xlsx').disabled);
    assert.equal(await c.page.isHidden('#ack-cost-box'), false);
    await c.page.click('#deliver-xlsx'); await c.page.waitForSelector('[data-producer="universal_delivery"]');
    await c.page.check('#ack-criteria'); await c.page.check('#ack-sim'); await c.page.click('#accept-r53');
    await until(c.page, () => /unknown_cost_ack_required/.test(document.getElementById('feedback').textContent));
    await c.page.check('#ack-cost'); await c.page.click('#accept-r53');
    await until(c.page, () => document.getElementById('out-headline').dataset.status === 'accepted');
    f.state.mode = 'ok';
    assert.deepEqual(c.errors, []); await c.context.close();
    ok('unknown-cost-acknowledgement');

    // Phone + reduced motion on the live contract.
    const m = await open(browser, f, { reducedMotion: 'reduce', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await m.page.goto(m.base + PAGE); await ready(m.page);
    await makeTeam(m.page, F.BLIND[7]);
    assert.match(await m.page.getAttribute('#halo', 'class'), /static/);
    assert.ok(await m.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll');
    await m.page.tap('[data-grant] >> nth=0'); assert.equal(await m.page.getAttribute('[data-grant-role] >> nth=0', 'data-role-status'), 'approved');
    await m.page.screenshot({ path: path.join(SHOTS, 'r54-phone.png'), fullPage: true });
    assert.deepEqual(m.errors, []); await m.context.close();
    ok('phone-and-reduced-motion');

    evidence.result = 'PASS'; evidence.screenshots = fs.readdirSync(SHOTS).filter(n => /^r54-.*\.png$/.test(n));
    fs.writeFileSync(path.join(SHOTS, 'r54-ui-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('R54 UI E2E PASS', evidence.checks.length, 'checks; evidence in', SHOTS);
  } catch (e) {
    console.error('R54 UI E2E FAIL', e && e.stack || e);
    if (current) { try { await current.screenshot({ path: path.join(SHOTS, 'r54-failure.png'), fullPage: true }); console.error('feedback:', await current.textContent('#feedback'), '| url:', current.url()); } catch { /* page gone */ } }
    process.exitCode = 1;
  } finally { if (browser) await browser.close(); if (f) await f.stop(); }
})();
