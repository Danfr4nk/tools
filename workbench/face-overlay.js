/* workbench/face-overlay.js — the telemetry lab's telestrator, ported for the workbench.
 *
 * Pure drawing + geometry. ZERO imports: landmark index tables are copied
 * verbatim from their sources (cited below) so this module never pulls the
 * MediaPipe/transformers/ort stacks — render.js and import.js stay lightweight.
 *
 * Sources of truth for the index tables:
 *   IDX/EXTRA  <- attraction/js/measure.js  (MediaPipe FaceLandmarker indices)
 *   nasion/subnasale <- attraction/js/telemetry.js (its local EXTRA)
 *   IRIS / EYE_RING_* / LIP_RING <- attraction/js/telemetry2.js
 */

const I = {
  eye_outer_L: 33, eye_inner_L: 133, eye_inner_R: 362, eye_outer_R: 263,
  mouth_L: 61, mouth_R: 291, lip_top: 0, lip_bot: 17,
  nostril_L: 98, nostril_R: 327,
  chin: 152, jaw_L: 172, jaw_R: 397,
  cheek_L: 234, cheek_R: 454, forehead: 10,
  brow_inner_L: 107, brow_inner_R: 336,
  subnasale: 2,
};
const IRIS = { center_L: 468, center_R: 473, L_axes: [[469, 471], [470, 472]], R_axes: [[474, 476], [475, 477]] };
const EYE_RING_L = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const EYE_RING_R = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
const LIP_RING = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// Overlay inputs derived from NORMALIZED landmarks (FaceLandmarker, 478 pts).
// Distances come back in normalized units; callers multiply by display width.
export function computeFaceOverlayData(lm) {
  if (!lm || lm.length < 478) return null;
  const glabella = mid(lm[I.brow_inner_L], lm[I.brow_inner_R]);
  const eyeCL = mid(lm[I.eye_outer_L], lm[I.eye_inner_L]);
  const eyeCR = mid(lm[I.eye_inner_R], lm[I.eye_outer_R]);
  const rollDeg = Math.atan2(eyeCR.y - eyeCL.y, eyeCR.x - eyeCL.x) * 180 / Math.PI;
  const tU = dist(lm[I.forehead], glabella);
  const tM = dist(glabella, lm[I.subnasale]);
  const tL = dist(lm[I.subnasale], lm[I.chin]);
  const tTot = (tU + tM + tL) || 1;
  const axes = [...IRIS.L_axes, ...IRIS.R_axes].map(([a, b]) => dist(lm[a], lm[b]));
  const irisDiamN = axes.reduce((s, v) => s + v, 0) / axes.length;
  const tilt = (inner, outer) =>
    Math.atan2(-(outer.y - inner.y), Math.abs(outer.x - inner.x)) * 180 / Math.PI;
  return {
    glabella, eyeCL, eyeCR, rollDeg,
    thirdsPct: [tU / tTot * 100, tM / tTot * 100, tL / tTot * 100],
    irisDiamN,
    tiltL: tilt(lm[I.eye_inner_L], lm[I.eye_outer_L]),
    tiltR: tilt(lm[I.eye_inner_R], lm[I.eye_outer_R]),
    ipdN: dist(eyeCL, eyeCR),
  };
}

function seg(ctx, a, b, color, label) {
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  for (const p of [a, b]) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 7); ctx.fill(); }
  if (label) {
    ctx.font = '11px ui-monospace, monospace'; ctx.fillStyle = color;
    ctx.fillText(label, (a.x + b.x) / 2 + 6, (a.y + b.y) / 2 - 6);
  }
}

// Draws the annotated face: photo + every overlay layer, lab-style.
// ctx must already carry the caller's transform; W,H are logical (native-image)
// dimensions. label = short HUD tag, e.g. 'face 1 · 512×512 crop'.
export function drawFaceOverlay(ctx, W, H, img, lm, d, label) {
  ctx.drawImage(img, 0, 0, W, H);
  const X = (p) => ({ x: p.x * W, y: p.y * H });
  const A = d;

  // mesh dots
  ctx.fillStyle = 'rgba(45,212,191,.5)';
  for (const p of lm) ctx.fillRect(p.x * W - 1, p.y * H - 1, 2, 2);

  // metric segments + contour rings
  seg(ctx, X(lm[I.cheek_L]), X(lm[I.cheek_R]), '#d8b4fe', 'cheek');
  seg(ctx, X(lm[I.jaw_L]), X(lm[I.jaw_R]), '#86efac', 'jaw');
  seg(ctx, X(A.eyeCL), X(A.eyeCR), '#7dd3fc', 'IPD');
  seg(ctx, X(lm[I.eye_outer_L]), X(lm[I.eye_inner_L]), '#7dd3fc');
  seg(ctx, X(lm[I.eye_inner_R]), X(lm[I.eye_outer_R]), '#7dd3fc');
  seg(ctx, X(lm[I.mouth_L]), X(lm[I.mouth_R]), '#fca5a5', 'mouth');
  seg(ctx, X(lm[I.nostril_L]), X(lm[I.nostril_R]), '#fcd34d', 'nose');
  seg(ctx, X(lm[I.lip_top]), X(lm[I.lip_bot]), '#fca5a5', 'lip');
  ctx.lineWidth = 1.5;
  for (const [ring, color] of [[EYE_RING_L, '#7dd3fc'], [EYE_RING_R, '#7dd3fc'], [LIP_RING, '#fca5a5']]) {
    ctx.strokeStyle = color; ctx.beginPath();
    ring.forEach((idx, j) => {
      const p = X(lm[idx]);
      j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    });
    ctx.closePath(); ctx.stroke();
  }

  // facial horizontal (eye axis) — thirds dividers run perpendicular to the
  // facial midline so tilted heads get anatomical thirds, not horizontal slices
  const rollR = A.rollDeg * Math.PI / 180;
  const rdx = Math.cos(rollR), rdy = Math.sin(rollR);
  ctx.font = '11px ui-monospace, monospace';

  // thirds
  {
    const halfSpan = Math.abs(X(lm[I.cheek_R]).x - X(lm[I.cheek_L]).x) / 2 + 20;
    const rows = [
      [X(lm[I.forehead]), `U ${A.thirdsPct[0].toFixed(1)}%`],
      [X(A.glabella), ''],
      [X(lm[I.subnasale]), `M ${A.thirdsPct[1].toFixed(1)}%`],
      [X(lm[I.chin]), `L ${A.thirdsPct[2].toFixed(1)}%`],
    ];
    for (const [a, lab] of rows) {
      ctx.strokeStyle = '#f472b6'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(a.x - rdx * halfSpan, a.y - rdy * halfSpan);
      ctx.lineTo(a.x + rdx * halfSpan, a.y + rdy * halfSpan);
      ctx.stroke();
      ctx.setLineDash([]);
      if (lab) { ctx.fillStyle = '#f472b6'; ctx.fillText(lab, a.x + rdx * halfSpan + 6, a.y + rdy * halfSpan + 4); }
    }
  }

  // midline
  {
    const f = X(lm[I.forehead]), c = X(lm[I.chin]);
    const ex = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    const a = ex(f, c, -0.3), b = ex(f, c, 1.3);
    ctx.strokeStyle = 'rgba(45,212,191,.55)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(45,212,191,.85)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText('MIDLINE', b.x + 6, b.y + 3);
  }

  // fifths
  {
    const cL = X(lm[I.cheek_L]), cR = X(lm[I.cheek_R]);
    const f = X(lm[I.forehead]), ch = X(lm[I.chin]);
    const vlen = Math.hypot(ch.x - f.x, ch.y - f.y) * 0.7;
    ctx.strokeStyle = 'rgba(196,141,255,.4)'; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
    ctx.beginPath();
    for (let k = 1; k < 5; k++) {
      const px = cL.x + (cR.x - cL.x) * k / 5, py = cL.y + (cR.y - cL.y) * k / 5;
      ctx.moveTo(px + rdy * vlen, py - rdx * vlen);
      ctx.lineTo(px - rdy * vlen, py + rdx * vlen);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(196,141,255,.75)';
    ctx.font = '10px ui-monospace, monospace';
    const top5 = { x: cL.x + (cR.x - cL.x) / 5, y: cL.y + (cR.y - cL.y) / 5 };
    ctx.fillText('FIFTHS', top5.x + rdy * vlen + 4, top5.y - rdx * vlen);
  }

  // iris
  {
    const r = Math.max(3, A.irisDiamN * W / 2);
    ctx.strokeStyle = 'rgba(125,211,252,.9)'; ctx.lineWidth = 1.5;
    ctx.font = '10px ui-monospace, monospace';
    for (const idx of [IRIS.center_L, IRIS.center_R]) {
      const p = X(lm[idx]);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x - r - 6, p.y); ctx.lineTo(p.x - r + 4, p.y);
      ctx.moveTo(p.x + r - 4, p.y); ctx.lineTo(p.x + r + 6, p.y);
      ctx.moveTo(p.x, p.y - r - 6); ctx.lineTo(p.x, p.y - r + 4);
      ctx.moveTo(p.x, p.y + r - 4); ctx.lineTo(p.x, p.y + r + 6);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(125,211,252,.9)';
    const pc = X(lm[IRIS.center_R]);
    ctx.fillText(`IRIS Ø${(A.irisDiamN * W).toFixed(0)}px`, pc.x + r + 8, pc.y - r - 6);
  }

  // dims: IPD dimension line + canthal tilt arcs
  {
    const a = X(A.eyeCL), b = X(A.eyeCR);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const nx = -Math.sin(ang), ny = Math.cos(ang), off = 30;
    const a2 = { x: a.x + nx * off, y: a.y + ny * off }, b2 = { x: b.x + nx * off, y: b.y + ny * off };
    ctx.strokeStyle = 'rgba(252,211,77,.9)'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(a.x + nx * 8, a.y + ny * 8); ctx.lineTo(a2.x + nx * 8, a2.y + ny * 8);
    ctx.moveTo(b.x + nx * 8, b.y + ny * 8); ctx.lineTo(b2.x + nx * 8, b2.y + ny * 8);
    ctx.moveTo(a2.x, a2.y); ctx.lineTo(b2.x, b2.y);
    for (const p of [a2, b2]) {
      ctx.moveTo(p.x - nx * 5 - Math.cos(ang) * 5, p.y - ny * 5 - Math.sin(ang) * 5);
      ctx.lineTo(p.x + nx * 5 + Math.cos(ang) * 5, p.y + ny * 5 + Math.sin(ang) * 5);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(252,211,77,.95)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(`IPD ${(A.ipdN * W).toFixed(0)}px`, (a2.x + b2.x) / 2 + 10, (a2.y + b2.y) / 2 - 6);
    const tiltArc = (innerLm, outerLm, tiltDeg) => {
      const o = X(outerLm), inn = X(innerLm);
      const s = Math.sign(o.x - inn.x) || 1;
      const aRef = Math.atan2(s * rdy, s * rdx);
      const aAct = Math.atan2(inn.y - o.y, inn.x - o.x);
      let dd = aAct - aRef;
      while (dd > Math.PI) dd -= 2 * Math.PI;
      while (dd < -Math.PI) dd += 2 * Math.PI;
      ctx.strokeStyle = 'rgba(248,113,113,.9)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(o.x, o.y, 17, aRef, aRef + dd, dd < 0); ctx.stroke();
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(o.x, o.y); ctx.lineTo(o.x + Math.cos(aRef) * 28, o.y + Math.sin(aRef) * 28);
      ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(248,113,113,.9)';
      ctx.fillText(tiltDeg.toFixed(1) + '°', o.x + Math.cos(aRef) * 32 - 10, o.y + Math.sin(aRef) * 32 + 3);
    };
    tiltArc(lm[I.eye_inner_L], lm[I.eye_outer_L], A.tiltL);
    tiltArc(lm[I.eye_inner_R], lm[I.eye_outer_R], A.tiltR);
  }

  // HUD frame: corner brackets + data block
  {
    const B = 16, L = 42;
    ctx.strokeStyle = 'rgba(45,212,191,.8)'; ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [cx, cy, sx, sy] of [[B, B, 1, 1], [W - B, B, -1, 1], [B, H - B, 1, -1], [W - B, H - B, -1, -1]]) {
      ctx.moveTo(cx + sx * L, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + sy * L);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(45,212,191,.9)';
    ctx.font = '11px ui-monospace, monospace';
    const hud = [
      `WORKBENCH TELEMETRY · ${label}`,
      `ROLL ${A.rollDeg.toFixed(1)}° · THIRDS U ${A.thirdsPct[0].toFixed(1)} / M ${A.thirdsPct[1].toFixed(1)} / L ${A.thirdsPct[2].toFixed(1)}%`,
    ];
    hud.forEach((t, i) => ctx.fillText(t, B + 10, B + 18 + i * 14));
  }
}

// Full-resolution annotated export. Renders the overlay onto an offscreen
// canvas (long side `target`, default 1024) and returns a PNG data URL —
// the guidelines baked in, ready to embed in the report JSON or download.
export function annotatedPngDataUrl(img, lm, d, label, target = 1024) {
  const nw = img.naturalWidth || img.width, nh = img.naturalHeight || img.height;
  const scale = target / Math.max(nw, nh);
  const c = document.createElement('canvas');
  c.width = Math.round(nw * scale); c.height = Math.round(nh * scale);
  const ctx = c.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  // text/line widths are authored in native-image px — scale them back up so
  // the export matches the lab's on-screen proportions
  drawFaceOverlay(ctx, nw, nh, img, lm, d, label);
  return c.toDataURL('image/png');
}
