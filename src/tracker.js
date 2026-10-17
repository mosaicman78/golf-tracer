// Image analysis for finding impact and tracking the ball after launch.
// Everything here works on plain grayscale frames: { w, h, data: Uint8ClampedArray }
// so it can run in the browser or in a Node test against decoded footage.

export function toGray(imageData) {
  const { width: w, height: h, data } = imageData;
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    out[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return { w, h, data: out };
}

function windowStats(gray, x, y, R) {
  const { w, h, data } = gray;
  const x0 = Math.max(0, Math.round(x - R)), x1 = Math.min(w - 1, Math.round(x + R));
  const y0 = Math.max(0, Math.round(y - R)), y1 = Math.min(h - 1, Math.round(y + R));
  let sum = 0, n = 0, maxV = 0, mx = x, my = y;
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const v = data[yy * w + xx];
      sum += v; n++;
      if (v > maxV) { maxV = v; mx = xx; my = yy; }
    }
  }
  return { x0, x1, y0, y1, mean: sum / n, maxV, mx, my };
}

// Centre of the bright blob nearest the tap, so a slightly-off tap still lands on the ball.
export function snapToBall(gray, x, y) {
  const { w, h, data } = gray;
  const R = Math.max(6, Math.round(h / 60));
  const s = windowStats(gray, x, y, R);
  if (s.maxV - s.mean < 30) return { x, y };
  const thresh = s.mean + (s.maxV - s.mean) * 0.5;
  // flood fill from the brightest pixel, which is on the ball
  const seen = new Uint8Array(w * h);
  const stack = [s.my * w + s.mx];
  let sx = 0, sy = 0, a = 0;
  while (stack.length && a < R * R * 4) {
    const k = stack.pop();
    if (seen[k]) continue;
    seen[k] = 1;
    const kx = k % w, ky = (k - kx) / w;
    if (kx < s.x0 || kx > s.x1 || ky < s.y0 || ky > s.y1 || data[k] < thresh) continue;
    a++; sx += kx; sy += ky;
    stack.push(k - 1, k + 1, k - w, k + w);
  }
  return a >= 3 ? { x: sx / a, y: sy / a } : { x, y };
}

// Estimate the ball's radius from the bright blob at (x, y). Falls back to a fraction of
// the frame height when there is no clear blob.
export function estimateBallRadius(gray, x, y) {
  const { w, h, data } = gray;
  const fallback = Math.max(3, Math.round(h / 150));
  const s = windowStats(gray, x, y, fallback * 4);
  if (s.maxV - s.mean < 30) return fallback;
  const thresh = s.mean + (s.maxV - s.mean) * 0.5;
  let area = 0;
  for (let yy = s.y0; yy <= s.y1; yy++) for (let xx = s.x0; xx <= s.x1; xx++) if (data[yy * w + xx] >= thresh) area++;
  if (area < 3) return fallback;
  return Math.max(2, Math.min(fallback * 3, Math.sqrt(area / Math.PI)));
}

// Is the ball still sitting where it was at address? Counts bright pixels near the spot,
// which tolerates a few pixels of hand-held camera shake.
export function ballPresent(gray, ball, ref) {
  const { w, data } = gray;
  const R = ball.r * 1.6;
  const s = windowStats(gray, ball.x, ball.y, R);
  let n = 0;
  for (let yy = s.y0; yy <= s.y1; yy++) {
    for (let xx = s.x0; xx <= s.x1; xx++) {
      if (Math.hypot(xx - ball.x, yy - ball.y) <= R && data[yy * w + xx] >= ref.thresh) n++;
    }
  }
  return n >= ref.area * 0.3;
}

export function ballReference(gray, ball) {
  const { w, data } = gray;
  const s = windowStats(gray, ball.x, ball.y, ball.r * 3);
  // ball pixels vs surrounding ring
  let inSum = 0, inN = 0, outSum = 0, outN = 0;
  for (let yy = s.y0; yy <= s.y1; yy++) {
    for (let xx = s.x0; xx <= s.x1; xx++) {
      const d = Math.hypot(xx - ball.x, yy - ball.y);
      const v = data[yy * w + xx];
      if (d <= ball.r * 0.8) { inSum += v; inN++; } else if (d >= ball.r * 1.8) { outSum += v; outN++; }
    }
  }
  const inMean = inN ? inSum / inN : 255, outMean = outN ? outSum / outN : 0;
  const thresh = outMean + (inMean - outMean) * 0.5;
  let area = 0;
  for (let yy = s.y0; yy <= s.y1; yy++) for (let xx = s.x0; xx <= s.x1; xx++) {
    if (Math.hypot(xx - ball.x, yy - ball.y) <= ball.r * 1.6 && data[yy * w + xx] >= thresh) area++;
  }
  return { thresh, area: Math.max(area, 3) };
}

// Find small, isolated blobs that got brighter between prev and curr inside a window.
// Returns candidates sorted by score (best first): [{ x, y, area, score, iso }]
export function findBlobs(curr, prev, win, opts = {}) {
  const { w, h } = curr;
  const thresh = opts.thresh ?? 28;
  const minArea = opts.minArea ?? 2;
  const maxArea = opts.maxArea ?? 400;
  const isoMax = opts.isoMax ?? 10;
  const x0 = Math.max(0, Math.floor(win.x0)), x1 = Math.min(w - 1, Math.ceil(win.x1));
  const y0 = Math.max(0, Math.floor(win.y0)), y1 = Math.min(h - 1, Math.ceil(win.y1));
  const ww = x1 - x0 + 1, wh = y1 - y0 + 1;
  if (ww <= 0 || wh <= 0) return [];

  const mask = new Uint8Array(ww * wh);
  for (let y = y0; y <= y1; y++) {
    const row = y * w;
    for (let x = x0; x <= x1; x++) {
      if (curr.data[row + x] - prev.data[row + x] > thresh) mask[(y - y0) * ww + (x - x0)] = 1;
    }
  }

  const blobs = [];
  const stack = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 1) continue;
    let area = 0, sx = 0, sy = 0, bright = 0;
    let bx0 = ww, bx1 = 0, by0 = wh, by1 = 0;
    stack.push(i);
    mask[i] = 2;
    while (stack.length) {
      const k = stack.pop();
      const kx = k % ww, ky = (k - kx) / ww;
      area++; sx += kx; sy += ky;
      if (kx < bx0) bx0 = kx; if (kx > bx1) bx1 = kx; if (ky < by0) by0 = ky; if (ky > by1) by1 = ky;
      bright += curr.data[(ky + y0) * w + (kx + x0)];
      if (kx > 0 && mask[k - 1] === 1) { mask[k - 1] = 2; stack.push(k - 1); }
      if (kx < ww - 1 && mask[k + 1] === 1) { mask[k + 1] = 2; stack.push(k + 1); }
      if (ky > 0 && mask[k - ww] === 1) { mask[k - ww] = 2; stack.push(k - ww); }
      if (ky < wh - 1 && mask[k + ww] === 1) { mask[k + ww] = 2; stack.push(k + ww); }
      if (area > maxArea * 4) break; // runaway region: a body or the sky brightening
    }
    if (area < minArea || area > maxArea) continue;
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    if (Math.max(bw, bh) * Math.max(bw, bh) > area * 6) continue; // elongated: shaft, edge
    const x = sx / area + x0, y = sy / area + y0;
    const rb = Math.max(2, Math.sqrt(area / Math.PI));
    const iso = ringDiff(curr, prev, x, y, rb * 2.5, rb * 5);
    if (iso > isoMax) continue;
    const dist = opts.px != null ? Math.hypot(x - opts.px, y - opts.py) / (opts.pr || 1) : 0;
    const score = (bright / area) / 255 - iso / isoMax * 0.5 - dist * 0.5 - area / maxArea * 0.2;
    blobs.push({ x, y, area, score, iso });
  }
  blobs.sort((a, b) => b.score - a.score);
  return blobs;
}

// Mean |curr - prev| in a ring around (x, y): low when the blob is a lone moving dot.
function ringDiff(curr, prev, x, y, r0, r1) {
  const { w, h } = curr;
  const x0 = Math.max(0, Math.round(x - r1)), x1 = Math.min(w - 1, Math.round(x + r1));
  const y0 = Math.max(0, Math.round(y - r1)), y1 = Math.min(h - 1, Math.round(y + r1));
  let sum = 0, n = 0;
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const d = Math.hypot(xx - x, yy - y);
      if (d < r0 || d > r1) continue;
      const i = yy * w + xx;
      sum += Math.abs(curr.data[i] - prev.data[i]);
      n++;
    }
  }
  return n ? sum / n : 255;
}

// Cheap check for a repeated frame (seeking in a browser can serve the same frame twice).
export function sameFrame(a, b) {
  if (a === b) return true;
  const n = a.data.length;
  for (let i = 0; i < n; i += 61) if (a.data[i] !== b.data[i]) return false;
  return true;
}

// Drives the whole analysis over a sequence of frames.
// getFrame(i) -> Promise<gray frame>, i counted from the address frame (0).
// ball: { x, y, r } in frame pixels.
// Returns { impactIndex, points: [{ x, y, i }] }: ball centres after impact.
export async function analyze(getFrame, ball, opts = {}) {
  const maxFrames = opts.maxFrames ?? 150;
  const findFrames = opts.findFrames ?? 10;  // frames after impact to look for the ball anywhere above
  const maxMisses = opts.maxMisses ?? 4;
  const onProgress = opts.onProgress ?? (() => {});

  const address = await getFrame(0);
  const ref = ballReference(address, ball);
  let prev = address;
  let impactIndex = -1;
  const points = [];
  let misses = 0;
  let vx = 0, vy = 0;

  for (let i = 1; i <= maxFrames; i++) {
    const curr = await getFrame(i);
    onProgress(i / maxFrames);
    if (sameFrame(curr, prev)) continue; // duplicate frame: nothing moved, not a miss

    if (impactIndex < 0) {
      if (!ballPresent(curr, ball, ref)) {
        const n1 = await getFrame(i + 1);
        const n2 = await getFrame(i + 2);
        if (!ballPresent(n1, ball, ref) && !ballPresent(n2, ball, ref)) impactIndex = i;
      }
      prev = curr;
      continue;
    }

    const maxArea = Math.PI * ball.r * ball.r * 4;
    let hit = null;
    if (!points.length) {
      // The ball leaves the frame bottom fast at 30 fps; look for a lone bright dot anywhere above it.
      if (i - impactIndex > findFrames) break;
      const win = { x0: 0, x1: curr.w - 1, y0: 0, y1: ball.y - ball.r * 2 };
      const blobs = findBlobs(curr, prev, win, { maxArea, px: ball.x, py: ball.y, pr: curr.h, thresh: opts.thresh });
      hit = blobs[0] || null;
      if (hit) {
        const dt = i - impactIndex;
        vx = (hit.x - ball.x) / dt; vy = (hit.y - ball.y) / dt;
      }
    } else {
      const last = points[points.length - 1];
      const dt = i - last.i;
      // The ball slows down on screen as it flies away, so predict with damped velocity
      const px = last.x + vx * dt * 0.6, py = last.y + vy * dt * 0.6;
      const speed = Math.hypot(vx, vy) * dt;
      const r = (Math.max(ball.r * 6, speed * 0.7 + ball.r * 3)) * (1 + misses * 0.6);
      const win = { x0: px - r, x1: px + r, y0: py - r, y1: py + r };
      const blobs = findBlobs(curr, prev, win, { maxArea, px, py, pr: r, thresh: opts.thresh });
      // Must have moved, but not implausibly far for the current speed (a jump means we
      // latched onto something else, usually once the ball is lost against trees).
      const maxJump = speed * 2 + ball.r * 4;
      hit = blobs.find((b) => {
        const d = Math.hypot(b.x - last.x, b.y - last.y);
        return d > ball.r * 0.3 && d < maxJump;
      }) || null;
      if (hit) {
        const nvx = (hit.x - last.x) / dt, nvy = (hit.y - last.y) / dt;
        vx = vx * 0.4 + nvx * 0.6;
        vy = vy * 0.4 + nvy * 0.6;
      }
    }

    if (hit) {
      points.push({ x: hit.x, y: hit.y, i });
      misses = 0;
    } else if (points.length) {
      misses++;
      if (misses > maxMisses) break;
    }
    prev = curr;
  }

  return { impactIndex, points };
}
