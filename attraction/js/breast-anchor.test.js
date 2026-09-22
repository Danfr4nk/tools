// breast-anchor.test.js — regression tests for the face-anchor gates in the
// breast pipeline (attraction/js/breast.js).
//
// The 2026-09-22 wiring: the workbench's faceAnchor() result (head size +
// rolled face midline, same pixel space) now (a) vetoes nipple-seed
// candidates outside the anchor-predicted torso band before scoring, and
// (b) cross-checks the finished report (expected vs detected, PASS/SUSPECT,
// never silent). Per the vision-gate test lesson, the gates are tested
// DIRECTLY on synthetic inputs — the sampler's subtleties must not be what
// exercises them.
//
// Two geometries:
//   1. synthetic upright (round numbers, exact axis) — exercises the math,
//   2. real-photo-derived (landmarks eyeball-estimated from a real 576x1024
//      reference frame; asymmetric, non-round) — exercises the math on real
//      head proportions.
// Run: node --test attraction/js/breast-anchor.test.js  (from the repo root)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faceAnchor } from '../../workbench/face-anchor.js';
import {
  anchorUsable, anchorNeckPoint, anchorBandCheck, tiltedNippleRow,
  anchorScaleCheck, anchorCrossCheck, vetoSeedBlobs,
} from './breast.js';

// [landmarkIndex, x, y] — MediaPipe FaceLandmarker indices (see face-anchor.js).
function makeAnchor(pts, W, H, box = null) {
  const lm = new Array(478).fill(null);
  for (const [i, x, y] of pts) lm[i] = { x, y };
  return faceAnchor(lm, box, W, H);
}

// Geometry 1: synthetic upright. forehead(10)=(500,200), chin(152)=(500,420),
// cheeks 234=(380,300), 454=(620,300), brows (450,250)/(550,250),
// eyes (440,280)/(480,280) and (520,280)/(560,280).
const UPRIGHT = [
  [10, 500, 200], [152, 500, 420], [234, 380, 300], [454, 620, 300],
  [107, 450, 250], [336, 550, 250], [33, 440, 280], [133, 480, 280],
  [362, 520, 280], [263, 560, 280],
];

// Geometry 2: real-photo-derived — landmarks eyeball-estimated from a real
// 576x1024 reference frame (asymmetric head, non-round numbers). Real head
// proportions: trichion-chin 159px -> headH 197.2, bizygomatic 185px.
const REALISH = [
  [10, 300, 133], [152, 300, 292], [234, 207, 225], [454, 392, 225],
  [107, 265, 189], [336, 334, 189], [33, 248, 210], [133, 279, 210],
  [362, 320, 210], [263, 351, 210],
];

const A1 = makeAnchor(UPRIGHT, 1000, 1200);   // synthetic upright
const A2 = makeAnchor(REALISH, 576, 1024);    // real-photo-derived

test('landmark anchors are usable; neck recovers from the unclipped box', () => {
  assert.equal(anchorUsable(A1), true);
  assert.equal(anchorUsable(A2), true);
  const n1 = anchorNeckPoint(A1);
  assert.ok(Math.abs(n1.x - 500) < 0.01 && Math.abs(n1.y - 452.736) < 0.01,
    'neck = chin + 0.12 heads: ' + JSON.stringify(n1));
  const n2 = anchorNeckPoint(A2);
  assert.ok(Math.abs(n2.x - 300) < 0.01 && Math.abs(n2.y - 315.66) < 0.01,
    'real-ish neck: ' + JSON.stringify(n2));
});

test('head proportions are sane on both geometries', () => {
  assert.ok(Math.abs(A1.headH - 272.8) < 0.01 && Math.abs(A1.headW - 240) < 0.01);
  // real-ish: 159px trichion-chin -> 197.2 headH; 185px bizygomatic
  assert.ok(Math.abs(A2.headH - 197.16) < 0.01 && Math.abs(A2.headW - 185) < 0.01);
  const ratio = A2.headW / A2.headH;
  assert.ok(ratio > 0.8 && ratio < 1.1, 'realistic head width/height ratio: ' + ratio);
});

test('bust-band point passes on both geometries', () => {
  const b1 = anchorBandCheck(A1, 500, 620);
  assert.equal(b1.inside, true);
  assert.ok(Math.abs(b1.depth_heads - 0.61) < 0.02, 'depth: ' + b1.depth_heads);
  const b2 = anchorBandCheck(A2, 300, 420);
  assert.equal(b2.inside, true);
  assert.ok(Math.abs(b2.depth_heads - 0.53) < 0.02, 'real-ish depth: ' + b2.depth_heads);
});

test('face-region and hand-region seeds are rejected with reasons', () => {
  const face = anchorBandCheck(A2, 300, 200);
  assert.equal(face.inside, false);
  assert.equal(face.reason, 'above the bust band');
  const hand = anchorBandCheck(A2, 80, 900);
  assert.equal(hand.inside, false);
  assert.equal(hand.reason, 'below the bust band');
  const wide = anchorBandCheck(A1, 100, 620);
  assert.equal(wide.inside, false);
  assert.equal(wide.reason, 'outside the torso width');
});

test('tilted head: band follows the rolled axis, row angle rotates with it', () => {
  // Rotate the upright geometry 30 deg about the forehead (image coords, y down).
  const rad = 30 * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
  const rot = ([i, x, y]) => {
    const dx = x - 500, dy = y - 200;
    return [i, 500 + dx * c - dy * s, 200 + dx * s + dy * c];
  };
  const AT = makeAnchor(UPRIGHT.map(rot), 1000, 1200);
  assert.ok(Math.abs(Math.abs(AT.rollDeg) - 30) < 1, 'roll ~30: ' + AT.rollDeg);
  assert.equal(anchorUsable(AT), true);
  // A point ON the rolled axis at 0.6 heads below the neck is in-band;
  // the same y on the old vertical line is off-axis but still lateral-in
  // (the gate is generous) — the discriminating check is the row angle.
  const neck = anchorNeckPoint(AT);
  const al = Math.hypot(AT.axis.x, AT.axis.y);
  const px = neck.x + (AT.axis.x / al) * 0.6 * AT.headH;
  const py = neck.y + (AT.axis.y / al) * 0.6 * AT.headH;
  const on = anchorBandCheck(AT, px, py);
  assert.equal(on.inside, true, 'on-axis point under tilt is in-band');
  const row = tiltedNippleRow(AT);
  assert.ok(Math.abs(Math.abs(row.angle_deg) - 30) < 1,
    'row rotates with the head (got ' + row.angle_deg + ', roll ' + AT.rollDeg + ')');
  assert.equal(tiltedNippleRow(A1).angle_deg, 0, 'upright row is horizontal');
});

test('low-confidence (extreme-roll) anchor is never gated on', () => {
  // Eyes vertical -> roll ~90 deg -> confidence 'low'.
  const pts = UPRIGHT.map(([i, x, y]) => {
    if (i === 33) return [i, 460, 200];
    if (i === 133) return [i, 460, 260];
    if (i === 362) return [i, 460, 320];
    if (i === 263) return [i, 460, 380];
    return [i, x, y];
  });
  const AL = makeAnchor(pts, 1000, 1200);
  assert.equal(AL.confidence, 'low');
  assert.equal(anchorUsable(AL), false);
  const rep = { measured_px: { right_nipple: { x: 500, y: 620 } } };
  const chk = anchorCrossCheck(rep, AL);
  assert.equal(chk.applicable, false);
  assert.ok(/low confidence/.test(chk.reason), 'reason names it: ' + chk.reason);
});

test('bbox-fallback anchor is usable (med confidence)', () => {
  const AB = faceAnchor(null, [400, 150, 600, 430], 1000, 1200);
  assert.equal(anchorUsable(AB), true);
  const b = anchorBandCheck(AB, 500, 620);
  assert.equal(b.inside, true);
});

test('scale check: sane sizes pass, absurd ones flag', () => {
  const ok = anchorScaleCheck(A2, { areola_diameter_px: 38, mound_width_px: 150, nipple_to_fold_px: 95 });
  assert.ok(ok.every(s => s.ok), JSON.stringify(ok));
  assert.ok(Math.abs(ok[0].value_heads - 0.19) < 0.02, 'areola ~0.19 heads');
  const bad = anchorScaleCheck(A2, { mound_width_px: 600 });
  assert.equal(bad[0].ok, false);
  assert.ok(bad[0].value_heads > 2, 'giant mound in heads: ' + bad[0].value_heads);
  assert.equal(anchorScaleCheck(null, { mound_width_px: 150 }), null);
  assert.equal(anchorScaleCheck({ garbage: 1 }, { mound_width_px: 150 }), null);
});

test('anchorCrossCheck: plausible rep PASSES with full numbers', () => {
  const rep = { measured_px: {
    right_nipple: { x: 300, y: 420 },
    right_areola_diameter_px: 38, right_mound_width_px: 150,
    right_nipple_to_fold_px: 95, cleavage_x_at_nipple_height_px: 295,
  } };
  const chk = anchorCrossCheck(rep, A2);
  assert.equal(chk.applicable, true);
  assert.equal(chk.passed, true);
  assert.equal(chk.verdict, 'PASS');
  assert.deepEqual(chk.failures, []);
  assert.equal(chk.detected.depth_heads, 0.53);
  assert.equal(chk.expected.anchor_source, 'landmarks');
  assert.equal(chk.expected.anchor_confidence, 'high');
  assert.ok(chk.expected.nipple_band.depth_lo_heads > 0.2, 'band reported');
});

test('anchorCrossCheck: hand-lock seed comes back SUSPECT, never silent', () => {
  const rep = { measured_px: {
    right_nipple: { x: 80, y: 900 },
    right_areola_diameter_px: 38, right_mound_width_px: 150,
    right_nipple_to_fold_px: 95, cleavage_x_at_nipple_height_px: 295,
  } };
  const chk = anchorCrossCheck(rep, A2);
  assert.equal(chk.applicable, true);
  assert.equal(chk.passed, false);
  assert.equal(chk.verdict, 'SUSPECT');
  assert.ok(chk.failures.some(f => /bust band/.test(f)),
    'failure names the band: ' + JSON.stringify(chk.failures));
  // the numbers are still reported even on SUSPECT
  assert.ok(chk.detected.depth_heads > 2, 'detected depth reported');
  assert.ok(chk.expected.nipple_band.depth_hi_heads < 1, 'expected band reported');
});

test('anchorCrossCheck degrades honestly with no anchor / no report', () => {
  const rep = { measured_px: { right_nipple: { x: 300, y: 420 } } };
  const noAnchor = anchorCrossCheck(rep, null);
  assert.equal(noAnchor.applicable, false);
  assert.equal(noAnchor.reason, 'no face anchor for this photo');
  const noRep = anchorCrossCheck(null, A2);
  assert.equal(noRep.applicable, false);
  assert.equal(noRep.reason, 'no breast report to check');
});

test('regression: existing vetoSeedBlobs behavior is untouched', () => {
  // 3:1+ elongated bar is vetoed (finger-gap class).
  const bar = { bbox: { w: 40, h: 10 }, centroid: { x: 500, y: 500 } };
  const blob = { bbox: { w: 20, h: 18 }, centroid: { x: 500, y: 500 } };
  let r = vetoSeedBlobs([bar, blob], []);
  assert.equal(r.kept.length, 1);
  assert.equal(r.vetoed, 1);
  // Face-box veto: seed inside a face box (both bbox forms) is rejected.
  const inFace = { bbox: { w: 20, h: 18 }, centroid: { x: 500, y: 200 } };
  r = vetoSeedBlobs([inFace], [[400, 100, 600, 300]]);
  assert.equal(r.kept.length, 0);
  r = vetoSeedBlobs([inFace], [{ bbox: [400, 100, 600, 300] }]);
  assert.equal(r.kept.length, 0);
  // Clean seed far from any face survives.
  r = vetoSeedBlobs([blob], [[400, 100, 600, 300]]);
  assert.equal(r.kept.length, 1);
});
