'use strict';
// Controlled JavaScript execution. Isolation tests need unprivileged namespaces;
// where they are unavailable the tool must refuse (fail closed) and tests that
// need it are reported as SKIPPED with the reason.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fresh = () => { delete require.cache[require.resolve('../lib/code-exec')]; return require('../lib/code-exec'); };
const withEnv = async (v, fn) => { const old = process.env.AIJ_ENABLE_CODE_EXECUTION; if (v === undefined) delete process.env.AIJ_ENABLE_CODE_EXECUTION; else process.env.AIJ_ENABLE_CODE_EXECUTION = v; try { return await fn(); } finally { if (old === undefined) delete process.env.AIJ_ENABLE_CODE_EXECUTION; else process.env.AIJ_ENABLE_CODE_EXECUTION = old; } };
const isolated = fresh().codeExecStatus().isolated;

test('code execution is off by default and refuses to run', async () => {
  await withEnv(undefined, async () => {
    const CX = fresh();
    assert.equal(CX.codeExecStatus().enabled, false);
    await assert.rejects(CX.runJavaScript({ code: 'console.log(1)' }), e => e.code === 'tool_unavailable' && /管理员未开启/.test(e.message));
  });
});

test('code execution: real output, files, no network, no file access outside its dir, no child processes, timeout', { skip: !isolated && 'unprivileged network namespaces unavailable here (tool correctly refuses to run)' }, async () => {
  await withEnv('1', async () => {
    const CX = fresh();
    const ok = await CX.runJavaScript({ code: "const fs=require('fs');const d=fs.readFileSync('data.csv','utf8').trim().split('\\n').slice(1).map(l=>+l.split(',')[1]);fs.writeFileSync('out/sum.json',JSON.stringify({sum:d.reduce((a,b)=>a+b,0)}));console.log('rows',d.length)", files: { 'data.csv': 'k,v\na,1\nb,2\nc,39\n' } });
    assert.equal(ok.exitCode, 0, ok.stderr); assert.match(ok.stdout, /rows 3/);
    assert.deepEqual(JSON.parse(ok.outputs.find(o => o.path === 'out/sum.json').buffer), { sum: 42 });
    const secret = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aij-secret-')), 'key.txt'); fs.writeFileSync(secret, 'TOP-SECRET');
    const read = await CX.runJavaScript({ code: `try{console.log(require('fs').readFileSync(${JSON.stringify(secret)},'utf8'))}catch(e){console.log('blocked',e.code)}` });
    assert.match(read.stdout, /blocked ERR_ACCESS_DENIED/); assert.doesNotMatch(read.stdout, /TOP-SECRET/);
    const env = await CX.runJavaScript({ code: "console.log(JSON.stringify(Object.keys(process.env).sort()))" });
    assert.deepEqual(JSON.parse(env.stdout), ['HOME', 'LANG', 'NODE_OPTIONS', 'PATH', 'TMPDIR'], 'no keys or proxy settings are inherited');
    const net = await CX.runJavaScript({ code: "require('net').connect(80,'1.1.1.1').on('error',e=>console.log('net',e.code)).on('connect',()=>console.log('CONNECTED'))", timeoutMs: 5000 });
    assert.match(net.stdout, /net E/); assert.doesNotMatch(net.stdout, /CONNECTED/);
    const child = await CX.runJavaScript({ code: "try{require('child_process').execSync('id')}catch(e){console.log('blocked',e.code)}" });
    assert.match(child.stdout, /blocked ERR_ACCESS_DENIED/);
    const evalTry = await CX.runJavaScript({ code: "try{eval('1+1')}catch(e){console.log('eval blocked')}" });
    assert.match(evalTry.stdout, /eval blocked/);
    const slow = await CX.runJavaScript({ code: 'while(true){}', timeoutMs: 1000 });
    assert.equal(slow.timedOut, true);
    const loud = await CX.runJavaScript({ code: "process.stdout.write('x'.repeat(200000))" });
    assert.equal(loud.truncated, true); assert.equal(loud.stdout.length, CX.CODE_EXEC_LIMITS.maxStreamBytes);
    await assert.rejects(CX.runJavaScript({ code: '1', files: { '../escape.txt': 'x' } }), e => e.code === 'invalid_path');
  });
});
