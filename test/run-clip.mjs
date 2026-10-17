// Usage: node test/run-clip.mjs <clip> <ballX> <ballY> [addressFrame] [outDir]
// Coordinates are in the clip's own pixels (after rotation). Prints impact + tracked points
// and writes annotated frames to outDir.
import { mkdirSync } from 'node:fs';
import { decodeGray, annotate } from './clip-harness.mjs';
import { analyze, estimateBallRadius, snapToBall } from '../src/tracker.js';
import { defaultTrace, positionAt } from '../src/curve.js';

const [clip, bx, by, addr = '0', outDir = 'test/out'] = process.argv.slice(2);
const W = 960;
const { frames, w, h, fps } = decodeGray(clip, W, { start: Number(addr), count: 150 });
const meta = { w, h, fps, frames: frames.length };
console.log('decoded', meta);

const scale = W / (await import('./clip-harness.mjs')).probe(clip).width;
const tap = snapToBall(frames[0], Number(bx) * scale, Number(by) * scale);
const r = estimateBallRadius(frames[0], tap.x, tap.y);
const ball = { x: tap.x, y: tap.y, r };
console.log('ball', ball);

const t0 = Date.now();
const res = await analyze(async (i) => frames[Math.min(i, frames.length - 1)], ball, { maxFrames: frames.length - 2 });
console.log(`analysis took ${Date.now() - t0} ms`);
console.log('impactIndex', res.impactIndex, 'impact time', (res.impactIndex / fps).toFixed(3), 's');
console.log('points', res.points.map((p) => `${p.i}:(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(' '));
const trace = defaultTrace(ball, res.points, res.impactIndex, w, h);
console.log('trace: hangFrames', trace.hangFrames.toFixed(1), 'points', trace.pts.length,
  'landing', JSON.stringify(trace.pts[trace.pts.length - 1]));

mkdirSync(outDir, { recursive: true });
const last = res.points.length ? res.points[res.points.length - 1].i : res.impactIndex + 5;
const curvePts = [];
for (let s = 0; s <= 80; s++) curvePts.push(positionAt(trace.pts, s / 80));
annotate(frames[Math.min(last, frames.length - 1)], [ball, ...res.points], `${outDir}/tracked.png`);
annotate(frames[Math.min(last, frames.length - 1)], curvePts, `${outDir}/curve.png`);
if (res.impactIndex >= 0) annotate(frames[res.impactIndex], [ball], `${outDir}/impact.png`);
