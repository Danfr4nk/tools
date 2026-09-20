// breast-gates.test.js — regression tests for the 2026-09-19 plausibility gates.
// The areola-first seeder locked onto a hand (finger creases are dark
// V-minima in skin that cluster like a nipple/areola complex), fit an
// ellipse to fingers, flooded the contour onto window blinds, and read the
// cup "firm". These tests pin the three gates that stop that chain:
//   1. elongated dark cores are vetoed (finger gaps / wrinkles),
//   2. seeds inside a detected face box are vetoed,
//   3. bright neutrals (blinds, walls) are not skin.
// Run: node --test attraction/js/breast-gates.test.js  (from the repo root)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ycrcbSkin, skinMask, detectNipple, vetoSeedBlobs } from './breast.js';

const blob = (w, h, cx, cy) => ({
  bbox: { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2, w, h },
  centroid: { x: cx, y: cy },
});

test('elongated dark cores are vetoed; compact ones survive', () => {
  const blobs = [
    blob(90, 8, 100, 100),   // finger gap, ~11:1
    blob(60, 10, 140, 100),  // second crease, 6:1
    blob(12, 10, 200, 200),  // nipple dark core, ~1:1
    blob(7, 7, 260, 260),    // mole, 1:1
  ];
  const { kept, vetoed } = vetoSeedBlobs(blobs, null);
  assert.equal(vetoed, 2, 'both creases vetoed');
  assert.equal(kept.length, 2, 'nipple + mole survive');
  assert.ok(kept.every(b => b.centroid.x >= 200), 'survivors are the compact ones');
});

test('3:1 aspect bar is generous: 2.5:1 survives, 4:1 dies', () => {
  const { kept: k1, vetoed: v1 } = vetoSeedBlobs([blob(25, 10, 0, 0)], null);
  assert.equal(v1, 0); assert.equal(k1.length, 1);
  const { kept: k2, vetoed: v2 } = vetoSeedBlobs([blob(40, 10, 0, 0)], null);
  assert.equal(v2, 1); assert.equal(k2.length, 0);
});

test('seeds inside a detected face box are vetoed', () => {
  const faces = [[150, 150, 250, 280]];
  const blobs = [blob(10, 10, 200, 210), blob(10, 10, 320, 320)];
  const { kept, vetoed } = vetoSeedBlobs(blobs, faces);
  assert.equal(vetoed, 1, 'the in-face seed is vetoed');
  assert.equal(kept.length, 1, 'the out-of-face seed survives');
  assert.equal(kept[0].centroid.x, 320);
  // {bbox:[...]} form (workbench face objects) works too
  const r2 = vetoSeedBlobs([blob(10, 10, 200, 210)], [{ bbox: [150, 150, 250, 280] }]);
  assert.equal(r2.vetoed, 1);
  // no faces (body-only mode / old callers): nothing vetoed
  const r3 = vetoSeedBlobs(blobs, []);
  assert.equal(r3.vetoed, 0); assert.equal(r3.kept.length, 2);
});

test('bright neutrals are not skin; real skin still is', () => {
  assert.equal(ycrcbSkin(235, 228, 215), false, 'warm-white blinds excluded');
  assert.equal(ycrcbSkin(245, 245, 240), false, 'near-white wall excluded');
  assert.equal(ycrcbSkin(205, 155, 125), true, 'typical light skin kept');
  assert.equal(ycrcbSkin(150, 100, 80), true, 'mid skin kept');
  assert.equal(ycrcbSkin(90, 60, 50), true, 'dark skin kept');
  assert.equal(ycrcbSkin(120, 60, 55), true, 'reddish nipple-area skin kept');
});

// End to end: a true nipple (compact dark core + broad red areola) still
// seeds through detectNipple with zero vetoes — the gates must not break
// the validated reference-photo behavior.
const W = 400, H = 400;
function torsoWithNipple() {
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    rgb[i * 3] = 205; rgb[i * 3 + 1] = 155; rgb[i * 3 + 2] = 125;
  }
  const disk = (cx, cy, r, c) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (Math.hypot(x - cx, y - cy) <= r) {
        const i = y * W + x;
        rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2];
      }
    }
  };
  disk(200, 260, 45, [195, 125, 115]); // broad red areola fills the 20-60px annulus
  disk(200, 260, 14, [110, 55, 50]);   // compact dark nipple core (fills the r<12 core sample)
  return rgb;
}

test('true nipple still seeds end-to-end with zero vetoes', () => {
  const rgb = torsoWithNipple();
  const skin = skinMask(rgb, W, H);
  const nip = detectNipple(rgb, W, H, skin, null);
  assert.ok(nip.x != null, 'a seed resolves');
  assert.ok(Math.hypot(nip.x - 200, nip.y - 260) < 40,
    `seed lands on the nipple, got (${nip.x}, ${nip.y})`);
  assert.equal(nip.vetoed || 0, 0, 'no false vetoes on a clean frame');
});

test('all candidates vetoed -> honest null (no x/y)', () => {
  const rgb = torsoWithNipple();
  const skin = skinMask(rgb, W, H);
  // the only candidate sits inside the face box: pipeline must fail, not fit
  const nip = detectNipple(rgb, W, H, skin, [[100, 160, 300, 360]]);
  assert.ok(nip.x == null, 'no seed resolved');
  assert.ok((nip.vetoed || 0) >= 1, 'the veto was counted');
});
