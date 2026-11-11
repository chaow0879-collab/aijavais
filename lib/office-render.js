'use strict';
/* Optional Office conversion/rendering through system programs (no npm deps):
 *   LibreOffice (soffice) converts DOCX/XLSX/PPTX to PDF;
 *   poppler (pdftoppm) renders PDF pages to PNG and to tiny grayscale maps
 *   used for a blank-page check.
 * Inputs are untrusted: each call uses a private temp dir and a throwaway
 * LibreOffice profile, no shell, a timeout that kills the process group, and
 * bounded outputs. LibreOffice does not run document macros in headless
 * conversion with a fresh profile (default macro security). */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const LIMITS = Object.freeze({ convertTimeoutMs: 120000, renderTimeoutMs: 60000, maxPages: 30, maxPdfBytes: 64 * 1024 * 1024, maxPngBytes: 8 * 1024 * 1024 });
class RenderError extends Error { constructor(code, message) { super(message); this.code = code; this.status = 422; } }
function which(name) {
  for (const dir of String(process.env.PATH || '/usr/bin:/bin').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    try { const f = path.join(dir, name); fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}
const tools = () => ({ soffice: which('soffice') || which('libreoffice'), pdftoppm: which('pdftoppm') });

function run(file, args, { cwd, timeoutMs, signal, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, shell: false, detached: process.platform !== 'win32', stdio: 'ignore', env });
    let done = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* exited */ } } };
    const finish = err => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); if (err) { kill(); reject(err); } else resolve(); };
    const timer = setTimeout(() => finish(new RenderError('render_timeout', '转换或渲染超时')), timeoutMs);
    const onAbort = () => finish(new RenderError('aborted', '已取消'));
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', () => finish(new RenderError('tool_failed', '无法启动 ' + path.basename(file))));
    child.on('close', code => code === 0 ? finish() : finish(new RenderError('render_failed', path.basename(file) + ' 处理失败（文件可能损坏或受保护）')));
  });
}
async function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-office-'));
  fs.chmodSync(dir, 0o700);
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const baseEnv = home => ({ PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: home, TMPDIR: home });

async function convertToPdf(buffer, ext, { signal } = {}) {
  const t = tools();
  if (!t.soffice) throw new RenderError('tool_unavailable', '服务器未安装 LibreOffice，无法转换为 PDF');
  if (!['docx', 'xlsx', 'pptx'].includes(ext)) throw new RenderError('unsupported_type', '只能转换 Word / Excel / PPT 文件');
  return withTemp(async dir => {
    const input = path.join(dir, 'input.' + ext);
    fs.writeFileSync(input, buffer, { mode: 0o600 });
    const profile = pathToFileURL(path.join(dir, 'profile')).href;
    await run(t.soffice, ['--headless', '--norestore', '--nologo', '--nodefault', '--nolockcheck', '-env:UserInstallation=' + profile, '--convert-to', 'pdf', '--outdir', dir, input], { cwd: dir, timeoutMs: LIMITS.convertTimeoutMs, signal, env: baseEnv(dir) });
    const out = path.join(dir, 'input.pdf');
    if (!fs.existsSync(out)) throw new RenderError('render_failed', 'LibreOffice 没有生成 PDF');
    if (fs.statSync(out).size > LIMITS.maxPdfBytes) throw new RenderError('render_limit', '生成的 PDF 过大');
    return fs.readFileSync(out);
  });
}
/* Fraction of non-white pixels in a binary PGM (P5) produced by pdftoppm -gray. */
function inkRatio(pgm) {
  const header = /^P5\s+(?:#.*\s+)*(\d+)\s+(\d+)\s+(\d+)\s/.exec(pgm.subarray(0, 100).toString('latin1'));
  if (!header) return null;
  const [, w, h] = header.map(Number), data = pgm.subarray(header[0].length, header[0].length + w * h);
  let ink = 0; for (const v of data) if (v < 235) ink++;
  return data.length ? ink / data.length : null;
}
async function renderPdf(pdf, { maxPages = 10, dpi = 72, signal } = {}) {
  const t = tools();
  if (!t.pdftoppm) throw new RenderError('tool_unavailable', '服务器未安装 poppler-utils（pdftoppm），无法渲染页面');
  maxPages = Math.max(1, Math.min(LIMITS.maxPages, Math.floor(maxPages)));
  return withTemp(async dir => {
    const input = path.join(dir, 'in.pdf');
    fs.writeFileSync(input, pdf, { mode: 0o600 });
    const opts = { cwd: dir, timeoutMs: LIMITS.renderTimeoutMs, signal, env: baseEnv(dir) };
    await run(t.pdftoppm, ['-png', '-r', String(Math.max(30, Math.min(150, dpi))), '-l', String(maxPages), input, path.join(dir, 'page')], opts);
    await run(t.pdftoppm, ['-gray', '-r', '20', '-l', String(maxPages), input, path.join(dir, 'ink')], opts);
    const pick = (prefix, ext) => fs.readdirSync(dir).filter(f => f.startsWith(prefix + '-') && f.endsWith(ext)).sort((a, b) => Number(/-(\d+)\./.exec(a)[1]) - Number(/-(\d+)\./.exec(b)[1]));
    const pngs = pick('page', '.png'), maps = pick('ink', '.pgm');
    if (!pngs.length) throw new RenderError('render_failed', 'PDF 没有可渲染的页面');
    return pngs.map((f, i) => {
      const png = fs.readFileSync(path.join(dir, f));
      if (png.length > LIMITS.maxPngBytes) throw new RenderError('render_limit', '页面图片过大');
      const ratio = maps[i] ? inkRatio(fs.readFileSync(path.join(dir, maps[i]))) : null;
      return { page: i + 1, png, inkRatio: ratio, blank: ratio !== null && ratio < 0.002 };
    });
  });
}
module.exports = { convertToPdf, renderPdf, officeTools: () => { const t = tools(); return { soffice: !!t.soffice, pdftoppm: !!t.pdftoppm }; }, RenderError, RENDER_LIMITS: LIMITS };
