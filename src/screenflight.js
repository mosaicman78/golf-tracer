// A projectile seen through a level pinhole camera, written directly in screen space.
//
// For a ball launched from the tee at distance d0 in front of the camera (height hc,
// focal f), moving away at vz with vertical launch speed vy under gravity g:
//   x(t) = cx + (x0 - cx + M t) / (1 + k t)
//   y(t) = cy + (y0 - cy - B t + C t^2) / (1 + k t)
// with k = vz/d0, B = f vy/d0, C = f g/(2 d0), M = f vx/d0. (x0, y0) is the tee pixel.
// The six free numbers (cx, cy, k, B, C, M) are fitted to the tracked points by
// Levenberg-Marquardt. The curve is smooth, continues to landing at t = B/C, and the
// gravity term sets the real-world scale, which gives rough speed and carry estimates.

const G = 9.81;

export function evalModel(m, t) {
  const den = 1 + m.k * t;
  return {
    x: m.cx + (m.x0 - m.cx + m.M * t) / den,
    y: m.cy + (m.y0 - m.cy - m.B * t + m.C * t * t) / den,
  };
}

function sse(m, obs) {
  let s = 0;
  for (const o of obs) {
    const p = evalModel(m, o.t);
    s += (p.x - o.x) ** 2 + (p.y - o.y) ** 2;
  }
  return s;
}

const KEYS = ['cx', 'cy', 'k', 'B', 'C', 'M'];

// obs: [{ x, y, t }] with t in seconds since impact; tee: { x, y } pixel.
export function fitScreenFlight(tee, obs, w, h) {
  if (obs.length < 6) return null;
  let best = null;
  const tMax = obs[obs.length - 1].t || 1;
  for (const k0 of [0.3, 1, 3]) {
    for (const hang of [3, 5, 7]) {
      // start with a curve that peaks around the tracked points' highest y
      let minY = Infinity; for (const o of obs) minY = Math.min(minY, o.y);
      const C0 = (2 * (tee.y - minY) * (1 + k0 * hang / 2)) / (hang * hang) * 2;
      let m = { x0: tee.x, y0: tee.y, cx: w / 2, cy: h / 2, k: k0, B: C0 * hang, C: C0, M: 0 };
      let err = sse(m, obs);
      let lambda = 1e-2;
      for (let iter = 0; iter < 80; iter++) {
        const J = [], r = [];
        for (const o of obs) {
          const p = evalModel(m, o.t);
          r.push(p.x - o.x, p.y - o.y);
          const rowx = [], rowy = [];
          for (const key of KEYS) {
            const d = Math.max(1e-4, Math.abs(m[key]) * 1e-4);
            const q = evalModel({ ...m, [key]: m[key] + d }, o.t);
            rowx.push((q.x - p.x) / d); rowy.push((q.y - p.y) / d);
          }
          J.push(rowx, rowy);
        }
        const n = KEYS.length;
        const A = Array.from({ length: n }, () => new Array(n).fill(0)), g = new Array(n).fill(0);
        for (let i = 0; i < r.length; i++) for (let a = 0; a < n; a++) {
          g[a] += J[i][a] * r[i];
          for (let b = 0; b < n; b++) A[a][b] += J[i][a] * J[i][b];
        }
        let improved = false;
        for (let tries = 0; tries < 8 && !improved; tries++) {
          const Mx = A.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-9 : v)));
          const step = solve(Mx, g);
          if (!step) break;
          const nm = { ...m };
          KEYS.forEach((key, i) => { nm[key] = m[key] - step[i]; });
          if (nm.k < 0.01 || nm.C <= 0 || nm.B <= 0) { lambda *= 5; continue; }
          const ne = sse(nm, obs);
          if (ne < err) { m = nm; err = ne; lambda = Math.max(1e-7, lambda / 3); improved = true; }
          else lambda *= 5;
        }
        if (!improved) break;
      }
      void tMax;
      if (m.k > 0 && m.B > 0 && m.C > 0 && (!best || err < best.err)) best = { m, err };
    }
  }
  if (!best) return null;
  const { m, err } = best;
  const tLand = m.B / m.C;
  return { model: m, rms: Math.sqrt(err / obs.length), tLand };
}

// Rough real-world numbers. f is the focal length in pixels; the vacuum model overstates
// speed and carry for a real (draggy, spinning) ball, so scale them down a little.
export function flightStats(fit, f) {
  const { model: m, tLand } = fit;
  const d0 = (G * f) / (2 * m.C);           // camera-to-tee distance implied by gravity
  const vy = (m.B * d0) / f, vz = m.k * d0, vx = (m.M * d0) / f;
  const vacuumCarry = Math.hypot(vz, vx) * tLand;
  return {
    d0, vx, vy, vz, tLand,
    speed: Math.hypot(vx, vy, vz),
    launchAngle: (Math.atan2(vy, Math.hypot(vx, vz)) * 180) / Math.PI,
    apexHeight: (vy * vy) / (2 * G),
    carry: vacuumCarry * 0.85,
  };
}

export function screenPolyline(fit, n = 120) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * fit.tLand;
    const p = evalModel(fit.model, t);
    pts.push({ x: p.x, y: p.y, s: i / n });
  }
  return pts;
}

// Gaussian elimination with partial pivoting.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const fct = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= fct * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}
