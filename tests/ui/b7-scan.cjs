'use strict';
/* Helper (not in CI): print English words visible on a page, using the same rule as b7-usability.e2e.js. */
const { chromium } = require('playwright');
const H = require('../helpers');
const ALLOW = ['AIJAVAIS', 'Word', 'Excel', 'PPT', 'DeepSeek'];
const left = t => { for (const w of ALLOW) t = t.split(w).join(' '); return [...new Set(t.match(/[A-Za-z][A-Za-z_]{2,}/g) || [])]; };
(async () => {
  const app = await H.boot({});
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {});
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const ck = H.cookies.get(app.port).split('=');
    await ctx.addCookies([{ name: ck[0], value: ck.slice(1).join('='), domain: 'localhost', path: '/' }]);
    const page = await ctx.newPage();
    for (const pth of (process.argv[2] || '/admin.html').split(',')) {
      await page.goto('http://localhost:' + app.port + pth); await page.waitForTimeout(1200);
      console.log(pth, 'EMPTY:', JSON.stringify(left(await page.innerText('body'))));
    }
    if (!process.argv[2] || process.argv[2] === '/admin.html') {
      await app.call('POST', '/api/models/batch', { providerId: 'deepseek', apiKey: 'mock-key-1234', models: [{ modelId: 'deepseek-flash', capabilities: ['writing'] }] });
      await page.reload(); await page.waitForTimeout(1200);
      console.log('/admin.html WITH MODEL:', JSON.stringify(left(await page.innerText('body'))));
      await page.click('#mList button:has-text("编辑")').catch(() => {}); await page.waitForTimeout(500);
      console.log('/admin.html EDIT:', JSON.stringify(left(await page.innerText('#modal').catch(() => ''))));
    }
  } finally { await browser.close(); await app.stop(); }
})().catch(e => { console.error(e); process.exit(1); });
