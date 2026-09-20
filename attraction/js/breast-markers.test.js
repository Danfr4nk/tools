// Marker-placement regression tests (piece #3).
//
// 1. cleavageX: the old fixed [0.48W, 0.70W] window assumed a right-of-center
//    torso and missed left-shifted mirror selfies; anchoring the window to the
//    pose torso midline finds the cleavage there.
// 2. moundWidthPx: the old code always measured toward the skin run's right
//    end, shooting the cyan marker across the other breast for image-left
//    breasts. The contour's outer edge on the nipple's side is the honest
//    bound, direction-aware.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleavageX, moundWidthPx } from './breast.js';

function cleavageScene() {
  const W = 400, H = 300;
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // torso skin, with a dark cleavage band at x=150 (left of center)
    const g = (x >= 146 && x <= 154 && y >= 100 && y <= 200) ? 60 : 180;
    const p = (y * W + x) * 3;
    rgb[p] = g; rgb[p + 1] = g; rgb[p + 2] = g;
  }
  return { rgb, W, H };
}

test('cleavageX finds a left-shifted cleavage when anchored to the torso midline', () => {
  const { rgb, W, H } = cleavageScene();
  const cx = cleavageX(rgb, W, H, 150, 150);
  assert.ok(Math.abs(cx - 150) <= 5, 'midline-anchored search should find x=150, got ' + cx);
});

test('cleavageX old fixed window misses the left-shifted cleavage (the bug)', () => {
  const { rgb, W, H } = cleavageScene();
  const cx = cleavageX(rgb, W, H, 150, null);
  assert.ok(Math.abs(cx - 150) > 20, 'unanchored search should miss x=150, got ' + cx);
});

test('moundWidthPx measures outward on the nipple side', () => {
  const contour = [];
  for (let i = 0; i < 12; i++) contour.push({ x: 60 + i * 10, y: 150 });
  // contour spans x=60..170
  const left = moundWidthPx(contour, 200, -1, [40, 360]);
  assert.equal(left.px, 140, 'image-left breast: cleavage minus contour min');
  assert.match(left.source, /contour/);
  const right = moundWidthPx(contour, 40, 1, [40, 360]);
  assert.equal(right.px, 130, 'image-right breast: contour max minus cleavage');
});

test('moundWidthPx falls back to the run edge, direction-aware', () => {
  const sparse = [{ x: 100, y: 150 }, { x: 110, y: 150 }];
  const left = moundWidthPx(sparse, 200, -1, [40, 360]);
  assert.equal(left.px, 160, 'image-left fallback: |run[0] - cx|');
  assert.match(left.source, /skin run/);
  const right = moundWidthPx(sparse, 200, 1, [40, 360]);
  assert.equal(right.px, 160, 'image-right fallback: |run[1] - cx|');
});
