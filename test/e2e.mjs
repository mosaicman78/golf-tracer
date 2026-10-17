// End-to-end run in headless Chromium: load a clip, tap the ball, let the app track it,
// then export. Usage: node test/e2e.mjs <clip.webm|mp4> <ballX> <ballY> [outDir]
// (Chromium here can't decode HEVC/H.264, so use a VP9 .webm for the test clip.)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const [clip, bx, by, outDir = 'test/out'] = process.argv.slice(2);
if (!clip) { console.error('usage: node test/e2e.mjs <clip> <ballX> <ballY> [outDir]'); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const port = 8089;
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); else console.log('[page]', m.text()); });

try {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.setInputFiles('#file', clip);
  await page.waitForSelector('#panel-tap:not(.hidden)');
  const vw = await page.evaluate(() => document.getElementById('video').videoWidth);
  const box = await page.locator('#canvas').boundingBox();
  const scale = box.width / vw;
  await page.mouse.click(box.x + Number(bx) * scale, box.y + Number(by) * scale);
  await page.waitForSelector('#panel-adjust:not(.hidden)', { timeout: 120000 });
  const result = await page.evaluate(() => ({
    impactTime: window.__tracer.impactTime,
    points: window.__tracer.points.length,
    hang: window.__tracer.hang,
    ball: window.__tracer.ball,
    msg: document.getElementById('adjust-msg').textContent,
  }));
  console.log('analysis', JSON.stringify(result));
  await page.screenshot({ path: `${outDir}/adjust.png` });

  // drag the apex handle a little and make sure the trace follows
  const before = await page.evaluate(() => JSON.stringify(window.__tracer.trace[Math.floor(window.__tracer.trace.length / 2)]));
  const apex = await page.evaluate(() => {
    const t = window.__tracer.trace;
    let b = 0; for (let k = 1; k < t.length; k++) if (t[k].y < t[b].y) b = k;
    return t[b];
  });
  await page.mouse.move(box.x + apex.x * scale, box.y + apex.y * scale);
  await page.mouse.down();
  await page.mouse.move(box.x + apex.x * scale + 20, box.y + apex.y * scale - 10, { steps: 5 });
  await page.mouse.up();
  const after = await page.evaluate(() => JSON.stringify(window.__tracer.trace[Math.floor(window.__tracer.trace.length / 2)]));
  console.log('drag changed trace:', before !== after);

  await page.click('#export');
  await page.waitForSelector('#download:not(.hidden)', { timeout: 180000 });
  const exportMsg = await page.textContent('#export-msg');
  console.log('export', exportMsg);
  const size = await page.evaluate(async () => {
    const r = await fetch(document.getElementById('download').href);
    return (await r.blob()).size;
  });
  console.log('exported bytes', size);
  const buf = await page.evaluate(async () => {
    const r = await fetch(document.getElementById('download').href);
    return Array.from(new Uint8Array(await r.arrayBuffer()));
  });
  writeFileSync(`${outDir}/export.webm`, Buffer.from(buf));
  // the export must carry the clip's sound when the clip has any
  const streams = (sp) => new Promise((r) => { const c = spawn('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', sp]); let o = ''; c.stdout.on('data', (d) => (o += d)); c.on('close', () => r(o.trim().split('\n').filter(Boolean))); });
  const inStreams = await streams(clip), outStreams = await streams(`${outDir}/export.webm`);
  console.log('streams in', inStreams, 'out', outStreams);
  if (inStreams.includes('audio') && !outStreams.includes('audio')) { console.log('export lost the audio track'); process.exitCode = 1; }
  await page.screenshot({ path: `${outDir}/export.png` });
  if (errors.length) { console.log('page errors:', errors); process.exitCode = 1; }
  if (!(result.points >= 3 && size > 0)) process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
