// Unit tests on synthetic frames: a bright ball on a plain background that gets hit and flies
// along a parabola. Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, estimateBallRadius, snapToBall, findBlobs } from '../src/tracker.js';
import { defaultTrace, moveHandle, handles, positionAt } from '../src/curve.js';

const W = 320, H = 480;
const BALL = { x: 160, y: 400, r: 4 };

function blank(bg = 90) {
  const data = new Uint8ClampedArray(W * H).fill(bg);
  // a "horizon" of darker ground so the frame isn't perfectly flat
  for (let y = 300; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = 70 + ((x * 7 + y * 3) % 9);
  return { w: W, h: H, data };
}
function disc(frame, cx, cy, r, v = 240) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (Math.hypot(x - cx, y - cy) <= r) frame.data[y * W + x] = v;
    }
  }
}
// Ball sits still until frame 10, then flies: big first jump, then a parabola in the "sky".
function flightPos(i) {
  const t = i - 10;
  if (t <= 0) return null;
  return { x: BALL.x - 2 * t, y: BALL.y - 60 - 18 * t + 0.25 * t * t };
}
function frame(i) {
  const f = blank();
  // a moving "golfer" blob so there is other motion around
  disc(f, 100 + i * 0.5, 380, 12, 40);
  const p = flightPos(i);
  if (!p) disc(f, BALL.x, BALL.y, BALL.r);
  else if (p.y > 0) disc(f, p.x, p.y, Math.max(1.5, BALL.r - t(i) * 0.08));
  return f;
}
const t = (i) => i - 10;

test('snapToBall and estimateBallRadius find the ball near a rough tap', () => {
  const f = frame(0);
  const p = snapToBall(f, BALL.x + 5, BALL.y - 4);
  assert.ok(Math.hypot(p.x - BALL.x, p.y - BALL.y) < 1.5, `snapped to ${p.x},${p.y}`);
  const r = estimateBallRadius(f, p.x, p.y);
  assert.ok(r > 2.5 && r < 6, `radius ${r}`);
});

test('findBlobs ignores large and elongated changes', () => {
  const a = blank(), b = blank();
  disc(b, 50, 50, 3);            // small dot: wanted
  disc(b, 150, 100, 20);         // big blob: too large
  for (let y = 150; y < 200; y++) b.data[y * W + 200] = 250; // thin line: elongated
  const blobs = findBlobs(b, a, { x0: 0, x1: W - 1, y0: 0, y1: 300 }, { maxArea: 200 });
  assert.equal(blobs.length, 1);
  assert.ok(Math.hypot(blobs[0].x - 50, blobs[0].y - 50) < 1);
});

test('analyze finds impact and follows the ball', async () => {
  const res = await analyze(async (i) => frame(i), BALL, { maxFrames: 80 });
  assert.ok(res.impactIndex >= 10 && res.impactIndex <= 12, `impact at ${res.impactIndex}`);
  assert.ok(res.points.length >= 25, `tracked ${res.points.length} points`);
  for (const p of res.points) {
    const truth = flightPos(p.i);
    assert.ok(Math.hypot(p.x - truth.x, p.y - truth.y) < 3, `frame ${p.i} off by ${Math.hypot(p.x - truth.x, p.y - truth.y)}`);
  }
  const tr = defaultTrace(BALL, res.points, res.impactIndex, W, H);
  assert.ok(tr.hangFrames > 20);
  assert.equal(tr.pts[0].s, 0);
  assert.equal(tr.pts[tr.pts.length - 1].s, 1);
});

test('handles warp the polyline smoothly', () => {
  const pts = [];
  for (let k = 0; k <= 20; k++) pts.push({ x: 100 + k * 5, y: 400 - 300 * Math.sin((k / 20) * Math.PI), s: k / 20 });
  const h = handles(pts);
  assert.equal(h.start.s, 0);
  assert.equal(h.landing.s, 1);
  const moved = moveHandle(pts, 'apex', 0, -50);
  assert.equal(moved[0].y, pts[0].y);                     // ends stay put
  assert.equal(moved[20].y, pts[20].y);
  assert.ok(handles(moved).apex.y < h.apex.y - 45);        // apex moved by about the drag
  const land = moveHandle(pts, 'landing', 30, 0);
  assert.equal(land[0].x, pts[0].x);
  assert.equal(land[20].x, pts[20].x + 30);
  const mid = positionAt(pts, 0.525);
  assert.ok(mid.x > pts[10].x && mid.x < pts[11].x);
});
