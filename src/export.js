// Records the stage canvas while the clip plays through the shot, producing a shareable video.

const CANDIDATES = [
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export function supportedMimeTypes() {
  if (typeof MediaRecorder === 'undefined') return [];
  return CANDIDATES.filter((m) => MediaRecorder.isTypeSupported(m));
}

// opts: { canvas, video, from, to, fps, onProgress, draw, audioTrack }
// `draw` is called every animation frame to paint the current video frame plus the trace.
// `audioTrack` (optional) is a MediaStreamTrack carrying the clip's sound; it is muxed in.
// Tries each supported container in turn, since some browsers accept a type and then
// record nothing with it.
export async function recordClip(opts) {
  const types = supportedMimeTypes();
  if (!types.length) throw new Error('Video recording is not supported in this browser.');
  let lastErr = null;
  for (const mimeType of types) {
    try {
      const blob = await recordOnce(mimeType, opts);
      if (blob.size > 0) {
        return { blob, ext: mimeType.startsWith('video/mp4') ? 'mp4' : 'webm' };
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Recording produced an empty file.');
}

async function recordOnce(mimeType, { canvas, video, from, to, fps = 30, onProgress = () => {}, draw, audioTrack = null }) {
  const stream = canvas.captureStream(fps);
  if (audioTrack) stream.addTrack(audioTrack);
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000, audioBitsPerSecond: 128_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((resolve, reject) => {
    rec.onstop = resolve;
    rec.onerror = (e) => reject(e.error || new Error('Recorder error'));
  });

  await seek(video, from);
  draw();
  rec.start(250);
  await video.play();
  const wallLimit = performance.now() + (to - from) * 1000 + 4000;
  await new Promise((resolve) => {
    const tick = () => {
      draw();
      onProgress(Math.min(1, (video.currentTime - from) / (to - from)));
      if (video.currentTime >= to || video.ended || performance.now() > wallLimit) {
        video.pause();
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // Let the recorder catch the last frames
  await new Promise((r) => setTimeout(r, 300));
  rec.stop();
  await done;
  stream.getVideoTracks().forEach((t) => t.stop());
  return new Blob(chunks, { type: mimeType.split(';')[0] });
}

export function seek(video, t) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 1e-4 && video.readyState >= 2) { resolve(); return; }
    let timer;
    const onSeeked = () => { clearTimeout(timer); video.removeEventListener('seeked', onSeeked); resolve(); };
    video.addEventListener('seeked', onSeeked);
    // Safari occasionally never fires `seeked` for a no-op seek; don't hang on it
    timer = setTimeout(onSeeked, 1500);
    video.currentTime = t;
  });
}
