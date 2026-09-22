// face-anchor.test.js — plain-node tests for the face-anchor math.
// Run: node face-anchor.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  faceAnchor, anchorIoU, pointsBbox, selectContour, validateAgainstAnchor,
  HEAD_UNITS, CROWN_RATIO, SHOULDER_HEAD_RATIO, WIDTH_MARGIN, IOU_PASS,
} from './face-anchor.js';

const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// Landmark indices this module reads (copied from the module's IDX table).
const I = {
  forehead: 10, chin: 152, cheek_L: 234, cheek_R: 454,
  brow_inner_L: 107, brow_inner_R: 336,
  eye_outer_L: 33, eye_inner_L: 133, eye_inner_R: 362, eye_outer_R: 263,
};

// Build a 478-landmark array with only the named points placed (pixel space).
function synth(pts) {
  const lm = new Array(478).fill(null).map(() => ({ x: 0, y: 0, z: 0 }));
  for (const [k, v] of Object.entries(pts)) lm[I[k]] = { x: v[0], y: v[1], z: 0 };
  return lm;
}

// Upright frontal face, 200px wide cheeks, forehead->chin 150px.
function uprightFace() {
  return synth({
    forehead: [500, 100], chin: [500, 250],
    cheek_L: [400, 180], cheek_R: [600, 180],
    brow_inner_L: [480, 140], brow_inner_R: [520, 140],
    eye_outer_L: [430, 160], eye_inner_L: [470, 160],
    eye_inner_R: [530, 160], eye_outer_R: [570, 160],
  });
}

test('upright face: canon dims', () => {
  const a = faceAnchor(uprightFace(), null, 1000, 2000);
  assert(a, 'anchor should exist');
  assert.equal(a.source, 'landmarks');
  assert.equal(a.confidence, 'high');
  assert(approx(a.rollDeg, 0, 0.5), 'roll ~0, got ' + a.rollDeg);
  const headH = 150 * CROWN_RATIO; // 186
  assert(approx(a.headH, headH, 0.01), 'headH, got ' + a.headH);
  assert(approx(a.headW, 200, 0.01), 'headW, got ' + a.headW);
  // neck = chin + 0.12*headH down the axis: (500, 250+22.32)
  assert(approx(a.expected.y1, 250 + 0.12 * headH, 0.01), 'top just below chin, got ' + a.expected.y1);
  // crown = forehead - (headH-150) up: y = 100-36
  const crownY = 100 - (headH - 150);
  assert(approx(a.expectedFull.y2, crownY + HEAD_UNITS * headH, 0.01), 'canon bottom');
  // width = 2 * 200 * margin, centered on neck x=500
  const sw = 2 * 200 * WIDTH_MARGIN;
  assert(approx(a.expected.x1, 500 - sw / 2, 0.01), 'x1');
  assert(approx(a.expected.x2, 500 + sw / 2, 0.01), 'x2');
  assert.equal(a.halfBody, false, 'tall frame: no clipping');
});

test('half-body crop: expected box clips at frame bottom', () => {
  const a = faceAnchor(uprightFace(), null, 1000, 800);
  assert(a.halfBody, 'canon body runs below the 800px frame');
  assert(a.clipped, 'clipped flag set');
  assert.equal(a.expected.y2, 800, 'bottom pinned to frame');
  assert(a.expectedFull.y2 > 800, 'unclipped box kept for reference');
});

test('face near frame edge: box clips horizontally', () => {
  const lm = synth({
    forehead: [60, 100], chin: [60, 250],
    cheek_L: [-40, 180], cheek_R: [160, 180],
    brow_inner_L: [40, 140], brow_inner_R: [80, 140],
    eye_outer_L: [-10, 160], eye_inner_L: [30, 160],
    eye_inner_R: [90, 160], eye_outer_R: [130, 160],
  });
  const a = faceAnchor(lm, null, 1000, 2000);
  assert(a.clipped, 'left side clips');
  assert.equal(a.expected.x1, 0, 'pinned at 0');
});

test('tilted face: neck extrapolates along the rolled midline', () => {
  // forehead at (500,100), chin shifted right+down (roll ~14 deg)
  const lm = synth({
    forehead: [500, 100], chin: [540, 246],
    cheek_L: [392, 160], cheek_R: [592, 200],
    brow_inner_L: [476, 128], brow_inner_R: [516, 136],
    eye_outer_L: [424, 148], eye_inner_L: [466, 154],
    eye_inner_R: [528, 166], eye_outer_R: [568, 172],
  });
  const a = faceAnchor(lm, null, 1000, 2000);
  assert(a.rollDeg > 5, 'roll detected, got ' + a.rollDeg);
  // axis = normalize(chin-forehead) = (40,146)/len; neck x must sit right of chin-ish
  const len = Math.hypot(40, 146);
  const headH = len * CROWN_RATIO;
  const neckX = 540 + (40 / len) * 0.12 * headH;
  const cx = (a.expected.x1 + a.expected.x2) / 2;
  assert(approx(cx, neckX, 0.5), 'center-x follows the tilted axis, got ' + cx + ' want ' + neckX);
  assert.notEqual(cx, 540, 'not the naive chin x');
  assert.notEqual(cx, 500, 'not the forehead x either');
});

test('strong roll degrades confidence, does not crash', () => {
  // ~50 deg roll: eye centers (455,90) -> (530,180)
  const lm = synth({
    forehead: [500, 100], chin: [640, 280],
    cheek_L: [430, 40], cheek_R: [570, 260],
    brow_inner_L: [482, 96], brow_inner_R: [518, 118],
    eye_outer_L: [432, 76], eye_inner_L: [478, 104],
    eye_inner_R: [522, 176], eye_outer_R: [568, 204],
  });
  const a = faceAnchor(lm, null, 1000, 2000);
  assert(a, 'still produces an anchor');
  assert.equal(a.confidence, 'low', 'strong roll -> low confidence, got ' + a.confidence);
});

test('bbox fallback: no landmarks', () => {
  const a = faceAnchor(null, [400, 80, 600, 260], 1000, 2000);
  assert(a, 'anchor from bbox');
  assert.equal(a.source, 'bbox');
  assert.equal(a.confidence, 'med');
  assert(approx(a.headH, 180, 0.01), 'headH = box height');
  assert(approx(a.expected.y2 - a.expected.y1 > 6 * 180, true), 'canon height present');
  const cx = (a.expected.x1 + a.expected.x2) / 2;
  assert(approx(cx, 500, 0.01), 'centered on box center');
});

test('garbage in: null out', () => {
  assert.equal(faceAnchor(null, null, 1000, 1000), null);
  assert.equal(faceAnchor(new Array(10).fill({ x: 0, y: 0 })), null);
  assert.equal(faceAnchor(uprightFace(), null, 0, 1000), null);
});

test('anchorIoU: identical / disjoint / partial', () => {
  const b = { x1: 0, y1: 0, x2: 100, y2: 100 };
  assert(approx(anchorIoU(b, b), 1), 'identical -> 1');
  assert.equal(anchorIoU(b, { x1: 200, y1: 200, x2: 300, y2: 300 }), 0, 'disjoint -> 0');
  // half overlap in x: inter=50x100=5000, union=10000+10000-5000=15000 -> 1/3
  assert(approx(anchorIoU(b, { x1: 50, y1: 0, x2: 150, y2: 100 }), 1 / 3, 1e-9), 'partial');
});

test('pointsBbox handles both point shapes and skips NaN', () => {
  const b = pointsBbox([[0, 5], [10, 1], [NaN, 3], { x: 4, y: 9 }]);
  assert.deepEqual(b, { x1: 0, y1: 1, x2: 10, y2: 9 });
  assert.equal(pointsBbox([{ x: NaN, y: 1 }]), null);
});

test('selectContour: picks the anchored loop, not the biggest', () => {
  // big background blob far from the anchor, small person-shaped loop on it
  const big = [[0, 0], [0, 200], [200, 200], [200, 0]];
  const person = [[440, 300], [440, 900], [560, 900], [560, 300]];
  const sel = selectContour([big, person], { x1: 400, y1: 250, x2: 600, y2: 950 });
  assert.equal(sel.index, 1, 'anchored loop picked over the larger one');
  assert.equal(sel.anchored, true);
  assert(sel.iou > 0.5, 'strong overlap, got ' + sel.iou);
});

test('selectContour: falls back to largest without anchor or overlap', () => {
  const big = [[0, 0], [0, 200], [200, 200], [200, 0]];
  const small = [[440, 300], [440, 500], [560, 500], [560, 300]];
  const noA = selectContour([big, small], null);
  assert.equal(noA.index, 0, 'no anchor -> largest');
  assert.equal(noA.anchored, false);
  const miss = selectContour([big, small], { x1: 800, y1: 800, x2: 900, y2: 900 });
  assert.equal(miss.index, 0, 'no overlap -> largest');
});

test('validateAgainstAnchor: sane read passes', () => {
  const exp = { x1: 280, y1: 272, x2: 720, y2: 1459 };
  // detected slightly smaller and shifted: comfortably inside tolerance
  const det = { x1: 300, y1: 290, x2: 700, y2: 1400 };
  const v = validateAgainstAnchor(exp, det);
  assert(v.pass && v.verdict === 'PASS', JSON.stringify(v));
  assert(v.iou > IOU_PASS, 'iou ' + v.iou);
});

test('validateAgainstAnchor: wrong-size read is SUSPECT with reasons', () => {
  const exp = { x1: 280, y1: 272, x2: 720, y2: 1459 };
  const det = { x1: 400, y1: 300, x2: 600, y2: 700 }; // half-width, ~1/3 height
  const v = validateAgainstAnchor(exp, det);
  assert(!v.pass && v.verdict === 'SUSPECT', JSON.stringify(v));
  assert(v.failures.length >= 2, 'multiple reasons: ' + v.failures.join(' | '));
});

test('validateAgainstAnchor: misplaced read fails on IoU', () => {
  const exp = { x1: 280, y1: 272, x2: 720, y2: 1459 };
  const det = { x1: 700, y1: 272, x2: 1140, y2: 1459 }; // same size, shifted right
  const v = validateAgainstAnchor(exp, det);
  assert(!v.pass, 'shifted box should fail IoU');
  assert(v.failures.some(f => f.startsWith('iou')), 'iou is the reason');
});

test('validateAgainstAnchor: null-safe', () => {
  assert.equal(validateAgainstAnchor(null, { x1: 0, y1: 0, x2: 1, y2: 1 }), null);
  assert.equal(validateAgainstAnchor({ x1: 0, y1: 0, x2: 1, y2: 1 }, null), null);
});
