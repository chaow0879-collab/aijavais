'use strict';
/* B7f reproduction helper (kept as evidence; not part of CI): a paid/unknown-price model,
 * fee cap 0, "approve paid" ticked, click 开始执行 — what does the user see? MOCK model only. */
const http = require('node:http');
const { chromium } = require('playwright');
const H = require('../helpers');
(async () => {
  const mock = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '好' } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n'); }); });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const app = await H.boot({ env: { LOCAL_MODEL_TARGETS: '127.0.0.1:' + mock.address().port } });
  let browser;
  try {
    const reg = await app.call('POST', '/api/models', { providerId: 'custom', protocol: 'openai', baseUrl: 'http://127.0.0.1:' + mock.address().port + '/v1', modelId: 'paid-model', displayName: 'paid', pricingMode: 'unknown', apiKey: 'mock-key' });
    const id = reg.json.connection.connectionId;
    const t = await app.call('POST', '/api/providers/' + id + '/test', { approvePaid: true });
    if (!t.json.ok) throw Error('probe failed ' + t.text);
    browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {});
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const ck = H.cookies.get(app.port).split('=');
    await ctx.addCookies([{ name: ck[0], value: ck.slice(1).join('='), domain: 'localhost', path: '/' }]);
    const page = await ctx.newPage();
    await page.goto('http://localhost:' + app.port + '/workspace.html');
    await page.waitForSelector('#project-name');
    await page.fill('#project-name', '复现');
    await page.fill('#project-description', '复现费用上限为 0 时点击开始执行');
    for (const s of await page.$$('#roles-editor select')) await s.selectOption(id);
    await page.fill('#max-cost', '0');
    if (await page.$('#approve-paid')) await page.check('#approve-paid');
    await page.click('#start-run');
    await page.waitForTimeout(1500);
    const fb = await page.$eval('#feedback', e => ({ text: e.textContent, top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom }));
    const runTabVisible = await page.$eval('#panel-run', e => !e.hidden);
    const scrollY = await page.evaluate(() => scrollY);
    console.log(JSON.stringify({ feedback: fb, bannerInViewport: fb.bottom > 0 && fb.top < 800, scrollY, runTabVisible }));
    await page.screenshot({ path: process.env.B7_REPRO_SHOT || '/tmp/b7-repro.png' });
  } finally { if (browser) await browser.close(); await app.stop(); mock.close(); }
})().catch(e => { console.error(e); process.exit(1); });
