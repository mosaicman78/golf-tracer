// The tracer is a polyline of { x, y, s } where s in [0, 1] is the fraction of the hang time
// at which the ball is at that point. When the ball was tracked, s comes from the real frame
// times, so the drawn line keeps pace with the ball in the video. The user edits it with three
// handles (start, apex, landing) that warp the polyline smoothly.

export function positionAt(pts, s) {
  if (s <= 0) return pts[0];
  if (s >= 1) return pts[pts.length - 1];
  let k = 1;
  while (k < pts.length - 1 && pts[k].s < s) k++;
  const a = pts[k - 1], b = pts[k];
  const f = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, s };
}

// Points drawn when the ball is at fraction s of its flight (ends with the interpolated head).
export function visiblePoints(pts, s) {
  if (s <= 0) return [];
  const out = [];
  for (const p of pts) { if (p.s <= s) out.push(p); else break; }
  if (s < 1) out.push(positionAt(pts, s));
  return out;
}

export function apexIndex(pts) {
  let best = 0;
  for (let k = 1; k < pts.length; k++) if (pts[k].y < pts[best].y) best = k;
  return best;
}

export function handles(pts) {
  return { start: pts[0], apex: pts[apexIndex(pts)], landing: pts[pts.length - 1] };
}

// Move a handle by (dx, dy): the start and landing drag their own half of the line with a
// falloff towards the apex; the apex drags the middle with a falloff towards both ends.
export function moveHandle(pts, which, dx, dy) {
  const ai = apexIndex(pts);
  const sa = pts[ai].s;
  return pts.map((p) => {
    let w;
    if (which === 'apex') {
      const width = p.s <= sa ? Math.max(sa, 1e-3) : Math.max(1 - sa, 1e-3);
      const d = Math.abs(p.s - sa) / width;
      w = d >= 1 ? 0 : (1 - d * d) * (1 - d * d);
    } else if (which === 'landing') {
      w = p.s <= sa ? 0 : Math.pow((p.s - sa) / Math.max(1 - sa, 1e-3), 2);
    } else {
      w = p.s >= sa ? 0 : Math.pow((sa - p.s) / Math.max(sa, 1e-3), 2);
    }
    return { x: p.x + dx * w, y: p.y + dy * w, s: p.s };
  });
}

// Least-squares fit of x(t) = a + b t and y(t) = c + d t + e t^2 over tracked points.
export function fitLaunch(points, t0) {
  const n = points.length;
  if (n < 3) return null;
  let st = 0, stt = 0, sttt = 0, stttt = 0, sx = 0, sxt = 0, sy = 0, syt = 0, sytt = 0;
  for (const p of points) {
    const t = p.i - t0;
    st += t; stt += t * t; sttt += t * t * t; stttt += t * t * t * t;
    sx += p.x; sxt += p.x * t;
    sy += p.y; syt += p.y * t; sytt += p.y * t * t;
  }
  const detX = n * stt - st * st;
  if (Math.abs(detX) < 1e-9) return null;
  const b = (n * sxt - st * sx) / detX;
  const a = (sx - b * st) / n;
  const sol = solve3([[n, st, stt], [st, stt, sttt], [stt, sttt, stttt]], [sy, syt, sytt]);
  if (!sol) return null;
  return { a, b, c: sol[0], d: sol[1], e: sol[2] };
}

function det3(m) {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}
function solve3(M, v) {
  const det = det3(M);
  if (Math.abs(det) < 1e-9) return null;
  return [0, 1, 2].map((col) => det3(M.map((row, i) => row.map((val, j) => (j === col ? v[i] : val)))) / det);
}

// Sample a cubic Bezier that starts at p0, passes through `apex` at t = 0.5 and ends at `land`.
function shapePolyline(p0, apex, land, n = 60) {
  // B(0.5) = 0.125 p0 + 0.375 p1 + 0.375 p2 + 0.125 p3, with p1 = p2
  const c = {
    x: (apex.x - 0.125 * (p0.x + land.x)) / 0.75,
    y: (apex.y - 0.125 * (p0.y + land.y)) / 0.75,
  };
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n, u = 1 - t;
    const b1 = 3 * u * u * t + 3 * u * t * t;
    pts.push({ x: u * u * u * p0.x + b1 * c.x + t * t * t * land.x, y: u * u * u * p0.y + b1 * c.y + t * t * t * land.y, s: t });
  }
  return pts;
}

// Polyline straight from the tracked points: lightly smoothed, then extended a little past
// the last sighting along the ball's final direction.
function trackedPolyline(start, points, impactIndex, w, h) {
  const raw = [{ x: start.x, y: start.y, i: impactIndex }, ...points];
  const sm = raw.map((p, k) => {
    // the first segment is the fast launch, keep it as seen; smooth the rest with a 5-tap kernel
    if (k < 2 || k > raw.length - 3) return p;
    const w = [1, 2, 3, 2, 1];
    let x = 0, y = 0;
    for (let j = -2; j <= 2; j++) { x += raw[k + j].x * w[j + 2]; y += raw[k + j].y * w[j + 2]; }
    return { x: x / 9, y: y / 9, i: p.i };
  });
  const last = sm[sm.length - 1];
  const dur = last.i - impactIndex;
  const ext = dur * 0.1;
  // direction from a least-squares line through the last few points (robust to jitter)
  const tail = sm.slice(Math.max(0, sm.length - 10));
  const n = tail.length;
  let si = 0, sii = 0, sx = 0, sy = 0, sxi = 0, syi = 0;
  for (const p of tail) { si += p.i; sii += p.i * p.i; sx += p.x; sy += p.y; sxi += p.x * p.i; syi += p.y * p.i; }
  const den = n * sii - si * si || 1;
  const vx = (n * sxi - si * sx) / den, vy = (n * syi - si * sy) / den;
  const end = { x: last.x + vx * ext, y: last.y + vy * ext, i: last.i + ext };
  end.x = Math.min(w - 4, Math.max(4, end.x)); end.y = Math.min(h - 4, Math.max(4, end.y));
  const total = end.i - impactIndex;
  const pts = [...sm, end].map((p) => ({ x: p.x, y: p.y, s: (p.i - impactIndex) / total }));
  return { pts, hangFrames: total };
}

// Build the default trace from the launch point and tracked points.
// Returns { pts, hangFrames } (hangFrames = 0 when nothing was tracked).
export function defaultTrace(start, points, impactIndex, w, h) {
  const fit = fitLaunch(points, impactIndex);
  const p0 = { x: start.x, y: start.y };
  const clamp = (p) => ({ x: Math.min(w - 4, Math.max(4, p.x)), y: Math.min(h - 4, Math.max(4, p.y)) });

  const last = points.length ? points[points.length - 1] : null;
  const tApexFit = fit && fit.e > 1e-4 && fit.d < 0 ? -fit.d / (2 * fit.e) : null;
  const trackedPastApex = last && tApexFit != null && (last.i - impactIndex) > tApexFit * 1.3;

  if (points.length >= 12 && trackedPastApex) return trackedPolyline(p0, points, impactIndex, w, h);

  let apex, land, hangFrames;
  if (tApexFit != null) {
    const tApex = tApexFit, tLand = tApex * 1.8;
    apex = { x: fit.a + fit.b * tApex, y: fit.c + fit.d * tApex + fit.e * tApex * tApex };
    land = { x: fit.a + fit.b * tLand, y: fit.c + fit.d * tLand + fit.e * tLand * tLand };
    hangFrames = tLand;
  } else if (points.length >= 2) {
    // Only the launch was seen: extend its direction into a generic shape
    const dx = (last.x - p0.x) / Math.max(1, last.i - impactIndex);
    const dy = (last.y - p0.y) / Math.max(1, last.i - impactIndex);
    const k = Math.max(20, (p0.y * 0.6) / Math.max(1e-3, -dy));
    apex = { x: p0.x + dx * k, y: p0.y + dy * k * 0.9 };
    land = { x: p0.x + dx * k * 1.8, y: p0.y * 0.55 };
    hangFrames = k * 1.8;
  } else {
    apex = { x: w * 0.5, y: h * 0.18 };
    land = { x: w * 0.52, y: h * 0.42 };
    hangFrames = 0;
  }
  return { pts: shapePolyline(p0, clamp(apex), clamp(land)), hangFrames };
}
