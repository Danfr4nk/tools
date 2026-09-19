/* tools/body/tests/sculpt.test.js — node --test, no dependencies.
 * mannequin.js is pure math; the real body-neutral.obj is parsed for the
 * mesh-grounded checks (apex detection, sculpt displacement, winding). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PARAMS, deriveParams, bustOffset, moundFalloff, detectApexes, sculptBust,
  areolaAngle, areolaR, foldDepthAt,
} from '../mannequin.js';

const dir = dirname(fileURLToPath(import.meta.url));
const T = { moundW: 148, areolaD: 48, nipUp: 108.7, nipLat: 93.6, apexH: 148 / 2 * PARAMS.projectionFactor };

/* --- bustOffset profile --- */
test('apex offset = H + areola + nipple terms', () => {
  const R = T.moundW / 2, H = R * PARAMS.projectionFactor;
  assert.ok(Math.abs(bustOffset(0, 0, T) - (H + 1.6 + 5.0)) < 1e-9);
});

test('offset decays to ~0 outside the mound', () => {
  const R = T.moundW / 2;
  assert.ok(Math.abs(bustOffset(R * 2.5, 0, T)) < 1e-9);
  assert.ok(Math.abs(bustOffset(0, R * 2.5, T)) < 1e-9);
});

test('teardrop: fuller below the nipple than above', () => {
  const R = T.moundW / 2;
  assert.ok(bustOffset(0, -R * 0.8, T) > bustOffset(0, R * 0.8, T));
});

test('upper pole is full: no ski-slope drop above the apex', () => {
  const R = T.moundW / 2;
  const ratio = bustOffset(0, R * 0.8, T) / bustOffset(0, -R * 0.8, T);
  assert.ok(ratio > 0.8, 'upper/lower offset ratio = ' + ratio.toFixed(3));
  assert.ok(moundFalloff(0, R * 1.1, T) > 0, 'mound still has volume above the apex');
});

test('inframammary crease dips below the fold line', () => {
  const R = T.moundW / 2;
  const atFold = bustOffset(0, -T.nipUp, T);
  const above = bustOffset(0, -T.nipUp + 40, T);
  const below = bustOffset(0, -T.nipUp - 40, T);
  assert.ok(atFold < above && atFold < below);
});

/* --- moundFalloff --- */
test('falloff is 1 at apex, 0 outside, smooth in between', () => {
  assert.equal(moundFalloff(0, 0, T), 1);
  assert.equal(moundFalloff(T.moundW, 0, T), 0);
  const mid = moundFalloff(T.moundW / 4, 0, T);
  assert.ok(mid > 0 && mid < 1);
});

/* --- deriveParams --- */
test('deriveParams converts px deltas with mm/px and clamps', () => {
  const obj = {
    measured_px: {
      right_nipple: { x: 380, y: 1180 },
      cleavage_x_at_nipple_height_px: 1000,
      right_fold_y_px: 1900,
    },
    scale_model: { mm_per_px: 0.151 },
    modeled_physical: { right_mound_width_mm: 148, right_areola_diameter_mm: 48 },
    cup_estimate: { verdict: 'D (34D)' },
    source: 'test',
  };
  const P = deriveParams(obj);
  assert.ok(Math.abs(P.nipLat - 620 * 0.151) < 1e-9);
  assert.ok(Math.abs(P.nipUp - 720 * 0.151) < 1e-9);
  assert.equal(P.moundW, 148);
});

test('deriveParams: measured apex projection overrides the 0.45 factor', () => {
  const mk = (apx) => deriveParams({
    measured_px: {
      right_nipple: { x: 380, y: 1180 },
      cleavage_x_at_nipple_height_px: 1000,
      right_fold_y_px: 1900,
    },
    scale_model: { mm_per_px: 0.151 },
    modeled_physical: Object.assign(
      { right_mound_width_mm: 148, right_areola_diameter_mm: 48 },
      apx === undefined ? {} : { apex_projection_mm: apx }),
    cup_estimate: { verdict: 'withheld' },
    source: 'test',
  });
  const P0 = mk(undefined);
  assert.equal(P0.apexMeasured, false);
  assert.ok(Math.abs(P0.apexH - 148 / 2 * PARAMS.projectionFactor) < 1e-9);
  const P1 = mk(42);
  assert.equal(P1.apexMeasured, true);
  assert.equal(P1.apexH, 42);
  // the override reaches the sculpted profile at the apex
  const R = P1.moundW / 2;
  assert.ok(Math.abs(bustOffset(0, 0, P1) - (42 + 1.6 + 5.0)) < 1e-9);
  assert.ok(bustOffset(0, 0, P1) > bustOffset(0, 0, P0), 'measured-fuller bust projects further');
});

/* --- real mesh --- */
function loadObj() {
  const lines = readFileSync(join(dir, '..', 'body-neutral.obj'), 'utf8').split('\n');
  const pos = [];
  const idx = [];
  for (const l of lines) {
    if (l.startsWith('v ')) pos.push(...l.split(/\s+/).slice(1, 4).map(Number));
    else if (l.startsWith('f ')) idx.push(...l.split(/\s+/).slice(1, 4).map(s => parseInt(s, 10) - 1));
  }
  return { pos: new Float32Array(pos), idx };
}
const { pos, idx } = loadObj();

test('OBJ parses: 19158 verts, 36972 tris', () => {
  assert.equal(pos.length / 3, 19158);
  assert.equal(idx.length / 3, 36972);
});

/* area-weighted normals, same convention as three.js computeVertexNormals */
function computeNormals(p, ix) {
  const n = new Float32Array(p.length);
  for (let f = 0; f < ix.length; f += 3) {
    const a = ix[f] * 3, b = ix[f + 1] * 3, c = ix[f + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) { n[v] += nx; n[v + 1] += ny; n[v + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}
const nrm = computeNormals(pos, idx);

test('winding is outward: apex normals point forward (+z)', () => {
  const ap = detectApexes(pos);
  for (const A of ap) {
    // nearest vertex in 3D to the detected apex (the detected apex is an
    // average of top verts, not itself a vertex — a fixed xy radius can miss)
    let bd = 1e9, bi = 0;
    for (let i = 0; i < pos.length / 3; i++) {
      const d = Math.hypot(pos[i * 3] - A.x, pos[i * 3 + 1] - A.y, pos[i * 3 + 2] - A.z);
      if (d < bd) { bd = d; bi = i; }
    }
    assert.ok(bd < 25, 'apex vertex within 25mm, got ' + bd.toFixed(1));
    assert.ok(nrm[bi * 3 + 2] > 0.9, 'apex normal z = ' + nrm[bi * 3 + 2]);
  }
});

test('detectApexes: symmetric pair, plausible anatomy', () => {
  const ap = detectApexes(pos);
  assert.equal(ap.length, 2);
  const [R, L] = ap[0].side === 1 ? ap : [ap[1], ap[0]];
  assert.ok(Math.abs(R.x + L.x) < 2, 'x mirror: ' + R.x + ' / ' + L.x);
  assert.ok(Math.abs(R.y - L.y) < 2, 'y match: ' + R.y + ' / ' + L.y);
  assert.ok(R.x > 30 && R.x < 120, 'apex x = ' + R.x);
  assert.ok(R.y > 950 && R.y < 1450, 'apex y = ' + R.y);
  assert.ok(R.bump > 5 && R.bump < 60, 'neutral bump = ' + R.bump);
  assert.ok(Math.abs(R.bump - L.bump) < 3);
});

test('sculptBust: apex lands at chestWall + full profile, foot untouched', () => {
  const ap = detectApexes(pos);
  const { pos: out, colors } = sculptBust(pos, nrm, T, ap);
  const R = T.moundW / 2, H = R * PARAMS.projectionFactor;
  for (const A of ap) {
    // nearest vertex to the detected apex
    let bd = 1e9, bi = 0;
    for (let i = 0; i < pos.length / 3; i++) {
      const d = Math.hypot(pos[i * 3] - A.x, pos[i * 3 + 1] - A.y, pos[i * 3 + 2] - A.z);
      if (d < bd) { bd = d; bi = i; }
    }
    const moved = Math.hypot(out[bi * 3] - pos[bi * 3], out[bi * 3 + 1] - pos[bi * 3 + 1], out[bi * 3 + 2] - pos[bi * 3 + 2]);
    // expected offset evaluated at the vertex's real distance from the apex
    // (the detected apex is an average, not a vertex — falloff applies)
    const dx = pos[bi * 3] - A.x, dy = pos[bi * 3 + 1] - A.y;
    const expect = bustOffset(dx, dy, T) - A.bump; // profile minus neutral bump
    assert.ok(Math.abs(moved - expect) < 3, 'moved ' + moved.toFixed(1) + ' expected ' + expect.toFixed(1));
    // areola tint present near apex
    assert.ok(colors[bi * 3] < 0.95, 'tint r = ' + colors[bi * 3]);
  }
  // a foot vertex must not move
  let fi = 0;
  for (let i = 0; i < pos.length / 3; i++)
    if (pos[i * 3 + 1] < 5) { fi = i; break; }
  assert.equal(out[fi * 3], pos[fi * 3]);
  assert.equal(colors[fi * 3], 1);
});

test('sculptBust: zero displacement outside the sculpt window', () => {
  const ap = detectApexes(pos);
  const { pos: out } = sculptBust(pos, nrm, T, ap);
  const R = T.moundW / 2;
  let checked = 0, worst = 0;
  for (let i = 0; i < pos.length / 3; i++) {
    let inside = false;
    for (const A of ap) {
      const dx = Math.abs(pos[i * 3] - A.x), dy = Math.abs(pos[i * 3 + 1] - A.y);
      if (dx < R * 1.95 && dy < R * 2.25) { inside = true; break; }
    }
    if (inside) continue;
    checked++;
    const d = Math.hypot(out[i * 3] - pos[i * 3], out[i * 3 + 1] - pos[i * 3 + 1], out[i * 3 + 2] - pos[i * 3 + 2]);
    if (d > worst) worst = d;
  }
  assert.ok(checked > 10000, 'checked ' + checked);
  assert.equal(worst, 0);
});

/* --- v3.4: measured geometry package (ellipse + contour + fold curve) --- */
function baseObj() {
  return {
    measured_px: {
      right_nipple: { x: 380, y: 1180 },
      cleavage_x_at_nipple_height_px: 1000,
      right_fold_y_px: 1900,
    },
    scale_model: { mm_per_px: 0.151 },
    modeled_physical: { right_mound_width_mm: 148, right_areola_diameter_mm: 48 },
    cup_estimate: { verdict: 'D (34D)' },
    source: 'test',
  };
}
function fullLoopPts(n = 72, rx = 490, ry = 585) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / n * 2 * Math.PI;
    pts.push([380 + rx * Math.cos(t), 1180 - ry * Math.sin(t)]);
  }
  return pts;
}

test('deriveParams: absent new geometry degrades to nulls, no throw', () => {
  const P = deriveParams(baseObj());
  assert.equal(P.areolaEllipse, null);
  assert.equal(P.contourTable, null);
  assert.equal(P.contourMm, null);
  assert.equal(P.foldCurve, null);
  assert.equal(P.contourCoverage, 0);
  // and the sculpt behaves exactly like v3.3
  assert.equal(bustOffset(10, 20, P), bustOffset(10, 20, T));
});

test('deriveParams: areola ellipse parsed to mm, tilt kept as diagnostic', () => {
  const obj = baseObj();
  obj.measured_px.right_areola_ellipse = {
    semi_major_px: 170, semi_minor_px: 140,
    major_axis_angle_deg: 20, tilt_deg: 34.6, axis_ratio: 0.82,
  };
  const P = deriveParams(obj);
  assert.ok(Math.abs(P.areolaEllipse.a - 170 * 0.151) < 1e-9);
  assert.ok(Math.abs(P.areolaEllipse.b - 140 * 0.151) < 1e-9);
  assert.ok(Math.abs(P.areolaEllipse.ang - 20 * Math.PI / 180) < 1e-9);
  assert.equal(P.areolaEllipse.tiltDeg, 34.6);
});

test('deriveParams: inverted ellipse axes rejected', () => {
  const obj = baseObj();
  obj.measured_px.right_areola_ellipse = {
    semi_major_px: 140, semi_minor_px: 170, major_axis_angle_deg: 20,
  };
  assert.equal(deriveParams(obj).areolaEllipse, null);
});

test('areolaR: elliptical boundary, mirrored on the left, circular fallback', () => {
  const obj = baseObj();
  obj.measured_px.right_areola_ellipse = {
    semi_major_px: 170, semi_minor_px: 140, major_axis_angle_deg: 0,
  };
  const P = deriveParams(obj);
  const { a, b } = P.areolaEllipse;
  // major axis along x: inside at 0.95a on x, outside at 0.95a on y
  assert.ok(areolaR(a * 0.95, 0, P, 1) < 1, 'inside on major axis');
  assert.ok(areolaR(0, a * 0.95, P, 1) > 1, 'outside on minor axis');
  // same distance on x sits deeper inside than on y (elliptical, not circular)
  assert.ok(areolaR(a * 0.95, 0, P, 1) < areolaR(0, a * 0.95, P, 1));
  // mirror: left breast reflects the angle across the midline
  assert.ok(Math.abs(areolaAngle(P, -1) - (Math.PI - P.areolaEllipse.ang)) < 1e-12);
  assert.ok(Math.abs(areolaAngle(P, 1) - P.areolaEllipse.ang) < 1e-12);
  // no ellipse -> circular fallback on areolaD
  assert.ok(Math.abs(areolaR(24, 0, T, 1) - 1) < 1e-9);
  assert.ok(Math.abs(areolaR(0, 24, T, -1) - 1) < 1e-9);
});

test('bustOffset: default side matches explicit side=1', () => {
  assert.equal(bustOffset(10, 20, T), bustOffset(10, 20, T, 1));
});

test('deriveParams: full contour loop drives ~all of the footprint', () => {
  const obj = baseObj();
  obj.measured_px.right_breast_contour_px = fullLoopPts();
  const P = deriveParams(obj);
  assert.ok(P.contourCoverage > 0.95, 'coverage = ' + P.contourCoverage.toFixed(3));
  assert.ok(P.contourMm.length <= 120 && P.contourMm.length >= 12);
  // boundary at angle 0 is ~490px*0.151 = 74mm: inside -> table falloff, outside -> 0
  const inside = moundFalloff(60, 0, P), outside = moundFalloff(90, 0, P);
  assert.ok(inside > 0 && inside < 1, 'inside = ' + inside.toFixed(3));
  assert.equal(outside, 0);
});

test('deriveParams: tiny contour rejected (< 12 pts)', () => {
  const obj = baseObj();
  obj.measured_px.right_breast_contour_px = fullLoopPts(8);
  assert.equal(deriveParams(obj).contourTable, null);
});

test('moundFalloff: unmeasured directions fall back to the modeled footprint', () => {
  const obj = baseObj();
  const pts = [];
  for (let i = 0; i < 40; i++) { // 200° arc only, like a partial contour
    const t = (i / 40) * (200 * Math.PI / 180) - Math.PI / 2;
    pts.push([380 + 490 * Math.cos(t), 1180 - 585 * Math.sin(t)]);
  }
  obj.measured_px.right_breast_contour_px = pts;
  const P = deriveParams(obj);
  assert.ok(P.contourCoverage > 0.3 && P.contourCoverage < 0.7,
    'coverage = ' + P.contourCoverage.toFixed(3));
  // angle 180° is in the gap -> identical to the old analytic model
  assert.ok(Math.abs(moundFalloff(-37, 0, P) - moundFalloff(-37, 0, T)) < 1e-12);
  assert.ok(Math.abs(moundFalloff(0, 50, P) - moundFalloff(0, 50, T)) > 1e-6,
    'measured direction differs from analytic');
});

test('foldDepthAt: measured curve beats the flat nipUp', () => {
  const obj = baseObj();
  const fold = [];
  for (let i = 0; i <= 20; i++) {
    const x = -50 + i / 20 * 860;
    fold.push([x, 1890 + 20 * Math.cos((x - 380) / 490 * Math.PI)]);
  }
  obj.measured_px.right_fold_curve_px = fold;
  const P = deriveParams(obj);
  assert.ok(P.foldCurve.length >= 4);
  assert.notEqual(foldDepthAt(P, -200), foldDepthAt(P, 0));
  assert.equal(foldDepthAt(P, -1e6), P.foldCurve[0].depth); // clamped at ends
  assert.equal(foldDepthAt(P, 1e6), P.foldCurve[P.foldCurve.length - 1].depth);
  // the crease tracks the curve: local minimum at the curve's depth
  const d0 = foldDepthAt(P, 0);
  const at = bustOffset(0, -d0, P);
  assert.ok(at < bustOffset(0, -d0 + 40, P) && at < bustOffset(0, -d0 - 40, P),
    'crease follows the fold curve');
});

test('deriveParams: short fold curve rejected (< 4 pts)', () => {
  const obj = baseObj();
  obj.measured_px.right_fold_curve_px = [[0, 1900], [10, 1900], [20, 1900]];
  assert.equal(deriveParams(obj).foldCurve, null);
});

test('sculptBust: full new-geometry T sculpts the real mesh, no NaN', () => {
  const obj = baseObj();
  obj.measured_px.right_areola_ellipse = {
    semi_major_px: 170, semi_minor_px: 140, major_axis_angle_deg: 20, tilt_deg: 34.6,
  };
  obj.measured_px.right_breast_contour_px = fullLoopPts();
  const fold = [];
  for (let i = 0; i <= 20; i++) {
    const x = -50 + i / 20 * 860;
    fold.push([x, 1890 + 20 * Math.cos((x - 380) / 490 * Math.PI)]);
  }
  obj.measured_px.right_fold_curve_px = fold;
  const P = deriveParams(obj);
  const ap = detectApexes(pos);
  const { pos: out, colors } = sculptBust(pos, nrm, P, ap);
  let bad = 0;
  for (let i = 0; i < out.length; i++)
    if (!isFinite(out[i]) || !isFinite(colors[i])) bad++;
  assert.equal(bad, 0);
  // apex still moves outward by roughly the full profile
  const A = ap[0].side === 1 ? ap[0] : ap[1];
  let bd = 1e9, bi = 0;
  for (let i = 0; i < pos.length / 3; i++) {
    const d = Math.hypot(pos[i * 3] - A.x, pos[i * 3 + 1] - A.y, pos[i * 3 + 2] - A.z);
    if (d < bd) { bd = d; bi = i; }
  }
  const moved = Math.hypot(out[bi * 3] - pos[bi * 3], out[bi * 3 + 1] - pos[bi * 3 + 1], out[bi * 3 + 2] - pos[bi * 3 + 2]);
  assert.ok(moved > 20 && moved < 60, 'apex moved ' + moved.toFixed(1) + ' mm');
});
