// breast-pose.test.js — regression tests for the body-pose cross-check.
// The 2026-09-19 misfire: the seeder locked onto a curled hand and the
// contour flooded onto window blinds, and the verdict still read "firm".
// poseCrossCheck(rep, pose, w, h) is the anatomical backstop — a nipple
// seed must sit below the shoulders, inside the torso band, and clear of
// the hands. Tested directly on synthetic poses (per the vision-gate test
// lesson: never rely on end-to-end scorer sampling to exercise a gate).
// Run: node --test attraction/js/breast-pose.test.js  (from the repo root)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poseCrossCheck } from './breast.js';

const W = 1000, H = 1200;

// Synthetic standing pose, normalized coords. Shoulders y=0.30, hips y=0.62,
// wrists at the sides (0.30/0.70, 0.58) — the geometry of the misfire photo.
function makePose(overrides = {}) {
  const base = {
    11: [0.38, 0.30], 12: [0.62, 0.30],   // shoulders
    13: [0.33, 0.45], 14: [0.67, 0.45],   // elbows
    15: [0.30, 0.58], 16: [0.70, 0.58],   // wrists
    23: [0.42, 0.62], 24: [0.58, 0.62],   // hips
  };
  const pts = [];
  for (let i = 0; i < 33; i++) {
    const [x, y] = base[i] || [0.5, 0.5];
    const o = overrides[i] || {};
    pts.push({ x: o.x ?? x, y: o.y ?? y, visibility: o.v ?? 0.9 });
  }
  return pts;
}

// Minimal breast report: nipple + contour.
function makeRep(nx, ny, contour = null) {
  const c = contour || Array.from({ length: 10 }, (_, i) => {
    const a = (i / 10) * Math.PI * 2;
    return [nx + 60 * Math.cos(a), ny + 60 * Math.sin(a)];
  });
  return { measured_px: { right_nipple: { x: nx, y: ny }, right_breast_contour_px: c } };
}

test('clean mid-torso seed passes', () => {
  const chk = poseCrossCheck(makeRep(500, 500), makePose(), W, H);
  assert.equal(chk.applicable, true);
  assert.equal(chk.passed, true);
  assert.deepEqual(chk.failures, []);
  // shoulder y=360px, shoulder width=240px, hips y=744px
  assert.equal(chk.torso.shoulder_y_px, 360);
  assert.equal(chk.torso.shoulder_width_px, 240);
  assert.equal(chk.torso.hip_y_px, 744);
});

test('seed on a wrist is a hard fail (the hand-lock class)', () => {
  const chk = poseCrossCheck(makeRep(310, 690), makePose(), W, H);
  assert.equal(chk.applicable, true);
  assert.equal(chk.passed, false);
  assert.ok(chk.failures.some(f => /hand/.test(f)),
    'failure names the hand: ' + JSON.stringify(chk.failures));
});

test('seed on an elbow is a hard fail', () => {
  // left elbow at (330, 540); seed 12px away
  const chk = poseCrossCheck(makeRep(336, 548), makePose(), W, H);
  assert.equal(chk.passed, false);
  assert.ok(chk.failures.some(f => /hand/.test(f)));
});

test('seed above the shoulder line is a hard fail', () => {
  const chk = poseCrossCheck(makeRep(500, 250), makePose(), W, H);
  assert.equal(chk.passed, false);
  assert.ok(chk.failures.some(f => /shoulder line/.test(f)));
});

test('seed below the torso band is a hard fail', () => {
  // hips y=744, torso len=384 → band floor 744+115=859; seed at 900
  const chk = poseCrossCheck(makeRep(500, 900), makePose(), W, H);
  assert.equal(chk.passed, false);
  assert.ok(chk.failures.some(f => /torso band/.test(f)));
});

test('seed outside the torso width is a hard fail', () => {
  const chk = poseCrossCheck(makeRep(100, 500), makePose(), W, H);
  assert.equal(chk.passed, false);
  assert.ok(chk.failures.some(f => /torso width/.test(f)));
});

test('contour flooded above the shoulders warns but still passes', () => {
  const contour = Array.from({ length: 10 }, (_, i) =>
    i < 5 ? [500 + i * 10, 200] : [500 + i * 10, 500]); // half above y=300
  const chk = poseCrossCheck(makeRep(500, 500, contour), makePose(), W, H);
  assert.equal(chk.applicable, true);
  assert.equal(chk.passed, true, 'warnings never fail the read');
  assert.equal(chk.warnings.length, 1);
  assert.ok(/background leak/.test(chk.warnings[0]));
});

test('invisible shoulders → not applicable, not a pass', () => {
  const chk = poseCrossCheck(makeRep(500, 500), makePose({ 11: { v: 0.1 }, 12: { v: 0.2 } }), W, H);
  assert.equal(chk.applicable, false);
  assert.ok(/shoulders/.test(chk.reason));
});

test('null pose → not applicable', () => {
  const chk = poseCrossCheck(makeRep(500, 500), null, W, H);
  assert.equal(chk.applicable, false);
  assert.equal(chk.reason, 'no pose landmarks');
});

test('hips unseen → torso-band check degrades, shoulder/hand checks still run', () => {
  const pose = makePose({ 23: { v: 0.1 }, 24: { v: 0.1 } });
  const ok = poseCrossCheck(makeRep(500, 500), pose, W, H);
  assert.equal(ok.applicable, true);
  assert.equal(ok.passed, true);
  assert.equal(ok.torso.hip_y_px, null);
  const bad = poseCrossCheck(makeRep(310, 690), pose, W, H);
  assert.equal(bad.passed, false, 'hand check fires without hips');
});
