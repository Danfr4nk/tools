// silhouette.test.js — plain-node tests for the pure silhouette math.
// Run: node silhouette.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  personUnion, extractLoops, extractContour, smoothContour,
  widthProfile, silhouetteMetrics, SIL_KEYS, silhouetteLabel,
} from './silhouette.js';

const W = 256, H = 256;
const approx = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// solid rectangle mask: x in [x0,x1], y in [y0,y1]
function rectMask(x0, y0, x1, y1, w = W, h = H) {
  const m = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) m[y * w + x] = 1;
  return m;
}
function bbox(pts) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}
// tapered body-ish mask: wide shoulders, narrow waist, wide hips
function taperedMask() {
  const m = new Uint8Array(W * H);
  const band = (y0, y1, half) => {
    for (let y = y0; y <= y1; y++)
      for (let x = 128 - half; x <= 128 + half; x++) m[y * W + x] = 1;
  };
  band(0, 70, 60);    // shoulders: width 121
  band(71, 130, 40);  // waist:     width 81
  band(131, 255, 55); // hips:      width 111
  return m;
}
function totalCurvature(pts) {
  let sum = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n];
    const v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const d1 = Math.hypot(...v1), d2 = Math.hypot(...v2);
    if (d1 < 1e-12 || d2 < 1e-12) continue;
    let cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (d1 * d2);
    cos = Math.max(-1, Math.min(1, cos));
    sum += Math.acos(cos);
  }
  return sum;
}

// ---- personUnion ------------------------------------------------------------

test('personUnion maps background to 0 and every other class to 1', () => {
  const out = personUnion(new Uint8Array([0, 1, 2, 3, 4, 5, 0]));
  assert.deepEqual([...out], [0, 1, 1, 1, 1, 1, 0]);
});

test('personUnion of all-background is all zeros', () => {
  const out = personUnion(new Uint8Array(100));
  assert.ok(out instanceof Uint8Array);
  assert.equal([...out].reduce((s, v) => s + v, 0), 0);
});

// ---- marching squares -------------------------------------------------------

test('extractContour on a solid rectangle returns one closed loop', () => {
  const loop = extractContour(rectMask(60, 40, 180, 200), W, H);
  assert.ok(loop.length > 400 && loop.length < 800, 'point count ' + loop.length);
  const [fx, fy] = loop[0], [lx, ly] = loop[loop.length - 1];
  assert.ok(approx(fx, lx) && approx(fy, ly), 'loop is closed');
});

test('extractContour rectangle loop bounding box matches the rectangle', () => {
  const bb = bbox(extractContour(rectMask(60, 40, 180, 200), W, H));
  assert.ok(Math.abs(bb.x0 - 59.5) <= 1, 'x0=' + bb.x0);
  assert.ok(Math.abs(bb.x1 - 180.5) <= 1, 'x1=' + bb.x1);
  assert.ok(Math.abs(bb.y0 - 39.5) <= 1, 'y0=' + bb.y0);
  assert.ok(Math.abs(bb.y1 - 200.5) <= 1, 'y1=' + bb.y1);
});

test('extractContour on a two-blob mask returns the larger loop', () => {
  const m = rectMask(20, 20, 120, 100);           // big: 101x81
  const small = rectMask(200, 200, 230, 220);     // small: 31x21
  for (let i = 0; i < small.length; i++) m[i] |= small[i];
  const loops = extractLoops(m, W, H);
  assert.equal(loops.length, 2);
  const bb = bbox(extractContour(m, W, H));
  assert.ok(bb.x0 >= 18 && bb.x1 <= 122 && bb.y0 >= 18 && bb.y1 <= 102,
    'largest loop is the big blob: ' + JSON.stringify(bb));
});

test('extractContour on an empty mask returns []', () => {
  assert.deepEqual(extractContour(new Uint8Array(W * H), W, H), []);
});

test('extractContour on a single pixel returns a tiny closed diamond', () => {
  const m = new Uint8Array(W * H);
  m[100 * W + 100] = 1;
  const loop = extractContour(m, W, H);
  assert.equal(loop.length, 5); // 4 segments + closing point
  const bb = bbox(loop);
  assert.ok(approx(bb.x1 - bb.x0, 1) && approx(bb.y1 - bb.y0, 1));
});

// ---- widthProfile -----------------------------------------------------------

test('widthProfile of a rectangle is constant within 1px', () => {
  const prof = widthProfile(rectMask(60, 40, 180, 200), W, H);
  const inside = prof.slice(40, 201).map((r) => r.width);
  const lo = Math.min(...inside), hi = Math.max(...inside);
  assert.ok(hi - lo <= 1, `width range ${lo}..${hi}`);
  assert.equal(lo, 121);
});

test('widthProfile reports 0 width and -1 extents on empty rows', () => {
  const prof = widthProfile(rectMask(60, 40, 180, 200), W, H);
  assert.deepEqual(prof[0], { left: -1, right: -1, width: 0 });
  assert.deepEqual(prof[255], { left: -1, right: -1, width: 0 });
});

test('widthProfile left/right extents match the rectangle', () => {
  const r = widthProfile(rectMask(60, 40, 180, 200), W, H)[100];
  assert.equal(r.left, 60);
  assert.equal(r.right, 180);
});

// ---- smoothing --------------------------------------------------------------

test('smoothContour reduces total curvature on a jittered circle', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pts = [];
  for (let i = 0; i < 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    const r = 60 + (rnd() - 0.5) * 6;
    pts.push([128 + r * Math.cos(a), 128 + r * Math.sin(a)]);
  }
  const before = totalCurvature(pts);
  const after = totalCurvature(smoothContour(pts, 3));
  assert.ok(after < before, `curvature ${before.toFixed(2)} -> ${after.toFixed(2)}`);
});

test('smoothContour preserves point count', () => {
  const pts = Array.from({ length: 50 }, (_, i) => [i, Math.sin(i)]);
  assert.equal(smoothContour(pts, 3).length, 50);
});

test('smoothContour keeps the centroid within 1px', () => {
  const pts = [];
  for (let i = 0; i < 80; i++) {
    const a = (i / 80) * Math.PI * 2;
    pts.push([100 + 40 * Math.cos(a), 100 + 30 * Math.sin(a)]);
  }
  const cen = (ps) => [
    ps.reduce((s, p) => s + p[0], 0) / ps.length,
    ps.reduce((s, p) => s + p[1], 0) / ps.length,
  ];
  const [x0, y0] = cen(pts), [x1, y1] = cen(smoothContour(pts, 5));
  assert.ok(Math.abs(x1 - x0) < 1 && Math.abs(y1 - y0) < 1);
});

// ---- silhouetteMetrics ------------------------------------------------------

test('tapered mask: shoulder:waist > 1 and waist:hip < 1', () => {
  const s = silhouetteMetrics(taperedMask(), W, H, null);
  assert.ok(s.shoulder_waist > 1, 'shoulder_waist=' + s.shoulder_waist);
  assert.ok(s.waist_hip < 1, 'waist_hip=' + s.waist_hip);
});

test('tapered mask: ratios match the constructed geometry within 0.02', () => {
  // rows 64/115/140 hit the 121 / 81 / 111 bands exactly
  const s = silhouetteMetrics(taperedMask(), W, H, null);
  assert.ok(approx(s.shoulder_waist, 121 / 81, 0.02), 'shoulder_waist=' + s.shoulder_waist);
  assert.ok(approx(s.waist_hip, 81 / 111, 0.02), 'waist_hip=' + s.waist_hip);
  assert.ok(approx(s.hip_shoulder, 111 / 121, 0.02), 'hip_shoulder=' + s.hip_shoulder);
  assert.deepEqual(s.rows, { shoulder: 64, waist: 115, hip: 140 });
});

test('tapered mask: area fraction matches the constructed area', () => {
  const s = silhouetteMetrics(taperedMask(), W, H, null);
  const expected = (71 * 121 + 60 * 81 + 125 * 111) / (W * H);
  assert.ok(approx(s.area_fraction, expected, 0.01),
    `area ${s.area_fraction} vs ${expected.toFixed(4)}`);
});

test('tapered mask: bbox height fraction is 1 (full-height blob)', () => {
  const s = silhouetteMetrics(taperedMask(), W, H, null);
  assert.equal(s.bbox_height_fraction, 1);
});

test('silhouetteMetrics without pose uses height-fraction rows', () => {
  const s = silhouetteMetrics(taperedMask(), W, H, null);
  assert.equal(s.rows.shoulder, Math.round(0.25 * (H - 1)));
  assert.equal(s.rows.waist, Math.round(0.45 * (H - 1)));
  assert.equal(s.rows.hip, Math.round(0.55 * (H - 1)));
});

test('silhouetteMetrics with pose uses landmark rows', () => {
  const pose = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5 }));
  pose[11] = { x: 0.4, y: 0.2 }; pose[12] = { x: 0.6, y: 0.2 };   // shoulders y=0.2
  pose[23] = { x: 0.4, y: 0.6 }; pose[24] = { x: 0.6, y: 0.6 };   // hips y=0.6
  const s = silhouetteMetrics(taperedMask(), W, H, pose);
  assert.equal(s.rows.shoulder, Math.round(0.2 * (H - 1)));
  assert.equal(s.rows.hip, Math.round(0.6 * (H - 1)));
  assert.equal(s.rows.waist, Math.round(0.4 * (H - 1)));
});

test('silhouetteMetrics on an empty mask does not throw and nulls the ratios', () => {
  const s = silhouetteMetrics(new Uint8Array(W * H), W, H, null);
  assert.equal(s.shoulder_width, 0);
  assert.equal(s.shoulder_waist, null);
  assert.equal(s.waist_hip, null);
  assert.equal(s.hip_shoulder, null);
  assert.equal(s.area_fraction, 0);
  assert.equal(s.bbox_height_fraction, 0);
});

test('silhouetteMetrics returns every SIL_KEYS key with a label', () => {
  const s = silhouetteMetrics(taperedMask(), W, H, null);
  for (const k of SIL_KEYS) {
    assert.ok(k in s, 'missing key ' + k);
    assert.ok(typeof silhouetteLabel(k) === 'string' && silhouetteLabel(k) !== k,
      'missing label for ' + k);
  }
});
