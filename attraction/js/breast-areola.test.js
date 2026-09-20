// breast-areola.test.js — regression test for the 2026-09-20 innermost-dip fix.
// The areola radial scan used to take the STRONGEST qualified a-channel dip
// per ray. On close-ups the mound edge (breast -> torso shadow) drops harder
// than the areola edge, so rays latched onto the mound: giant pink ellipses
// and bogus ~60 deg tilts in the workbench overlay. The fix takes the
// INNERMOST qualified dip — the areola boundary is the first sustained
// redness drop outside the nipple.
// Run: node --test attraction/js/breast-areola.test.js  (from the repo root)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areolaRadial, fitAreolaEllipse } from './breast.js';

// Synthetic close-up: dark-red nipple disk, pink areola ring (edge r=40),
// lighter breast skin, then a HARD drop at r=110 (mound edge / shadow).
// The mound-edge drop is deliberately stronger than the areola edge.
function synthCloseup() {
  const w = 340, h = 340, cx = 170, cy = 170;
  const rgb = new Uint8ClampedArray(w * h * 3);
  const NIP = [120, 40, 50];     // dark red core, V=120
  const ARE = [200, 110, 120];    // pink areola, high a-channel
  const SKN = [225, 180, 165];   // breast skin, lower a
  const SHD = [140, 110, 105];   // shadow past the mound edge, much lower a
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const r = Math.hypot(x - cx, y - cy);
    const c = r < 12 ? NIP : r < 40 ? ARE : r < 110 ? SKN : SHD;
    const j = (y * w + x) * 3;
    rgb[j] = c[0]; rgb[j + 1] = c[1]; rgb[j + 2] = c[2];
  }
  return { rgb, w, h, cx, cy };
}

test('areolaRadial latches onto the areola edge, not the stronger mound edge', () => {
  const { rgb, w, h, cx, cy } = synthCloseup();
  const ar = areolaRadial(rgb, w, h, cx, cy);
  assert.ok(ar, 'areola found');
  assert.ok(ar.radius_px > 30 && ar.radius_px < 60,
    `radius ${ar.radius_px}px should hug the r=40 areola edge, not the r=110 mound edge`);
  assert.ok(ar.rays_used >= 60, `most rays should hit, got ${ar.rays_used}`);
});

test('fitAreolaEllipse on a circular areola reports ~0 tilt', () => {
  const { rgb, w, h, cx, cy } = synthCloseup();
  const ar = areolaRadial(rgb, w, h, cx, cy);
  assert.ok(ar && ar.polar.length >= 8, 'polar boundary present');
  const el = fitAreolaEllipse(ar.polar, cx, cy);
  assert.ok(el, 'ellipse fit');
  // Pixel quantization on a 340px synthetic reads ~23 deg; the point is it
  // is nowhere near the bogus ~60 deg the mound-latch produced.
  assert.ok(el.tilt_deg < 30, `circular areola should read low tilt, got ${el.tilt_deg}`);
  assert.ok(Math.abs(el.center_x - cx) < 6 && Math.abs(el.center_y - cy) < 6,
    'ellipse centered on the nipple');
});
