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
