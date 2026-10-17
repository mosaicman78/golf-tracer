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

import { fitFlight, simulate, project, cameraWithPitch, flightAt } from '../src/flight.js';
import { fitSmooth, smoothTrace } from '../src/curve.js';

test('fitFlight recovers a synthetic flight', () => {
  const w = 1080, h = 1920, fps = 30;
  const pitch = (5 * Math.PI) / 180;
  const cam = cameraWithPitch(w, h, pitch);
  const tee = { x: 0.2, y: 0, z: 3 };
  const v = { vx: -1, vy: 14, vz: 55, ax: 0 };
  const sim = simulate(tee, v);
  const teePx = project(cam, tee);
  const ball = { x: teePx.x, y: teePx.y, r: 8 };
  const t0 = 0.4 / fps;
  const obs = [];
  for (let i = 1; i <= 70; i++) {
    const t = i / fps;
    const k = Math.round((t + t0) / 0.01);
    const p = project(cam, sim.pts[Math.min(k, sim.pts.length - 1)]);
    obs.push({ x: p.x + (i % 3 - 1) * 0.5, y: p.y + (i % 2) * 0.5, t });
  }
  const fit = fitFlight(w, h, ball, obs, { fps });
  assert.ok(fit, 'fit found');
  const trueSpeed = Math.hypot(v.vx, v.vy, v.vz);
  assert.ok(Math.abs(fit.speed - trueSpeed) / trueSpeed < 0.08, `speed ${fit.speed} vs ${trueSpeed}`);
  const land = sim.pts[sim.pts.length - 1];
  const trueCarry = Math.hypot(land.x - tee.x, land.z - tee.z);
  assert.ok(Math.abs(fit.carry - trueCarry) / trueCarry < 0.1, `carry ${fit.carry} vs ${trueCarry}`);
  assert.ok(fit.rms < 3, `rms ${fit.rms}`);
  const at = flightAt(fit);
  assert.ok(Number.isFinite(at(1).x));
});

test('fitSmooth and smoothTrace follow the tracked points and run on to landing', () => {
  const start = { x: 500, y: 1200 };
  const obs = [];
  for (let i = 1; i <= 60; i++) {
    const t = i / 30;
    obs.push({ x: (500 + 40 * t) / (1 + 2 * t), y: (1200 - 1800 * t + 500 * t * t) / (1 + 2 * t), t });
  }
  const sm = fitSmooth(start, obs);
  assert.ok(sm.rms < 1, `rms ${sm.rms}`);
  const points = obs.map((o, k) => ({ x: o.x, y: o.y, i: 10 + k + 1 }));
  const flight = { tLand: 5, t0: 0, at: (t) => ({ x: 400, y: 300 + 60 * t * t }) };
  const tr = smoothTrace(start, points, 10, 30, 1080, 1920, flight);
  assert.equal(tr.pts[0].s, 0);
  assert.equal(tr.pts[tr.pts.length - 1].s, 1);
  assert.ok(Math.abs(tr.hangFrames - 150) < 1);
  const last = tr.pts[tr.pts.length - 1];
  assert.ok(last.y > obs[obs.length - 1].y, 'continues downward after the tracked part');
});
