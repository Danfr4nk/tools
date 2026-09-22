// silhouette.js — body-outline (person segmentation) for the workbench.
//
// MediaPipe tasks-vision ImageSegmenter (selfie_multiclass_256x256) → binary
// person mask at the model's native 256x256 → marching-squares contour of the
// largest blob → smoothed body outline + clothed-silhouette width metrics.
//
// Honest-caveat contract (same as the report copy): the outline traces
// clothing and hair, NOT the body underneath. The comparable unit across
// photos is the width RATIOS, not the pixel widths.
//
// Everything above the "browser" section is pure and DOM-free: importable
// from plain node for unit tests. The tasks-vision import is dynamic (inside
// ensureSegmenter) so the static module graph has no browser-only deps.
//
// Memory discipline: the stored artifact per photo is the 256x256 Uint8Array
// mask (65KB). Contour points live in mask coordinates; they are scaled to
// photo coordinates only at draw time.
export const SEG_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
export const MASK_SIZE = 256; // selfie_multiclass_256x256 is fixed 256x256

// selfie_multiclass classes: 0=background, 1=hair, 2=body-skin, 3=face-skin,
// 4=clothes, 5=accessories. Person = union of all non-background classes;
// hair counts — it is part of the silhouette.
export function personUnion(cats) {
  const out = new Uint8Array(cats.length);
  for (let i = 0; i < cats.length; i++) out[i] = cats[i] !== 0 ? 1 : 0;
  return out;
}

// ---- marching squares -------------------------------------------------------
// Binary mask → closed loops. Each cell contributes 0-2 segments on cell-edge
// midpoints (exact multiples of 0.5, so string keys are lossless). Segments
// are stitched into loops by endpoint adjacency; loops are returned
// largest-first. extractContour returns the largest loop (the body outline).
function cellSegments(x, y, c) {
  const T = [x + 0.5, y], R = [x + 1, y + 0.5], B = [x + 0.5, y + 1], L = [x, y + 0.5];
  switch (c) {
    case 1: return [[L, T]];
    case 2: return [[T, R]];
    case 3: return [[L, R]];
    case 4: return [[R, B]];
    case 5: return [[L, T], [R, B]];   // saddle: fixed disambiguation
    case 6: return [[T, B]];
    case 7: return [[L, B]];
    case 8: return [[L, B]];
    case 9: return [[T, B]];
    case 10: return [[T, R], [L, B]];  // saddle: fixed disambiguation
    case 11: return [[R, B]];
    case 12: return [[L, R]];
    case 13: return [[T, R]];
    case 14: return [[L, T]];
    default: return [];
  }
}

const key = (p) => p[0] + ',' + p[1];

export function extractLoops(mask, w, h) {
  const segs = [];
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : (mask[y * w + x] ? 1 : 0);
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const c = at(x, y) | (at(x + 1, y) << 1) | (at(x + 1, y + 1) << 2) | (at(x, y + 1) << 3);
      if (c === 0 || c === 15) continue;
      for (const s of cellSegments(x, y, c)) segs.push(s);
    }
  }
  if (!segs.length) return [];
  const adj = new Map();
  segs.forEach((s, i) => {
    for (let e = 0; e < 2; e++) {
      const k = key(s[e]);
      if (!adj.has(k)) adj.set(k, []);
      adj.get(k).push({ seg: i, end: e });
    }
  });
  const used = new Array(segs.length).fill(false);
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const loop = [segs[i][0], segs[i][1]];
    const startKey = key(segs[i][0]);
    let cur = key(segs[i][1]);
    for (let guard = 0; guard <= segs.length + 1; guard++) {
      const cands = (adj.get(cur) || []).filter((c) => !used[c.seg]);
      if (!cands.length) break; // open chain — shouldn't happen on closed blobs
      const nxt = cands[0];
      used[nxt.seg] = true;
      const s = segs[nxt.seg];
      const other = nxt.end === 0 ? s[1] : s[0];
      loop.push(other);
      cur = key(other);
      if (cur === startKey) break;
    }
    loops.push(loop);
  }
  loops.sort((a, b) => b.length - a.length);
  return loops;
}

export function extractContour(mask, w, h) {
  const loops = extractLoops(mask, w, h);
  return loops.length ? loops[0] : [];
}

// ---- smoothing --------------------------------------------------------------
// Closed-loop moving average (1-2-1 kernel). Kills pixel-staircase jitter
// without shrinking the loop much at low pass counts.
export function smoothContour(points, passes = 3) {
  let cur = points.map((p) => [p[0], p[1]]);
  for (let k = 0; k < passes; k++) {
    const n = cur.length;
    if (n < 3) return cur;
    const nxt = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = cur[(i - 1 + n) % n], b = cur[i], c = cur[(i + 1) % n];
      nxt[i] = [
        0.25 * a[0] + 0.5 * b[0] + 0.25 * c[0],
        0.25 * a[1] + 0.5 * b[1] + 0.25 * c[1],
      ];
    }
    cur = nxt;
  }
  return cur;
}

// ---- width profile + metrics --------------------------------------------------
export function widthProfile(mask, w, h) {
  const rows = new Array(h);
  for (let y = 0; y < h; y++) {
    let left = -1, right = -1;
    const base = y * w;
    for (let x = 0; x < w; x++) if (mask[base + x]) { left = x; break; }
    if (left >= 0) for (let x = w - 1; x >= 0; x--) if (mask[base + x]) { right = x; break; }
    rows[y] = left < 0 ? { left: -1, right: -1, width: 0 } : { left, right, width: right - left + 1 };
  }
  return rows;
}

const r3 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1000) / 1000);
const sd = (n, d) => (Math.abs(d) > 1e-9 ? n / d : null);

export const SIL_KEYS = [
  'shoulder_width', 'waist_width', 'hip_width',
  'shoulder_waist', 'waist_hip', 'hip_shoulder',
  'area_fraction', 'bbox_height_fraction',
];
const SIL_LABELS = {
  shoulder_width: 'shoulder width (mask px)', waist_width: 'waist width (mask px)',
  hip_width: 'hip width (mask px)', shoulder_waist: 'shoulder ÷ waist',
  waist_hip: 'waist ÷ hip', hip_shoulder: 'hip ÷ shoulder',
  area_fraction: 'silhouette area ÷ frame', bbox_height_fraction: 'silhouette height ÷ frame',
};
export const silhouetteLabel = (k) => SIL_LABELS[k] || k;

export function silhouetteMetrics(mask, w, h, pose = null) {
  // pose: array of {x, y} in normalized photo coords (MediaPipe PoseLandmarker
  // convention) or null. Mask rows for shoulder/waist/hip come from the
  // pose landmark y when available, else height fractions 0.25/0.45/0.55.
  // y maps linearly (the model input is a uniform resize of the photo), so
  // normalized photo y == mask row fraction.
  const prof = widthProfile(mask, w, h);
  let rs, rw, rh;
  if (pose && pose[11] && pose[12] && pose[23] && pose[24] &&
      isFinite(pose[11].y) && isFinite(pose[12].y) && isFinite(pose[23].y) && isFinite(pose[24].y)) {
    rs = ((pose[11].y + pose[12].y) / 2) * (h - 1);
    rh = ((pose[23].y + pose[24].y) / 2) * (h - 1);
    rw = (rs + rh) / 2;
  } else {
    rs = 0.25 * (h - 1); rw = 0.45 * (h - 1); rh = 0.55 * (h - 1);
  }
  const clampRow = (r) => Math.max(0, Math.min(h - 1, Math.round(r)));
  const sRow = clampRow(rs), wRow = clampRow(rw), hRow = clampRow(rh);
  const sw = prof[sRow].width, ww = prof[wRow].width, hw = prof[hRow].width;
  let person = 0, top = -1, bottom = -1;
  for (let y = 0; y < h; y++) {
    if (prof[y].width > 0) {
      if (top < 0) top = y;
      bottom = y;
      person += prof[y].width;
    }
  }
  return {
    shoulder_width: sw, waist_width: ww, hip_width: hw,
    shoulder_waist: r3(sd(sw, ww)), waist_hip: r3(sd(ww, hw)), hip_shoulder: r3(sd(hw, sw)),
    area_fraction: r3(person / (w * h)),
    bbox_height_fraction: r3(top < 0 ? 0 : (bottom - top + 1) / h),
    rows: { shoulder: sRow, waist: wRow, hip: hRow },
    model: 'MediaPipe ImageSegmenter (selfie_multiclass_256x256)',
  };
}

// ---- browser: draw + segment --------------------------------------------------
// points: contour in mask coordinates (0..MASK_SIZE). Scaled to the target
// canvas size here, at draw time — the stored artifact stays in mask space.
export function drawOutline(ctx, points, imgW, imgH, style = {}) {
  if (!points || points.length < 3) return;
  const sx = imgW / MASK_SIZE, sy = imgH / MASK_SIZE;
  ctx.save();
  ctx.strokeStyle = style.stroke || 'rgba(125,211,252,0.95)';
  ctx.lineWidth = style.width || 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0][0] * sx, points[0][1] * sy);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0] * sx, points[i][1] * sy);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

let segmenter = null, segFailed = false;

export function segmenterError() { return segFailed; }

export async function ensureSegmenter(onStatus) {
  if (segmenter || segFailed) return segmenter;
  let vision;
  try {
    vision = await import('@mediapipe/tasks-vision'); // dynamic: keeps the static graph node-testable
  } catch (e) {
    segFailed = true;
    onStatus && onStatus('segmentation unavailable');
    return null;
  }
  const mk = async (delegate) => {
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
    return vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: SEG_MODEL_URL, delegate },
      runningMode: 'IMAGE',
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
  };
  try {
    onStatus && onStatus('loading segmentation model…');
    segmenter = await mk('GPU');
    onStatus && onStatus('segmentation ready');
  } catch (e) {
    try { segmenter = await mk('CPU'); onStatus && onStatus('segmentation ready'); }
    catch (e2) { segFailed = true; onStatus && onStatus('segmentation unavailable'); }
  }
  return segmenter;
}

// image: any ImageSource (HTMLImageElement, canvas, ImageBitmap…).
// Returns { mask: Uint8Array (1=person), w, h } at the model's native
// resolution, or null on any failure (caller treats null as "unavailable").
export async function segmentPerson(image, seg = null) {
  const s = seg || await ensureSegmenter();
  if (!s) return null;
  let res = null;
  try {
    res = s.segment(image);
    const cm = res && res.categoryMask;
    if (!cm) return null;
    const mw = cm.width || MASK_SIZE, mh = cm.height || MASK_SIZE;
    let cats = null;
    try { cats = cm.getAsUint8Array(); } catch (e) { cats = null; }
    if (!cats || cats.length !== mw * mh) return null;
    return { mask: personUnion(cats), w: mw, h: mh };
  } catch (e) {
    return null;
  } finally {
    try { res && res.categoryMask && res.categoryMask.close(); } catch (e) {}
  }
}
