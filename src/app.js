import { toGray, analyze, snapToBall, estimateBallRadius } from './tracker.js?v=7';
import { defaultTrace, smoothTrace, handles, moveHandle } from './curve.js?v=7';
import { fitFlight, flightAt } from './flight.js?v=7';
import { drawTrace, drawHandles, drawTrackedPoints, drawBallMarker, drawCarryLabel } from './render.js?v=7';
import { recordClip, seek } from './export.js?v=7';

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

const FPS = 30;          // playback frame rate used for stepping and analysis
const ANALYSIS_W = 1280; // frames are downscaled to at most this width for tracking
const OUT_MAX = 1920;    // longest side of the working/export canvas (4K clips are scaled down)

const state = {
  step: 'load',
  url: null,
  ball: null,          // { x, y, r } in video pixels
  addressTime: 0,
  impactTime: null,
  points: [],          // tracked ball centres in video pixels
  trace: null,         // polyline [{ x, y, s }] in video pixels, s = fraction of hang time
  style: { color: '#ff3b30', width: 6 },
  hang: 5,             // seconds the tracer takes to complete
  drag: null,
  previewing: false,
  framesDrawn: 0,      // frames painted since the clip was loaded (0 = still black)
};
window.__tracer = state; // handy for debugging and tests

// ---------- steps / panels ----------
function setStep(step) {
  state.step = step;
  const order = ['load', 'tap', 'analyze', 'adjust', 'export'];
  const idx = order.indexOf(step);
  document.querySelectorAll('#steps li').forEach((li) => {
    const i = order.indexOf(li.dataset.step);
    li.classList.toggle('active', i === idx);
    li.classList.toggle('done', i < idx);
  });
  for (const s of order) $(`panel-${s}`).classList.toggle('hidden', s !== step);
  $('stage').classList.toggle('hidden', step === 'load');
  $('restart').classList.toggle('hidden', step === 'load');
  draw();
}

function overlay(msg) {
  const el = $('overlay-msg');
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

// ---------- loading ----------
$('file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try { await loadFile(file); } catch (err) { overlay(`Error: ${err.message}`); }
});

// Surface failures on screen: the user is on a phone with no console.
window.addEventListener('error', (e) => overlay(`Error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => overlay(`Error: ${e.reason && e.reason.message || e.reason}`));

async function loadFile(file) {
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(file);
  $('stage').classList.remove('hidden');
  overlay(`Opening ${file.name || 'clip'} (${(file.size / 1e6).toFixed(0)} MB, ${file.type || 'unknown type'})…`);
  video.src = state.url;
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error(`Could not open that video (${video.error && video.error.message || 'decode error'}).`));
  });
  const k = Math.min(1, OUT_MAX / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.round(video.videoWidth * k);
  canvas.height = Math.round(video.videoHeight * k);
  $('scrubber').max = video.duration;
  $('scrubber').value = 0;
  state.ball = null; state.points = []; state.trace = null; state.impactTime = null;
  setStep('tap');
  overlay(`Loading first frame… (${video.videoWidth}×${video.videoHeight}, ${video.duration.toFixed(1)} s)`);
  await primeVideo();
  state.framesDrawn = 0;
  draw();
  if (!state.framesDrawn) overlay(`Waiting for video data (readyState ${video.readyState})…`);
  else overlay('Tap the ball');
}

// Keep painting while a clip is loaded; some browsers only deliver the first frame late.
function drawLoop() {
  if (state.step === 'tap' || (state.step === 'adjust' && !state.previewing)) {
    const before = state.framesDrawn;
    draw();
    if (!before && state.framesDrawn && state.step === 'tap') overlay('Tap the ball');
  }
  requestAnimationFrame(drawLoop);
}
requestAnimationFrame(drawLoop);

// iOS Safari won't hand a frame to drawImage until the video has actually started once,
// so nudge it with a muted play/pause and a tiny seek, then wait for data to be ready.
async function primeVideo() {
  try { await video.play(); video.pause(); } catch { /* autoplay refused; the seek below still helps */ }
  await seek(video, 0.001);
  if (video.readyState < 2) {
    await new Promise((resolve) => {
      const done = () => { video.removeEventListener('loadeddata', done); video.removeEventListener('canplay', done); resolve(); };
      video.addEventListener('loadeddata', done);
      video.addEventListener('canplay', done);
      setTimeout(done, 2000);
    });
  }
}

// ---------- scrubbing ----------
$('scrubber').addEventListener('input', async (e) => {
  await seek(video, parseFloat(e.target.value));
  updateTimeLabel();
  draw();
});
$('back').addEventListener('click', () => stepFrame(-1));
$('fwd').addEventListener('click', () => stepFrame(1));

async function stepFrame(n) {
  const t = Math.min(video.duration, Math.max(0, video.currentTime + n / FPS));
  await seek(video, t);
  $('scrubber').value = t;
  updateTimeLabel();
  draw();
}
function updateTimeLabel() { $('time-label').textContent = `${video.currentTime.toFixed(2)} s`; }

// ---------- pointer handling (tap the ball / drag handles) ----------
function toVideoCoords(ev) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((ev.clientX - rect.left) / rect.width) * canvas.width,
    y: ((ev.clientY - rect.top) / rect.height) * canvas.height,
  };
}
function cssScale() { return canvas.width / canvas.getBoundingClientRect().width; }

canvas.addEventListener('pointerdown', (ev) => {
  const p = toVideoCoords(ev);
  if (state.step === 'tap') {
    state.ball = { x: p.x, y: p.y, r: Math.max(4, Math.round(canvas.height / 150)) };
    state.addressTime = video.currentTime;
    draw();
    startAnalysis();
  } else if (state.step === 'adjust' && state.trace && !state.previewing) {
    const hitR = 28 * cssScale();
    const h = handles(state.trace);
    for (const key of ['apex', 'landing', 'start']) {
      if (Math.hypot(h[key].x - p.x, h[key].y - p.y) < hitR) {
        state.drag = { key, last: p };
        canvas.setPointerCapture(ev.pointerId);
        break;
      }
    }
  }
});
canvas.addEventListener('pointermove', (ev) => {
  if (!state.drag) return;
  const p = toVideoCoords(ev);
  state.trace = moveHandle(state.trace, state.drag.key, p.x - state.drag.last.x, p.y - state.drag.last.y);
  state.drag.last = p;
  draw();
});
const endDrag = () => { state.drag = null; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ---------- analysis ----------
async function startAnalysis() {
  setStep('analyze');
  overlay('');
  // Analysis frames are drawn straight from the video (not the display canvas) so a 4K clip
  // keeps its detail; `scale` converts canvas coordinates to analysis coordinates.
  const aw = Math.min(ANALYSIS_W, video.videoWidth);
  const ah = Math.round((video.videoHeight * aw) / video.videoWidth);
  const scale = aw / canvas.width;
  const work = document.createElement('canvas');
  work.width = aw; work.height = ah;
  const wctx = work.getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  const getFrame = async (i) => {
    if (cache.has(i)) return cache.get(i);
    // aim for the middle of frame i so seeking never lands on a frame boundary
    await seek(video, state.addressTime + (i + 0.5) / FPS);
    wctx.drawImage(video, 0, 0, aw, ah);
    const g = toGray(wctx.getImageData(0, 0, aw, ah));
    cache.set(i, g);
    if (cache.size > 6) cache.delete(cache.keys().next().value);
    return g;
  };
  // Snap the tap onto the ball and measure it, so the user doesn't have to be pixel-precise
  const address = await getFrame(0);
  const snapped = snapToBall(address, state.ball.x * scale, state.ball.y * scale);
  const ball = { x: snapped.x, y: snapped.y, r: estimateBallRadius(address, snapped.x, snapped.y) };
  state.ball = { x: ball.x / scale, y: ball.y / scale, r: ball.r / scale };
  const maxFrames = Math.min(150, Math.floor((video.duration - state.addressTime) * FPS) - 3);

  const progress = $('analyze-progress');
  const result = await analyze(getFrame, ball, {
    maxFrames,
    onProgress: (p) => { progress.value = p; },
  });

  state.points = result.points.map((p) => ({ x: p.x / scale, y: p.y / scale, i: p.i }));
  if (result.impactIndex < 0) {
    state.impactTime = state.addressTime + 0.5;
    $('adjust-msg').textContent = "Couldn't see the ball leave. Set the handles by hand, or re-tap on a frame just before the swing.";
  } else {
    state.impactTime = state.addressTime + result.impactIndex / FPS;
    $('adjust-msg').textContent = state.points.length >= 3
      ? `Tracked ${state.points.length} frames after impact. Drag the handles to fine-tune.`
      : 'Found impact but lost the ball quickly. Drag the handles to match the shot.';
  }
  // Fit the flight model and build a smooth curve that runs on to landing; fall back to
  // the plain polyline when there is too little to fit.
  state.stats = null;
  let t = null;
  if (result.impactIndex >= 0 && state.points.length >= 6) {
    $('analyze-msg').textContent = 'Fitting the ball flight…';
    await new Promise((r) => setTimeout(r, 20));
    const obs = state.points.map((p) => ({ x: p.x, y: p.y, t: (p.i - result.impactIndex) / FPS }));
    let flight = null;
    try {
      const fit = fitFlight(canvas.width, canvas.height, state.ball, obs, { fps: FPS });
      if (fit) {
        flight = { ...fit, at: flightAt(fit) };
        state.stats = { carryYd: fit.carry * 1.0936, hang: fit.tLand, speedMph: fit.speed * 2.237, launch: fit.launchAngle };
      }
    } catch (err) { console.warn('flight fit failed', err); }
    t = smoothTrace(state.ball, state.points, result.impactIndex, FPS, canvas.width, canvas.height, flight);
    if (t && state.stats) $('adjust-msg').textContent += ` Carry estimate ≈ ${Math.round(state.stats.carryYd)} yd (rough: single phone camera, no calibration).`;
  }
  if (!t) t = defaultTrace(state.ball, state.points, result.impactIndex, canvas.width, canvas.height);
  state.trace = t.pts;
  if (t.hangFrames > 0) {
    state.hang = Math.min(9, Math.max(1.5, t.hangFrames / FPS));
    $('hang').value = state.hang.toFixed(1);
    $('hang-label').textContent = `${state.hang.toFixed(1)} s`;
  }
  await seek(video, state.impactTime + Math.min(state.hang, 1.2));
  overlay('');
  setStep('adjust');
}

// ---------- adjust controls ----------
$('color').addEventListener('input', (e) => { state.style.color = e.target.value; draw(); });
$('width').addEventListener('input', (e) => { state.style.width = parseInt(e.target.value, 10); draw(); });
$('hang').addEventListener('input', (e) => {
  state.hang = parseFloat(e.target.value);
  $('hang-label').textContent = `${state.hang.toFixed(1)} s`;
  draw();
});
$('retap').addEventListener('click', async () => {
  state.points = []; state.trace = null;
  await seek(video, state.addressTime);
  $('scrubber').value = state.addressTime;
  updateTimeLabel();
  setStep('tap');
  overlay('Tap the ball');
});
$('restart').addEventListener('click', () => {
  video.pause();
  $('file').value = '';
  setStep('load');
});

function previewRange() {
  const from = Math.max(0, state.impactTime - 0.8);
  const to = Math.min(video.duration, state.impactTime + state.hang + 1.2);
  return { from, to };
}

$('play').addEventListener('click', async () => {
  if (state.previewing) { video.pause(); return; }
  const { from, to } = previewRange();
  await seek(video, from);
  state.previewing = true;
  $('play').textContent = 'Stop';
  await video.play();
  const tick = () => {
    draw();
    if (!state.previewing || video.paused || video.currentTime >= to) {
      video.pause();
      state.previewing = false;
      $('play').textContent = 'Preview';
      draw();
      return;
    }
    requestAnimationFrame(tick);
  };
  tick();
});
video.addEventListener('pause', () => { state.previewing = false; $('play').textContent = 'Preview'; });

// ---------- export ----------
let lastBlob = null;
let audio = null; // { ctx, dest } once the clip's sound has been routed through Web Audio

// Route the <video>'s sound into a MediaStream so the recorder can mux it. Must be created
// (and resumed) inside a user gesture for iOS Safari. After this the element's audio only
// reaches the recorder, which is fine: previews stay silent as before.
function audioTrackForExport() {
  try {
    if (!audio) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      const ctx = new Ctx();
      const src = ctx.createMediaElementSource(video);
      const dest = ctx.createMediaStreamDestination();
      src.connect(dest);
      audio = { ctx, dest };
    }
    if (audio.ctx.state !== 'running') audio.ctx.resume();
    return audio.dest.stream.getAudioTracks()[0] || null;
  } catch (err) {
    console.warn('audio capture unavailable', err);
    return null;
  }
}

$('export').addEventListener('click', async () => {
  // Everything that needs the user gesture happens before the first await.
  const audioTrack = audioTrackForExport();
  video.muted = false;           // a muted element feeds silence into the audio graph
  video.volume = 1;
  const unlock = video.play().then(() => video.pause(), () => { /* fall back to silent below */ });
  setStep('export');
  $('download').classList.add('hidden');
  $('share').classList.add('hidden');
  $('share-hint').classList.add('hidden');
  $('export-msg').textContent = 'Rendering… keep this screen open.';
  const { from, to } = previewRange();
  try {
    await unlock;
    const { blob, ext } = await recordClip({
      canvas, video, from, to, fps: FPS,
      onProgress: (p) => { $('export-progress').value = p; },
      draw: () => draw(true),
      audioTrack,
    });
    lastBlob = new File([blob], `golf-tracer.${ext}`, { type: blob.type });
    $('export-msg').textContent = `Done (${(blob.size / 1e6).toFixed(1)} MB${audioTrack ? ', with sound' : ', no sound'}).`;
    const a = $('download');
    a.href = URL.createObjectURL(blob);
    a.download = lastBlob.name;
    a.classList.remove('hidden');
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [lastBlob] }));
    if (canShare) {
      $('share').classList.remove('hidden');
      $('share-hint').classList.remove('hidden');
      $('download').classList.remove('primary');
    } else {
      $('download').classList.add('primary');
      $('download').textContent = 'Save video';
    }
  } catch (err) {
    $('export-msg').textContent = `Export failed: ${err.message}`;
  } finally {
    video.muted = true;
  }
  draw();
});
$('share').addEventListener('click', async () => {
  // On iPhone the share sheet offers "Save Video", which puts the clip in Photos.
  try { await navigator.share({ files: [lastBlob], title: 'Golf shot' }); }
  catch (err) { if (err && err.name !== 'AbortError') $('export-msg').textContent = `Share failed: ${err.message}`; }
});
$('back-to-adjust').addEventListener('click', () => setStep('adjust'));

// ---------- drawing ----------
function draw(clean = false) {
  if (state.step === 'load' || !video.videoWidth || video.readyState < 2) return;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  state.framesDrawn = (state.framesDrawn || 0) + 1;
  const scale = cssScale() || 1;
  if (state.step === 'tap' && state.ball) drawBallMarker(ctx, state.ball, scale);
  if (state.trace && state.impactTime != null) {
    const progress = Math.min(1, Math.max(0, (video.currentTime - state.impactTime) / state.hang));
    drawTrace(ctx, state.trace, progress, state.style);
    if (state.stats && progress > 0) drawCarryLabel(ctx, state.stats, scale);
    if (!clean && state.step === 'adjust' && !state.previewing) {
      drawTrackedPoints(ctx, state.points, scale);
      drawHandles(ctx, state.trace, scale);
    }
  }
}

// keep the canvas fresh while the video is seeking/paused
video.addEventListener('seeked', () => draw());
video.addEventListener('loadeddata', () => draw());
video.addEventListener('canplay', () => draw());
video.addEventListener('timeupdate', () => { if (!state.previewing) draw(); });
window.addEventListener('resize', () => draw());
