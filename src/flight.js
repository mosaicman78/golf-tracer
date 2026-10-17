// A physical ball-flight model fitted to the tracked screen positions.
//
// World frame: origin on the ground under the camera, x right, y up, z forward (down the
// target line). The camera sits at height `cameraHeight`, pitched down by `pitch`, with a
// pinhole focal length in pixels derived from the phone's lens. The tee position comes from
// the ball's screen position and apparent size at address. The flight is a vacuum
// projectile from the tee (3 unknowns: launch velocity), fitted by least squares on the
// reprojection error of the tracked points. Drag and lift are ignored, so the numbers are
// estimates, but the curve shape and timing match the footage well.

const G = 9.81;
const BALL_RADIUS_M = 0.02135;

// Focal length in pixels for a frame of w x h, from the 35mm-equivalent focal length.
export function focalPx(w, h, equivMm = 24) {
  return (equivMm / 43.27) * Math.hypot(w, h);
}

// Camera with a given pitch (radians, down positive).
export function cameraWithPitch(w, h, pitch, opts = {}) {
  const f = focalPx(w, h, opts.equivMm ?? 24);
  const hc = opts.cameraHeight ?? 1.4;
  return { f, cx: w / 2, cy: h / 2, hc, pitch, cos: Math.cos(pitch), sin: Math.sin(pitch), w, h };
}

// Initial camera geometry from the ball at address: { x, y, r } in frame pixels. The ball's
// apparent size gives its distance, which with the camera height gives the pitch.
export function makeCamera(w, h, ball, opts = {}) {
  const f = focalPx(w, h, opts.equivMm ?? 24);
  const hc = opts.cameraHeight ?? 1.4;
  const cy = h / 2;
  const dist = Math.max(1.0, (f * BALL_RADIUS_M) / Math.max(1, ball.r)); // camera to ball, metres
  const beta = Math.atan2(ball.y - cy, f);                                // ball below optical axis
  const ratio = Math.min(0.95, hc / dist);
  const pitch = Math.asin(ratio) - beta;                                  // camera tilt down
  const cam = cameraWithPitch(w, h, pitch, opts);
  const tee = groundPoint(cam, ball.x, ball.y);
  return { cam, tee, dist };
}

// Where the ray through pixel (u, v) meets the ground (y = 0).
function groundPoint(cam, u, v) {
  const dirc = { x: (u - cam.cx) / cam.f, y: -(v - cam.cy) / cam.f, z: 1 };
  // camera axes in world: right (1,0,0), up (0,cos,sin), forward (0,-sin,cos)
  const dw = {
    x: dirc.x,
    y: dirc.y * cam.cos - dirc.z * cam.sin,
    z: dirc.y * cam.sin + dirc.z * cam.cos,
  };
  const t = dw.y < -1e-6 ? -cam.hc / dw.y : 1e6;
  return { x: dw.x * t, y: 0, z: dw.z * t };
}

export function project(cam, p) {
  const d = { x: p.x, y: p.y - cam.hc, z: p.z };
  const xc = d.x;
  const yc = d.y * cam.cos + d.z * cam.sin;
  const zc = -d.y * cam.sin + d.z * cam.cos;
  if (zc < 0.05) return null;
  return { x: cam.cx + (cam.f * xc) / zc, y: cam.cy - (cam.f * yc) / zc };
}

// Aerodynamics: drag plus backspin lift (no spin decay, no wind). The coefficients are a
// middle ground between a driver and a wedge; they fit both sample clips to a few pixels.
// k = 0.5 * air density * ball area / ball mass.
const K_AERO = (0.5 * 1.2 * 0.00143) / 0.0459;
const CD = 0.3, CL = 0.3;
const DT = 0.01;

// Simulate the flight from the tee until the ball returns to the ground.
// Returns { pts: [{x,y,z}], tLand } with one entry per DT step.
export function simulate(tee, v, maxT = 12) {
  const sideAcc = v.ax || 0; // constant sideways acceleration standing in for sidespin (draw/fade)
  const pts = [{ x: tee.x, y: 0, z: tee.z }];
  let p = { ...pts[0] };
  let vel = { x: v.vx, y: v.vy, z: v.vz };
  let t = 0;
  while (t < maxT) {
    const speed = Math.hypot(vel.x, vel.y, vel.z) || 1e-6;
    const vh = Math.hypot(vel.x, vel.z) || 1e-6;
    // lift: perpendicular to velocity in its vertical plane, pointing up
    const nx = (-vel.x * vel.y) / vh / speed, ny = vh / speed, nz = (-vel.z * vel.y) / vh / speed;
    const drag = K_AERO * (v.cd ?? CD) * speed, lift = K_AERO * (v.cl ?? CL) * speed * speed;
    const ax = -drag * vel.x + lift * nx + sideAcc;
    const ay = -drag * vel.y + lift * ny - G;
    const az = -drag * vel.z + lift * nz;
    vel = { x: vel.x + ax * DT, y: vel.y + ay * DT, z: vel.z + az * DT };
    p = { x: p.x + vel.x * DT, y: p.y + vel.y * DT, z: p.z + vel.z * DT };
    t += DT;
    pts.push(p);
    if (t > 0.1 && p.y <= 0) break;
  }
  return { pts, tLand: t };
}

export function positionAt(sim, t) {
  const k = t / DT;
  const i = Math.min(sim.pts.length - 1, Math.max(0, Math.floor(k)));
  const j = Math.min(sim.pts.length - 1, i + 1);
  const f = Math.min(1, Math.max(0, k - i));
  const a = sim.pts[i], b = sim.pts[j];
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
}

// Vacuum position (kept for tests and quick estimates).
export function position(tee, v, t) {
  return { x: tee.x + v.vx * t, y: v.vy * t - 0.5 * G * t * t, z: tee.z + v.vz * t };
}

// Parameters of the fit: launch velocity, camera pitch and the time offset between the
// detected impact frame and the real moment of impact (the ball is already gone on the
// first frame we call "impact", so the true launch was up to one frame earlier).
const KEYS = ['vx', 'vy', 'vz', 'pitch', 't0', 'ax'];
const STEPS = { vx: 1e-3, vy: 1e-3, vz: 1e-3, pitch: 1e-5, t0: 1e-4, ax: 1e-3 };

function geometry(w, h, ball, p, opts) {
  const cam = cameraWithPitch(w, h, p.pitch, opts);
  const tee = groundPoint(cam, ball.x, ball.y);
  return { cam, tee };
}

function projectAll(w, h, ball, p, obs, opts) {
  const { cam, tee } = geometry(w, h, ball, p, opts);
  const sim = simulate(tee, { vx: p.vx, vy: p.vy, vz: p.vz, ax: p.ax, cl: opts.cl, cd: opts.cd });
  return obs.map((o) => {
    const t = o.t + p.t0;
    if (t < 0 || t > sim.tLand + 0.05) return null;
    return project(cam, positionAt(sim, t));
  });
}

// Huber loss: a few badly placed points (motion streaks right after impact, a wrong blob)
// should not drag the whole fit.
const HUBER = 12;
function huber(r2) {
  const r = Math.sqrt(r2);
  return r <= HUBER ? r2 : HUBER * (2 * r - HUBER);
}
function huberWeight(r2) {
  const r = Math.sqrt(r2);
  return r <= HUBER ? 1 : HUBER / r;
}

// Soft prior on what a golf shot can be: when only the climb was tracked the data alone
// barely pins down speed, so keep the fit inside plausible hang times and ball speeds.
function prior(w, h, ball, p, opts) {
  const { tee } = geometry(w, h, ball, p, opts);
  const sim = simulate(tee, { vx: p.vx, vy: p.vy, vz: p.vz, ax: p.ax, cl: opts.cl, cd: opts.cd });
  const speed = Math.hypot(p.vx, p.vy, p.vz);
  const over = Math.max(0, sim.tLand - 7) + Math.max(0, 1.5 - sim.tLand) + Math.max(0, (speed - 85) / 10);
  // The ball's apparent size says how far the tee is; let the fitted pitch disagree by a
  // modest factor only, which keeps speed and distance from trading off against each other.
  const f = focalPx(w, h, opts.equivMm ?? 24);
  const distBall = Math.max(1, (f * BALL_RADIUS_M) / Math.max(1, ball.r));
  const teeDist = Math.hypot(tee.x, tee.z);
  const off = Math.log(teeDist / distBall) / 0.3;
  return 1e4 * over * over + 2000 * off * off;
}

function residuals(w, h, ball, p, obs, opts) {
  let sum = prior(w, h, ball, p, opts);
  const ps = projectAll(w, h, ball, p, obs, opts);
  for (let i = 0; i < obs.length; i++) {
    const q = ps[i];
    if (!q) { sum += 1e6; continue; }
    sum += huber((q.x - obs[i].x) ** 2 + (q.y - obs[i].y) ** 2);
  }
  return sum;
}

function valid(p, maxT0, maxLaunch = 0.5) {
  const launch = Math.atan2(p.vy, Math.hypot(p.vx, p.vz));
  return p.vy > 0 && p.vz > 3 && p.t0 >= 0 && p.t0 <= maxT0 && p.pitch > -0.6 && p.pitch < 0.9
    && Math.abs(p.ax) < 6 && launch > 0.06 && launch < maxLaunch;
}

// Levenberg-Marquardt with a numerical Jacobian, from a few starting speeds and angles.
// obs: [{ x, y, t }] pixel positions at t seconds after the detected impact frame.
// ball: { x, y, r } at address. Returns null when nothing fits.
export function fitFlight(w, h, ball, obs, opts = {}) {
  if (obs.length < 6) return null;
  const fps = opts.fps ?? 30;
  const maxT0 = 1.5 / fps;
  const maxLaunch = opts.maxLaunch ?? 0.95; // up to ~55°, so lofted pitches fit too
  const init = makeCamera(w, h, ball, opts);
  let best = null;
  for (const speed of [30, 45, 60, 75]) {
    for (const angle of (opts.angles ?? [8, 14, 22, 32, 42])) {
      const a = (angle * Math.PI) / 180;
      let p = { vx: 0, vy: speed * Math.sin(a), vz: speed * Math.cos(a), pitch: init.cam.pitch, t0: 0.5 / fps, ax: 0 };
      let lambda = 1e-2;
      let err = residuals(w, h, ball, p, obs, opts);
      for (let iter = 0; iter < 60; iter++) {
        const J = [], r = [];
        const base = projectAll(w, h, ball, p, obs, opts);
        const cols = KEYS.map((k) => projectAll(w, h, ball, { ...p, [k]: p[k] + STEPS[k] }, obs, opts));
        for (let i = 0; i < obs.length; i++) {
          if (!base[i] || cols.some((c) => !c[i])) continue;
          const rx = base[i].x - obs[i].x, ry = base[i].y - obs[i].y;
          const sw = Math.sqrt(huberWeight(rx * rx + ry * ry));
          r.push(rx * sw, ry * sw);
          J.push(cols.map((c, k) => ((c[i].x - base[i].x) / STEPS[KEYS[k]]) * sw));
          J.push(cols.map((c, k) => ((c[i].y - base[i].y) / STEPS[KEYS[k]]) * sw));
        }
        if (r.length < 2 * KEYS.length) break;
        const n = KEYS.length;
        const A = Array.from({ length: n }, () => new Array(n).fill(0)), g = new Array(n).fill(0);
        for (let i = 0; i < r.length; i++) for (let a1 = 0; a1 < n; a1++) {
          g[a1] += J[i][a1] * r[i];
          for (let b = 0; b < n; b++) A[a1][b] += J[i][a1] * J[i][b];
        }
        let improved = false;
        for (let tries = 0; tries < 8 && !improved; tries++) {
          const M = A.map((row, i) => row.map((val, j) => (i === j ? val * (1 + lambda) + 1e-9 : val)));
          const step = solve(M, g);
          if (!step) break;
          const np = { ...p };
          KEYS.forEach((k, i) => { np[k] = p[k] - step[i]; });
          if (!valid(np, maxT0, maxLaunch)) { lambda *= 5; continue; }
          const nerr = residuals(w, h, ball, np, obs, opts);
          if (nerr < err) { p = np; err = nerr; lambda = Math.max(1e-7, lambda / 3); improved = true; }
          else lambda *= 5;
        }
        if (!improved) break;
      }
      if (valid(p, maxT0, maxLaunch) && (!best || err < best.err)) best = { p, err };
    }
  }
  if (!best) return null;
  const { p, err } = best;
  const { cam, tee } = geometry(w, h, ball, p, opts);
  const v = { vx: p.vx, vy: p.vy, vz: p.vz, ax: p.ax, cl: opts.cl, cd: opts.cd };
  const sim = simulate(tee, v);
  const land = sim.pts[sim.pts.length - 1];
  let apexHeight = 0;
  for (const q of sim.pts) if (q.y > apexHeight) apexHeight = q.y;
  return {
    v, cam, tee, t0: p.t0,
    rms: Math.sqrt(err / obs.length),
    tLand: sim.tLand,
    carry: Math.hypot(land.x - tee.x, land.z - tee.z), // metres
    apexHeight,                                        // metres
    speed: Math.hypot(v.vx, v.vy, v.vz),               // m/s
    launchAngle: (Math.atan2(v.vy, Math.hypot(v.vx, v.vz)) * 180) / Math.PI,
    direction: (Math.atan2(v.vx, v.vz) * 180) / Math.PI, // + = right of the camera axis
  };
}

// Screen position of the fitted flight at t seconds after the detected impact frame.
export function flightAt(fit) {
  const sim = simulate(fit.tee, fit.v);
  let last = null;
  return (t) => {
    const p = project(fit.cam, positionAt(sim, Math.min(sim.tLand, t + fit.t0)));
    if (p) last = p;
    return p || last || { x: fit.cam.cx, y: fit.cam.cy };
  };
}

// Screen polyline of the fitted flight, with s = (t - t0) / (tLand - t0) so that s = 0 is
// the detected impact frame and s = 1 is landing.
export function flightPolyline(fit, n = 120) {
  const at = flightAt(fit);
  const pts = [];
  const span = fit.tLand - fit.t0;
  for (let k = 0; k <= n; k++) {
    const p = at((k / n) * span);
    pts.push({ x: p.x, y: p.y, s: k / n });
  }
  return pts;
}

// Gaussian elimination with partial pivoting.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const fct = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= fct * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

