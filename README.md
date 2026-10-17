# Golf Tracer

A web app that draws a shot-tracer line over a golf swing filmed on your phone. Open it in
Safari on an iPhone, pick a clip from Photos, tap the ball, and the app finds impact, follows
the ball into the sky, and draws the flight. Drag three handles to fine-tune, then export a
video to share.

No build step, no server: it's plain HTML, CSS and JavaScript, so it runs from any static host
(GitHub Pages here) and works offline once loaded.

## Filming tips

- Film from behind the golfer, down the target line, with the phone steady (tripod or braced).
- Keep the ball in the lower third of the frame and the sky behind the flight.
- The brighter the ball against its background, the better the tracking. Clear sky is ideal.
- 4K at 30 fps works; slo-mo helps the launch frames.

## How it works

1. **Tap the ball** on a frame before the swing. The tap snaps to the bright blob nearby and
   measures the ball's size (`src/tracker.js`: `snapToBall`, `estimateBallRadius`).
2. **Impact** is the first frame where that spot stops containing a ball-sized bright patch,
   confirmed over the next two frames (`ballPresent`).
3. **Launch tracking** looks for a small, isolated blob that got brighter between consecutive
   frames (`findBlobs`), first anywhere above the ball, then in a window predicted from the
   ball's screen velocity. Blobs that are large, elongated (club shaft), or surrounded by
   other motion (the golfer) are rejected.
4. **The trace** is a polyline through the tracked points timed to the real frames, extended a
   little past where the ball was lost. If only the launch was seen, a generic arc is fitted
   from the launch direction (`src/curve.js`). Three handles warp it smoothly.
5. **Export** replays the shot on a canvas with the tracer and records it with `MediaRecorder`
   (MP4 on Safari, WebM elsewhere).

## Development

```sh
npm start          # serves the app at http://localhost:8080
npm test           # unit tests on synthetic frames (no clip needed)

# run the tracker on a real clip from the command line (needs ffmpeg):
node test/run-clip.mjs path/to/clip.mov <ballX> <ballY>
# full browser run in headless Chromium (needs a VP9 .webm, Chromium can't decode HEVC):
node test/e2e.mjs path/to/clip.webm <ballX> <ballY>
```

Ball coordinates are in the clip's own pixels after rotation.

## Deploying

Pushes to `main` publish the site with GitHub Pages via `.github/workflows/pages.yml`.
