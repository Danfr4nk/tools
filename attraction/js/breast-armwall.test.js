// Arm-wall regression test: the mound flood must not walk onto the adjacent arm.
//
// Synthetic close-up: a bright mound disk (gray 200) touching a bright
// vertical "arm" bar (gray 195, within K=12 of the mound reference) with dark
// background (gray 100). Without the pose arm wall the flood leaks across the
// whole bar and the contour's max x lands on the bar's far edge; with the wall
// the contour stops at the arm line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breastContour, armWallMask } from './breast.js';

const W = 300, H = 300;
const NX = 120, NY = 150, AREOLA_R = 20, RMAX = 200;

function buildScene() {
  const rgb = new Uint8Array(W * H * 3);
  const skin = new Uint8Array(W * H);
  const set = (x, y, g) => {
    const p = y * W + x;
    rgb[p * 3] = g; rgb[p * 3 + 1] = g; rgb[p * 3 + 2] = g;
    skin[p] = 1;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, 100);
  // mound disk: bright, radius 80 around the nipple
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    if (Math.hypot(x - NX, y - NY) <= 80) set(x, y, 200);
  // arm bar: same-ish luminance, touching the mound's outer edge
  for (let y = 60; y < 290; y++) for (let x = 198; x < 265; x++) set(x, y, 195);
  return { rgb, skin };
}

// 33 MediaPipe-style landmarks; the r-side arm runs vertically at x=201,
// between the mound (edge x=200) and the arm bar. l_shoulder is parked far
// away so the nearest-shoulder pick lands on the r side.
function armPose() {
  const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  const put = (i, x, y) => { lm[i] = { x: x / W, y: y / H, visibility: 0.9 }; };
  put(11, 30, 40);   // l_shoulder (far side)
  put(12, 201, 40);  // r_shoulder
  put(14, 201, 150); // r_elbow
  put(16, 201, 260); // r_wrist
  return lm;
}

const maxX = pts => Math.max(...pts.map(p => p.x));

test('mound flood leaks onto the arm bar without the wall', () => {
  const { rgb, skin } = buildScene();
  const pts = breastContour(rgb, W, H, skin, NX, NY, AREOLA_R, RMAX, 12, null, 0, null);
  assert.ok(pts.length >= 12, 'expected a contour, got ' + pts.length + ' points');
  assert.ok(maxX(pts) > 240, 'without the wall the flood should reach the bar far edge; maxX=' + maxX(pts));
});

test('pose arm wall stops the flood at the arm line', () => {
  const { rgb, skin } = buildScene();
  const wall = armWallMask(armPose(), W, H, NX, NY, RMAX);
  assert.ok(wall, 'expected a wall mask');
  assert.equal(wall[150 * W + 201], 1, 'wall should cover the arm polyline');
  assert.equal(wall[150 * W + 120], 0, 'wall should not cover the nipple');
  const pts = breastContour(rgb, W, H, skin, NX, NY, AREOLA_R, RMAX, 12, null, 0, wall);
  assert.ok(pts.length >= 12, 'expected a contour, got ' + pts.length + ' points');
  assert.ok(maxX(pts) < 215, 'with the wall the contour must stop at the arm line; maxX=' + maxX(pts));
});

test('armWallMask degrades to null without usable pose', () => {
  assert.equal(armWallMask(null, W, H, NX, NY, RMAX), null);
  assert.equal(armWallMask([], W, H, NX, NY, RMAX), null);
  const lowVis = armPose().map(l => ({ ...l, visibility: 0.1 }));
  assert.equal(armWallMask(lowVis, W, H, NX, NY, RMAX), null,
    'unreliable landmarks must not invent a wall');
});
