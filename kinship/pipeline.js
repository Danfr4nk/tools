'use strict';
/* Kinship web pipeline — insightface buffalo_l in the browser.
 *
 * Faithful port of the Python reference (insightface model_zoo):
 *   detection : SCRFD det_10g.onnx  (strides 8/16/32, 2 anchors, 5 landmarks)
 *   alignment : 5-point Umeyama similarity fit to the ArcFace 112x112 template
 *   embedding : ArcFace w600k_r50.onnx, L2-normalized, cosine similarity
 *   attr      : genderage.onnx -> sex ('M'/'F') + age, for caveats
 *
 * Conventions (verified against the Python stack):
 *   - Pixels are RGB throughout (Python feeds BGR + swapRB; net effect is RGB).
 *   - cv2.warpAffine moves content FORWARD by M: out(x,y) = in(M^-1 . x,y).
 *     Verified empirically: a dot at (10,10) with M=[[1,0,20],[0,1,0]]
 *     lands at (30,10).
 *   - skimage estimate_norm returns M mapping image landmarks -> template
 *     (verified: max|M@kps - template| ~ fit residual).
 *   - All resampling is bilinear with constant-0 border (cv2 INTER_LINEAR).
 *
 * No DOM, no ort dependency here: sessions are passed in. Works in Node
 * (onnxruntime-node) and browsers (onnxruntime-web).
 */

const ARCFACE_TEMPLATE = [
  [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
  [41.5493, 92.3655], [70.7299, 92.2041],
];
const DET_SIZE = 640;
const DET_THRESH = 0.5;
const NMS_THRESH = 0.4;
const LOGIT_CENTER = 0.30;
const LOGIT_SLOPE = 11.0;
const SAME_PERSON_HINT = 0.45;

const VERDICTS = [
  [0.55, 'very strong resemblance',
   'At this level it may be the same person (or identical twins) rather than two siblings.'],
  [0.40, 'strong resemblance',
   'Consistent with close kinship -- or the same person photographed years apart.'],
  [0.28, 'moderate resemblance',
   'Weak-to-moderate evidence. Many unrelated lookalikes score in this range.'],
  [0.15, 'slight resemblance',
   'Little evidence of kinship either way.'],
  [-1.0, 'no meaningful resemblance',
   'No evidence of kinship from facial similarity.'],
];

/* ---------------- pixel helpers (RGB, row-major) ---------------- */

function bilinearSample(src, sw, sh, x, y) {
  // BORDER_CONSTANT 0, matching cv2.warpAffine borderValue=0.0
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  let r = 0, g = 0, b = 0;
  for (let j = 0; j <= 1; j++) {
    const yy = y0 + j;
    if (yy < 0 || yy >= sh) continue;
    const wy = j === 0 ? 1 - fy : fy;
    for (let i = 0; i <= 1; i++) {
      const xx = x0 + i;
      if (xx < 0 || xx >= sw) continue;
      const wx = i === 0 ? 1 - fx : fx;
      const w = wx * wy, o = (yy * sw + xx) * 3;
      r += src[o] * w; g += src[o + 1] * w; b += src[o + 2] * w;
    }
  }
  return [r, g, b];
}

function bilinearResize(src, sw, sh, dw, dh) {
  // cv2 INTER_LINEAR coordinate mapping: sx = (dx+0.5)*sw/dw - 0.5
  const out = new Float32Array(dw * dh * 3);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const srcY = (y + 0.5) * sy - 0.5;
    for (let x = 0; x < dw; x++) {
      const srcX = (x + 0.5) * sx - 0.5;
      const [r, g, b] = bilinearSample(src, sw, sh, srcX, srcY);
      const o = (y * dw + x) * 3;
      out[o] = r; out[o + 1] = g; out[o + 2] = b;
    }
  }
  return out;
}

// 2x3 affine inverse (for warp: dst pixel -> src sample point)
function invertAffine23(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * e - b * d;
  const ia = e / det, ib = -b / det, id = -d / det, ie = a / det;
  return [ia, ib, -(ia * c + ib * f), id, ie, -(id * c + ie * f)];
}

// warp with content moving FORWARD by M (cv2.warpAffine convention)
function warpAffine(src, sw, sh, m, dw, dh) {
  const mi = invertAffine23(m);
  const [a, b, c, d, e, f] = mi;
  const out = new Float32Array(dw * dh * 3);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx = a * x + b * y + c, sy = d * x + e * y + f;
      const [r, g, bb] = bilinearSample(src, sw, sh, sx, sy);
      const o = (y * dw + x) * 3;
      out[o] = r; out[o + 1] = g; out[o + 2] = bb;
    }
  }
  return out;
}

/* ---------------- Umeyama 2D similarity (matches skimage) ---------------- */

function eig2sym(b00, b01, b11) {
  const tr = b00 + b11, det = b00 * b11 - b01 * b01;
  const disc = Math.sqrt(Math.max(0, (tr / 2) * (tr / 2) - det));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  let v1;
  if (Math.abs(b01) > 1e-12) v1 = [b01, l1 - b00];
  else v1 = b00 >= b11 ? [1, 0] : [0, 1];
  const n = Math.hypot(v1[0], v1[1]) || 1;
  v1 = [v1[0] / n, v1[1] / n];
  return { l1, l2, v1, v2: [-v1[1], v1[0]] };
}

// Estimate similarity mapping src -> dst. Returns 2x3 matrix.
function umeyama(src, dst) {
  const n = src.length;
  let smx = 0, smy = 0, dmx = 0, dmy = 0;
  for (let i = 0; i < n; i++) {
    smx += src[i][0]; smy += src[i][1];
    dmx += dst[i][0]; dmy += dst[i][1];
  }
  smx /= n; smy /= n; dmx /= n; dmy /= n;
  // A = dst_demean^T @ src_demean / n   (Eq. 38)
  let a00 = 0, a01 = 0, a10 = 0, a11 = 0, srcVar = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - smx, sy = src[i][1] - smy;
    const dx = dst[i][0] - dmx, dy = dst[i][1] - dmy;
    a00 += dx * sx; a01 += dx * sy;
    a10 += dy * sx; a11 += dy * sy;
    srcVar += sx * sx + sy * sy;
  }
  a00 /= n; a01 /= n; a10 /= n; a11 /= n;
  srcVar /= n;
  // SVD of A (2x2 analytic): A = U diag(S) Vh
  const b00 = a00 * a00 + a10 * a10, b01 = a00 * a01 + a10 * a11, b11 = a01 * a01 + a11 * a11;
  const { l1, l2, v1, v2 } = eig2sym(b00, b01, b11);
  const s1 = Math.sqrt(Math.max(0, l1)), s2 = Math.sqrt(Math.max(0, l2));
  let u1, u2;
  if (s1 > 1e-12) {
    const t1x = a00 * v1[0] + a01 * v1[1], t1y = a10 * v1[0] + a11 * v1[1];
    u1 = [t1x / s1, t1y / s1];
  } else u1 = [1, 0];
  if (s2 > 1e-12) {
    const t2x = a00 * v2[0] + a01 * v2[1], t2y = a10 * v2[0] + a11 * v2[1];
    u2 = [t2x / s2, t2y / s2];
  } else u2 = [-u1[1], u1[0]];
  // d correction (Eq. 39): reflection guard
  const d = [1, 1];
  if (a00 * a11 - a01 * a10 < 0) d[1] = -1;
  // R = U @ diag(d) @ Vh ; Vh rows are v1, v2
  const r00 = (u1[0] * d[0] * v1[0] + u2[0] * d[1] * v2[0]);
  const r01 = (u1[0] * d[0] * v1[1] + u2[0] * d[1] * v2[1]);
  const r10 = (u1[1] * d[0] * v1[0] + u2[1] * d[1] * v2[0]);
  const r11 = (u1[1] * d[0] * v1[1] + u2[1] * d[1] * v2[1]);
  const scale = (s1 * d[0] + s2 * d[1]) / (srcVar || 1e-12);
  const t0 = dmx - scale * (r00 * smx + r01 * smy);
  const t1 = dmy - scale * (r10 * smx + r11 * smy);
  return [scale * r00, scale * r01, t0, scale * r10, scale * r11, t1];
}

/* ---------------- detection ---------------- */

function letterbox(rgb, w, h) {
  const imRatio = h / w, modelRatio = 1; // DET_SIZE x DET_SIZE
  let nw, nh;
  if (imRatio > modelRatio) { nh = DET_SIZE; nw = Math.floor(nh / imRatio); }
  else { nw = DET_SIZE; nh = Math.floor(nw * imRatio); } // int() truncation like insightface
  const detScale = nh / h;
  const resized = bilinearResize(rgb, w, h, nw, nh);
  const out = new Float32Array(DET_SIZE * DET_SIZE * 3); // zeros
  for (let y = 0; y < nh; y++)
    for (let x = 0; x < nw; x++) {
      const s = (y * nw + x) * 3, d = (y * DET_SIZE + x) * 3;
      out[d] = resized[s]; out[d + 1] = resized[s + 1]; out[d + 2] = resized[s + 2];
    }
  return { data: out, detScale };
}

function detInput(letterboxed) {
  const { data } = letterboxed, n = DET_SIZE * DET_SIZE;
  const out = new Float32Array(n * 3);
  for (let c = 0; c < 3; c++)
    for (let i = 0; i < n; i++)
      out[c * n + i] = (data[i * 3 + c] - 127.5) / 128.0;
  return out;
}

function decodeDetections(outputs, detScale) {
  // outputs: [s8,s16,s32, b8,b16,b32, k8,k16,k32], each {data, dims}
  const strides = [8, 16, 32];
  const faces = [];
  for (let l = 0; l < 3; l++) {
    const stride = strides[l];
    const scores = outputs[l].data, bboxes = outputs[l + 3].data, kpss = outputs[l + 6].data;
    const h = DET_SIZE / stride, w = DET_SIZE / stride;
    let idx = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cx = x * stride, cy = y * stride;
        for (let a = 0; a < 2; a++, idx++) {
          const s = scores[idx];
          if (s < DET_THRESH) continue;
          const bo = idx * 4;
          const x1 = (cx - bboxes[bo] * stride) / detScale;
          const y1 = (cy - bboxes[bo + 1] * stride) / detScale;
          const x2 = (cx + bboxes[bo + 2] * stride) / detScale;
          const y2 = (cy + bboxes[bo + 3] * stride) / detScale;
          const ko = idx * 10, kps = [];
          for (let k = 0; k < 5; k++)
            kps.push([(cx + kpss[ko + k * 2] * stride) / detScale,
                      (cy + kpss[ko + k * 2 + 1] * stride) / detScale]);
          faces.push({ bbox: [x1, y1, x2, y2], score: s, kps });
        }
      }
    }
  }
  // stable desc sort by score (matches np.argsort(-scores, kind='stable'))
  faces.sort((a, b) => b.score - a.score);
  return nms(faces);
}

function nms(faces) {
  const keep = [];
  const order = faces.map((_, i) => i);
  const areas = faces.map(f => (f.bbox[2] - f.bbox[0] + 1) * (f.bbox[3] - f.bbox[1] + 1));
  while (order.length) {
    const i = order.shift();
    keep.push(i);
    const [x1, y1, x2, y2] = faces[i].bbox;
    const rest = [];
    for (const j of order) {
      const b = faces[j].bbox;
      const xx1 = Math.max(x1, b[0]), yy1 = Math.max(y1, b[1]);
      const xx2 = Math.min(x2, b[2]), yy2 = Math.min(y2, b[3]);
      const w = Math.max(0, xx2 - xx1 + 1), h = Math.max(0, yy2 - yy1 + 1);
      const ovr = (w * h) / (areas[i] + areas[j] - w * h);
      if (ovr <= NMS_THRESH) rest.push(j);
    }
    order.length = 0; order.push(...rest);
  }
  return keep.map(i => faces[i]);
}

/* ---------------- alignment / recognition / attributes ---------------- */

function alignFace(rgb, w, h, kps) {
  const m = umeyama(kps, ARCFACE_TEMPLATE);
  return warpAffine(rgb, w, h, m, 112, 112);
}

function recInput(aligned) {
  const n = 112 * 112, out = new Float32Array(n * 3);
  for (let c = 0; c < 3; c++)
    for (let i = 0; i < n; i++)
      out[c * n + i] = (aligned[i * 3 + c] - 127.5) / 127.5;
  return out;
}

function l2norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

// genderage crop: face_align.transform(img, center, 96, scale, 0)
// t = T_translate(48,48) o T_rot(0) o T_translate(-c) o T_scale(s)
function genderAgeCrop(rgb, w, h, bbox) {
  const [x1, y1, x2, y2] = bbox;
  const bw = x2 - x1, bh = y2 - y1;
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  const s = 96 / (Math.max(bw, bh) * 1.5);
  // M = T4 @ T3 @ T2 @ T1 (3x3), rows 0:2
  // T1=scale(s), T2=trans(-cx,-cy), T3=rot(0)=I, T4=trans(48,48)
  const m = [s, 0, 48 - s * cx, 0, s, 48 - s * cy];
  return warpAffine(rgb, w, h, m, 96, 96);
}

function genderAgeInput(crop) {
  const n = 96 * 96, out = new Float32Array(n * 3);
  for (let c = 0; c < 3; c++)
    for (let i = 0; i < n; i++)
      out[c * n + i] = (crop[i * 3 + c] - 127.5) / 128.0;
  return out;
}

/* ---------------- scoring (same constants as the CLI) ---------------- */

function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d; // inputs are L2-normalized
}

function confidence(s) {
  return 1 / (1 + Math.exp(-LOGIT_SLOPE * (s - LOGIT_CENTER)));
}

function verdict(s) {
  for (const [floor, label, note] of VERDICTS)
    if (s >= floor) return { label, note };
  const last = VERDICTS[VERDICTS.length - 1];
  return { label: last[1], note: last[2] };
}

/* ---------------- full per-image pipeline ---------------- */

// Detection only: returns faces largest-first (bbox/score/kps rounded).
async function detectFaces(sessions, names, rgb, w, h) {
  const lb = letterbox(rgb, w, h);
  const detOut = await sessions.det.run({ [names.detIn]: {
    dims: [1, 3, DET_SIZE, DET_SIZE], data: detInput(lb),
  } });
  // map outputs by order: scores(3), bboxes(3), kps(3)
  const outs = names.detOut.map(nm => {
    const t = detOut[nm];
    return { data: t.data, dims: t.dims };
  });
  const faces = decodeDetections(outs, lb.detScale).filter(f => f.score >= DET_THRESH);
  // largest first (matches CLI)
  faces.sort((a, b) =>
    ((b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1])) -
    ((a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1])));
  return faces.map(f => ({ bbox: f.bbox, score: f.score, kps: f.kps }));
}

const r2 = v => +v.toFixed(2);

// Embedding + attributes for one already-detected face.
async function embedFace(sessions, names, rgb, w, h, face) {
  const aligned = alignFace(rgb, w, h, face.kps);
  const recOut = await sessions.rec.run({ [names.recIn]: {
    dims: [1, 3, 112, 112], data: recInput(aligned),
  } });
  const embedding = l2norm(recOut[names.recOut].data);
  // attributes
  const crop = genderAgeCrop(rgb, w, h, face.bbox);
  const gaOut = await sessions.ga.run({ [names.gaIn]: {
    dims: [1, 3, 96, 96], data: genderAgeInput(crop),
  } });
  const pred = gaOut[names.gaOut].data;
  const gender = pred[0] >= pred[1] ? 0 : 1;
  return {
    embedding: Array.from(embedding, v => +v.toFixed(6)),
    sex: gender === 1 ? 'M' : 'F',
    age: Math.round(pred[2] * 100),
  };
}

async function embedImage(sessions, names, rgb, w, h, faceIndex = 0) {
  const faces = await detectFaces(sessions, names, rgb, w, h);
  if (!faces.length) return { faces: [], error: 'no face detected (det_score >= 0.5)' };
  const fi = Math.min(faceIndex, faces.length - 1);
  const e = await embedFace(sessions, names, rgb, w, h, faces[fi]);
  // rounded faces for display/test dumps; embedding used full-precision kps
  const rf = faces.map(f => ({
    bbox: f.bbox.map(r2), score: +f.score.toFixed(4),
    kps: f.kps.map(p => [r2(p[0]), r2(p[1])]),
  }));
  return { faces: rf, faceIndex: fi, ...e, error: null };
}

function compareResults(a, b) {
  const s = cosine(a.embedding, b.embedding);
  const p = confidence(s);
  const { label, note } = verdict(s);
  const caveats = [];
  if (a.sex !== b.sex)
    caveats.push('different predicted sexes -- cross-sex comparisons are intrinsically harder (Griffin: resemblance is judged relative to sex norms)');
  if (Math.abs(a.age - b.age) > 15)
    caveats.push(`large predicted age gap (~${Math.abs(a.age - b.age)}y) -- age differences mask family cues`);
  if (s >= SAME_PERSON_HINT)
    caveats.push('score is above the local same-person threshold (0.45) -- the two photos may show the SAME individual, not two relatives');
  if (a.faces.length > 1 || b.faces.length > 1)
    caveats.push(`multiple faces detected (A:${a.faces.length}, B:${b.faces.length}) -- compared the largest in each; pick others to compare different faces`);
  return {
    cosine_similarity: +s.toFixed(4),
    kinship_confidence: +p.toFixed(3),
    verdict: label, verdict_note: note, caveats,
    faces_detected: { a: a.faces.length, b: b.faces.length },
    detection_scores: { a: a.faces[a.faceIndex].score, b: b.faces[b.faceIndex].score },
    calibration: 'heuristic logistic(center=0.30, slope=11) on ArcFace cosine; NOT trained on sibling data -- resemblance meter, not a test',
  };
}

// Node / browser interop
const K = {
  ARCFACE_TEMPLATE, DET_SIZE, DET_THRESH, NMS_THRESH,
  bilinearResize, warpAffine, umeyama, letterbox, detInput,
  decodeDetections, nms, alignFace, recInput, l2norm,
  genderAgeCrop, genderAgeInput, cosine, confidence, verdict,
  detectFaces, embedFace, embedImage, compareResults,
};
if (typeof module !== 'undefined' && module.exports) module.exports = K;
else if (typeof window !== 'undefined') window.KinshipPipeline = K;
