import { focalPx } from './flight.js?v=10';
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

// Smooth curve through the tracked points: x(t) and y(t) are each fitted with the shape a
// projectile has on screen, (a + b t + c t^2) / (1 + k t), pinned to the tee at t = 0. The
// denominator's k is picked by a grid search, the numerators by linear least squares.
// Returns { xy(t), tEnd } or null when there are too few points.
export function fitSmooth(start, obs) {
  if (obs.length < 5) return null;
  const weights = obs.map((o, i) => (i < 2 && obs.length > 10 ? 0.3 : 1));
  let best = null;
  const tryK = (e) => {
    const k = Math.exp(e);
    const fit = (key) => {
      // (y(1+kt) - y0) = b t + c t^2, weighted LS in (b, c)
      let s11 = 0, s12 = 0, s22 = 0, r1 = 0, r2 = 0;
      obs.forEach((o, i) => {
        const t = o.t, wgt = weights[i];
        const target = o[key] * (1 + k * t) - start[key];
        s11 += wgt * t * t; s12 += wgt * t * t * t; s22 += wgt * t * t * t * t;
        r1 += wgt * t * target; r2 += wgt * t * t * target;
      });
      const det = s11 * s22 - s12 * s12;
      if (Math.abs(det) < 1e-12) return null;
      const b = (s22 * r1 - s12 * r2) / det, c = (s11 * r2 - s12 * r1) / det;
      let sse = 0;
      obs.forEach((o, i) => {
        const v = (start[key] + b * o.t + c * o.t * o.t) / (1 + k * o.t);
        sse += weights[i] * (v - o[key]) ** 2;
      });
      return { b, c, sse };
    };
    const fx = fit('x'), fy = fit('y');
    if (!fx || !fy) return;
    const sse = fx.sse + fy.sse;
    if (!best || sse < best.sse) best = { e, k, fx, fy, sse };
  };
  for (let e = -1.6; e <= 3.4; e += 0.2) tryK(e);
  if (!best) return null;
  const centre = best.e;
  for (let e = centre - 0.2; e <= centre + 0.2; e += 0.02) tryK(e);
  const { k, fx, fy } = best;
  const tEnd = obs[obs.length - 1].t;
  return {
    tEnd,
    rms: Math.sqrt(best.sse / obs.length),
    xy: (t) => ({
      x: (start.x + fx.b * t + fx.c * t * t) / (1 + k * t),
      y: (start.y + fy.b * t + fy.c * t * t) / (1 + k * t),
    }),
  };
}

// The final trace: the smooth fit over the tracked part of the flight, continued to landing
// along the physics model (shifted so it joins seamlessly). `flight` is the result of
// fitFlight plus `polylineAt(t)` giving the model's screen point at time t since impact;
// it may be null, in which case the smooth curve is simply run on a little further.
// Returns { pts, hangFrames }.
export function smoothTrace(start, points, impactIndex, fps, w, h, flight) {
  const obs = points.map((p) => ({ x: p.x, y: p.y, t: (p.i - impactIndex) / fps }));
  const sm = fitSmooth(start, obs);
  if (!sm) return null;
  const clamp = (p) => ({ x: Math.min(w - 4, Math.max(4, p.x)), y: Math.min(h - 4, Math.max(4, p.y)) });
  const tEnd = sm.tEnd;
  // The ball lands on the ground somewhere down-range, which on screen is between the tee and
  // the horizon. The flight model's own landing projection is the best guess; failing that,
  // the ball's apparent size gives the tee distance and so where the horizon roughly sits.
  const groundY = landingY(start, w, h, flight);
  let tTotal;
  const samples = [];
  const n1 = 60;
  for (let i = 0; i <= n1; i++) {
    const t = (i / n1) * tEnd;
    samples.push({ ...sm.xy(t), t });
  }
  const end = sm.xy(tEnd);
  if (end.y >= groundY && groundY != null) {
    // Already down to the ground within the tracked part: cut the curve where it got there.
    tTotal = tEnd;
  } else if (flight && flight.tLand - flight.t0 > tEnd + 0.15) {
    // Height follows the shape of the model's descent, scaled so it ends on the ground; sideways
    // motion carries on from the smooth curve's last drift and dies away, since the model's
    // lateral extrapolation is the least reliable thing about it.
    tTotal = flight.tLand - flight.t0;
    const before = sm.xy(Math.max(0, tEnd - 0.3));
    const vxEnd = (end.x - before.x) / Math.max(0.05, tEnd - Math.max(0, tEnd - 0.3));
    const yModelEnd = flight.at(tEnd).y;
    const dropModel = flight.at(tTotal).y - yModelEnd;
    const dropNeeded = groundY - end.y;
    const g = dropModel > 1 ? Math.min(4, Math.max(0.25, dropNeeded / dropModel)) : 1;
    const n2 = 60;
    for (let i = 1; i <= n2; i++) {
      const t = tEnd + (i / n2) * (tTotal - tEnd);
      const tau = t - tEnd;
      samples.push({
        x: end.x + (vxEnd * tau) / (1 + tau / 1.5),
        y: end.y + (flight.at(t).y - yModelEnd) * g,
        t,
      });
    }
  } else {
    tTotal = tEnd * 1.25;
    const n2 = 15;
    for (let i = 1; i <= n2; i++) {
      const t = tEnd + (i / n2) * (tTotal - tEnd);
      samples.push({ ...sm.xy(t), t });
    }
  }
  // Never draw past the ground: stop at the first sample that reaches it (after the apex).
  if (groundY != null) {
    let apex = 0;
    for (let k = 1; k < samples.length; k++) if (samples[k].y < samples[apex].y) apex = k;
    for (let k = apex + 1; k < samples.length; k++) {
      if (samples[k].y >= groundY) {
        const a = samples[k - 1], b = samples[k];
        const f = (groundY - a.y) / Math.max(1e-6, b.y - a.y);
        samples.length = k;
        samples.push({ x: a.x + (b.x - a.x) * f, y: groundY, t: a.t + (b.t - a.t) * f });
        tTotal = samples[samples.length - 1].t;
        break;
      }
    }
  }
  const pts = samples.map((p) => ({ ...clamp(p), s: p.t / tTotal }));
  return { pts, hangFrames: tTotal * fps, rms: sm.rms };
}

// Screen y where the ball should land: the flight model's landing projection when there is
// one, else a point near the horizon implied by the ball's apparent size at the tee.
export function landingY(start, w, h, flight) {
  const f = focalPx(w, h);
  const r = start.r > 0 ? start.r : h / 150;
  const dist = Math.max(1, (f * 0.021335) / r);            // camera to tee, metres
  const horizonGap = (f * 1.4) / dist;                      // tee is this far below the horizon
  const nearHorizon = start.y - horizonGap * 0.85;          // a ~20 m carry already gets here
  if (flight) {
    const y = flight.at(flight.tLand - flight.t0).y;
    if (Number.isFinite(y) && y < start.y - horizonGap * 0.3) return Math.max(y, start.y - horizonGap);
  }
  return nearHorizon;
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
