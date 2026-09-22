// breast-trace.test.js — the hand-trace veto in detectNipple (2026-09-22).
// The user finger-traces the body outline; candidates outside the traced
// polygon are rejected pre-scoring as background clutter. The nipple is
// always inside the body outline, so the veto cannot false-reject a true
// nipple — these tests pin that contract on synthetic inputs.
// Run: node --test attraction/js/breast-trace.test.js  (from the repo root)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skinMask, detectNipple } from './breast.js';

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
  disk(200, 260, 45, [195, 125, 115]); // broad red areola
  disk(200, 260, 14, [110, 55, 50]);   // compact dark nipple core
  return rgb;
}

// A trace that excludes the nipple at (200,260) vetoes it: honest null.
test('trace excluding the nipple -> honest null, veto counted', () => {
  const rgb = torsoWithNipple();
  const skin = skinMask(rgb, W, H);
  const trace = { points: [[0, 0], [100, 0], [100, 100], [0, 100]] };
  const nip = detectNipple(rgb, W, H, skin, null, null, trace);
  assert.ok(nip.x == null, 'no seed resolved outside the traced region');
  assert.ok((nip.traceVetoed || 0) >= 1, 'the trace veto was counted');
});

// A trace that includes the nipple leaves the validated behavior untouched.
test('trace including the nipple -> seed resolves, zero trace vetoes', () => {
  const rgb = torsoWithNipple();
  const skin = skinMask(rgb, W, H);
  const trace = { points: [[0, 0], [W, 0], [W, H], [0, H]] };
  const nip = detectNipple(rgb, W, H, skin, null, null, trace);
  assert.ok(nip.x != null, 'a seed resolves');
  assert.ok(Math.hypot(nip.x - 200, nip.y - 260) < 40,
    `seed lands on the nipple, got (${nip.x}, ${nip.y})`);
  assert.equal(nip.traceVetoed || 0, 0, 'no trace vetoes inside the polygon');
});

// Degenerate trace (< 3 points) is ignored — exactly the old behavior.
test('degenerate trace is ignored', () => {
  const rgb = torsoWithNipple();
  const skin = skinMask(rgb, W, H);
  const nip = detectNipple(rgb, W, H, skin, null, null, { points: [[1, 1], [2, 2]] });
  assert.ok(nip.x != null, 'a seed resolves');
  assert.equal(nip.traceVetoed || 0, 0);
});

// No trace at all: old callers are unaffected.
test('absent trace -> old behavior, traceVetoed is 0', () => {
  const rgb = torsoWithNipple();
  const skin = skinMask(rgb, W, H);
  const nip = detectNipple(rgb, W, H, skin);
  assert.ok(nip.x != null, 'a seed resolves');
  assert.equal(nip.traceVetoed || 0, 0);
});
