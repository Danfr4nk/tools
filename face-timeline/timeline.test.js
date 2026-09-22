// timeline.test.js — plain-node tests for the pure timeline math.
// Run: node timeline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_METRICS, METRIC_KEYS, uid, datingLabel,
  insertEntry, moveEntry, removeEntry,
  deltasFor, deviance, topMovers,
  incrementalAnalysis, totalAnalysis, devianceSeries,
} from './timeline.js';

function mkEntry(id, dating, metrics) {
  return { id, dating, metrics: metrics || null };
}

// Every metric = base, except overrides. Keeps the 17-key vector realistic.
function vec(base, overrides = {}) {
  const m = {};
  for (const k of METRIC_KEYS) m[k] = base;
  Object.assign(m, overrides);
  return m;
}

const approx = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ---- insertion -------------------------------------------------------------

test('insertEntry appends at end by default', () => {
  const a = mkEntry('a'), b = mkEntry('b');
  const out = insertEntry([a], b);
  assert.deepEqual(out.map(e => e.id), ['a', 'b']);
});

test('insertEntry before/after an anchor id', () => {
  const a = mkEntry('a'), c = mkEntry('c'), b = mkEntry('b');
  assert.deepEqual(insertEntry([a, c], b, { at: 'before', anchorId: 'c' }).map(e => e.id), ['a', 'b', 'c']);
  assert.deepEqual(insertEntry([a, c], b, { at: 'after', anchorId: 'a' }).map(e => e.id), ['a', 'b', 'c']);
});

test('insertEntry with a missing anchor falls back to end', () => {
  const out = insertEntry([mkEntry('a')], mkEntry('b'), { at: 'before', anchorId: 'ghost' });
  assert.deepEqual(out.map(e => e.id), ['a', 'b']);
});

test('insertEntry does not mutate the input array', () => {
  const arr = [mkEntry('a')];
  insertEntry(arr, mkEntry('b'));
  assert.equal(arr.length, 1);
});

// ---- dating labels ----------------------------------------------------------

test('datingLabel renders the three dating modes', () => {
  const entries = [
    mkEntry('a', { mode: 'exact', date: '2021-03-04' }),
    mkEntry('b', { mode: 'year', year: 2019 }),
    mkEntry('c', { mode: 'relative', relation: 'before', anchorId: 'a' }),
    mkEntry('d', { mode: 'unknown' }),
  ];
  assert.equal(datingLabel(entries[0], entries), 'Mar 4, 2021');
  assert.equal(datingLabel(entries[1], entries), '2019');
  assert.equal(datingLabel(entries[2], entries), 'before «Mar 4, 2021»');
  assert.equal(datingLabel(entries[3], entries), '?');
});

test('datingLabel degrades honestly on bad input', () => {
  assert.equal(datingLabel(mkEntry('x', { mode: 'exact', date: 'not-a-date' })), '?');
  assert.equal(datingLabel(mkEntry('x', { mode: 'year', year: 99 })), '?');
  assert.equal(datingLabel(mkEntry('x', { mode: 'relative', relation: 'after', anchorId: 'gone' }), []), 'after another photo');
  assert.equal(datingLabel(mkEntry('x')), '?');
});

// ---- drag-reorder index math --------------------------------------------------

test('moveEntry relocates entries with clamping', () => {
  const ids = () => ['a', 'b', 'c', 'd'].map(id => mkEntry(id));
  assert.deepEqual(moveEntry(ids(), 0, 2).map(e => e.id), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveEntry(ids(), 3, 0).map(e => e.id), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveEntry(ids(), 1, 99).map(e => e.id), ['a', 'c', 'd', 'b']); // clamps to end
  assert.deepEqual(moveEntry(ids(), 1, -5).map(e => e.id), ['b', 'a', 'c', 'd']); // clamps to start
  assert.deepEqual(moveEntry(ids(), 7, 0).map(e => e.id), ['a', 'b', 'c', 'd']);  // bad source: no-op
});

test('removeEntry drops by id', () => {
  const arr = ['a', 'b', 'c'].map(id => mkEntry(id));
  assert.deepEqual(removeEntry(arr, 'b').map(e => e.id), ['a', 'c']);
});

// ---- delta engine --------------------------------------------------------------

test('deltasFor computes exact absolute and relative deltas', () => {
  const a = vec(1.0), b = vec(1.0, { width_height_ratio: 1.1, jaw_to_cheek: 0.9 });
  const d = deltasFor(a, b);
  assert.ok(approx(d.width_height_ratio.delta, 0.1));
  assert.ok(approx(d.width_height_ratio.rel, 0.1));
  assert.ok(approx(d.jaw_to_cheek.delta, -0.1));
  assert.ok(approx(d.jaw_to_cheek.rel, -0.1));
  assert.ok(approx(d.ipd_to_cheek.delta, 0));
  assert.equal(d.ipd_to_cheek.rel, 0);
});

test('deltasFor yields null on missing values, not zero', () => {
  const a = vec(1.0), b = vec(1.0);
  delete b.nose_to_cheek;
  b.mouth_to_cheek = NaN;
  const d = deltasFor(a, b);
  assert.equal(d.nose_to_cheek, null);
  assert.equal(d.mouth_to_cheek, null);
});

test('deviance is the Euclidean norm of relative deltas', () => {
  // two metrics move +10% each: sqrt(0.1² + 0.1²) = sqrt(0.02)
  const a = vec(1.0), b = vec(1.0, { width_height_ratio: 1.1, jaw_to_cheek: 1.1 });
  assert.ok(approx(deviance(a, b), Math.sqrt(0.02)), 'got ' + deviance(a, b));
  // identical vectors → 0
  assert.equal(deviance(a, vec(1.0)), 0);
  // scale check: doubling one metric of magnitude 2 → rel 1.0 → deviance 1
  const c = vec(1.0, { gonial_angle_mean: 2.0 }), d2 = vec(1.0, { gonial_angle_mean: 4.0 });
  assert.ok(approx(deviance(c, d2), 1), 'got ' + deviance(c, d2));
});

test('deviance is NaN when no metrics overlap', () => {
  assert.ok(Number.isNaN(deviance({}, {})));
});

test('topMovers ranks by |relative delta|', () => {
  const a = vec(1.0);
  const b = vec(1.0, { width_height_ratio: 1.5, jaw_to_cheek: 0.8, ipd_to_cheek: 1.01 });
  const tops = topMovers(deltasFor(a, b), 2);
  assert.deepEqual(tops.map(t => t.key), ['width_height_ratio', 'jaw_to_cheek']);
  assert.ok(approx(tops[0].rel, 0.5));
});

test('incrementalAnalysis pairs consecutive measurable entries', () => {
  const entries = [
    mkEntry('a', { mode: 'year', year: 2020 }, vec(1.0)),
    mkEntry('b', { mode: 'year', year: 2021 }, vec(1.0, { width_height_ratio: 1.2 })),
    mkEntry('c', { mode: 'year', year: 2022 }, vec(1.0, { width_height_ratio: 1.2, jaw_to_cheek: 1.4 })),
  ];
  const steps = incrementalAnalysis(entries);
  assert.equal(steps.length, 2);
  assert.deepEqual([steps[0].fromId, steps[0].toId], ['a', 'b']);
  assert.ok(approx(steps[0].deltas.width_height_ratio.delta, 0.2));
  assert.ok(approx(steps[0].deviance, 0.2), 'single +20% metric → deviance 0.2, got ' + steps[0].deviance);
  assert.ok(approx(steps[1].deltas.jaw_to_cheek.rel, 0.4));
  assert.ok(approx(steps[1].deviance, 0.4));
});

test('incrementalAnalysis breaks the chain at a failed scan', () => {
  const entries = [
    mkEntry('a', {}, vec(1.0)),
    mkEntry('b', {}, null), // scan failed
    mkEntry('c', {}, vec(2.0)),
  ];
  const steps = incrementalAnalysis(entries);
  assert.equal(steps.length, 0, 'no step may bridge across the failed entry');
});

test('totalAnalysis compares every entry against entry #1', () => {
  const entries = [
    mkEntry('a', {}, vec(1.0)),
    mkEntry('b', {}, vec(1.0, { width_height_ratio: 1.1 })),
    mkEntry('c', {}, vec(1.0, { width_height_ratio: 1.3 })),
  ];
  const rows = totalAnalysis(entries);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'b');
  assert.ok(approx(rows[0].deviance, 0.1));
  assert.ok(approx(rows[1].deviance, 0.3));
  assert.ok(approx(rows[1].deltas.width_height_ratio.delta, 0.3));
  assert.equal(rows[0].baselineId, 'a');
});

test('devianceSeries pins the baseline at zero', () => {
  const entries = [
    mkEntry('a', {}, vec(1.0)),
    mkEntry('b', {}, vec(1.0, { width_height_ratio: 1.1 })),
  ];
  const s = devianceSeries(entries);
  assert.equal(s.total.length, 2);
  assert.ok(s.total[0].baseline);
  assert.equal(s.total[0].v, 0);
  assert.ok(approx(s.total[1].v, 0.1));
  assert.equal(s.incremental.length, 1);
  assert.ok(approx(s.incremental[0].v, 0.1));
});

test('uid produces unique ids', () => {
  const ids = new Set(Array.from({ length: 200 }, uid));
  assert.equal(ids.size, 200);
});

test('CORE_METRICS covers the 17-measure diagnostic set', () => {
  assert.equal(CORE_METRICS.length, 17);
  assert.equal(METRIC_KEYS.length, new Set(METRIC_KEYS).size);
});
