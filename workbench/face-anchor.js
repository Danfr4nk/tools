// face-anchor.js — face-derived body anchor for the workbench body instruments.
//
// One face detection already gives us the two things body analysis needs most:
// a scale (how big is a head, in pixels) and a position (where is the person).
// This module turns a face box + landmarks into an expected body box using the
// standard 7.5-heads anthropometric canon, then gives the body instruments two
// things to do with it:
//
//   A) SEARCH CONSTRAINT — the body-outline trace picks the contour loop that
//      best overlaps the anchor box instead of blindly taking the largest loop
//      (matters with background people in frame).
//   B) VALIDATION GATE — a detected body bbox (pose skeleton, silhouette mask)
//      is checked against the anchor: IoU plus width/height ratios. A read
//      that fails comes back flagged SUSPECT, with the numbers shown — never
//      silently reported.
//
// Everything in this file is pure and DOM-free: importable from plain node
// for unit tests (face-anchor.test.js). The 478-pt landmark indices are copied
// verbatim from their sources (cited below) so this module never pulls the
// MediaPipe/transformers stacks.
//
// Index sources:
//   forehead(10), chin(152), cheek_L(234), cheek_R(454),
//   brow_inner_L(107), brow_inner_R(336),
//   eye_outer_L(33), eye_inner_L(133), eye_inner_R(362), eye_outer_R(263)
//     <- attraction/js/measure.js IDX (MediaPipe FaceLandmarker indices),
//        same tables copied into workbench/face-overlay.js.

// ---- anthropometric constants (documented, not tuned) ------------------------
// Head-height canon: total body height ~= 7.5 head heights (crown-to-chin).
// Crown estimate: trichion(forehead lm 10)-to-menton(chin lm 152) is ~18.5cm
// in adults; menton-to-vertex (crown) ~23cm (standard anthropometric tables,
// e.g. Farkas). Ratio 23/18.5 ~= 1.24.
export const HEAD_UNITS = 7.5;            // body heights in head heights
export const CROWN_RATIO = 1.24;          // crown-to-chin ~= 1.24 x forehead-to-chin
export const SHOULDER_HEAD_RATIO = 2.0;   // biacromial shoulder width ~= 2 x bizygomatic head width
export const NECK_DROP_HEADS = 0.12;      // neck sits ~0.12 head-heights below the chin
export const WIDTH_MARGIN = 1.1;          // slack on the expected box (hair, clothing)
export const BOX_HEADW_FALLBACK = 1.05;   // bbox-only mode: head width ~= 1.05 x face box width
// Validation gate tolerances.
export const IOU_PASS = 0.30;             // minimum anchor/detected IoU
export const RATIO_LO = 0.6, RATIO_HI = 1.4; // detected/expected dim must land in [0.6, 1.4]
// A contour loop must overlap the anchor at all to be considered anchored.
export const LOOP_MIN_IOU = 0.05;

const IDX = {
  forehead: 10, chin: 152,
  cheek_L: 234, cheek_R: 454,
  brow_inner_L: 107, brow_inner_R: 336,
  eye_outer_L: 33, eye_inner_L: 133,
  eye_inner_R: 362, eye_outer_R: 263,
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---- head geometry -----------------------------------------------------------
// lm: 478 landmarks in PIXEL space of the image the anchor will be expressed
// in (caller converts from crop/normalized space). box: [x1,y1,x2,y2] in the
// same pixel space (SCRFD face box), used only when landmarks are absent.
// Returns null only when neither is usable.
function headFromLandmarks(lm) {
  if (!lm || lm.length < 478) return null;
  for (const k of Object.values(IDX)) {
    const p = lm[k];
    if (!p || !isFinite(p.x) || !isFinite(p.y)) return null;
  }
  const forehead = lm[IDX.forehead], chin = lm[IDX.chin];
  const glabella = mid(lm[IDX.brow_inner_L], lm[IDX.brow_inner_R]);
  const eyeCL = mid(lm[IDX.eye_outer_L], lm[IDX.eye_inner_L]);
  const eyeCR = mid(lm[IDX.eye_inner_R], lm[IDX.eye_outer_R]);
  const rollDeg = Math.atan2(eyeCR.y - eyeCL.y, eyeCR.x - eyeCL.x) * 180 / Math.PI;
  // Face midline axis (top -> bottom). The neck/body center is extrapolated
  // ALONG this axis, so in-plane head roll shifts the anchor instead of being
  // ignored (a plain box-center would sit off-axis on tilted heads).
  const dx = chin.x - forehead.x, dy = chin.y - forehead.y;
  const len = Math.hypot(dx, dy) || 1;
  const ax = dx / len, ay = dy / len;
  const trichionChin = len; // forehead landmark sits at trichion (hairline)
  const headH = trichionChin * CROWN_RATIO;
  const headW = dist(lm[IDX.cheek_L], lm[IDX.cheek_R]); // bizygomatic
  if (!(headH > 0) || !(headW > 0)) return null;
  const crown = { x: forehead.x - ax * (headH - trichionChin), y: forehead.y - ay * (headH - trichionChin) };
  const neck = { x: chin.x + ax * NECK_DROP_HEADS * headH, y: chin.y + ay * NECK_DROP_HEADS * headH };
  return {
    source: 'landmarks',
    headH, headW, rollDeg,
    axis: { x: ax, y: ay },
    crown, neck,
    glabella,
  };
}

function headFromBox(box) {
  if (!box || box.length < 4) return null;
  const [x1, y1, x2, y2] = box;
  const bw = x2 - x1, bh = y2 - y1;
  if (!(bw > 0) || !(bh > 0)) return null;
  // SCRFD boxes span roughly crown-to-chin, so box height ~= head height.
  const headH = bh, headW = bw * BOX_HEADW_FALLBACK;
  const neck = { x: (x1 + x2) / 2, y: y2 + NECK_DROP_HEADS * headH };
  const crown = { x: (x1 + x2) / 2, y: y1 };
  return {
    source: 'bbox',
    headH, headW, rollDeg: 0,
    axis: { x: 0, y: 1 },
    crown, neck,
    glabella: null,
  };
}

// ---- the anchor ---------------------------------------------------------------
// Returns the expected body box in the same pixel space as the inputs, or
// null when the face data is unusable. `expected` is clipped to the image;
// `expectedFull` is the unclipped canon box (bottom below the frame = a
// half-body crop, which is normal and fine).
export function faceAnchor(lm, box, W, H) {
  const head = headFromLandmarks(lm) || headFromBox(box);
  if (!head || !(W > 0) || !(H > 0)) return null;
  const shoulderW = head.headW * SHOULDER_HEAD_RATIO * WIDTH_MARGIN;
  const centerX = head.neck.x;
  const top = head.neck.y;                       // just below the chin
  const bottom = head.crown.y + HEAD_UNITS * head.headH; // face top + 7.5 heads
  const full = {
    x1: centerX - shoulderW / 2, y1: top,
    x2: centerX + shoulderW / 2, y2: bottom,
  };
  const expected = {
    x1: clamp(full.x1, 0, W), y1: clamp(full.y1, 0, H),
    x2: clamp(full.x2, 0, W), y2: clamp(full.y2, 0, H),
  };
  const clipped = expected.x1 !== full.x1 || expected.y1 !== full.y1 ||
                  expected.x2 !== full.x2 || expected.y2 !== full.y2;
  const halfBody = full.y2 > H + 1e-6; // the canon body runs below the frame
  const rollAbs = Math.abs(head.rollDeg);
  const confidence =
    head.source === 'bbox' ? 'med' :
    rollAbs > 45 ? 'low' :
    rollAbs > 20 ? 'med' : 'high';
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    source: head.source,
    confidence,
    rollDeg: r2(head.rollDeg),
    headH: r2(head.headH), headW: r2(head.headW),
    axis: { x: r2(head.axis.x), y: r2(head.axis.y) },
    expected, expectedFull: full,
    clipped, halfBody,
    image: { w: W, h: H },
  };
}

// ---- IoU ----------------------------------------------------------------------
export function boxArea(b) {
  return Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
}

export function anchorIoU(a, b) {
  const ix1 = Math.max(a.x1, b.x1), iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2), iy2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

// bbox of an array of points — [x,y] pairs (contour loops) or {x,y} objects
// (pose landmarks). Returns null when nothing is finite.
export function pointsBbox(pts) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, n = 0;
  for (const p of pts) {
    const x = Array.isArray(p) ? p[0] : p.x;
    const y = Array.isArray(p) ? p[1] : p.y;
    if (!isFinite(x) || !isFinite(y)) continue;
    n++;
    if (x < x1) x1 = x; if (x > x2) x2 = x;
    if (y < y1) y1 = y; if (y > y2) y2 = y;
  }
  return n ? { x1, y1, x2, y2 } : null;
}

// ---- A) search constraint: contour loop selection ------------------------------
// loops: largest-first (extractLoops already sorts). expectedBox: the anchor
// expected box in the LOOPS' coordinate space (caller scales). Picks the loop
// with the best IoU against the anchor; falls back to the largest loop when
// there is no anchor or nothing overlaps it.
export function selectContour(loops, expectedBox) {
  if (!loops || !loops.length) return { loop: [], iou: 0, index: -1, anchored: false };
  if (!expectedBox) return { loop: loops[0], iou: 0, index: 0, anchored: false };
  let best = -1, bestIoU = 0;
  for (let i = 0; i < loops.length; i++) {
    const bb = pointsBbox(loops[i]);
    if (!bb) continue;
    const iou = anchorIoU(bb, expectedBox);
    if (iou > bestIoU) { bestIoU = iou; best = i; }
  }
  if (best < 0 || bestIoU < LOOP_MIN_IOU)
    return { loop: loops[0], iou: bestIoU, index: 0, anchored: false };
  return { loop: loops[best], iou: bestIoU, index: best, anchored: true };
}

// ---- B) validation gate ----------------------------------------------------------
// detected: a body bbox in the SAME pixel space as anchor.expected
// (pose-skeleton bbox or silhouette-mask bbox). Fails when the IoU is too low
// or either dimension is off by more than the tolerance.
export function validateAgainstAnchor(expected, detected) {
  if (!expected || !detected) return null;
  const r2 = (v) => Math.round(v * 1000) / 1000;
  const iou = anchorIoU(expected, detected);
  const wR = (detected.x2 - detected.x1) / Math.max(1e-9, expected.x2 - expected.x1);
  const hR = (detected.y2 - detected.y1) / Math.max(1e-9, expected.y2 - expected.y1);
  const failures = [];
  if (iou < IOU_PASS) failures.push('iou ' + r2(iou) + ' < ' + IOU_PASS);
  if (wR < RATIO_LO || wR > RATIO_HI) failures.push('width ratio ' + r2(wR) + ' outside [' + RATIO_LO + ', ' + RATIO_HI + ']');
  if (hR < RATIO_LO || hR > RATIO_HI) failures.push('height ratio ' + r2(hR) + ' outside [' + RATIO_LO + ', ' + RATIO_HI + ']');
  return {
    pass: failures.length === 0,
    verdict: failures.length === 0 ? 'PASS' : 'SUSPECT',
    iou: r2(iou),
    widthRatio: r2(wR), heightRatio: r2(hR),
    failures,
  };
}
