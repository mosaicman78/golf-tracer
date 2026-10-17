// Decodes a clip into grayscale frames with ffmpeg so the tracker can be run from Node
// against real footage: node test/run-clip.mjs <clip> <ballX> <ballY>
import { spawnSync } from 'node:child_process';

export function probe(path) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,nb_frames', '-of', 'json', path], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const s = JSON.parse(r.stdout).streams[0];
  const [n, d] = s.r_frame_rate.split('/').map(Number);
  return { width: s.width, height: s.height, fps: n / d, frames: Number(s.nb_frames) };
}

// Returns { w, h, frames: [{ w, h, data }] } with the clip scaled to `width` pixels wide.
// ffmpeg applies the rotation metadata, so portrait iPhone clips come out portrait.
export function decodeGray(path, width, { start = 0, count = 150 } = {}) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path,
    '-vf', `select=gte(n\\,${start}),scale=${width}:-2`, '-vsync', '0', '-frames:v', String(count),
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  const buf = r.stdout;
  // Work out height from the first frame size: ask ffprobe for the scaled dims
  const p = probe(path);
  const h = Math.round((p.height * width) / p.width / 2) * 2;
  const size = width * h;
  const frames = [];
  for (let off = 0; off + size <= buf.length; off += size) {
    frames.push({ w: width, h, data: new Uint8ClampedArray(buf.buffer, buf.byteOffset + off, size) });
  }
  return { w: width, h, frames, fps: p.fps };
}

// Writes a PNG of frame `fr` with circles at `points` (for eyeballing tracker output).
export function annotate(frame, points, outPath, extra = '') {
  const draw = points.map((p) => `drawbox=x=${Math.round(p.x) - 4}:y=${Math.round(p.y) - 4}:w=8:h=8:color=red@0.9:t=2`).join(',');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray',
    '-s', `${frame.w}x${frame.h}`, '-i', '-', '-vf', (draw || 'null') + (extra ? ',' + extra : ''), '-frames:v', '1', outPath],
    { input: Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.length) });
  if (r.status !== 0) throw new Error(r.stderr.toString());
}
