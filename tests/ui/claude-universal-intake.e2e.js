'use strict';
// R44 (#28) real Chromium + real server (HTTP, auth, SQLite). No model is configured and
// no model request is made: evidence level E2/E3 only (not real-model E4, not human E5).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const H = require('../helpers');

const SHOTS = process.env.UI_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'aij-claude-universal-'));
const CASES = [
  { key: 'pet-funeral', description: '为城市宠物殡葬与纪念服务门店设计开业服务流程、价目表和客户告别仪式方案', audience: '失去宠物的家庭',
    domain: '宠物殡葬与纪念服务', success: '服务流程每一步都有负责人\n价目表包含成本测算', constraints: '遵守当地动物尸体无害化处理规定', expectRisk: true },
  { key: 'drone-plant-protection', description: '规划一个农业无人机植保作业季的排班、农药配比安全规范和农户沟通材料', audience: '合作社农户',
    domain: '农业无人机植保', success: '排班覆盖全部地块\n安全规范引用适用标准', constraints: '一个作业季内完成', outputs: ['schedule', 'document'], expectRisk: true },
  { key: 'bamboo-live-commerce', description: '为乡村非遗竹编手工艺开设短视频直播带货，做选品分析、直播脚本和视觉海报', audience: '直播间观众',
    domain: '非遗竹编直播电商', success: '三场直播脚本完整\n海报适配手机竖屏', constraints: '两周内上线', expectRisk: false }
];

(async () => {
  let app, browser;
  const evidence = { level: 'E2/E3 (real Chromium + real server, no model)', cases: {} };
  try {
    app = await H.boot();
    const options = { headless: true };
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    browser = await chromium.launch(options);
    const base = 'http://localhost:' + app.port;
    const context = await browser.newContext({ viewport: { width: 1360, height: 950 }, acceptDownloads: true });
    await context.addCookies([{ name: 'aij_session', value: app.cookie.split('=').slice(1).join('='), url: base }]);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
    const next = () => page.click('#next');
    const title = () => page.textContent('#step-title');

    async function goal(c) {
      await page.goto(base + '/project-intake.html');
      await page.fill('#description', c.description); await page.fill('#audience', c.audience); await next();
      assert.equal(await title(), '选择项目类型');
    }
    for (const c of CASES) {
      await goal(c);
      // M1/M2: no strong match → the universal path is recommended; samples are labelled as unmatched/weak, never "智能推荐".
      assert.match(await page.textContent('#match-note'), /没有找到与你的领域明确匹配的模板/);
      assert.equal(await page.locator('[data-strength="strong"]').count(), 0);
      assert.equal(await page.locator('text=智能推荐').count(), 0);
      assert.ok(await page.locator('[data-template]:not(#universal-choice)').count() > 0, 'reference samples still available');
      await page.click('#universal-choice'); await next();
      assert.ok(await page.locator('#u-analysis[data-status="needs_clarification"]').count(), 'domain/criteria missing → needs clarification first');
      await page.fill('#u-domain', c.domain); await page.fill('#u-success', c.success); await page.fill('#u-constraints', c.constraints);
      if (c.outputs) { for (const box of await page.locator('[data-uoutput]').all()) await box.uncheck(); for (const o of c.outputs) await page.check('[data-uoutput="' + o + '"]'); }
      await page.click('[data-action="reanalyze"]');
      assert.equal(await page.getAttribute('#u-analysis', 'data-status'), 'draft_ready_for_edit');
      await page.screenshot({ path: path.join(SHOTS, 'claude-universal-' + c.key + '-goal.png'), fullPage: true });
      await next();
      // Roles: edit the first role's name inline.
      const roleIds = await page.locator('[data-rolecard]').evaluateAll(n => n.map(x => x.dataset.rolecard));
      const roleNames = await page.locator('[data-rolecard] .roleMeta strong').allTextContents();
      assert.ok(roleIds.length >= 5, c.key + ' roles: ' + roleNames);
      assert.ok(roleNames.some(n => n.includes(c.domain)));
      await page.locator('[data-rolecard="u-scope"] details summary').click();
      await page.fill('#role-u-scope-name', c.domain + '项目协调人');
      await next();
      await page.locator('#step-content details').first().locator('summary').click();
      await page.fill('#step-u-step-scope-deliverable', '用户确认的范围清单');
      await next();
      assert.equal(await title(), '确认方案与提示词');
      assert.ok(await page.locator('#u-result').count());
      assert.equal(await page.getAttribute('#u-result', 'data-status'), 'draft_ready_for_edit');
      const checks = await page.locator('#u-checks li').allTextContents();
      assert.ok(checks.some(x => x.includes(c.success.split('\n')[0])), 'user success criteria shown as delivery checks');
      assert.equal(await page.locator('#u-human').count() > 0, c.expectRisk, 'human expert review only where a risk domain was found');
      assert.match(await page.textContent('#prompt-output'), new RegExp(c.domain + '项目协调人'));
      assert.match(await page.textContent('#prompt-output'), /用户确认的范围清单/);
      await page.screenshot({ path: path.join(SHOTS, 'claude-universal-' + c.key + '-result.png'), fullPage: true });
      evidence.cases[c.key] = { roles: roleNames, checks: checks.length, human: c.expectRisk };
    }
    const sets = Object.values(evidence.cases).map(x => x.roles.filter(n => !/需求与范围|独立质量复核|专业内容负责人/.test(n)).sort().join('|'));
    assert.equal(new Set(sets).size, CASES.length, 'three unseen industries produce different specialist teams: ' + JSON.stringify(sets));

    // Export a re-editable draft, reset, import it again and save to the workspace (real server + SQLite).
    const c = CASES[CASES.length - 1]; // the page currently shows the last case's result
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="draft"]')]);
    const draftPath = path.join(SHOTS, 'claude-universal-draft.json'); await download.saveAs(draftPath);
    const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
    assert.equal(draft.format, 'aijavais-intake-draft'); assert.doesNotMatch(JSON.stringify(draft), /assignments|availableModels|apiKey/);
    await page.click('#reset');
    assert.equal(await title(), '明确任务目标');
    await page.setInputFiles('#import-draft', draftPath);
    await page.waitForSelector('#import-note');
    assert.equal(await title(), '确定岗位与模型');
    assert.ok((await page.locator('[data-rolecard] .roleMeta strong').allTextContents()).includes(c.domain + '项目协调人'), 'edits survive export → import');
    await next(); await next();
    const [nav] = await Promise.all([page.waitForURL(/workspace\.html\?project=/), page.click('[data-action="save-project"]')]);
    void nav;
    const projectId = new URL(page.url()).searchParams.get('project');
    const saved = (await app.call('GET', '/api/v2/projects/' + projectId)).json;
    assert.ok(saved.project.roles.some(r => r.name === c.domain + '项目协调人'));
    assert.equal(saved.project.intake.projectType, 'universal'); assert.equal(saved.runs.length, 0);
    await page.screenshot({ path: path.join(SHOTS, 'claude-universal-workspace.png'), fullPage: true });
    evidence.savedProject = { projectId, name: saved.project.name, roles: saved.project.roles.length };

    // Malformed import is refused with a message; nothing changes.
    const badPath = path.join(SHOTS, 'claude-universal-bad.json'); fs.writeFileSync(badPath, '{"format":"other"}');
    await page.goto(base + '/project-intake.html'); await page.setInputFiles('#import-draft', badPath);
    await page.waitForSelector('#import-note'); assert.match(await page.textContent('#import-note'), /导入失败/);
    assert.equal(await title(), '明确任务目标');

    // XSS: hostile text in every universal field is rendered as text only.
    const evil = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=1</script>';
    await page.fill('#description', evil + '为社区设计活动计划表'); await page.fill('#audience', evil); await next();
    await page.click('#universal-choice'); await next();
    await page.fill('#u-domain', evil); await page.fill('#u-success', evil); await page.click('[data-action="reanalyze"]'); await next(); await next(); await next();
    assert.equal(await page.evaluate(() => window.__pwn), undefined);
    assert.equal(await page.locator('#step-content img').count(), 0);
    assert.ok((await page.textContent('#prompt-output')).includes('<img src=x'), 'shown literally');

    // Vague goal: draft still possible, but needs clarification and not executable.
    await page.goto(base + '/project-intake.html'); await page.fill('#description', '帮我把这件事情好好安排一下吧'); await next();
    await page.click('#universal-choice'); await next(); await next(); await next(); await next();
    assert.equal(await page.getAttribute('#u-result', 'data-status'), 'needs_clarification');
    assert.match(await page.textContent('.warnbox'), /需要澄清：/);
    await page.screenshot({ path: path.join(SHOTS, 'claude-universal-clarify.png'), fullPage: true });

    // Familiar goal regression: strong catalog match still offered and usable.
    await page.goto(base + '/project-intake.html'); await page.fill('#description', '开发一个网站代码程序并附测试'); await next();
    assert.match(await page.textContent('#match-note'), /已找到关键词匹配的参考模板/);
    assert.ok(await page.locator('[data-template="software-development"][data-strength="strong"]').count());
    await page.click('[data-template="software-development"]'); await next(); await next(); await next(); await next();
    assert.equal(await title(), '确认方案与提示词'); assert.equal(await page.locator('#u-result').count(), 0);

    const usage = await app.call('GET', '/api/v2/usage/system');
    assert.equal((usage.json.usage || []).length, 0, 'no model request was made');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(SHOTS, 'claude-universal-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('PASS R44 universal intake Chromium E2E: ' + JSON.stringify(evidence) + ' shots=' + SHOTS);
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { if (browser) await browser.close(); if (app) await app.stop(); }
})();
