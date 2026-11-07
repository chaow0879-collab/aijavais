'use strict';
// Independent acceptance gap runner: real server.js, loopback HTTP/SSE, Chromium,
// temporary SQLite, and explicit process fault windows. Never runs industry or
// developer unit suites and never changes the business source tree.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const H = require('./harness.cjs');
const mode = process.argv.includes('--browser') ? 'browser' : 'api';
const onlyCase = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
const results = [];
function safe(condition, message, severity = 'P1') {
  if (!condition) throw Object.assign(Error(message), { severity });
}
async function runCase(id, description, fn) {
  if (onlyCase && onlyCase !== id) return;
  const item = { id, description, start: new Date().toISOString(), status: 'NOT_RUN' };
  console.log('QA_GAPS_START ' + id);
  try { Object.assign(item, await fn()); item.status = item.status === 'NOT_RUN' ? 'PASS' : item.status; }
  catch (error) { item.status = 'FAIL'; item.error = error.message; item.stack = error.stack; item.severity = error.severity || 'TEST_REVIEW_REQUIRED'; }
  item.end = new Date().toISOString(); results.push(item);
  H.write(mode + '-results.json', { businessSha: H.BUSINESS_SHA, testBaseSha: H.TEST_BASE_SHA, mode, results });
  console.log('QA_GAPS_CASE ' + JSON.stringify(item));
  if (item.severity === 'P0' || item.severity === 'P1') {
    H.write('ALERT.json', item); throw Error('STOP: ' + item.severity + ' requires immediate Issue #4/#10 escalation');
  }
}
async function concurrency() {
  const provider = await new H.Provider().start(); const app = new H.App(provider, 'T2-10-concurrent');
  let evidence = {};
  try {
    await app.start(); await app.register(); provider.mode = 'hold';
    const input = app.input('qa-concurrent-same-id'); const burst = 8;
    let release; const barrier = new Promise(resolve => { release = resolve; });
    let finished = 0;
    const requests = Array.from({ length: burst }, async (_, index) => {
      await barrier;
      const response = await app.call('POST', '/api/v2/intake/ai-draft', input);
      finished++; return { index, status: response.status, code: response.json?.code, ledgerId: response.json?.ledgerId };
    });
    const barrierAt = Date.now(); release();
    await H.until(() => provider.calls.length >= 1, 'first actual provider request');
    await H.until(() => finished >= burst - 1, 'concurrent duplicate responses');
    const during = H.sqlSnapshot(app.dir);
    safe(provider.calls.length === 1, 'Same-ID concurrent burst dispatched more than one model HTTP request', 'P0');
    safe(during.requests.length === 1 && during.usage.length === 1, 'Same-ID burst created duplicate request or ledger rows', 'P1');
    assert.equal(during.requests[0].state, 'dispatching'); assert.equal(during.usage[0].cost, null);
    const changed = await app.call('POST', '/api/v2/intake/ai-draft', { ...input, description: input.description + ' 变更了输入。' });
    assert.equal(changed.status, 409); assert.equal(changed.json.code, 'idempotency_key_reused');
    safe(provider.calls.length === 1, 'Changed payload dispatched during same-ID conflict', 'P0');
    provider.release(); const responses = await Promise.all(requests);
    assert.equal(responses.filter(r => r.status === 200).length, 1);
    assert.equal(responses.filter(r => r.status === 409 && r.code === 'duplicate_request').length, burst - 1);
    const completed = H.sqlSnapshot(app.dir);
    assert.equal(completed.requests[0].state, 'completed'); assert.ok(completed.usage[0].cost > 0);
    await app.terminate(); await app.start();
    const duplicate = await app.call('POST', '/api/v2/intake/ai-draft', input);
    const changedAfterRestart = await app.call('POST', '/api/v2/intake/ai-draft', { ...input, maxOutputTokens: 1024 });
    assert.equal(duplicate.status, 409); assert.equal(duplicate.json.code, 'duplicate_request');
    assert.equal(changedAfterRestart.status, 409); assert.equal(changedAfterRestart.json.code, 'idempotency_key_reused');
    safe(provider.calls.length === 1, 'Same-ID restart replay sent a second provider HTTP request', 'P0');
    const after = H.sqlSnapshot(app.dir); assert.equal(after.usage.length, 1); assert.equal(after.integrity, 'ok');
    assert.equal(after.requests[0].ledger_id, during.requests[0].ledger_id);
    evidence = { burst, barrierAt, during, completed, after, responses, changed: changed.json, duplicate: duplicate.json, changedAfterRestart: changedAfterRestart.json };
    return { actualModelCalls: provider.calls.length, burst, ledgerRows: after.usage.length, evidence: app.label + '/evidence.json' };
  } finally { provider.release(); await app.cleanup(evidence); await provider.stop(); }
}
async function crashWindow(window) {
  const provider = await new H.Provider().start(); const app = new H.App(provider, 'T2-13-' + window);
  let evidence = {};
  try {
    await app.start(window === 'after-http' ? '' : window); await app.register(); provider.mode = 'hold';
    const input = app.input('qa-crash-' + window);
    const pending = app.call('POST', '/api/v2/intake/ai-draft', input).catch(error => ({ networkError: error.message }));
    if (window === 'after-http') await H.until(() => provider.calls.length === 1, 'actual model HTTP receipt');
    else await H.until(() => fs.existsSync(path.join(app.dir, 'qa-checkpoint.json')), 'committed crash barrier');
    const before = H.sqlSnapshot(app.dir);
    const checkpoint = window === 'after-http' ? { phase: 'actual-provider-received-request' } : JSON.parse(fs.readFileSync(path.join(app.dir, 'qa-checkpoint.json')));
    assert.equal(before.requests.length, 1); assert.equal(before.usage.length, 1); assert.equal(before.usage[0].status, 'reserved');
    assert.equal(before.requests[0].state, window === 'claimed' ? 'claimed' : 'dispatching');
    assert.ok(before.usage[0].reservedCost > 0); assert.equal(before.usage[0].cost, null);
    const callsBeforeKill = provider.calls.length;
    assert.equal(callsBeforeKill, window === 'after-http' ? 1 : 0);
    await app.terminate('SIGKILL');
    assert.equal(app.terminations.at(-1).signal, 'SIGKILL');
    const disconnected = await pending;
    await app.start();
    const recovered = H.sqlSnapshot(app.dir);
    assert.equal(recovered.integrity, 'ok'); assert.equal(recovered.requests.length, 1); assert.equal(recovered.usage.length, 1);
    const expectedState = window === 'claimed' ? 'not_dispatched' : 'interrupted_unknown';
    safe(recovered.requests[0].state === expectedState, 'SIGKILL restart did not conservatively recover durable request state', 'P1');
    if (window === 'claimed') {
      assert.equal(recovered.usage[0].cost, 0); assert.equal(recovered.usage[0].requestSent, false); assert.equal(recovered.usage[0].reservedCost, 0);
    } else {
      safe(recovered.usage[0].cost === null, 'May-have-sent crash recovery manufactured a zero cost', 'P1');
      assert.equal(recovered.usage[0].reservedCost, before.usage[0].reservedCost); assert.ok(recovered.usage[0].budgetCost > 0);
    }
    const duplicate = await app.call('POST', '/api/v2/intake/ai-draft', input);
    assert.equal(duplicate.status, 409); assert.equal(duplicate.json.code, 'duplicate_request');
    const exceptions = await app.call('GET', '/api/v2/usage/system/exceptions');
    safe(provider.calls.length === callsBeforeKill, 'SIGKILL recovery or same-ID retry replayed a model call', 'P0');
    evidence = { checkpoint, before, recovered, callsBeforeKill, callsAfterRecovery: provider.calls.length, disconnected, duplicate: duplicate.json, exceptions: exceptions.json };
    return { crashWindow: checkpoint.phase, actualModelCalls: provider.calls.length, recoveredState: expectedState, recoveredCost: recovered.usage[0].cost, evidence: app.label + '/evidence.json' };
  } finally { await app.cleanup(evidence); await provider.stop(); }
}
let browser;
async function usageText(page) { const field=page.locator('#ai-usage'); return await field.count() ? await field.textContent() : ''; }
async function contextFor(app) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const cookie = app.cookie.slice(app.cookie.indexOf('=') + 1);
  await context.addCookies([{ name: 'aij_session', value: cookie, url: app.origin }]);
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const exchanges = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/v2/intake/ai-draft' && request.method() === 'POST') {
      const input = request.postDataJSON(); exchanges.push({ at: Date.now(), requestId: input.requestId, input });
    }
  });
  await page.goto(app.origin + '/project-intake.html');
  await page.fill('#description', app.input('unused').description); await page.click('#next'); await page.click('#ai-draft-open');
  await page.selectOption('#ai-model', app.mid); await page.fill('#ai-max-cost', '1'); await page.fill('#ai-input-rate', '2'); await page.fill('#ai-output-rate', '4');
  return { context, page, errors, exchanges };
}
async function consent(page) {
  await page.click('#ai-estimate');
  await page.waitForFunction(() => document.querySelector('#ai-estimate-text')?.textContent.includes('当前上限可覆盖'));
  await page.check('#ai-consent'); assert.equal(await page.isEnabled('#ai-generate'), true);
}
function responseFor(page) {
  return page.waitForResponse(response => new URL(response.url()).pathname === '/api/v2/intake/ai-draft' && response.request().method() === 'POST', { timeout: 80000 });
}
async function observedReply(ui, responsePromise) {
  const response = await responsePromise; const body = await response.json();
  await ui.page.waitForFunction(() => document.querySelector('#ai-cancel')?.disabled && !document.querySelector('#ai-message')?.textContent.startsWith('正在请求'));
  const message = await ui.page.locator('#ai-message').textContent();
  const usage = await usageText(ui.page);
  const result = { status: response.status(), body, message, usage };
  ui.exchanges.at(-1).response = result;
  return result;
}
async function screenshot(ui, name) {
  await ui.page.locator('#ai-message').scrollIntoViewIfNeeded();
  await ui.page.screenshot({ path: H.write(name + '.png', Buffer.alloc(0)) });
  H.write(name + '-text.json', { message: await ui.page.locator('#ai-message').textContent(), usage: await usageText(ui.page) });
}
async function finishUi(ui, label) {
  if (!ui) return;
  H.write(label + '/browser-http.json', ui.exchanges); H.write(label + '/page-errors.json', ui.errors);
  const trace = H.write(label + '/trace.zip', Buffer.alloc(0));
  await ui.context.tracing.stop({ path: trace });
  execFileSync('python3', [path.join(__dirname, 'sanitize-trace.py'), trace]);
  await ui.context.close();
}
async function errorUi(kind) {
  const provider = await new H.Provider().start(); const label = 'T2-09-' + kind; const app = new H.App(provider, label);
  let ui, evidence = {};
  try {
    await app.start(); await app.register(); ui = await contextFor(app);
    provider.mode = /^\d/.test(kind) ? 'error-' + kind : 'hold';
    await consent(ui.page); const responsePromise = responseFor(ui.page); const began = Date.now();
    await ui.page.click('#ai-generate');
    if (kind === 'cancel') { await H.until(() => provider.calls.length === 1, 'cancelled request reached model'); await ui.page.click('#ai-cancel'); }
    const reply = await observedReply(ui, responsePromise); const elapsedMs = Date.now() - began;
    safe(reply.body.usage?.cost === null, 'Sent model error displayed a confirmed zero fee', 'P1');
    assert.match(reply.usage, /未知/); assert.doesNotMatch(reply.usage, /费用：\$0(?:\s|\D)/);
    if (/^\d/.test(kind)) { assert.equal(reply.status, 502); assert.match(reply.message, new RegExp('HTTP ' + kind)); }
    else if (kind === 'timeout') { assert.equal(reply.status, 504); assert.equal(reply.body.code, 'timeout'); assert.ok(elapsedMs >= 59000, 'Use the real unmodified 60-second draft deadline'); }
    else { assert.equal(reply.status, 409); assert.equal(reply.body.code, 'cancelled'); assert.match(reply.message, /可能产生费用/); }
    assert.match(reply.message, /手工|模板|账本/);
    await screenshot(ui, label + '/error'); const failedLedger = H.sqlSnapshot(app.dir);
    await H.sleep(300); assert.equal(provider.calls.length, 1, 'No automatic retry during the observed error window');
    provider.mode = 'ok'; await consent(ui.page); const recoveryPromise = responseFor(ui.page); await ui.page.click('#ai-generate');
    const recovery = await observedReply(ui, recoveryPromise);
    assert.equal(recovery.status, 200); assert.equal(provider.calls.length, 2);
    assert.notEqual(ui.exchanges[0].requestId, ui.exchanges[1].requestId);
    assert.equal((await app.call('GET', '/api/v2/projects')).json.projects.length, 0);
    assert.deepEqual(ui.errors, []);
    evidence = { kind, elapsedMs, reply, recovery, failedLedger, after: H.sqlSnapshot(app.dir), browserRequests: ui.exchanges };
    return { providerFailure: kind, applicationStatus: reply.status, elapsedMs, fee: reply.body.usage.cost, explicitRecovery: true, actualModelCalls: provider.calls.length, evidence: label + '/evidence.json', usabilityLimit: 'Automated text/operation checks only; no human comprehension study' };
  } finally { await finishUi(ui, label); await app.cleanup(evidence); await provider.stop(); }
}
async function settlementUi() {
  const provider = await new H.Provider().start(); const label = 'T2-11-settlement-ui'; const app = new H.App(provider, label);
  let ui, evidence = {};
  try {
    await app.start('settlement-failure'); await app.register(); ui = await contextFor(app);
    await consent(ui.page); const responsePromise = responseFor(ui.page); await ui.page.click('#ai-generate');
    const reply = await observedReply(ui, responsePromise);
    assert.equal(reply.status, 202); assert.equal(reply.body.code, 'usage_unsettled'); assert.equal(reply.body.ok, false);
    assert.equal(reply.body.financiallyComplete, false); safe(reply.body.usage.cost === null, 'Settlement failure showed zero/confirmed cost', 'P1');
    assert.match(reply.message, /账本未完成/); assert.match(reply.message, /费用未知/); assert.match(reply.message, /人工核对/);
    assert.match(reply.usage, /未知，不能视为零/); assert.doesNotMatch(reply.usage, /已记录账本|费用：\$0/);
    assert.equal(await ui.page.locator('.ai-role-name').count(), 2); assert.equal(await ui.page.isEnabled('#ai-save'), false);
    await screenshot(ui, label + '/202-unknown'); const before = H.sqlSnapshot(app.dir);
    assert.equal(before.requests[0].state, 'dispatching'); assert.equal(before.usage[0].status, 'reserved'); assert.ok(before.usage[0].reservedCost > 0);
    await app.terminate(); await app.start();
    const after = H.sqlSnapshot(app.dir); assert.equal(after.requests[0].state, 'interrupted_unknown'); assert.equal(after.usage[0].cost, null);
    const duplicate = await app.call('POST', '/api/v2/intake/ai-draft', ui.exchanges[0].input);
    assert.equal(duplicate.status, 409); safe(provider.calls.length === 1, 'Settlement failure was replayed after restart', 'P0');
    const recoveryContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await recoveryContext.addCookies([{ name: 'aij_session', value: app.cookie.slice(app.cookie.indexOf('=') + 1), url: app.origin }]);
    const recoveryPage = await recoveryContext.newPage(); await recoveryPage.goto(app.origin + '/capabilities.html');
    await recoveryPage.locator('#system-usage-warning').waitFor({ state: 'visible' });
    const accountingText = await recoveryPage.locator('#system-usage-warning').textContent(); assert.match(accountingText, /未知|待核对/);
    await recoveryPage.locator('#system-usage-warning').screenshot({ path: H.write(label + '/restarted-accounting.png', Buffer.alloc(0)) });
    await recoveryContext.close(); assert.deepEqual(ui.errors, []);
    evidence = { reply, before, after, duplicate: duplicate.json, accountingText };
    return { applicationStatus: 202, fee: null, actualModelCalls: 1, manualSaveRequired: true, recovered: 'interrupted_unknown', evidence: label + '/evidence.json' };
  } finally { await finishUi(ui, label); await app.cleanup(evidence); await provider.stop(); }
}
async function doubleClickUi() {
  const provider = await new H.Provider().start(); const label = 'T2-10-browser-double-click'; const app = new H.App(provider, label);
  let ui, evidence = {};
  try {
    await app.start(); await app.register(); ui = await contextFor(app); provider.mode = 'hold'; await consent(ui.page);
    const box = await ui.page.locator('#ai-generate').boundingBox(); const responsePromise = responseFor(ui.page);
    await ui.page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2, { delay: 80 });
    await H.until(() => provider.calls.length >= 1, 'native double-click model request'); await H.sleep(200);
    safe(provider.calls.length === 1 && ui.exchanges.length === 1, 'A native double click triggered more than one authorized model request', 'P1');
    const during = H.sqlSnapshot(app.dir); assert.equal(during.usage.length, 1);
    provider.release(); const reply = await observedReply(ui, responsePromise); assert.equal(reply.status, 200);
    await screenshot(ui, label + '/double-click'); evidence = { during, after: H.sqlSnapshot(app.dir), browserRequests: ui.exchanges };
    return { nativeInput: 'Playwright mouse.dblclick, 80ms interval', browserRequests: ui.exchanges.length, actualModelCalls: provider.calls.length, ledgerRows: during.usage.length, evidence: label + '/evidence.json' };
  } finally { provider.release(); await finishUi(ui, label); await app.cleanup(evidence); await provider.stop(); }
}
async function capacityUi() {
  const provider = await new H.Provider().start(); const label = 'T2-12-permanent-capacity'; const app = new H.App(provider, label);
  let ui, evidence = {};
  try {
    await app.start('ignore-abort'); await app.register(); ui = await contextFor(app); provider.mode = 'hold';
    const cancelled = [];
    for (let i = 0; i < 3; i++) {
      await consent(ui.page); const responsePromise = responseFor(ui.page); await ui.page.click('#ai-generate');
      await H.until(() => provider.calls.length === i + 1, 'non-cooperative model receipt'); await ui.page.click('#ai-cancel');
      const reply = await observedReply(ui, responsePromise);
      assert.equal(reply.status, 409); assert.equal(reply.body.billingStatus, 'dispatch_outstanding'); assert.equal(reply.body.usage.cost, null);
      assert.match(reply.message, /尚未确认结束/); assert.match(reply.message, /可能仍在处理并计费/); cancelled.push(reply);
    }
    await screenshot(ui, label + '/outstanding-unknown');
    const before = H.sqlSnapshot(app.dir); const callsBefore = provider.calls.length;
    const status = await app.call('GET', '/api/v2/intake/ai-draft/status');
    const exceptions = await app.call('GET', '/api/v2/usage/system/exceptions');
    const statusAgain = await app.call('GET', '/api/v2/intake/ai-draft/status');
    const afterRead = H.sqlSnapshot(app.dir);
    assert.equal(status.json.activeSlots, 3); assert.equal(status.json.underlyingInFlight, 3); assert.equal(status.json.outstandingAfterResponse, 3);
    assert.equal(status.json.readOnly, true); assert.deepEqual(before, afterRead); assert.equal(provider.calls.length, callsBefore);
    assert.equal(exceptions.json.exceptions.length, 3);
    for (const entry of exceptions.json.exceptions) { assert.equal(entry.cost, null); assert.equal(entry.requestState, 'dispatching'); assert.ok(entry.reservedCost > 0); }
    await consent(ui.page); const fourthPromise = responseFor(ui.page); await ui.page.click('#ai-generate');
    const fourth = await observedReply(ui, fourthPromise); assert.equal(fourth.status, 429); assert.equal(fourth.body.code, 'draft_busy');
    assert.match(fourth.message, /已有3个/); assert.match(fourth.message, /本次未发送请求/);
    safe(provider.calls.length === 3 && provider.peak <= 3, 'Fourth request exceeded actual model HTTP capacity', 'P1');
    assert.equal(H.sqlSnapshot(app.dir).usage.length, 3); await screenshot(ui, label + '/429-full');
    const current = ui.page.locator('#ai-current-request'), previous = ui.page.locator('#ai-usage-previous');
    assert.match(await current.textContent(), /未发送请求，本次费用为0/);
    assert.match(await previous.textContent(), /与本次请求无关.*未知/);
    assert.equal(await current.getAttribute('data-request-id'), ui.exchanges.at(-1).requestId);
    assert.equal(await previous.getAttribute('data-request-id'), ui.exchanges.at(-2).requestId);
    assert.notEqual(await current.getAttribute('data-request-id'), await previous.getAttribute('data-request-id'));
    assert.equal(await ui.page.locator('#ai-usage').count(), 0);
    H.write(label+'/request-attribution.json', {current:await current.textContent(),previous:await previous.textContent(),currentRequestId:await current.getAttribute('data-request-id'),previousRequestId:await previous.getAttribute('data-request-id')});
    const staleUsageAttribution = fourth.usage === cancelled.at(-1).usage && /本次用量/.test(fourth.usage) && /供应商调用尚未结束/.test(fourth.usage);
    const findings = staleUsageAttribution ? [{ id: 'QA-GAPS-UX-01', severity: 'P2', status: 'FAIL',
      title: '429 capacity rejection reuses the previous cancelled request usage as current-request usage',
      expected: 'The rejected request has no dispatch/ledger; identify earlier outstanding usage as a prior request, or hide the stale current-request usage panel.',
      actual: { message: fourth.message, usage: fourth.usage, sameAsPriorUsage: true, fourthHttpBody: fourth.body },
      evidence: label + '/429-full.png' }] : [];
    const originals = ui.exchanges.slice(0, 3).map(x => x.input);
    await app.terminate(); await H.until(() => provider.active === 0, 'child process exit closes held HTTP sockets');
    const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-r43-backup-')); fs.cpSync(app.dir, backup, {recursive:true}); const backupState=H.sqlSnapshot(backup); assert.equal(backupState.integrity,'ok'); assert.equal(backupState.usage.length,3); fs.rmSync(backup,{recursive:true,force:true});
    await app.start(); const recovered = H.sqlSnapshot(app.dir);
    for (const row of recovered.usage) { assert.equal(row.status, 'interrupted_unknown'); assert.equal(row.cost, null); assert.ok(row.reservedCost > 0); }
    for (const input of originals) assert.equal((await app.call('POST', '/api/v2/intake/ai-draft', input)).status, 409);
    safe(provider.calls.length === 3, 'Permanent-call recovery replayed an old request', 'P0');
    const recoveredStatus = await app.call('GET', '/api/v2/intake/ai-draft/status'); assert.equal(recoveredStatus.json.activeSlots, 0);
    provider.mode = 'ok'; const fresh = await app.call('POST', '/api/v2/intake/ai-draft', app.input('qa-after-operator-restart')); assert.equal(fresh.status, 200);
    assert.equal(provider.calls.length, 4); assert.deepEqual(ui.errors, []);
    evidence = { testHook: 'Only the temporary adapter removes AbortSignal; real local HTTP stays open until the app exits', cancelled, before, status: status.json, exceptions: exceptions.json, statusAgain: statusAgain.json, afterRead, fourth, recovered, recoveredStatus: recoveredStatus.json, fresh: fresh.json, findings };
    const sop=fs.readFileSync(path.join(H.ROOT,'docs/P2-OPERATIONS.md'),'utf8'); assert.match(sop,/人工恢复SOP/); assert.match(sop,/interrupted_unknown/); const diagnosis=require('../../tools/p2/preflight').diagnose(status.json); assert.equal(diagnosis.status,'CAPACITY_BLOCKED'); assert.equal(diagnosis.readOnly,true); H.write(label+'/sop-validation.json',{source:'docs/P2-OPERATIONS.md',sha256:H.hash(sop),diagnosis,backupState,mode:'isolated authorized stop/backup/restart; production NOT_RUN'});
    return { status: findings.length ? 'FAIL' : 'PASS', ...(findings.length ? { severity: 'P2' } : {}),
      verifiedSubchecks: 'PASS: native UI outstanding/429, real HTTP peak3, no hidden dispatch, read-only SQLite/diagnostics, isolated restart/no replay/fresh request',
      sopResult: 'PASS: shipped P2-OPERATIONS SOP, read-only diagnose, stopped-instance backup integrity and unknown-preserving restart; production NOT_RUN',
      subchecks: [{ id: 'T2-12-capacity', status: 'PASS' }, { id: 'T2-12-diagnostics-and-restart', status: 'PASS' }, { id: 'T2-12-current-request-usage', status: findings.length ? 'FAIL' : 'PASS' }, { id: 'T2-12-shipped-admin-SOP', status: 'PASS' }],
      findings, actualModelCallsBeforeRestart: 3, peakProviderHttp: provider.peak, evidence: label + '/evidence.json' };
  } finally { await finishUi(ui, label); await app.cleanup(evidence); await provider.stop(); }
}
(async () => {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: H.ROOT, encoding: 'utf8' }).trim();
  const worktreeStatus = execFileSync('git', ['status', '--porcelain=v1'], { cwd: H.ROOT, encoding: 'utf8' }).trim();
  const sourceHashes = Object.fromEntries(['run.cjs', 'harness.cjs', 'fault-preload.cjs', 'sanitize-trace.py'].map(name => [name, H.hash(fs.readFileSync(path.join(__dirname, name)))]));
  H.write('provenance.json', { businessSha: H.BUSINESS_SHA, testBaseSha: H.TEST_BASE_SHA, testHeadSha: sha, worktreeStatus, sourceHashes, node: process.version, mode, scope: 'E2/E3 local synthetic product gap acceptance only; E4/E5 NOT_RUN' });
  if (mode === 'api') {
    await runCase('T2-10-API', 'Barrier concurrent same-ID/changed-payload/restart with real HTTP and SQLite', concurrency);
    for (const window of ['after-http']) await runCase('T2-13-' + window, 'SIGKILL crash window ' + window + ', recovery, reservation and no replay', () => crashWindow(window));
  } else {
    const { chromium } = require('playwright');
    const options = { headless: true };
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    if (process.env.QA_GAPS_CHROMIUM_NO_SANDBOX === '1') options.args = ['--no-sandbox'];
    browser = await chromium.launch(options);
    try {
      H.write('browser-version.json', { chromium: browser.version(), playwright: require('playwright/package.json').version });
      for (const kind of ['cancel']) await runCase('T2-09-' + kind, 'Real Chromium provider error/cancel and explicit recovery: ' + kind, () => errorUi(kind));
      await runCase('T2-11-UI', 'Actual HTTP202 unknown billing rendering and restart warning', settlementUi);
      await runCase('T2-12-GAP', 'Permanent non-cooperative capacity and controlled operator restart', capacityUi);
    } finally { await browser.close(); }
  }
  if (onlyCase && results.length !== 1) throw Error('Requested case was not executed: ' + onlyCase);
  const counts = Object.fromEntries(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].map(status => [status, results.filter(row => row.status === status).length]));
  H.write('summary.json', { mode, testHeadSha: sha, businessSha: H.BUSINESS_SHA, counts, results }); H.manifest();
  console.log('QA_GAPS_SUMMARY ' + JSON.stringify(counts));
  if (counts.FAIL) process.exitCode = 1;
})().catch(error => { console.error(error.stack); H.manifest(); process.exitCode = 1; });
