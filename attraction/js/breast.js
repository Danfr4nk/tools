// breast.js — breast telemetry instrument for the attraction workbench.
//
// JS port of the ~/workspace/breast-telemetry/ prototype (measure2.py /
// measure3.py / measure4.py), which produced the FIXED schema
// `breast_telemetry/v1`. This module computes that exact schema client-side
// and also validates + renders pasted JSON of the same schema.
//
// Pipeline (pure functions over an RGB buffer — no DOM, no models):
//   1. YCrCb skin mask (Cr 135-180, Cb 85-135) + morphological close/open.
//   2. Nipple seeds: HSV dark-red disks (H 0-12, S>50, V 20-160) inside skin,
//      area 150-3000px, y < 0.72*H (rejects red nail polish). Largest wins.
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

function ycrcbSkin(r, g, b) {
  const Y = 0.299 * r + 0.587 * g + 0.114 * b;
  const Cr = (r - Y) * 0.713 + 128;
  const Cb = (b - Y) * 0.564 + 128;
  return Cr >= 135 && Cr <= 180 && Cb >= 85 && Cb <= 135;
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

function skinMask(rgb, w, h) {
  const mask = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < mask.length; i++, j += 3)
    if (ycrcbSkin(rgb[j], rgb[j + 1], rgb[j + 2])) mask[i] = 1;
  return mask;
}

// Nipple seeds: HSV dark-red disks inside skin, area 150-3000px, y < 0.72H.
function nippleSeeds(rgb, w, h, skin) {
  let cand = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!skin[p]) continue;
      const j = p * 3;
      const [hh, ss, vv] = rgbToHsv(rgb[j], rgb[j + 1], rgb[j + 2]);
      if (hh >= 0 && hh <= 12 && ss > 50 && vv >= 20 && vv <= 160) cand[p] = 1;
    }
  }
  cand = morphOpen(cand, w, h, 5);
  const { labels, blobs } = labelBlobs(cand, w, h, 0);
  const seeds = [];
  for (const b of blobs) {
    if (b.area <= 150 || b.area >= 3000) continue;
    if (b.centroid.y >= h * NIPPLE_SEED_MAX_Y) continue; // nail polish, not nipple
    const pts = componentPixels(labels, b.id, w, h);
    const c = enclosingCircle(pts);
    seeds.push({ x: c.cx, y: c.cy, r: c.r, area: b.area });
  }
  seeds.sort((a, b) => b.area - a.area);
  return seeds;
}

// Areola: radial-edge scan on the CIELAB a-channel from the nipple center.
function areolaRadial(rgb, w, h, nx, ny) {
  const radii = [];
  const at = (x, y) => {
    const j = (y * w + x) * 3;
    return labA(rgb[j], rgb[j + 1], rgb[j + 2]);
  };
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
    let gi = -1, gv = 0;
    for (let i = 0; i < sm.length; i++) {
      const r = rs[i + 1];
      if (r > 30 && r < 130 && sm[i] < gv) { gv = sm[i]; gi = i; }
    }
    if (gi >= 0 && gv < -0.35) radii.push(rs[gi + 1]);
  }
  if (radii.length < 8) return null;
  const lo = percentile(radii, 10), hi = percentile(radii, 90);
  const core = radii.filter(r => r >= lo && r <= hi);
  const rMed = median(core);
  return {
    radius_px: rMed,
    diameter_px: rMed * 2,
    rays_used: radii.length,
    iqr: [percentile(radii, 25), percentile(radii, 75)],
  };
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

// Nail anchor: HSV red blobs in the hand region (y > 0.6H); median min-area-
// rect short side; 13mm assumed nail width.
function nailAnchor(rgb, w, h) {
  let red = new Uint8Array(w * h);
  const yHand = Math.floor(h * 0.6);
  for (let y = yHand; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x, j = p * 3;
      const [hh, ss, vv] = rgbToHsv(rgb[j], rgb[j + 1], rgb[j + 2]);
      if ((hh <= 8 || hh >= 172) && ss > 90 && vv > 40) red[p] = 1;
    }
  }
  red = morphClose(red, w, h, 5);
  const { labels, blobs } = labelBlobs(red, w, h, 0);
  const big = blobs.filter(b => b.area > 200).sort((a, b) => b.area - a.area).slice(0, 5);
  if (!big.length) return null;
  const widths = big.map(b => {
    const hull = convexHull(componentPixels(labels, b.id, w, h));
    return minAreaRect(hull).h; // short side = nail width
  }).filter(v => v > 0);
  if (!widths.length) return null;
  return { median_width_px: median(widths), n_nails: widths.length };
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

export function measureBreastTelemetry(rgb, w, h, sourceName) {
  // rgb: Float32Array/Uint8Array/Buffer of RGB bytes, length w*h*3.
  // Returns the exact breast_telemetry/v1 schema object, or null when the
  // pipeline cannot resolve the required landmarks.
  if (!rgb || rgb.length < w * h * 3) return null;

  // 1. skin mask
  let skin = skinMask(rgb, w, h);
  skin = morphClose(skin, w, h, 9);
  skin = morphOpen(skin, w, h, 9);

  // 2. nipple seed
  const seeds = nippleSeeds(rgb, w, h, skin);
  if (!seeds.length) return null;
  const nx = seeds[0].x, ny = seeds[0].y;

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

  // 6. nail scale anchor
  const nail = nailAnchor(rgb, w, h);
  if (!nail) return null;
  const mmPerPx = NAIL_MM / nail.median_width_px;
  const mm = px => r1(px * mmPerPx);

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
      right_mound_width_px: Math.round(moundWpx),
      right_nipple_to_fold_px: Math.round(nippleToFoldPx),
      right_fold_y_px: yBot,
      cleavage_x_at_nipple_height_px: cx,
      nail_anchor_median_width_px: r1(nail.median_width_px),
    },
    scale_model: {
      method: 'nail_anchor',
      assumption: 'adult female fingernail width = ' + NAIL_MM.toFixed(1) + 'mm (population mean, index/middle)',
      mm_per_px: Math.round(mmPerPx * 10000) / 10000,
      caveat: 'hand likely 3-8cm closer to lens than chest plane; physical values skew small. treat as +-25%.',
    },
    modeled_physical: {
      right_areola_diameter_mm: mm(ar.diameter_px),
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
        '); low-angle close-up adds apparent volume.',
    },
    confidence: {
      areola_diameter: areolaConf + ' (' + ar.rays_used + ' radial rays, IQR ' +
        Math.round(ar.iqr[0]) + '-' + Math.round(ar.iqr[1]) + 'px)',
      mound_width: 'medium (clean fabric-boundary edges; angled close-up, not orthographic)',
      nipple_to_fold: 'high (sharp fabric edge under breast)',
      physical_mm: 'low-medium (single nail anchor, perspective caveat)',
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
  need(obj && typeof obj === 'object', 'not a JSON object');
  if (!obj || typeof obj !== 'object') return { ok: false, errors };
  need(obj.schema === SCHEMA, 'schema must be "' + SCHEMA + '" (got ' + JSON.stringify(obj.schema) + ')');
  need(typeof obj.source === 'string', 'missing source');
  need(obj.image && NUM(obj.image.w) && NUM(obj.image.h), 'missing image.{w,h}');
  const mp = obj.measured_px || {};
  need(mp.right_nipple && NUM(mp.right_nipple.x) && NUM(mp.right_nipple.y), 'missing measured_px.right_nipple.{x,y}');
  for (const k of ['right_areola_diameter_px', 'right_mound_width_px', 'right_nipple_to_fold_px',
    'right_fold_y_px', 'cleavage_x_at_nipple_height_px', 'nail_anchor_median_width_px'])
    need(NUM(mp[k]), 'missing measured_px.' + k);
  const sm = obj.scale_model || {};
  need(sm.method && sm.assumption && NUM(sm.mm_per_px) && sm.caveat, 'incomplete scale_model');
  const ph = obj.modeled_physical || {};
  for (const k of ['right_areola_diameter_mm', 'right_mound_width_mm', 'right_nipple_to_fold_mm'])
    need(NUM(ph[k]), 'missing modeled_physical.' + k);
  need(obj.left_breast && typeof obj.left_breast === 'object', 'missing left_breast');
  const ce = obj.cup_estimate || {};
  need(ce.method && ce.assumption && typeof ce.verdict === 'string' && ce.band_table && ce.note,
    'incomplete cup_estimate');
  const cf = obj.confidence || {};
  for (const k of ['areola_diameter', 'mound_width', 'nipple_to_fold', 'physical_mm', 'cup', 'left_breast'])
    need(typeof cf[k] === 'string', 'missing confidence.' + k);
  return { ok: errors.length === 0, errors };
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
  // areola circle
  ctx.strokeStyle = '#f0f';
  ctx.beginPath();
  ctx.arc(X(mp.right_nipple.x), ny, (mp.right_areola_diameter_px / 2) * sx, 0, 7);
  ctx.stroke();
  // nipple dot
  ctx.fillStyle = '#f00';
  ctx.beginPath();
  ctx.arc(X(mp.right_nipple.x), ny, Math.max(3, w / 250), 0, 7);
  ctx.fill();
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
  // fold line
  ctx.strokeStyle = '#0f0';
  ctx.beginPath();
  ctx.moveTo(X(mp.cleavage_x_at_nipple_height_px), Y(mp.right_fold_y_px));
  ctx.lineTo(X(mp.cleavage_x_at_nipple_height_px + mp.right_mound_width_px), Y(mp.right_fold_y_px));
  ctx.stroke();
  ctx.font = 'bold 13px sans-serif';
  ctx.fillStyle = '#ff0';
  ctx.fillText('cleavage ' + mp.cleavage_x_at_nipple_height_px + 'px',
    X(mp.cleavage_x_at_nipple_height_px) + 6, ny - 46 * sy);
  ctx.fillStyle = '#0ff';
  ctx.fillText('mound ' + mp.right_mound_width_px + 'px',
    X(mp.cleavage_x_at_nipple_height_px) + 6, ny + 20 * sy);
}
