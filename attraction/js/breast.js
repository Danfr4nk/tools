// breast.js — breast telemetry instrument for the attraction workbench.
//
// JS port of the ~/workspace/breast-telemetry/ prototype (measure2.py /
// measure3.py / measure4.py), which produced the FIXED schema
// `breast_telemetry/v1`. This module computes that exact schema client-side
// and also validates + renders pasted JSON of the same schema.
//
// Pipeline (pure functions over an RGB buffer — no DOM, no models):
//   1. YCrCb skin mask (Cr 130-205, Cb 80-140 — widened for warm light) +
//      morphological close/open. Bright neutrals (blinds, walls) are
//      excluded even when they pass Cr/Cb — they used to let the mound
//      contour flood onto window blinds.
//   2. Nipple seeding, areola-first: local V minima in skin with dark cores
//      (kills the red-lips false positive), scored by dark-core depth and
//      areola-redness (a-channel annulus vs background), ranked by cluster
//      density then redness, refined to the pinkest point (nipple tip).
//      The old HSV dark-red-disk detector locked onto hair; it is gone.
//      Plausibility vetoes: elongated dark cores (finger gaps/wrinkles)
//      and seeds inside a detected face box are rejected; if nothing
//      survives, the pipeline returns null instead of fitting fingers.
//   3. Areola: radial-edge scan from the nipple center on the CIELAB
//      a-channel — 90 rays, steepest negative a-gradient in 30-130px with
//      edge strength < -0.35; median of trimmed radii. (Robust where
//      region-growing floods.)
//   4. Cleavage: darkest vertical shadow at nipple height (mean gray strip
//      +/-6px, boxcar-smoothed, argmin in the x 0.48-0.70 window).
//   5. Mound width: skin-mask run at nipple height containing the nipple,
//      from cleavage_x to run end. Nipple-to-fold: skin column at nipple x,
//      bottom = fabric edge.
//   6. Scale anchor: red nail-polish blobs (HSV red, hand region y>0.6H),
//      median min-area-rect short side; 13mm assumed nail width -> mm/px
//      (flagged +/-25%: the hand sits closer to the lens than the chest).
//   7. Cup: mound-proportion model. Band is not visible in frame, so the
//      verdict is modeled from mound fullness with an assumed band table —
//      firm per the Frame Describe lexicon ("cup size always estimated,
//      never hedged"), method labeled in the output.
//
// Adult-domain instrument: measures breast geometry from torso photos of
// ADULT subjects. No age estimation here; in the workbench it ships
// alongside the age instrument. The adult-subject sanity note is a standing
// reminder, not a gate. Do not apply it to imagery that reads as a minor.

export const SCHEMA = 'breast_telemetry/v1';

// Stated population assumptions (same as the Python prototype).
export const NAIL_MM = 13.0;          // adult female fingernail width, index/middle
export const NIPPLE_SEED_MAX_Y = 0.72; // seeds below this are nail polish, not nipples

/* ---------------- color conversions (OpenCV semantics) ---------------- */

export function ycrcbSkin(r, g, b) {
  const Y = 0.299 * r + 0.587 * g + 0.114 * b;
  const Cr = (r - Y) * 0.713 + 128;
  const Cb = (b - Y) * 0.564 + 128;
  // Widened for warm/incandescent light: measured torso skin hits Cr ~183
  // under warm bulbs, which the old 135-180 band excluded entirely
  // (leaving a Swiss-cheese mask and garbage downstream geometry).
  if (!(Cr >= 130 && Cr <= 205 && Cb >= 80 && Cb <= 140)) return false;
  // Bright neutrals pass the Cr/Cb band (warm-white blinds ~ Cr 135 /
  // Cb 116) and used to let the mound-contour flood leak onto window
  // blinds and walls. Near-white with no chroma is never skin.
  const Vv = Math.max(r, g, b);
  if (Vv > 215 && (Vv - Math.min(r, g, b)) / Vv < 0.20) return false;
  return true;
}

// Returns [h (0-180), s (0-255), v (0-255)] — OpenCV 8-bit HSV.
function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = 60 * ((g - b) / d);
    else if (mx === g) h = 120 + 60 * ((b - r) / d);
    else h = 240 + 60 * ((r - g) / d);
    if (h < 0) h += 360;
  }
  return [h / 2, mx === 0 ? 0 : (d / mx) * 255, mx];
}

const labF = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

// CIELAB a-channel only (D65) — the areola is redder (higher a) than skin.
function labA(r, g, b) {
  let R = r / 255, G = g / 255, B = b / 255;
  R = R > 0.04045 ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
  G = G > 0.04045 ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
  B = B > 0.04045 ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;
  const fx = labF((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const fy = labF(R * 0.2126 + G * 0.7152 + B * 0.0722);
  return 500 * (fx - fy);
}

const grayOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/* ---------------- binary morphology (separable 1D, O(n)) ---------------- */

// Sliding-window min/max over a virtual edge-replicated array. k must be odd.
function slidingWin(src, n, k, isMax) {
  const r = (k - 1) >> 1, N = n + 2 * r;
  const out = new Float64Array(n);
  const dq = new Int32Array(N);
  let qh = 0, qt = 0;
  const get = i => src[i < r ? 0 : (i >= n + r ? n - 1 : i - r)];
  for (let i = 0; i < N; i++) {
    const v = get(i);
    if (isMax) { while (qt > qh && get(dq[qt - 1]) <= v) qt--; }
    else { while (qt > qh && get(dq[qt - 1]) >= v) qt--; }
    dq[qt++] = i;
    while (dq[qh] <= i - k) qh++;
    if (i >= k - 1) out[i - (k - 1)] = get(dq[qh]);
  }
  return out;
}

function morph1D(mask, w, h, k, isMax, horizontal) {
  const out = new Uint8Array(w * h);
  const line = new Float64Array(horizontal ? w : h);
  if (horizontal) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) line[x] = mask[y * w + x];
      const f = slidingWin(line, w, k, isMax);
      for (let x = 0; x < w; x++) out[y * w + x] = f[x] > 0.5 ? 1 : 0;
    }
  } else {
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) line[y] = mask[y * w + x];
      const f = slidingWin(line, h, k, isMax);
      for (let y = 0; y < h; y++) out[y * w + x] = f[y] > 0.5 ? 1 : 0;
    }
  }
  return out;
}

// Ellipse structuring element approximated by horizontal+vertical line passes.
function morphClose(mask, w, h, k) {
  let m = morph1D(mask, w, h, k, true, true);
  m = morph1D(m, w, h, k, true, false);
  m = morph1D(m, w, h, k, false, true);
  m = morph1D(m, w, h, k, false, false);
  return m;
}
function morphOpen(mask, w, h, k) {
  let m = morph1D(mask, w, h, k, false, true);
  m = morph1D(m, w, h, k, false, false);
  m = morph1D(m, w, h, k, true, true);
  m = morph1D(m, w, h, k, true, false);
  return m;
}

/* ---------------- gaussian blur (separable, for the nipple detector) ---------------- */

function gaussianKernel(sigma) {
  const r = Math.ceil(sigma * 3);
  const k = new Float64Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; s += v; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return { k, r };
}

function gaussianBlur(src, w, h, sigma) {
  // src: Float64Array(w*h). Returns blurred Float64Array.
  const { k, r } = gaussianKernel(sigma);
  const tmp = new Float64Array(w * h), out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i < 0 ? 0 : (x + i >= w ? w - 1 : x + i);
        s += src[y * w + xx] * k[i + r];
      }
      tmp[y * w + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i < 0 ? 0 : (y + i >= h ? h - 1 : y + i);
        s += tmp[yy * w + x] * k[i + r];
      }
      out[y * w + x] = s;
    }
  }
  return out;
}

// 2D minimum filter via two 1D passes (reuses slidingWin).
function minimumFilter2D(src, w, h, k) {
  const tmp = new Float64Array(w * h), out = new Float64Array(w * h);
  const line = new Float64Array(Math.max(w, h));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) line[x] = src[y * w + x];
    const f = slidingWin(line, w, k, false);
    for (let x = 0; x < w; x++) tmp[y * w + x] = f[x];
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = tmp[y * w + x];
    const f = slidingWin(line, h, k, false);
    for (let y = 0; y < h; y++) out[y * w + x] = f[y];
  }
  return out;
}

/* ---------------- connected components + shape utils ---------------- */

export function labelBlobs(mask, w, h, minArea = 0) {
  const labels = new Int32Array(w * h).fill(-1);
  const blobs = [];
  const stack = new Int32Array(w * h);
  let n = 0;
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || labels[s] !== -1) continue;
    let sp = 0, area = 0;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, sx = 0, sy = 0;
    stack[sp++] = s; labels[s] = n;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w, y = (p / w) | 0;
      area++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && labels[p - 1] === -1) { labels[p - 1] = n; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && labels[p + 1] === -1) { labels[p + 1] = n; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && labels[p - w] === -1) { labels[p - w] = n; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && labels[p + w] === -1) { labels[p + w] = n; stack[sp++] = p + w; }
    }
    if (area >= minArea) {
      blobs.push({
        id: n, area,
        bbox: { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 },
        centroid: { x: sx / area, y: sy / area },
      });
    }
    n++;
  }
  return { labels, blobs };
}

// Collect pixel coordinates of one labeled component (for hull/calipers).
function componentPixels(labels, id, w, h) {
  const pts = [];
  for (let p = 0; p < labels.length; p++)
    if (labels[p] === id) pts.push([p % w, (p / w) | 0]);
  return pts;
}

// Ritter's bounding circle — adequate for seed sizing.
function enclosingCircle(pts) {
  const p0 = pts[0];
  let p1 = p0, d1 = -1;
  for (const p of pts) { const d = (p[0] - p0[0]) ** 2 + (p[1] - p0[1]) ** 2; if (d > d1) { d1 = d; p1 = p; } }
  let p2 = p1, d2 = -1;
  for (const p of pts) { const d = (p[0] - p1[0]) ** 2 + (p[1] - p1[1]) ** 2; if (d > d2) { d2 = d; p2 = p; } }
  let cx = (p1[0] + p2[0]) / 2, cy = (p1[1] + p2[1]) / 2;
  let r = Math.sqrt(d2) / 2;
  for (const p of pts) {
    const d = Math.hypot(p[0] - cx, p[1] - cy);
    if (d > r) { const nr = (r + d) / 2, k = (d - r) / (2 * d); cx += (p[0] - cx) * k; cy += (p[1] - cy) * k; r = nr; }
  }
  return { cx, cy, r };
}

// Andrew's monotone chain convex hull.
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// Rotating calipers: minimum-area enclosing rectangle of a convex polygon.
// Returns {w, h} (w >= h).
function minAreaRect(hull) {
  const n = hull.length;
  if (n === 0) return { w: 0, h: 0 };
  if (n === 1) return { w: 0, h: 0 };
  if (n === 2) return { w: Math.hypot(hull[1][0] - hull[0][0], hull[1][1] - hull[0][1]), h: 0 };
  let best = Infinity, bw = 0, bh = 0;
  for (let i = 0; i < n; i++) {
    const a = hull[i], b = hull[(i + 1) % n];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const ca = Math.cos(-ang), sa = Math.sin(-ang);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const q of hull) {
      const x = q[0] * ca - q[1] * sa, y = q[0] * sa + q[1] * ca;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const W = x1 - x0, H = y1 - y0, area = W * H;
    if (area < best) { best = area; bw = Math.max(W, H); bh = Math.min(W, H); }
  }
  return { w: bw, h: bh };
}

const median = xs => {
  const s = xs.slice().sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const percentile = (xs, q) => {
  const s = xs.slice().sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = (q / 100) * (s.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const r1 = v => Math.round(v * 10) / 10;

/* ---------------- pipeline stages ---------------- */

export function skinMask(rgb, w, h) {
  const mask = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < mask.length; i++, j += 3)
    if (ycrcbSkin(rgb[j], rgb[j + 1], rgb[j + 2])) mask[i] = 1;
  return mask;
}

// Plausibility veto over nipple-seed minima blobs (exported for tests).
// Drops elongated dark cores (finger gaps, wrinkles, mouth lines — a
// nipple's dark dimple is compact; the 3:1 bar is generous to
// shadow-streaked nipples and still kills finger creases at 5:1+) and
// anything inside a detected face box (faces: [[x1,y1,x2,y2],...] or
// [{bbox:[x1,y1,x2,y2]}]). Returns {kept, vetoed}.
export function vetoSeedBlobs(blobs, faces) {
  let vetoed = 0;
  const kept = [];
  for (const b of blobs) {
    const bw = b.bbox.w, bh = b.bbox.h;
    if (Math.max(bw, bh) / Math.max(Math.min(bw, bh), 1) > 3) { vetoed++; continue; }
    if (faces && faces.length) {
      const fcx = b.centroid.x, fcy = b.centroid.y;
      let inFace = false;
      for (const f of faces) {
        const bb = f.bbox || f; // [x1, y1, x2, y2]
        const ex = (bb[2] - bb[0]) * 0.12, ey = (bb[3] - bb[1]) * 0.12;
        if (fcx >= bb[0] - ex && fcx <= bb[2] + ex &&
            fcy >= bb[1] - ey && fcy <= bb[3] + ey) { inFace = true; break; }
      }
      if (inFace) { vetoed++; continue; }
    }
    kept.push(b);
  }
  return { kept, vetoed };
}

// Nipple seeding, areola-first (replaces the HSV dark-red-disk detector,
// which locked onto dark red-brown hair — e.g. (630,20) in hair on the
// Annie close-up vs the true nipple at (286,881)).
//   1. Local V (value) minima inside skin with elevated redness: the nipple
//      is a dark dimple; red lips fail here (no dark core, dV ~ 10).
//   2. Each minimum is scored by dark-core depth (dV = ring V - core V > 12)
//      and areola-redness (a-channel annulus 20-60px vs background 80-130px).
//   3. Rank: local-minimum cluster density first (the nipple/areola complex
//      throws several nearby minima; moles are isolated), then redness.
//   4. Refine: pinkest (max smoothed a-channel, V > 90) point within 60px —
//      the nipple tip. Darkest-pixel refinement was rejected: shadows win.
//   5. Plausibility vetoes (2026-09-19): the seeder locked onto a hand —
//      finger creases are dark V-minima in skin, they cluster like a
//      nipple/areola complex, and a dark window behind inflated their
//      redness. Vetoed candidates: elongated dark cores (finger gaps,
//      wrinkles — a nipple core is compact) and anything inside a detected
//      face box (the workbench passes its SCRFD faces in). When every
//      candidate is vetoed the pipeline fails honestly instead of fitting
//      an ellipse to fingers and reading the cup "firm".
// Validated against both reference photos (lands on the true nipple).
export function detectNipple(rgb, w, h, skin, faces) {
  // faces: optional array of [x1,y1,x2,y2] (or {bbox:[x1,y1,x2,y2]})
  const n = w * h;
  const V = new Float64Array(n), A = new Float64Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const r = rgb[j], g = rgb[j + 1], b = rgb[j + 2];
    V[i] = Math.max(r, g, b);
    A[i] = labA(r, g, b);
  }
  const Vs = gaussianBlur(V, w, h, 4);
  const As = gaussianBlur(A, w, h, 3);

  // skin median a-channel
  const aSkin = [];
  for (let i = 0; i < n; i++) if (skin[i]) aSkin.push(A[i]);
  if (!aSkin.length) return null;
  const medA = median(aSkin);

  // local minima of smoothed V: pixel equals the 31x31 minimum
  const minF = minimumFilter2D(Vs, w, h, 31);
  const pk = new Uint8Array(n);
  for (let y = 20; y < h - 20; y++) {
    for (let x = 20; x < w - 20; x++) {
      const i = y * w + x;
      if (skin[i] && Vs[i] === minF[i] && A[i] > medA + 3) pk[i] = 1;
    }
  }
  const { labels, blobs } = labelBlobs(pk, w, h, 0);

  // Veto pass over the raw minima blobs, before any scoring.
  const { kept, vetoed } = vetoSeedBlobs(blobs, faces);

  const cands = [];
  for (const b of kept) {
    const cx = b.centroid.x, cy = b.centroid.y;
    const coreV = [], ringV = [], annA = [], bgA = [];
    const R = 130;
    for (let dy = -R; dy <= R; dy++) {
      const y = Math.round(cy + dy);
      if (y < 0 || y >= h) continue;
      for (let dx = -R; dx <= R; dx++) {
        const x = Math.round(cx + dx);
        if (x < 0 || x >= w) continue;
        const r2 = dx * dx + dy * dy, i = y * w + x;
        // Independent bins (NOT else-if): ring [15,40) and annulus [20,60)
        // overlap by design, matching the validated prototype.
        if (r2 < 144) coreV.push(V[i]);
        if (r2 >= 225 && r2 < 1600) ringV.push(V[i]);
        if (r2 >= 400 && r2 < 3600) annA.push(A[i]);
        if (r2 >= 6400 && r2 < 16900) bgA.push(A[i]);
      }
    }
    if (!coreV.length || !ringV.length || !annA.length || !bgA.length) continue;
    const dV = median(ringV) - median(coreV);
    const redness = median(annA) - median(bgA);
    if (dV > 12 && redness > 2) cands.push({ x: cx, y: cy, dV, redness });
  }
  if (!cands.length) return { vetoed }; // every candidate vetoed: honest failure, no x/y

  // cluster density: neighbours within 70px
  for (const c of cands) {
    let d = 0;
    for (const o of cands) {
      if (o !== c && Math.hypot(o.x - c.x, o.y - c.y) < 70) d++;
    }
    c.density = d;
  }
  cands.sort((a, b) => b.density - a.density || b.redness - a.redness);
  const win = cands[0];

  // refine: pinkest point within 60px with V > 90
  let bx = win.x, by = win.y, ba = -Infinity;
  for (let dy = -60; dy <= 60; dy++) {
    const y = Math.round(win.y + dy);
    if (y < 0 || y >= h) continue;
    for (let dx = -60; dx <= 60; dx++) {
      if (dx * dx + dy * dy > 3600) continue;
      const x = Math.round(win.x + dx);
      if (x < 0 || x >= w) continue;
      const i = y * w + x;
      if (V[i] > 90 && As[i] > ba) { ba = As[i]; bx = x; by = y; }
    }
  }
  return { x: bx, y: by, areolaSeed: win, vetoed };
}

// Areola: radial-edge scan on the CIELAB a-channel from the nipple center.
export function areolaRadial(rgb, w, h, nx, ny) {
  const hits = []; // {deg, r} per successful ray — feeds the ellipse fit too
  const at = (x, y) => {
    const j = (y * w + x) * 3;
    return labA(rgb[j], rgb[j + 1], rgb[j + 2]);
  };
  const atV = (x, y) => {
    const j = (y * w + x) * 3;
    return rgbToHsv(rgb[j], rgb[j + 1], rgb[j + 2])[2];
  };
  // Nipple reference darkness: the dip we want is the AREOLA edge, not the
  // nipple edge. Sample V over the central disk; a dip only counts when the
  // tissue before it is clearly brighter than the nipple core.
  let nipV = 0, nipN = 0;
  for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
    if (dx * dx + dy * dy > 64) continue;
    const x = Math.round(nx + dx), y = Math.round(ny + dy);
    if (x < 0 || x >= w || y < 0 || y >= h) continue;
    nipV += atV(x, y); nipN++;
  }
  nipV = nipN ? nipV / nipN : 0;
  for (let deg = 0; deg < 360; deg += 4) {
    const dx = Math.cos(deg * Math.PI / 180), dy = Math.sin(deg * Math.PI / 180);
    const prof = [], rs = [];
    for (let r = 12; r < 150; r += 1.5) {
      const x = Math.round(nx + dx * r), y = Math.round(ny + dy * r);
      if (x < 0 || x >= w || y < 0 || y >= h) break;
      prof.push(at(x, y)); rs.push(r);
    }
    if (prof.length < 30) continue;
    const grad = [];
    for (let i = 0; i + 1 < prof.length; i++) grad.push(prof[i + 1] - prof[i]);
    // boxcar smooth width 5
    const sm = grad.map((_, i) => {
      let s = 0, n = 0;
      for (let k = -2; k <= 2; k++) { const ii = i + k; if (ii >= 0 && ii < grad.length) { s += grad[ii]; n++; } }
      return s / n;
    });
    // Innermost qualified dip on this ray wins. The areola boundary is the
    // FIRST sustained redness drop outside the nipple — the old strongest-dip
    // choice latched onto the mound edge on close-ups (giant ellipses, bogus
    // ~60 deg tilts). The old code's (30,130) window is gone — on full-body
    // photos the true edge sits inside 30px and the old floor forced every
    // ray to latch onto mound shadows instead (the giant circles). The nipple
    // V-guard + sustained-drop tests below are what now keeps the nipple
    // edge and texture wiggles out.
    let best = -1;
    for (let i = 0; i < sm.length; i++) {
      const r = rs[i + 1];
      if (r < 12 || r > 130) continue;
      if (sm[i] >= -0.35) continue;
      // sustained? mean a-channel of the 8 samples after the dip must sit
      // well below the 8 before it — kills intra-areola texture wiggles.
      // Plus the pre-dip tissue must be brighter than the nipple core, so a
      // nipple-edge dip (dark on both sides) can't win.
      let pre = 0, pn = 0, post = 0, qn = 0, preV = 0, vn = 0;
      for (let k = 1; k <= 8; k++) {
        if (i - k >= 0) { pre += prof[i - k]; pn++; preV += atV(Math.round(nx + dx * rs[i - k]), Math.round(ny + dy * rs[i - k])); vn++; }
        if (i + 1 + k < prof.length) { post += prof[i + 1 + k]; qn++; }
      }
      if (pn > 0 && qn > 0 && (post / qn) < (pre / pn) - 1.0 && (preV / vn) > nipV + 12) { best = r; break; }
    }
    if (best >= 0) hits.push({ deg, r: best });
  }
  if (hits.length < 8) return null;
  const radii = hits.map(hh => hh.r);
  const lo = percentile(radii, 10), hi = percentile(radii, 90);
  const core = hits.filter(hh => hh.r >= lo && hh.r <= hi);
  const rMed = median(core.map(hh => hh.r));
  return {
    radius_px: rMed,
    diameter_px: rMed * 2,
    rays_used: hits.length,
    iqr: [percentile(radii, 25), percentile(radii, 75)],
    polar: core.map(hh => [hh.deg, r1(hh.r)]), // trimmed (deg, r) pairs for the ellipse fit
  };
}

// Areola ellipse: 2nd-harmonic Fourier fit of the polar boundary r(theta).
// A planar circle viewed at an angle projects to an ellipse, so the fitted
// axis ratio gives the areola's surface tilt (0 = facing the camera) — real
// 3D orientation from a single photo, no extra sampling needed. The major
// axis direction is the tilt axis in the image plane.
export function fitAreolaEllipse(polar, nx, ny) {
  const n = polar.length;
  if (n < 8) return null;
  let r0 = 0, c2 = 0, s2 = 0, cx = 0, cy = 0;
  for (const [deg, r] of polar) {
    const t = deg * Math.PI / 180;
    r0 += r; c2 += r * Math.cos(2 * t); s2 += r * Math.sin(2 * t);
    cx += nx + r * Math.cos(t); cy += ny + r * Math.sin(t);
  }
  r0 /= n; c2 = 2 * c2 / n; s2 = 2 * s2 / n;
  const A = Math.hypot(c2, s2);
  const a = r0 + A, b = Math.max(r0 - A, 1); // a >= b by construction
  let ang = Math.atan2(s2, c2) / 2 * 180 / Math.PI; // direction of widest extent
  ang = ((ang % 180) + 180) % 180;
  const tilt = Math.acos(Math.min(1, b / a)) * 180 / Math.PI;
  return {
    center_x: r1(cx / n), center_y: r1(cy / n),
    semi_major_px: r1(a), semi_minor_px: r1(b),
    major_axis_angle_deg: r1(ang),
    tilt_deg: r1(tilt),
    axis_ratio: Math.round((b / a) * 1000) / 1000,
  };
}

// Breast mound contour: luminance-region boundary, not an edge hunt.
// The mound is the bright skin region around the nipple, bounded by darker
// tissue (cleavage shadow, under-fold shadow, outer falloff). Flood outward
// from the bright mound ring just outside the areola over skin pixels within
// K luminance levels of the ring median; the filled region's outer boundary
// is the contour. Interior holes (moles, the areola itself, hair strands)
// are filled. Backstops keep the region breast-local: rMax (a radius around
// the nipple) and the cleavage wall (never cross the midline into the other
// breast). Where the mound blends into evenly-lit chest the boundary follows
// the light falloff — honest about the indeterminacy.
export function breastContour(rgb, w, h, skin, nx, ny, areolaR, rMax, K = 12, wallX = null, wallSide = 0) {
  const atG = (x, y) => {
    const j = (y * w + x) * 3;
    return grayOf(rgb[j], rgb[j + 1], rgb[j + 2]);
  };
  // reference: median luminance on the bright mound ring outside the areola
  const ring = [];
  const ringXY = [];
  for (let deg = 0; deg < 360; deg += 6) {
    const dx = Math.cos(deg * Math.PI / 180), dy = Math.sin(deg * Math.PI / 180);
    for (let r = areolaR + 8; r < areolaR + 30; r += 4) {
      const x = Math.round(nx + dx * r), y = Math.round(ny + dy * r);
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      ring.push(atG(x, y)); ringXY.push([x, y]);
    }
  }
  if (!ring.length) return [];
  const refL = median(ring);
  const lo = refL - K; // luminance falloff that bounds the mound
  const inBlob = new Uint8Array(w * h);
  const stack = [];
  for (const [x, y] of ringXY) {
    const p = y * w + x;
    if (skin[p] && !inBlob[p] && atG(x, y) >= lo) { inBlob[p] = 1; stack.push(p); }
  }
  const rMax2 = rMax * rMax;
  let count = 0;
  while (stack.length) {
    const p = stack.pop(); count++;
    const x = p % w, y = (p / w) | 0;
    for (const [nx2, ny2] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx2 < 0 || nx2 >= w || ny2 < 0 || ny2 >= h) continue;
      const q = ny2 * w + nx2;
      if (inBlob[q] || !skin[q]) continue;
      const ddx = nx2 - nx, ddy = ny2 - ny;
      if (ddx * ddx + ddy * ddy > rMax2) continue;
      if (wallX !== null && wallSide < 0 && nx2 > wallX) continue; // never cross the cleavage
      if (wallX !== null && wallSide > 0 && nx2 < wallX) continue;
      if (atG(nx2, ny2) < lo) continue;
      inBlob[q] = 1; stack.push(q);
    }
  }
  if (count < 200) return []; // too small to trust
  // hole fill: flood the non-blob background from the frame borders;
  // whatever is neither blob nor background is an interior hole.
  const bg = new Uint8Array(w * h);
  const st2 = [];
  const seedBg = (x, y) => {
    const p = y * w + x;
    if (!inBlob[p] && !bg[p]) { bg[p] = 1; st2.push(p); }
  };
  for (let x = 0; x < w; x++) { seedBg(x, 0); seedBg(x, h - 1); }
  for (let y = 0; y < h; y++) { seedBg(0, y); seedBg(w - 1, y); }
  while (st2.length) {
    const p = st2.pop();
    const x = p % w, y = (p / w) | 0;
    for (const [nx2, ny2] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx2 < 0 || nx2 >= w || ny2 < 0 || ny2 >= h) continue;
      const q = ny2 * w + nx2;
      if (!inBlob[q] && !bg[q]) { bg[q] = 1; st2.push(q); }
    }
  }
  // boundary of the filled region, ordered angularly around its centroid
  let bx = 0, by = 0, bn = 0;
  const bpts = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const filled = inBlob[p] || !bg[p];
      if (!filled) continue;
      if ((inBlob[p - 1] || !bg[p - 1]) && (inBlob[p + 1] || !bg[p + 1]) &&
          (inBlob[p - w] || !bg[p - w]) && (inBlob[p + w] || !bg[p + w])) continue;
      bpts.push([x, y]); bx += x; by += y; bn++;
    }
  }
  if (bn < 12) return [];
  bx /= bn; by /= bn;
  bpts.sort((p1, p2) =>
    Math.atan2(p1[1] - by, p1[0] - bx) - Math.atan2(p2[1] - by, p2[0] - bx));
  // light circular smoothing (width 5) — kills flat-light scribble
  const sm2 = bpts.map((_, i) => {
    let sx = 0, sy = 0;
    for (let k = -2; k <= 2; k++) {
      const q = bpts[(i + k + bpts.length) % bpts.length];
      sx += q[0]; sy += q[1];
    }
    return [sx / 5, sy / 5];
  });
  // drop backstop-limited points: boundary riding the rMax circle is the
  // flood hitting the radius limit, not anatomy. The contour stays honestly
  // open where the light gives no boundary (typically the top in flat light).
  const kept = sm2.filter(([qx, qy]) => Math.hypot(qx - nx, qy - ny) <= rMax * 0.97);
  if (kept.length < 12) return [];
  const step = Math.max(1, Math.floor(kept.length / 240));
  const pts = [];
  for (let i = 0; i < kept.length; i += step) pts.push({ x: r1(kept[i][0]), y: r1(kept[i][1]) });
  return pts;
}

// Fold curve: the existing single-column bottom-skin scan, extended across
// the breast's horizontal extent. Per column, the first skin pixel from the
// bottom — the boundary may be the fold, a garment edge, or the frame edge.
function foldCurve(skin, w, h, x0, x1) {
  const pts = [];
  const lo = Math.max(0, Math.round(x0)), hi = Math.min(w - 1, Math.round(x1));
  for (let x = lo; x <= hi; x += 8) {
    let yb = -1;
    for (let y = h - 1; y >= 0; y--) if (skin[y * w + x]) { yb = y; break; }
    if (yb >= 0) pts.push([x, yb]);
  }
  return pts;
}

// Cleavage: darkest vertical shadow at nipple height, x in [0.48W, 0.70W].
function cleavageX(rgb, w, h, ny) {
  const y = Math.round(ny);
  const x0 = Math.round(w * 0.483), x1 = Math.round(w * 0.700);
  const strip = [];
  for (let x = x0; x <= x1; x++) {
    let s = 0, n = 0;
    for (let dy = -6; dy <= 6; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      const j = (yy * w + x) * 3;
      s += grayOf(rgb[j], rgb[j + 1], rgb[j + 2]); n++;
    }
    strip.push(s / n);
  }
  const sm = strip.map((_, i) => {
    let s = 0, n = 0;
    for (let k = -7; k <= 7; k++) { const ii = i + k; if (ii >= 0 && ii < strip.length) { s += strip[ii]; n++; } }
    return s / n;
  });
  let bi = 25, bv = Infinity;
  for (let i = 25; i < sm.length - 25; i++) if (sm[i] < bv) { bv = sm[i]; bi = i; }
  return x0 + bi;
}

// Skin-mask runs along one row (gap tolerance 3px, like the prototype).
function rowRuns(skin, w, y) {
  const runs = [];
  let cur = null;
  for (let x = 0; x < w; x++) {
    if (skin[y * w + x]) {
      if (cur && x > cur[1] + 3) { runs.push(cur); cur = null; }
      if (!cur) cur = [x, x]; else cur[1] = x;
    }
  }
  if (cur) runs.push(cur);
  return runs;
}

// Scale anchors, best-first chain: red nails (larger, more robust) ->
// barbell ball (chest plane, no perspective error, but tiny) ->
// manual (null). The old code measured the areola as a "nail"; the nipple
// zone is now excluded from nail search.
function nailAnchor(rgb, w, h, nx, ny) {
  let red = new Uint8Array(w * h);
  const yHand = Math.floor(h * 0.6);
  for (let y = yHand; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - nx, dy = y - ny;
      if (dx * dx + dy * dy < 150 * 150) continue; // not the areola
      const p = y * w + x, j = p * 3;
      const [hh, ss, vv] = rgbToHsv(rgb[j], rgb[j + 1], rgb[j + 2]);
      if ((hh <= 8 || hh >= 172) && ss > 90 && vv > 40) red[p] = 1;
    }
  }
  red = morphClose(red, w, h, 5);
  const { labels, blobs } = labelBlobs(red, w, h, 0);
  const widths = [];
  for (const b of blobs) {
    if (b.area < 150 || b.area > 1500) continue;
    const bw = b.bbox.w, bh = b.bbox.h;
    if (Math.max(bw, bh) / Math.max(Math.min(bw, bh), 1) > 3) continue;
    const hull = convexHull(componentPixels(labels, b.id, w, h));
    const short = minAreaRect(hull).h;
    if (short > 0) widths.push({ short, x: b.centroid.x, y: b.centroid.y });
  }
  // A median of one sample isn't a median: single-blob nail reads (warm light
  // merging nail with finger) produced absurd mm/px. Require >= 2.
  if (widths.length < 2) return null;
  widths.sort((a, b) => a.short - b.short);
  return {
    kind: 'nail',
    widths_px: widths.map(v => r1(v.short)),
    median_width_px: r1(median(widths.map(v => v.short))),
    n: widths.length,
  };
}

export const BARBELL_BALL_MM = 5.0; // 14G standard nipple barbell ball

// Barbell anchor: pair of small metallic blobs (bright, desaturated) near the
// nipple, midpoint within 30px of the nipple, separation 20-80px.
// Ball diameter in px -> 5.0mm assumed (14G standard; labeled, not certain).
function barbellAnchor(rgb, w, h, nx, ny) {
  const n = w * h;
  let met = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - nx, dy = y - ny;
      if (dx * dx + dy * dy > 120 * 120) continue;
      const j = (y * w + x) * 3;
      const r = rgb[j], g = rgb[j + 1], b = rgb[j + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      if (mx > 180 && sat < 0.35) met[y * w + x] = 1;
    }
  }
  met = morphOpen(met, w, h, 3);
  const { blobs } = labelBlobs(met, w, h, 0);
  const balls = blobs
    .filter(b => b.area >= 8 && b.area <= 200)
    .map(b => ({ x: b.centroid.x, y: b.centroid.y, d: 2 * Math.sqrt(b.area / Math.PI) }));
  for (let i = 0; i < balls.length; i++) {
    for (let k = i + 1; k < balls.length; k++) {
      const a = balls[i], b = balls[k];
      const sep = Math.hypot(a.x - b.x, a.y - b.y);
      if (sep < 20 || sep > 80) continue;
      const mxp = (a.x + b.x) / 2, myp = (a.y + b.y) / 2;
      if (Math.hypot(mxp - nx, myp - ny) > 30) continue;
      const ballPx = (a.d + b.d) / 2;
      return {
        kind: 'barbell',
        ball_diameter_px: r1(ballPx),
        mm_per_px: BARBELL_BALL_MM / ballPx,
      };
    }
  }
  return null;
}

// Cup verdict from mound fullness (scale-free): width / nipple-to-fold.
function cupVerdict(moundWpx, nippleToFoldPx) {
  const fullness = moundWpx / Math.max(nippleToFoldPx, 1);
  const order = ['A', 'B', 'C', 'D', 'DD', 'DDD'];
  let v = 'A';
  if (fullness >= 2.2) v = 'DD';
  else if (fullness >= 1.9) v = 'D';
  else if (fullness >= 1.6) v = 'C';
  else if (fullness >= 1.3) v = 'B';
  // sister-size the assumed band table: +2 band inches ~= one cup letter down.
  // (Matches the reference table: 32:DD, 34:D/DD, 36:D.)
  const soften = (letter, steps) => {
    const i = Math.max(1, order.indexOf(letter));
    return steps === 1 ? order[i - 1] + '/' + letter : order[i - 1];
  };
  return { verdict: v, fullness, band_table: { 32: v, 34: soften(v, 1), 36: soften(v, 2) } };
}

/* ---------------- main measurement: breast_telemetry/v1 ---------------- */

export function measureBreastTelemetry(rgb, w, h, sourceName, faces) {
  // rgb: Float32Array/Uint8Array/Buffer of RGB bytes, length w*h*3.
  // faces: optional [[x1,y1,x2,y2],...] from the workbench's face detector —
  //   nipple seeds inside a face box are vetoed (see detectNipple).
  // Returns the exact breast_telemetry/v1 schema object, or null when the
  // pipeline cannot resolve the required landmarks.
  if (!rgb || rgb.length < w * h * 3) return null;

  // 1. skin mask
  let skin = skinMask(rgb, w, h);
  skin = morphClose(skin, w, h, 9);
  skin = morphOpen(skin, w, h, 9);

  // 2. nipple seed (areola-first; the old HSV dark-red-disk detector is gone —
  //    it locked onto hair). x == null means every candidate was vetoed as
  //    non-anatomical — fail honestly, don't fit fingers.
  const nip = detectNipple(rgb, w, h, skin, faces);
  if (nip.x == null) return null;
  const nx = nip.x, ny = nip.y;
  const seedVetoes = nip.vetoed || 0;

  // 3. areola radial-edge fit
  const ar = areolaRadial(rgb, w, h, nx, ny);
  if (!ar) return null;

  // 4. cleavage shadow at nipple height
  const cx = cleavageX(rgb, w, h, ny);

  // 5. mound cross-section at nipple height
  const yRow = Math.max(0, Math.min(h - 1, Math.round(ny)));
  const runs = rowRuns(skin, w, yRow);
  const run = runs.find(r => r[0] <= nx && nx <= r[1]);
  if (!run) return null;
  const xOuter = run[1];
  const moundWpx = xOuter - cx;

  // nipple-to-fold: skin column at nipple x, bottom = fabric edge
  const xCol = Math.max(0, Math.min(w - 1, Math.round(nx)));
  let yTop = -1, yBot = -1;
  for (let y = 0; y < h; y++) if (skin[y * w + xCol]) { yTop = y; break; }
  for (let y = h - 1; y >= 0; y--) if (skin[y * w + xCol]) { yBot = y; break; }
  if (yTop < 0 || yBot < 0 || yBot <= ny) return null;
  const nippleToFoldPx = yBot - ny;

  // 5b. areola ellipse — 3D surface tilt from the polar boundary fit
  const ell = fitAreolaEllipse(ar.polar, nx, ny);

  // 5c. breast mound contour — luminance-region boundary around the nipple
  const rMaxC = Math.min(Math.max(w, h), Math.round(nippleToFoldPx * 1.15));
  const wallSide = nx < cx ? -1 : 1; // breast sits on the nipple's side of the cleavage
  const contour = breastContour(rgb, w, h, skin, nx, ny, ar.radius_px, rMaxC,
    12, cx - wallSide * 12, wallSide);

  // 5d. fold curve across the contour's horizontal extent
  // (fallback when the contour is sparse: nipple ± 1.5 areola diameters)
  let fx0 = nx - ar.diameter_px * 1.5, fx1 = nx + ar.diameter_px * 1.5;
  if (contour.length >= 8) {
    const cxs = contour.map(p => p.x);
    fx0 = Math.min(...cxs); fx1 = Math.max(...cxs);
  }
  const foldC = foldCurve(skin, w, h, fx0, fx1);

  // 6. scale anchor chain: barbell (chest plane) -> nails (hand plane) -> manual
  const barb = barbellAnchor(rgb, w, h, nx, ny);
  const nail = nailAnchor(rgb, w, h, nx, ny);
  let mmPerPx = null, scaleMethod = 'manual_required', scaleAssumption = '',
      scaleCaveat = 'no automatic anchor resolved; set mm/px manually in the workbench';
  const anchors = {};
  if (barb) {
    anchors.barbell = {
      ball_diameter_px: barb.ball_diameter_px,
      assumed_ball_mm: BARBELL_BALL_MM,
      mm_per_px: Math.round(barb.mm_per_px * 10000) / 10000,
    };
  }
  if (nail) {
    anchors.nails = {
      widths_px: nail.widths_px,
      median_width_px: nail.median_width_px,
      assumed_nail_mm: NAIL_MM,
      mm_per_px: Math.round((NAIL_MM / nail.median_width_px) * 10000) / 10000,
    };
  }
  // Nails are primary (larger target, more robust). Barbell is fallback-only:
  // at typical phone-photo distances the ball is a few px and the highlight
  // undermeasures it, so a barbell reading that disagrees with nails is
  // not trusted. Barbell requires >= 6px balls to be usable at all.
  if (nail) {
    mmPerPx = NAIL_MM / nail.median_width_px;
    scaleMethod = 'nail_anchor';
    scaleAssumption = 'adult female fingernail width = ' + NAIL_MM.toFixed(1) + 'mm (population mean, index/middle)';
    scaleCaveat = 'hand likely 3-8cm closer to lens than chest plane; physical values skew small. treat as +-25%.';
  } else if (barb && barb.ball_diameter_px >= 6) {
    mmPerPx = barb.mm_per_px;
    scaleMethod = 'barbell_ball';
    scaleAssumption = 'nipple barbell ball = ' + BARBELL_BALL_MM.toFixed(1) + 'mm (14G standard; gauge not verified from image)';
    scaleCaveat = 'ball is small in frame; diameter error dominates. chest plane: no perspective correction needed.';
  }
  const mm = px => mmPerPx == null ? null : r1(px * mmPerPx);

  // left breast: skin run at nipple height containing x ~ 0.30W (truncated)
  const lrun = runs.find(r => r[0] <= w * 0.30 && w * 0.30 <= r[1]);
  const left_breast = lrun
    ? {
        visible_from_x: 0,
        visible_to_x: lrun[1],
        visible_width_px: lrun[1],
        truncated: true,
        note: 'mound cut by frame edge; nipple sliver visible at left edge',
      }
    : { note: 'not resolved' };

  // 7. cup verdict (modeled; band unseen)
  const cup = cupVerdict(moundWpx, nippleToFoldPx);
  const bt = {};
  for (const [k, v] of Object.entries(cup.band_table)) bt[k] = v;

  const areolaConf = ar.rays_used >= 40 ? 'high' : 'medium';
  return {
    schema: SCHEMA,
    source: sourceName || 'upload',
    image: { w, h },
    measured_px: {
      right_nipple: { x: r1(nx), y: r1(ny) },
      right_areola_diameter_px: r1(ar.diameter_px),
      right_areola_ellipse: ell,
      right_breast_contour_px: contour.map(p => [p.x, p.y]),
      right_fold_curve_px: foldC,
      right_mound_width_px: Math.round(moundWpx),
      right_nipple_to_fold_px: Math.round(nippleToFoldPx),
      right_fold_y_px: yBot,
      cleavage_x_at_nipple_height_px: cx,
      nail_anchor_median_width_px: nail ? r1(nail.median_width_px) : null,
      barbell_ball_diameter_px: barb ? barb.ball_diameter_px : null,
    },
    scale_model: {
      method: scaleMethod,
      assumption: scaleAssumption,
      mm_per_px: mmPerPx == null ? null : Math.round(mmPerPx * 10000) / 10000,
      caveat: scaleCaveat,
      anchors_detected: anchors,
    },
    modeled_physical: {
      right_areola_diameter_mm: mm(ar.diameter_px),
      right_areola_ellipse_axes_mm: mmPerPx == null || !ell
        ? null : [r1(ell.semi_major_px * mmPerPx), r1(ell.semi_minor_px * mmPerPx)],
      right_breast_contour_mm: mmPerPx == null
        ? null : contour.map(p => [r1(p.x * mmPerPx), r1(p.y * mmPerPx)]),
      right_fold_curve_mm: mmPerPx == null
        ? null : foldC.map(([qx, qy]) => [r1(qx * mmPerPx), r1(qy * mmPerPx)]),
      right_mound_width_mm: mm(moundWpx),
      right_nipple_to_fold_mm: mm(nippleToFoldPx),
    },
    left_breast,
    cup_estimate: {
      method: 'mound-proportion model: bra cup ~ bust-underbust; underbust not visible in frame, so band is ASSUMED and cup derived from mound fullness class',
      assumption: 'slim torso build (visible wrist/hand scale); band 32-34',
      verdict: cup.verdict,
      band_table: bt,
      note: 'firm read per lexicon: mound fullness class ' + cup.verdict +
        ' (width/fold ratio ' + cup.fullness.toFixed(2) +
        '); camera angle unmodeled — apparent volume shifts with viewpoint.' +
        (seedVetoes > 0
          ? ' ' + seedVetoes + ' rival nipple candidate' + (seedVetoes === 1 ? '' : 's') +
            ' rejected as non-anatomical (elongated dark core, or inside a detected face box).'
          : ''),
    },
    confidence: {
      areola_diameter: areolaConf + ' (' + ar.rays_used + ' radial rays, IQR ' +
        Math.round(ar.iqr[0]) + '-' + Math.round(ar.iqr[1]) + 'px)',
      areola_ellipse: ell
        ? 'medium (axis ratio ' + ell.axis_ratio + ' -> tilt ~' + Math.round(ell.tilt_deg) +
          ' deg from camera axis; assumes a planar circular areola — tilts under ~15 deg are noise)'
        : 'not resolved',
      breast_contour: contour.length >= 8
        ? 'medium (' + contour.length + ' mound-region boundary points over ' + Math.round(fx1 - fx0) +
          'px; open where the light gives no boundary — typically the top in flat light)'
        : 'not resolved (mound luminance region too small or fragmented)',
      fold_curve: foldC.length + ' columns over ' + Math.round(fx1 - fx0) +
        'px; boundary may be fold, garment edge, or frame edge',
      mound_width: 'medium (' + runs.length + ' skin run' + (runs.length === 1 ? '' : 's') +
        ' at nipple height; outer edge ' +
        (run[1] >= w - 2 ? 'at frame edge (may undermeasure)' : 'resolved in frame') + ')',
      nipple_to_fold: 'medium-high (' + Math.round(nippleToFoldPx) +
        'px nipple to lower skin boundary at y=' + yBot +
        '; boundary may be fold, garment edge, or frame edge)',
      physical_mm: mmPerPx == null
        ? 'unresolved (no automatic anchor; set scale manually)'
        : 'low-medium (' + scaleMethod + '; ' + scaleCaveat + ')',
      cup: 'modeled (band unseen; verdict firm per standing lexicon, method labeled)',
      left_breast: lrun ? 'low (truncated by frame)' : 'not resolved',
    },
  };
}

/* ---------------- schema validation (paste-JSON import) ---------------- */

const NUM = v => typeof v === 'number' && isFinite(v);

export function validateBreastTelemetry(obj) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  const arr2 = a => Array.isArray(a) &&
    a.every(p => Array.isArray(p) && p.length === 2 && NUM(p[0]) && NUM(p[1]));
  need(obj && typeof obj === 'object', 'not a JSON object');
  if (!obj || typeof obj !== 'object') return { ok: false, errors };
  need(obj.schema === SCHEMA, 'schema must be "' + SCHEMA + '" (got ' + JSON.stringify(obj.schema) + ')');
  need(typeof obj.source === 'string', 'missing source');
  need(obj.image && NUM(obj.image.w) && NUM(obj.image.h), 'missing image.{w,h}');
  const mp = obj.measured_px || {};
  need(mp.right_nipple && NUM(mp.right_nipple.x) && NUM(mp.right_nipple.y), 'missing measured_px.right_nipple.{x,y}');
  for (const k of ['right_areola_diameter_px', 'right_mound_width_px', 'right_nipple_to_fold_px',
    'right_fold_y_px', 'cleavage_x_at_nipple_height_px'])
    need(NUM(mp[k]), 'missing measured_px.' + k);
  const el = mp.right_areola_ellipse || {};
  need(NUM(el.center_x) && NUM(el.center_y) && NUM(el.semi_major_px) && NUM(el.semi_minor_px) &&
    NUM(el.major_axis_angle_deg) && NUM(el.tilt_deg) && NUM(el.axis_ratio),
    'incomplete measured_px.right_areola_ellipse');
  need(arr2(mp.right_breast_contour_px), 'measured_px.right_breast_contour_px must be [[x,y],...]');
  need(arr2(mp.right_fold_curve_px), 'measured_px.right_fold_curve_px must be [[x,y],...]');
  need(mp.nail_anchor_median_width_px == null || NUM(mp.nail_anchor_median_width_px),
    'measured_px.nail_anchor_median_width_px must be a number or null');
  need(mp.barbell_ball_diameter_px == null || NUM(mp.barbell_ball_diameter_px),
    'measured_px.barbell_ball_diameter_px must be a number or null');
  const sm = obj.scale_model || {};
  need(typeof sm.method === 'string' && typeof sm.assumption === 'string' &&
    (sm.mm_per_px == null || NUM(sm.mm_per_px)) && typeof sm.caveat === 'string' &&
    sm.anchors_detected && typeof sm.anchors_detected === 'object', 'incomplete scale_model');
  const ph = obj.modeled_physical || {};
  for (const k of ['right_areola_diameter_mm', 'right_mound_width_mm', 'right_nipple_to_fold_mm'])
    need(ph[k] == null || NUM(ph[k]), 'modeled_physical.' + k + ' must be a number or null');
  need(ph.right_areola_ellipse_axes_mm == null ||
    (Array.isArray(ph.right_areola_ellipse_axes_mm) && ph.right_areola_ellipse_axes_mm.length === 2 &&
      NUM(ph.right_areola_ellipse_axes_mm[0]) && NUM(ph.right_areola_ellipse_axes_mm[1])),
    'modeled_physical.right_areola_ellipse_axes_mm must be [a,b] or null');
  need(ph.right_breast_contour_mm == null || arr2(ph.right_breast_contour_mm),
    'modeled_physical.right_breast_contour_mm must be [[x,y],...] or null');
  need(ph.right_fold_curve_mm == null || arr2(ph.right_fold_curve_mm),
    'modeled_physical.right_fold_curve_mm must be [[x,y],...] or null');
  need(obj.left_breast && typeof obj.left_breast === 'object', 'missing left_breast');
  const ce = obj.cup_estimate || {};
  need(ce.method && ce.assumption && typeof ce.verdict === 'string' && ce.band_table && ce.note,
    'incomplete cup_estimate');
  const cf = obj.confidence || {};
  for (const k of ['areola_diameter', 'areola_ellipse', 'breast_contour', 'fold_curve',
    'mound_width', 'nipple_to_fold', 'physical_mm', 'cup', 'left_breast'])
    need(typeof cf[k] === 'string', 'missing confidence.' + k);
  return { ok: errors.length === 0, errors };
}

/* ---------------- body-pose cross-check ---------------- */

// Validates the measured breast landmarks against a MediaPipe pose skeleton
// (33 normalized landmarks, {x, y, visibility}). Pure function — the
// workbench runs it after measureBreastTelemetry and refuses the read on a
// hard failure, so an anatomically impossible seed (a hand, the background)
// can never ship with a "firm" cup verdict.
//
// Degrades gracefully per-check: each check only runs when the landmarks it
// needs are visible (>= 0.5). applicable=false means the pose couldn't say
// anything (no pose, shoulders unseen) — not a pass, not a fail.
const PLM = { l_shoulder: 11, r_shoulder: 12, l_elbow: 13, r_elbow: 14,
              l_wrist: 15, r_wrist: 16, l_hip: 23, r_hip: 24 };

export function poseCrossCheck(rep, pose, w, h) {
  const out = { applicable: false, passed: true, failures: [], warnings: [],
                reason: null, torso: null };
  if (!pose || pose.length < 33) { out.reason = 'no pose landmarks'; return out; }
  const mp = rep && rep.measured_px;
  if (!mp || !mp.right_nipple || !isFinite(mp.right_nipple.x) || !isFinite(mp.right_nipple.y)) {
    out.reason = 'no breast report to check'; return out;
  }
  const vis = i => pose[i] && (pose[i].visibility ?? 0) >= 0.5;
  const PX = i => ({ x: pose[i].x * w, y: pose[i].y * h });
  if (!vis(PLM.l_shoulder) || !vis(PLM.r_shoulder)) {
    out.reason = 'shoulders not reliably detected'; return out;
  }
  out.applicable = true;
  const sL = PX(PLM.l_shoulder), sR = PX(PLM.r_shoulder);
  const shY = (sL.y + sR.y) / 2;
  const shW = Math.hypot(sL.x - sR.x, sL.y - sR.y);
  const shX0 = Math.min(sL.x, sR.x), shX1 = Math.max(sL.x, sR.x);
  const nx = mp.right_nipple.x, ny = mp.right_nipple.y;
  const aboveLine = shY - 0.25 * shW;   // generous: breast tissue never clears the shoulders

  // 1. shoulder line (hard): the nipple sits below the shoulder girdle, always.
  if (ny < aboveLine)
    out.failures.push('nipple seed is above the shoulder line — anatomically impossible');

  // 2. hand/arm proximity (hard): the classic misfire is a seed locked onto a
  //    curled hand — finger creases pass the dark-core gates. A true nipple is
  //    never within a third of a shoulder-width of a wrist or elbow.
  const limbs = [PLM.l_wrist, PLM.r_wrist, PLM.l_elbow, PLM.r_elbow]
    .filter(vis).map(PX);
  for (const p of limbs) {
    if (Math.hypot(nx - p.x, ny - p.y) < 0.30 * shW) {
      out.failures.push('nipple seed within 0.30 shoulder-widths of a hand/arm landmark — likely locked onto a hand, not a breast');
      break;
    }
  }

  // 3. torso band (hard, needs hips): the seed must sit between the shoulder
  //    line and the hip line, inside the torso's lateral span.
  let hipY = null, torsoLen = null;
  if (vis(PLM.l_hip) && vis(PLM.r_hip)) {
    const hL = PX(PLM.l_hip), hR = PX(PLM.r_hip);
    hipY = (hL.y + hR.y) / 2;
    torsoLen = hipY - shY;
    if (torsoLen > 1) {
      if (ny > hipY + 0.30 * torsoLen)
        out.failures.push('nipple seed below the torso band (past the hip line)');
      if (nx < shX0 - 0.6 * shW || nx > shX1 + 0.6 * shW)
        out.failures.push('nipple seed outside the torso width');
    }
  }
  out.torso = { shoulder_y_px: r1(shY), shoulder_width_px: r1(shW),
                hip_y_px: hipY == null ? null : r1(hipY),
                torso_len_px: torsoLen == null ? null : r1(torsoLen) };

  // 4. contour leak (soft): the mound boundary lives on the torso. If a big
  //    share of it sits above the shoulder line, the flood leaked onto the
  //    background (the window-blind failure class).
  const contour = mp.right_breast_contour_px || [];
  if (contour.length >= 8) {
    const above = contour.filter(p => p[1] < aboveLine).length;
    if (above / contour.length > 0.30)
      out.warnings.push(Math.round(above / contour.length * 100) +
        '% of the breast contour sits above the shoulder line — possible background leak');
  }

  out.passed = out.failures.length === 0;
  return out;
}

/* ---------------- browser overlay (workbench preview) ---------------- */

export function drawBreastOverlay(canvas, img, rep) {
  if (typeof document === 'undefined' || !rep || rep.schema !== SCHEMA) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width = img.naturalWidth || img.width;
  const h = canvas.height = img.naturalHeight || img.height;
  ctx.drawImage(img, 0, 0, w, h);
  const mp = rep.measured_px;
  const sx = w / rep.image.w, sy = h / rep.image.h;
  const X = v => v * sx, Y = v => v * sy;
  const ny = Y(mp.right_nipple.y);
  ctx.lineWidth = Math.max(2, w / 400);
  // areola ellipse fit (magenta) — supersedes the old median circle; the
  // squash encodes the areola's 3D tilt away from the camera
  const el = mp.right_areola_ellipse;
  if (el) {
    ctx.strokeStyle = '#f0f';
    ctx.beginPath();
    ctx.ellipse(X(el.center_x), Y(el.center_y),
      el.semi_major_px * sx, el.semi_minor_px * sy,
      el.major_axis_angle_deg * Math.PI / 180, 0, 7);
    ctx.stroke();
  }
  // nipple dot
  ctx.fillStyle = '#f00';
  ctx.beginPath();
  ctx.arc(X(mp.right_nipple.x), ny, Math.max(3, w / 250), 0, 7);
  ctx.fill();
  // breast silhouette contour (orange) — break the path where points jump,
  // so open sections don't get bridged by straight lines
  const bc = mp.right_breast_contour_px || [];
  ctx.strokeStyle = '#fa0';
  ctx.lineWidth = Math.max(2, w / 500);
  ctx.beginPath();
  let bx0 = null, by0 = null;
  for (const [qx, qy] of bc) {
    const Xq = X(qx), Yq = Y(qy);
    if (bx0 === null || Math.hypot(Xq - bx0, Yq - by0) > 40 * sx) ctx.moveTo(Xq, Yq);
    else ctx.lineTo(Xq, Yq);
    bx0 = Xq; by0 = Yq;
  }
  ctx.stroke();
  ctx.lineWidth = Math.max(2, w / 400);
  // cleavage vertical
  ctx.strokeStyle = '#ff0';
  ctx.beginPath();
  ctx.moveTo(X(mp.cleavage_x_at_nipple_height_px), ny - 40 * sy);
  ctx.lineTo(X(mp.cleavage_x_at_nipple_height_px), ny + 40 * sy);
  ctx.stroke();
  // mound width horizontal (cleavage -> outer edge)
  ctx.strokeStyle = '#0ff';
  ctx.beginPath();
  ctx.moveTo(X(mp.cleavage_x_at_nipple_height_px), ny);
  ctx.lineTo(X(mp.cleavage_x_at_nipple_height_px + mp.right_mound_width_px), ny);
  ctx.stroke();
  // fold curve (green polyline) — supersedes the old straight fold line
  const fc = mp.right_fold_curve_px || [];
  ctx.strokeStyle = '#0f0';
  ctx.beginPath();
  fc.forEach(([qx, qy], i) => {
    const Xq = X(qx), Yq = Y(qy);
    if (i) ctx.lineTo(Xq, Yq); else ctx.moveTo(Xq, Yq);
  });
  ctx.stroke();
  ctx.font = 'bold 13px sans-serif';
  ctx.fillStyle = '#ff0';
  ctx.fillText('cleavage ' + mp.cleavage_x_at_nipple_height_px + 'px',
    X(mp.cleavage_x_at_nipple_height_px) + 6, ny - 46 * sy);
  ctx.fillStyle = '#0ff';
  ctx.fillText('mound ' + mp.right_mound_width_px + 'px',
    X(mp.cleavage_x_at_nipple_height_px) + 6, ny + 20 * sy);
  if (el) {
    ctx.fillStyle = '#f0f';
    ctx.fillText('tilt ~' + Math.round(el.tilt_deg) + '°',
      X(el.center_x) + el.semi_major_px * sx + 6, Y(el.center_y) + 4);
  }
}
