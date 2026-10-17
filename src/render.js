import { visiblePoints, handles } from './curve.js?v=8';

// Draw the tracer up to `progress` (0..1 of the hang time) with a soft glow and a bright core.
export function drawTrace(ctx, trace, progress, style) {
  const pts = visiblePoints(trace, progress);
  if (pts.length < 2) return;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // glow: a few wide translucent strokes (cheaper than a blur filter on a big canvas)
  ctx.strokeStyle = style.color;
  for (const [k, a] of [[3.2, 0.10], [2.4, 0.16], [1.7, 0.25]]) {
    ctx.globalAlpha = a;
    ctx.lineWidth = style.width * k;
    strokePath(ctx, pts);
  }
  // body
  ctx.globalAlpha = 1;
  ctx.lineWidth = style.width;
  strokePath(ctx, pts);
  // core
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = Math.max(1, style.width * 0.3);
  strokePath(ctx, pts);
  // leading dot
  if (progress < 1) {
    const head = pts[pts.length - 1];
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(head.x, head.y, style.width * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function strokePath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

export function drawHandles(ctx, trace, scale) {
  const r = 14 * scale;
  const h = handles(trace);
  const items = [[h.start, 'Start'], [h.apex, 'Apex'], [h.landing, 'Landing']];
  ctx.save();
  ctx.font = `${13 * scale}px -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  for (const [p, label] of items) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fill();
    ctx.lineWidth = 2 * scale;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText(label, p.x, p.y - r - 6 * scale);
  }
  ctx.restore();
}

export function drawTrackedPoints(ctx, points, scale) {
  ctx.save();
  ctx.fillStyle = 'rgba(53,199,89,0.9)';
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3 * scale, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// Carry estimate in the top-left corner (it is part of the exported video).
export function drawCarryLabel(ctx, stats, scale) {
  const text = `Carry ≈ ${Math.round(stats.carryYd)} yd`;
  const pad = 10 * scale, size = 28 * scale, x = 16 * scale, y = 16 * scale;
  ctx.save();
  ctx.font = `600 ${size}px -apple-system, "Segoe UI", sans-serif`;
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  roundRect(ctx, x, y, tw + pad * 2, size + pad * 1.4, 8 * scale);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';
  ctx.fillText(text, x + pad, y + pad * 0.7);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawBallMarker(ctx, ball, scale) {
  ctx.save();
  ctx.strokeStyle = '#35c759';
  ctx.lineWidth = 2 * scale;
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, Math.max(ball.r * 1.5, 10 * scale), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
