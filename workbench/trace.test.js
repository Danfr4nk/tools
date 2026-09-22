/* workbench/trace.test.js — node:test for trace.js polygon utilities. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  simplifyStroke, pointInPolygon, polygonBBox, polygonArea,
  traceUsable, traceLandmarkCoverage,
} from './trace.js';

const square = [[0, 0], [10, 0], [10, 10], [0, 10]];

test('pointInPolygon: inside/outside/edge', () => {
  assert.equal(pointInPolygon(5, 5, square), true);
  assert.equal(pointInPolygon(15, 5, square), false);
  assert.equal(pointInPolygon(-1, -1, square), false);
  assert.equal(pointInPolygon(5, 5, []), false);
  assert.equal(pointInPolygon(5, 5, [[0, 0], [1, 1]]), false);
  assert.equal(pointInPolygon(NaN, 5, square), false);
});

test('pointInPolygon: concave shape', () => {
  // C-shaped polygon; the notch is outside.
  const c = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 7], [6, 7], [6, 3], [0, 3]];
  assert.equal(pointInPolygon(2, 5, c), false); // in the notch
  assert.equal(pointInPolygon(8, 5, c), true);
  assert.equal(pointInPolygon(8, 1, c), true);
});

test('polygonBBox', () => {
  assert.deepEqual(polygonBBox(square), { x1: 0, y1: 0, x2: 10, y2: 10 });
  assert.equal(polygonBBox([[1, 1]]), null);
  assert.equal(polygonBBox([[0, 0], [0, 0], [0, 0]]), null);
  assert.equal(polygonBBox([[0, 0], [NaN, 1]]), null);
});

test('polygonArea', () => {
  assert.equal(polygonArea(square), 100);
  assert.equal(polygonArea([[0, 0], [4, 0], [0, 3]]), 6);
  assert.equal(polygonArea([]), 0);
});

test('simplifyStroke: drops near-duplicate points, closes the loop', () => {
  const pts = [[0, 0], [0.5, 0.3], [1, 0], [5, 0], [5.2, 0.1], [10, 0]];
  const out = simplifyStroke(pts, 2);
  assert.deepEqual(out, [[0, 0], [5, 0], [10, 0], [0, 0]]);
});

test('simplifyStroke: short input passes through', () => {
  assert.deepEqual(simplifyStroke([[1, 2]], 2), [[1, 2]]);
  assert.deepEqual(simplifyStroke([], 2), []);
});

test('traceUsable: accepts a real loop, rejects junk', () => {
  const big = [];
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    big.push([500 + 300 * Math.cos(a), 800 + 600 * Math.sin(a)]);
  }
  const ok = traceUsable({ points: big }, 1000, 2000);
  assert.equal(ok.usable, true);
  assert.ok(ok.bbox.x2 > ok.bbox.x1 && ok.bbox.y2 > ok.bbox.y1);
  assert.ok(ok.area_fraction > 0.2);

  assert.equal(traceUsable({ points: [[1, 1], [2, 2]] }, 1000, 2000).usable, false);
  // tiny dot loop: enough points but negligible area
  const dot = [];
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    dot.push([500 + 2 * Math.cos(a), 500 + 2 * Math.sin(a)]);
  }
  const tiny = traceUsable({ points: dot }, 1000, 2000);
  assert.equal(tiny.usable, false);
  assert.match(tiny.reason, /too small/);
  assert.equal(traceUsable(null, 1000, 2000).usable, false);
});

test('traceLandmarkCoverage', () => {
  const big = [];
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    big.push([500 + 300 * Math.cos(a), 800 + 600 * Math.sin(a)]);
  }
  const cov = traceLandmarkCoverage({ points: big }, [
    { x: 500, y: 800 }, { x: 10, y: 10 }, { x: 500, y: 900 },
  ]);
  assert.deepEqual(cov, { inside: 2, total: 3, fraction: 0.667 });
  assert.equal(traceLandmarkCoverage(null, [{ x: 1, y: 1 }]), null);
  assert.equal(traceLandmarkCoverage({ points: big }, []), null);
});
