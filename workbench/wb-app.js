/* workbench — one photo, every instrument.
 *
 * Shared pipeline: SCRFD face detection (kinship's buffalo_l port) runs once.
 * The detected faces fan out to:
 *   - age estimation  (ViT bracket classifier via transformers.js)
 *   - facial telemetry (MediaPipe FaceLandmarker, same 17-ratio vector as the lab)
 * Everything runs on-device. Nothing is uploaded.
 */
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';
import { ensureLandmarker, disposeLandmarker, landmarkerError, landmarkerDelegate, detectError, detectLandmarks, measureImage } from '../attraction/js/measure.js?v=20260922b';
import { measureBreastTelemetry, validateBreastTelemetry, poseCrossCheck } from '../attraction/js/breast.js?v=20260922h';
import { esc, card, renderBreast, renderAge, renderTelemetry, renderBody, renderAnchor } from './render.js?v=20260922h';
import { ensurePose, disposePose, measureImage as measureBodyImage, drawSkeleton, SKELETON, RATIO_KEYS, ratioLabel } from '../attraction/js/body.js?v=20260922h';
import { ensureSegmenter, disposeSegmenter, segmentPerson, extractContour, extractLoops, smoothContour, silhouetteMetrics, drawOutline, silhouetteLabel } from '../attraction/js/silhouette.js?v=20260922b';
import { faceAnchor, selectContour, validateAgainstAnchor, pointsBbox } from './face-anchor.js';
import { simplifyStroke, traceUsable, traceLandmarkCoverage } from './trace.js';
import { computeFaceOverlayData, annotatedPngDataUrl } from './face-overlay.js';
import { planLifecycle, createModelManager, runPlannedSteps, MODEL_DEFS } from './model-lifecycle.js?v=20260922b';
import { remainingInstruments, orderReportHtml, sanitizeFaces, describeResume } from './resume-util.js?v=20260922b';

(function () {
  'use strict';
  const P = window.KinshipPipeline;
  ort.env.wasm.numThreads = 1; // no COOP/COEP on Pages -> single-threaded wasm
  env.allowRemoteModels = true;

  const $ = id => document.getElementById(id);

  /* ---------------- visible upload-status channel ---------------- */

  // #uploadstate sits under the drop zone in #uploadcard, which is always
  // visible — unlike #runstate, which lives in the hidden #runcard until a
  // run starts. Phone-debugging helper (2026-09-22): every upload error lands
  // here in plain text so it can be read on screen.
  let uploadGlobalErrs = 0;
  function uploadStatus(msg, isErr) {
    const el = $('uploadstate');
    if (!el) return;
    if (isErr) {
      el.innerHTML += (el.innerHTML ? '<br>' : '') +
        '<span class="err">upload error: ' + esc(msg) + '</span>';
    } else {
      el.textContent = msg;
    }
  }
  // Global trap: anything that throws outside a try/catch appends into the
  // always-visible #uploadstate (never clobbers the upload line) and unhides
  // #runcard so #runstate's own record is readable too. Capped at 5 so a
  // pathological loop can't spam the page.
  function showGlobalError(source, err) {
    if (uploadGlobalErrs >= 5) return;
    uploadGlobalErrs++;
    const msg = String((err && err.message) || err || 'unknown error').slice(0, 400);
    uploadStatus('[' + source + '] ' + msg, true);
    const rc = $('runcard');
    if (rc) rc.classList.remove('hidden');
  }

  /* ---------------- constants ---------------- */

  // Lazy loading (2026-09-22): models load only when a selected instrument
  // needs them, and release right after. The 174MB ArcFace recognition model
  // is GONE from this page entirely — nothing here ever needed it.
  const KIN_URLS = {
    det: '../kinship/models/det_10g.onnx',
    ga: '../kinship/models/genderage.onnx',
  };
  const KIN_SIZES = { det: 16923827, ga: 1322532 };

  const AGE_MODEL_ID = 'onnx-community/fairface_age_image_detection-ONNX';
  const AGE_LABELS = ['0-2', '3-9', '10-19', '20-29', '30-39', '40-49', '50-59', '60-69', 'more than 70'];
  const AGE_MIDPOINTS = [1, 6, 14.5, 24.5, 34.5, 44.5, 54.5, 64.5, 78];

  /* ---------------- state ---------------- */

  // Model lifecycle: every model lives in the manager. ensure() loads lazily
  // (per selected instrument), release() disposes the session AND drops the
  // reference — nothing lingers. Residency is the single source of truth:
  // modelMgr.isLoaded('land') replaces the old teleReady flag, etc.
  let modelMgr = null;
  const detH = () => modelMgr.handle('det'); // { session, names } or undefined
  const gaH = () => modelMgr.handle('ga');   // { session, names } or undefined
  const vitH = () => modelMgr.handle('vit'); // transformers classifier or undefined

  let photo = null;          // {rgb, w, h, img}
  let photoName = 'upload';
  let faces = [];            // SCRFD faces, largest-first
  let faceA = 0;
  let lastReport = null;
  let hasRun = false;
  let poseRaw = null, poseTried = false; // per-photo MediaPipe pose landmarks (33, normalized)
  let silCache = null, silTried = false; // per-photo segmentation: {mask, w, h, contour, anchorPick} (mask coords)
  let bodyView = 'skeleton'; // preview overlay mode: outline | skeleton | both
  let lastBodyResult = null; // body-telemetry result, for the lazy outline toggle
  let anchorCache = {};      // faceIdx -> faceAnchor() result (or null); per photo
  let bodyTrace = null;      // hand-traced body polygon {points:[[x,y]...]} in photo px; per photo
  let traceMode = false;     // finger-draw mode on the preview canvas
  let traceStroke = null;    // in-progress stroke (photo px), null when not drawing

  /* ---------------- model loading ---------------- */

  // Serialize session.run calls: concurrent runs on one single-threaded WASM
  // session can deadlock or OOM.
  let runQueue = Promise.resolve();
  function queuedRun(runFn) {
    const p = runQueue.then(runFn, runFn);
    runQueue = p.catch(() => {});
    return p;
  }

  async function fetchBuf(url, expected, onp) {
    const ctrl = new AbortController();
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('fetch failed: ' + url + ' (' + r.status + ')');
    const total = +(r.headers.get('content-length') || expected || 0);
    const reader = r.body.getReader();
    const chunks = [];
    let got = 0, lastMove = Date.now(), stalled = false;
    // A dead connection used to hang the progress bar forever (the 174MB
    // recognition model stalled at ~9% on cellular). Abort after 45s with
    // zero bytes so the user gets an error, not a frozen bar.
    const watchdog = setInterval(() => {
      if (Date.now() - lastMove > 45000) {
        stalled = true;
        clearInterval(watchdog);
        try { reader.cancel(); } catch (e) {}
        ctrl.abort();
      }
    }, 5000);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length; lastMove = Date.now();
        onp(got, total);
      }
    } catch (e) {
      if (stalled) throw new Error('download stalled (no data for 45s): ' + url);
      throw e;
    } finally {
      clearInterval(watchdog);
    }
    const buf = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    return buf;
  }

  const T = (data, dims) => new ort.Tensor('float32', data, dims);
  // The wrapper serializes session.run calls AND keeps the raw session
  // reachable so the manager can truly release it (ort sessions free their
  // WASM heap via session.release()).
  const wrap = s => ({
    raw: s,
    run: feeds => queuedRun(() => {
      const real = {};
      for (const [k, v] of Object.entries(feeds)) real[k] = T(v.data, v.dims);
      return s.run(real);
    }),
  });

  /* ---------------- model lifecycle ---------------- */
  // Lazy + sequential + disposable. Each model loads only when the first
  // selected instrument needing it runs, and releases right after the last
  // one needing it finishes — peak memory is one model at a time (two
  // briefly when the body anchor reuses telemetry's resident landmarker).
  // Per-model status renders in the model list under the photo.
  const MODEL_LABEL = {};
  for (const [k, label] of MODEL_DEFS) MODEL_LABEL[k] = label;

  function setModelStatus(key, state, pct) {
    const el = $('mod-' + key);
    if (!el) return;
    const label = MODEL_LABEL[key] || key;
    if (state === 'loading') {
      const extra = (pct != null && isFinite(pct)) ? ' ' + Math.round(pct * 100) + '%' : '…';
      el.innerHTML = '<span class="mdot load"></span>' + esc(label) + ' — loading' + extra;
    } else if (state === 'ready') {
      el.innerHTML = '<span class="mdot ok"></span>' + esc(label) + ' — ready';
    } else if (state === 'released') {
      el.innerHTML = '<span class="mdot idle"></span>' + esc(label) + ' — released';
    } else {
      el.innerHTML = '<span class="mdot idle"></span>' + esc(label) + ' — idle';
    }
  }

  function buildModelManager() {
    return createModelManager({
      load: async (key, onp) => {
        if (key === 'det' || key === 'ga') {
          const buf = await fetchBuf(KIN_URLS[key], KIN_SIZES[key], (got, total) => {
            if (onp && total) onp(got / total);
          });
          const s = await ort.InferenceSession.create(buf);
          if (key === 'det')
            return { session: wrap(s), names: { detIn: s.inputNames[0], detOut: s.outputNames } };
          return { session: wrap(s), names: { gaIn: s.inputNames[0], gaOut: s.outputNames[0] } };
        }
        if (key === 'vit') {
          return await pipeline('image-classification', AGE_MODEL_ID, {
            dtype: 'q4f16',
            progress_callback: ev => {
              if (ev.status === 'progress' && ev.progress != null && onp) onp(ev.progress / 100);
            },
          });
        }
        if (key === 'land') {
          const lm = await ensureLandmarker(msg => { if (onp) onp(null); });
          if (!lm) throw new Error('landmark model failed to load (' + (landmarkerError() || 'unknown reason') + ')');
          return lm;
        }
        if (key === 'pose') {
          const lm = await ensurePose(msg => { if (onp) onp(null); });
          if (!lm) throw new Error('pose model failed to load');
          return lm;
        }
        if (key === 'seg') {
          const sg = await ensureSegmenter(msg => { if (onp) onp(null); });
          if (!sg) throw new Error('segmentation model failed to load');
          return sg;
        }
        throw new Error('unknown model key: ' + key);
      },
      dispose: async (key, handle) => {
        if (key === 'det' || key === 'ga') {
          // ort sessions free their WASM heap via session.release()
          // (onnxruntime-common API). Reference drop alone is not enough.
          const raw = handle && handle.session && handle.session.raw;
          if (raw && typeof raw.release === 'function') {
            try { await raw.release(); } catch (e) {}
          }
          return;
        }
        if (key === 'vit') {
          try { await handle.dispose(); } catch (e) {}
          return;
        }
        if (key === 'land') { disposeLandmarker(); return; }
        if (key === 'pose') { disposePose(); return; }
        if (key === 'seg') { disposeSegmenter(); return; }
      },
      onStatus: (key, state, pct) => setModelStatus(key, state, pct),
    });
  }

  function setBar(pct, msg) {
    $('modelfill').style.width = (pct * 100).toFixed(1) + '%';
    if (msg) $('modelmsg').textContent = msg;
  }

  /* ---------------- photo intake ---------------- */

  // Decode + downscale an image to a working buffer. MAXD caps memory: the
  // heavy vision models never need more than ~1024px on the long edge.
  function rasterize(im, maxEdge) {
    const sc = Math.min(1, maxEdge / Math.max(im.naturalWidth, im.naturalHeight));
    const w = Math.max(1, Math.round(im.naturalWidth * sc));
    const h = Math.max(1, Math.round(im.naturalHeight * sc));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(im, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const rgb = new Float32Array(w * h * 3);
    for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
      rgb[j] = px[i]; rgb[j + 1] = px[i + 1]; rgb[j + 2] = px[i + 2];
    }
    return { rgb, w, h, img: im };
  }

  function readPhoto(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => {
        URL.revokeObjectURL(url);
        resolve(rasterize(im, 1600));
      };
      im.onerror = () => reject(new Error('could not read image'));
      im.src = url;
    });
  }

  // Restore the working photo from a resume record's JPEG.
  function photoFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(rasterize(im, 1600));
      im.onerror = () => reject(new Error('could not restore photo'));
      im.src = dataUrl;
    });
  }

  // Expanded square crop around a face bbox: photo-space rect {sx, sy, side}.
  // Returned separately from the canvas so landmark coordinates measured on
  // the crop can be mapped back to photo space (the face-anchor needs them).
  function faceCropRect(face) {
    const [x1, y1, x2, y2] = face.bbox;
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    let side = Math.max(x2 - x1, y2 - y1) * 1.5;
    const sx = Math.max(0, cx - side / 2), sy = Math.max(0, cy - side / 2);
    side = Math.min(side, photo.w - sx, photo.h - sy);
    return { sx, sy, side };
  }

  // Expanded square crop around a face bbox, returned as a canvas.
  function faceCropCanvas(face, size) {
    const { sx, sy, side } = faceCropRect(face);
    const src = document.createElement('canvas');
    src.width = photo.w; src.height = photo.h;
    const sctx = src.getContext('2d');
    const img = sctx.createImageData(photo.w, photo.h);
    for (let i = 0, j = 0; i < photo.rgb.length; i += 3, j += 4) {
      img.data[j] = photo.rgb[i]; img.data[j + 1] = photo.rgb[i + 1];
      img.data[j + 2] = photo.rgb[i + 2]; img.data[j + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    cv.getContext('2d').drawImage(src, sx, sy, side, side, 0, 0, size, size);
    return cv;
  }

  function cropToImage(face) {
    return new Promise((resolve, reject) => {
      const cv = faceCropCanvas(face, 512);
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = cv.toDataURL('image/jpeg', 0.92);
    });
  }

  // Face anchor for the body instruments: face box + landmarks (mapped back to
  // photo space via the crop rect) -> expected body box from the 7.5-heads
  // canon. Landmark failure degrades to a bbox-only anchor; a missing face
  // degrades to null and the body instruments fall back to full-frame search.
  // Cached per (photo, face).
  async function ensureFaceAnchor(faceIdx) {
    if (anchorCache[faceIdx] !== undefined) return anchorCache[faceIdx];
    const face = faces[faceIdx];
    if (!face) { anchorCache[faceIdx] = null; return null; }
    let lmPhoto = null;
    // Landmarks only when the landmarker is already resident (facial
    // telemetry ran first in this run). A body-only run never pulls the
    // landmark model for the anchor — it degrades to the bbox estimate.
    if (modelMgr.isLoaded('land')) {
      try {
        const cropImg = await cropToImage(face);
        const tf = faceCropRect(face);
        const lm = detectLandmarks(cropImg);
        if (lm && lm.length >= 478)
          lmPhoto = lm.map(p => ({ x: p.x * tf.side + tf.sx, y: p.y * tf.side + tf.sy }));
      } catch (e) { lmPhoto = null; }
    }
    const a = faceAnchor(lmPhoto, face.bbox, photo.w, photo.h);
    anchorCache[faceIdx] = a;
    return a;
  }

  /* ---------------- instruments ---------------- */

  async function instrumentAge(faceIdx) {
    // The run plan ensures the ViT before this step; ensure() is a no-op
    // when it is already resident.
    const classifier = await modelMgr.ensure('vit');
    const crop = faceCropCanvas(faces[faceIdx], 224);
    const out = await classifier(crop, { top_k: 9 });
    const byLabel = {};
    for (const r of out) byLabel[r.label] = r.score;
    const probs = AGE_LABELS.map(l => ({ label: l, score: byLabel[l] || 0 }));
    const expected = probs.reduce((s, p, i) => s + p.score * AGE_MIDPOINTS[i], 0);
    const top = probs.reduce((a, b) => (b.score > a.score ? b : a));
    return {
      expected_age: +expected.toFixed(1),
      top_bracket: top.label,
      top_confidence: +top.score.toFixed(3),
      distribution: probs.map(p => ({ bracket: p.label, p: +p.score.toFixed(4) })),
      model: 'onnx-community/fairface_age_image_detection-ONNX (ViT-Base, q4f16)',
      method: 'probability-weighted mean of bracket midpoints — approximate by construction',
    };
  }

  async function instrumentTelemetry(faceIdx) {
    // The run plan ensures the landmarker before this step; ensure() is a
    // no-op when it is already resident.
    await modelMgr.ensure('land');
    const cropImg = await cropToImage(faces[faceIdx]);
    let m = measureImage(cropImg);
    let src = 'face crop';
    let ovImg = cropImg;
    if (!m) {
      // Fallback: run the landmarker on the full photo. Distinguishes a bad
      // crop from a model/environment problem, and still yields telemetry.
      const cropErr = detectError();
      m = measureImage(photo.img);
      src = 'full photo (crop fallback)';
      ovImg = photo.img;
      if (!m) throw new Error('no landmarks (crop: ' + cropErr + '; full photo: ' + detectError() + ')');
    }
    // Annotated overlay: the lab's telestrator on the measured image, cropped
    // to the face like the lab's output. Baked into a PNG data URL so the
    // report card shows it and the export carries the guidelines with it.
    // Failures are surfaced on the result (never silent) so a missing picture
    // always says why.
    let annotatedPng = null, overlayError = null;
    try {
      const lm = detectLandmarks(ovImg);
      if (!lm) throw new Error('landmarker returned no landmarks for the overlay (' + (detectError() || 'unknown') + ')');
      const d = computeFaceOverlayData(lm);
      if (!d) throw new Error('overlay geometry failed (need 478 landmarks)');
      const iw = ovImg.naturalWidth || ovImg.width, ih = ovImg.naturalHeight || ovImg.height;
      annotatedPng = annotatedPngDataUrl(
        ovImg, lm, d, 'face ' + (faceIdx + 1) + ' · ' + iw + '×' + ih + 'px ' + src);
    } catch (e) { overlayError = (e && e.message) || String(e); console.warn('overlay render failed:', e); }
    const out = {
      metrics: m,
      measured_on: src,
      inference_delegate: landmarkerDelegate(),
      model: 'MediaPipe FaceLandmarker (float16)',
      method: 'same 17-ratio vector as the attraction telemetry lab',
    };
    if (annotatedPng) {
      out.annotated_png_dataurl = annotatedPng;
      window.__wbTelePng = { dataUrl: annotatedPng, faceIdx };
    } else {
      out.overlay_error = overlayError;
    }
    return out;
  }

  async function instrumentBreast(fileName) {
    $('runstate').textContent = 'running breast telemetry…';
    // faces feed the nipple-seed plausibility veto (seeds inside a face box
    // are rejected as non-anatomical); body-only mode passes [].
    // Pose is fetched first now: the nipple-side arm polyline becomes a wall
    // the mound flood cannot cross (stops the arm-leak scribbles), and the
    // same landmarks feed the cross-check below.
    const pose = await ensurePoseRaw();
    // Face anchor (computed by the body instrument when it ran): enables the
    // anchor seed-band veto + face_anchor/face_anchor_check in the report.
    // Absent anchor (body off, or anchor failed): exactly the old behavior.
    const faceIdx = faceA;
    // Hand trace (Dan's idea): the user's traced body outline, passed as
    // opts.trace — nipple seeds outside it are rejected pre-scoring as
    // background clutter. No trace: exactly the old behavior.
    const rep = measureBreastTelemetry(photo.rgb, photo.w, photo.h, fileName,
      faces.map(f => f.bbox), { anchor: anchorCache[faceIdx], trace: bodyTrace });
    if (!rep) throw new Error('breast telemetry: could not resolve nipple/areola/nail landmarks in this photo');
    const v = validateBreastTelemetry(rep);
    if (!v.ok) throw new Error('breast telemetry schema invalid: ' + v.errors.join('; '));
    // Body-pose cross-check: the nipple seed must be anatomically plausible
    // relative to the pose skeleton — below the shoulders, inside the torso
    // band, clear of the hands. Runs even when the body instrument is off;
    // it is part of breast validation now, not a separate card. A hard
    // failure refuses the read outright: no "firm" verdict on a hand-lock.
    if (pose) {
      $('runstate').textContent = 'cross-checking breast landmarks against body pose…';
      const chk = poseCrossCheck(rep, pose, photo.w, photo.h);
      rep.body_cross_check = chk;
      if (chk.applicable && !chk.passed)
        throw new Error('breast telemetry refused by body cross-check: ' + chk.failures.join('; '));
    }
    return rep;
  }

  // Raw 33-landmark pose for the cross-check, cached per photo. No visibility
  // gating here — poseCrossCheck degrades per-check on its own. The pose
  // model itself is owned by the model manager (loads once, releases after
  // the last instrument needing it).
  async function ensurePoseRaw() {
    if (poseTried) return poseRaw;
    poseTried = true;
    try {
      const lm = await modelMgr.ensure('pose');
      if (!lm) return null;
      const res = lm.detect(photo.img);
      const poses = res.landmarks || res.poseLandmarks || [];
      poseRaw = (poses.length && poses[0].length) ? poses[0] : null;
    } catch (e) { poseRaw = null; }
    return poseRaw;
  }

  // Body-outline segmentation, cached per photo. Null on any failure — the
  // tool works fine with the outline unavailable (skeleton-only fallback).
  // Stored artifact is the 256x256 mask (65KB) + smoothed contour in mask
  // coords; scaled to photo coords only at draw time.
  async function ensureSilhouetteRaw() {
    if (silTried) return silCache;
    silTried = true;
    try {
      const seg = await modelMgr.ensure('seg');
      if (!seg) return null;
      // Downscale first: the model is 256x256 internally, so feeding a 12MP
      // iPhone photo straight into the GPU delegate just burns memory — on
      // iOS that got the tab Jetsam-killed (~20s in, silent reload).
      const MAXD = 768, dsc = Math.min(1, MAXD / Math.max(photo.img.width, photo.img.height));
      const dc = document.createElement('canvas');
      dc.width = Math.max(1, Math.round(photo.img.width * dsc));
      dc.height = Math.max(1, Math.round(photo.img.height * dsc));
      dc.getContext('2d').drawImage(photo.img, 0, 0, dc.width, dc.height);
      const out = await segmentPerson(dc, seg);
      if (!out || !out.mask || !out.mask.some(v => v)) return null;
      // Anchor-constrained contour pick: the face anchor chooses the loop
      // with the best IoU against the expected body box instead of blindly
      // taking the largest loop (matters with background people in frame).
      // No face -> largest loop, exactly the old behavior.
      const loops = extractLoops(out.mask, out.w, out.h);
      let pick = { loop: loops.length ? loops[0] : [], iou: 0, index: 0, anchored: false };
      let anchor = null;
      if (loops.length > 1 && faces.length) {
        try { anchor = await ensureFaceAnchor(faceA); } catch (e) { anchor = null; }
        if (anchor) {
          const sx = out.w / photo.w, sy = out.h / photo.h;
          const eb = anchor.expected;
          pick = selectContour(loops, {
            x1: eb.x1 * sx, y1: eb.y1 * sy, x2: eb.x2 * sx, y2: eb.y2 * sy,
          });
        }
      }
      const loop = pick.loop;
      silCache = {
        mask: out.mask, w: out.w, h: out.h,
        contour: loop.length > 8 ? smoothContour(loop, 3) : null,
        anchorPick: pick.anchored
          ? { loops: loops.length, index: pick.index, iou: +pick.iou.toFixed(3) }
          : null,
      };
    } catch (e) { silCache = null; }
    return silCache;
  }

  // Annotated body export PNG (photo + skeleton and/or outline), downscaled.
  // Rebuilt when the outline finishes lazy-loading so the export matches the view.
  function buildBodyExportPng() {
    const full = document.createElement('canvas');
    drawSkeleton(full, photo.img, poseRaw); // photo alone when no pose
    const sil = silCache;
    if (sil && sil.contour)
      drawOutline(full.getContext('2d'), sil.contour, photo.w, photo.h,
        { stroke: 'rgba(125,211,252,0.95)', width: Math.max(2, photo.w / 300) });
    const MAXS = 900, sc = Math.min(1, MAXS / Math.max(full.width, full.height));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(full.width * sc));
    cv.height = Math.max(1, Math.round(full.height * sc));
    cv.getContext('2d').drawImage(full, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/png');
  }

  async function instrumentBody() {
    $('runstate').textContent = 'estimating body pose…';
    const raw = await ensurePoseRaw();
    // The outline is opt-in via the toggle below: loading the segmentation
    // model during the instrument run got iOS Safari Jetsam-killed (~20s in,
    // tab silently reloaded). The default path stays exactly as heavy as
    // before the outline existed; tapping outline/both loads it on demand.
    if (!raw) return { error: 'no pose detected in this photo' };
    // Strict full-body ratios (the body-metrics lab path: needs
    // shoulders-through-ankles); the stick figure draws from raw regardless.
    let strict = null;
    try { strict = raw ? await measureBodyImage(photo.img, { trace: bodyTrace }) : { ok: false, skip_reason: 'no pose landmarks' }; }
    catch (e) { strict = { ok: false, skip_reason: String((e && e.message) || e) }; }
    // Face anchor: expected body box from the 7.5-heads canon, then the
    // validation gate — the detected pose bbox must land inside it
    // (IoU + dimension ratios) or the read is flagged SUSPECT, not silent.
    // No face -> no anchor -> full-frame behavior, noted on the card.
    let face_anchor = null, anchor_check = null, anchor_note = null;
    if (faces.length) {
      $('runstate').textContent = 'deriving face anchor…';
      try { face_anchor = await ensureFaceAnchor(faceA); }
      catch (e) { face_anchor = null; }
      if (face_anchor) {
        const pts = raw.filter(p => p && isFinite(p.x) && isFinite(p.y));
        const bb = pts.length ? pointsBbox(pts) : null;
        if (bb) {
          const detected = {
            x1: bb.x1 * photo.w, y1: bb.y1 * photo.h,
            x2: bb.x2 * photo.w, y2: bb.y2 * photo.h,
          };
          anchor_check = {
            detected,
            ...validateAgainstAnchor(face_anchor.expected, detected),
          };
        } else anchor_note = 'face anchor derived, but the pose has no finite landmarks to check against.';
      } else anchor_note = 'face landmarks failed — body search ran full-frame.';
    } else anchor_note = 'no face anchor — full-frame search.';
    // Hand trace (Dan's idea): the user's traced outline is the initial body
    // region guide. Its bbox replaces the pose bbox as the "detected" body
    // box in the anchor gate (their ground truth beats the pose bbox), and
    // the pose landmarks get a coverage check against the polygon — guide
    // sanity, not a veto: the pose still computes.
    let trace_guide = null;
    const tu = bodyTrace ? traceUsable(bodyTrace, photo.w, photo.h) : null;
    if (tu && tu.usable) {
      const pts = raw.filter(p => p && isFinite(p.x) && isFinite(p.y))
        .map(p => ({ x: p.x * photo.w, y: p.y * photo.h }));
      trace_guide = {
        points: tu.points, bbox: tu.bbox, area_fraction: tu.area_fraction,
        landmark_coverage: pts.length ? traceLandmarkCoverage(bodyTrace, pts) : null,
      };
      if (anchor_check && face_anchor) {
        const detected = { x1: tu.bbox.x1, y1: tu.bbox.y1, x2: tu.bbox.x2, y2: tu.bbox.y2 };
        anchor_check = { detected, ...validateAgainstAnchor(face_anchor.expected, detected) };
        anchor_note = (anchor_note ? anchor_note + ' ' : '') + 'detected box is your hand-traced outline.';
      }
    }
    return {
      pose_png_dataurl: buildBodyExportPng(),
      has_outline: false, // filled in if the user loads the outline via the toggle
      has_skeleton: !!raw,
      ratios: strict.ok ? strict.ratios : null,
      visibility: strict.visibility || null,
      warnings: strict.warnings || [],
      skip_reason: strict.ok ? null : (strict.skip_reason || 'pose incomplete'),
      silhouette: null, // lazy: populated by the outline toggle, not the run
      silhouette_error: 'pending',
      silhouette_anchor: null, // lazy: contour loop pick vs the anchor, from the toggle
      face_anchor, anchor_check, anchor_note,
      trace_guide,
      model: 'MediaPipe PoseLandmarker (pose_landmarker_lite, float16)',
      method: '33 landmarks → 9 segment lengths + 7 scale-invariant ratios (same definitions as the body-metrics lab); body outline = largest person-segment contour at 256px, loaded on demand',
    };
  }

  // 2nd opinion for the age card: gender/age CNN on a tight face crop.
  // (The 174MB ArcFace embedding is gone — the vector was never used.)
  // Returns null on any failure; the card falls back to the ViT bracket.
  async function attrFor(faceIdx) {
    try {
      const gh = gaH() || await modelMgr.ensure('ga');
      const attr = await P.genderAgeCrop(gh.session, gh.names, photo, faceIdx, faces);
      const inp = await P.genderAgeInput(gh.session, gh.names, attr);
      const out = await gh.session.run({ [gh.names.gaIn]: inp });
      return { gender: out[gh.names.gaOut].data[0], age: out[gh.names.gaOut].data[1] };
    } catch (e) {
      return null;
    }
  }

  /* ---------------- rendering ---------------- */

  function drawPreview() {
    const cv = $('preview');
    const maxW = 480, scale = Math.min(maxW / photo.w, 1);
    cv.width = Math.round(photo.w * scale);
    cv.height = Math.round(photo.h * scale);
    const ctx = cv.getContext('2d');
    const off = document.createElement('canvas');
    off.width = photo.w; off.height = photo.h;
    const octx = off.getContext('2d');
    const img = octx.createImageData(photo.w, photo.h);
    for (let i = 0, j = 0; i < photo.rgb.length; i += 3, j += 4) {
      img.data[j] = photo.rgb[i]; img.data[j + 1] = photo.rgb[i + 1];
      img.data[j + 2] = photo.rgb[i + 2]; img.data[j + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    ctx.drawImage(off, 0, 0, cv.width, cv.height);
    ctx.lineWidth = 2;
    faces.forEach((f, i) => {
      const [x1, y1, x2, y2] = f.bbox;
      ctx.strokeStyle = i === faceA ? '#7dd3fc' : 'rgba(125,211,252,.35)';
      ctx.strokeRect(x1 * scale, y1 * scale, (x2 - x1) * scale, (y2 - y1) * scale);
      ctx.fillStyle = i === faceA ? '#7dd3fc' : 'rgba(125,211,252,.6)';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText(i === faceA ? 'A' : String(i + 1),
        x1 * scale + 4, y1 * scale + 16);
    });
    // body overlay: outline / skeleton / both (skeleton is the default; the
    // outline appears once the user loads it via the toggle)
    const hasOutline = !!(silCache && silCache.contour);
    let mode = bodyView;
    if (mode === 'outline' && !hasOutline) mode = poseRaw ? 'skeleton' : 'none';
    if (mode === 'skeleton' && !poseRaw) mode = hasOutline ? 'outline' : 'none';
    if (mode === 'both' && !poseRaw) mode = 'outline';
    if (mode === 'both' && !hasOutline) mode = 'skeleton';
    if (mode === 'skeleton' || mode === 'both') {
      ctx.strokeStyle = 'rgba(74,222,128,.85)';
      ctx.fillStyle = 'rgba(74,222,128,.9)';
      ctx.lineWidth = 2; ctx.lineCap = 'round';
      for (const [a, b] of SKELETON) {
        const A = poseRaw[a], B = poseRaw[b];
        if (!A || !B) continue;
        ctx.beginPath();
        ctx.moveTo(A.x * cv.width, A.y * cv.height);
        ctx.lineTo(B.x * cv.width, B.y * cv.height);
        ctx.stroke();
      }
      for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
        const p = poseRaw[i];
        if (!p) continue;
        ctx.beginPath();
        ctx.arc(p.x * cv.width, p.y * cv.height, 3, 0, 7);
        ctx.fill();
      }
    }
    if (mode === 'outline' || mode === 'both') {
      drawOutline(ctx, silCache.contour, cv.width, cv.height,
        { stroke: 'rgba(125,211,252,0.9)', width: 2 });
    }
    // Hand trace: dashed cyan polygon (photo px -> canvas px). Rendered last
    // so it sits above the model overlays — it's the user's own ground truth.
    if (bodyTrace && bodyTrace.points && bodyTrace.points.length >= 3) {
      const k = cv.width / photo.w;
      ctx.strokeStyle = 'rgba(34,211,238,0.95)';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([8, 5]);
      ctx.beginPath();
      bodyTrace.points.forEach(([x, y], i) => { i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k); });
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // the outline/skeleton toggle only means something once one of them exists
    const bvr = $('bodyViewRow');
    if (bvr) bvr.style.display = (poseRaw || hasOutline) ? '' : 'none';
  }

  // Silhouette metrics card — appended after renderBody's card. Widths are
  // mask px (256px mask); ratios are the comparable unit across photos.
  function renderSilhouette(r) {
    let inner;
    if (!r || r.error) inner = '';
    else if (r.silhouette) {
      const s = r.silhouette;
      const row = (k, v) => '<tr><td>' + esc(silhouetteLabel(k)) +
        ' <span class="note">' + esc(k) + '</span></td><td>' + esc(v) + '</td></tr>';
      const f = (v) => (typeof v === 'number' ? v.toFixed(3) : '—');
      let h = '<div class="kpi">' +
        '<div><div class="v">' + f(s.shoulder_waist) + '</div><div class="l">shoulder ÷ waist</div></div>' +
        '<div><div class="v">' + f(s.waist_hip) + '</div><div class="l">waist ÷ hip</div></div>' +
        '<div><div class="v">' + f(s.hip_shoulder) + '</div><div class="l">hip ÷ shoulder</div></div>' +
        '<div><div class="v">' + (typeof s.area_fraction === 'number' ? (s.area_fraction * 100).toFixed(1) + '%' : '—') +
        '</div><div class="l">frame covered</div></div></div>';
      h += '<table class="metrics">' +
        row('shoulder_width', s.shoulder_width + ' px @ row ' + s.rows.shoulder) +
        row('waist_width', s.waist_width + ' px @ row ' + s.rows.waist) +
        row('hip_width', s.hip_width + ' px @ row ' + s.rows.hip) +
        row('area_fraction', f(s.area_fraction)) +
        row('bbox_height_fraction', f(s.bbox_height_fraction)) +
        '</table>';
      h += '<p class="note">clothed-silhouette measurements — the outline traces clothing and hair, ' +
        'not the body underneath; the ratios are the comparable unit. ' + esc(s.model || '') + '.</p>';
      if (r.silhouette_anchor) {
        const ap = r.silhouette_anchor;
        h += '<p class="note">face anchor: contour loop ' + (ap.index + 1) + ' of ' + ap.loops +
          ' (IoU ' + ap.iou.toFixed(2) + ' vs the face-predicted body box) — picked by anchor overlap, not by size.</p>';
      }
      inner = card('body silhouette', h);
    }
    else if (r.silhouette_error === 'pending')
      inner = card('body silhouette',
        '<p class="note">outline not loaded — tap <b>outline</b> above the preview to trace it (the segmentation model loads on demand).</p>');
    else inner = card('body silhouette',
      '<p class="note">segmentation unavailable for this photo — skeleton only.</p>');
    return '<div id="silcard">' + inner + '</div>';
  }

  function renderChips() {
    const box = $('chipsA');
    box.innerHTML = '';
    const has = faces.length > 0;
    const title = $('facecardTitle');
    if (title) title.textContent = has ? 'faces detected' : 'photo';
    const sn = $('subjectNote');
    if (sn) sn.style.display = has ? '' : 'none';
    faces.forEach((f, i) => {
      const b = document.createElement('button');
      b.className = 'chip' + (i === faceA ? ' on' : '');
      b.textContent = 'face ' + (i + 1) + ' (' + f.score.toFixed(2) + ')';
      b.onclick = () => {
        faceA = i;
        renderChips(); drawPreview();
        if (hasRun) run();
      };
      box.appendChild(b);
    });
  }

  /* ---------------- hand trace (body region guide) ---------------- */
  // The user finger-draws the body outline on the photo. The polygon (photo
  // px) becomes the initial search-region guide for the body-symmetry and
  // breast-telemetry instruments. No model needed — this path works even
  // where the segmentation model gets jetsam-killed.

  function syncTraceUI() {
    const t = $('traceToggle'), c = $('traceClear');
    if (t) {
      t.textContent = traceMode ? 'tracing… tap to cancel' : 'trace body';
      t.classList.toggle('on', traceMode);
    }
    if (c) c.classList.toggle('hidden', !bodyTrace);
  }

  function setTraceMode(on) {
    traceMode = on && !!photo;
    traceStroke = null;
    const cv = $('preview');
    cv.style.touchAction = traceMode ? 'none' : '';
    cv.style.cursor = traceMode ? 'crosshair' : '';
    syncTraceUI();
    if (traceMode)
      uploadStatus('draw the body outline with your finger — lift to finish. One continuous loop is best.');
  }

  // Pointer event -> photo pixel coordinates. Robust to CSS scaling via
  // getBoundingClientRect (the canvas is max-width:100%).
  function canvasToPhoto(e) {
    const cv = $('preview');
    const r = cv.getBoundingClientRect();
    const k = cv.width / photo.w; // canvas px per photo px (drawPreview's scale)
    const cx = (e.clientX - r.left) * (cv.width / Math.max(1, r.width));
    const cy = (e.clientY - r.top) * (cv.height / Math.max(1, r.height));
    return [cx / k, cy / k];
  }

  function traceDown(e) {
    if (!traceMode || !photo) return;
    e.preventDefault();
    const cv = $('preview');
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* best-effort */ }
    drawPreview(); // clean base; segments draw incrementally from here
    traceStroke = [canvasToPhoto(e)];
  }

  function traceMove(e) {
    if (!traceMode || !traceStroke || !photo) return;
    e.preventDefault();
    const [x, y] = canvasToPhoto(e);
    const last = traceStroke[traceStroke.length - 1];
    const cv = $('preview'), k = cv.width / photo.w;
    if (Math.hypot((x - last[0]) * k, (y - last[1]) * k) < 3) return; // 3 canvas-px spacing
    traceStroke.push([x, y]);
    const ctx = cv.getContext('2d');
    ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(last[0] * k, last[1] * k);
    ctx.lineTo(x * k, y * k);
    ctx.stroke();
  }

  async function traceUp() {
    if (!traceMode || !traceStroke) return;
    const pts = traceStroke;
    traceStroke = null;
    setTraceMode(false);
    if (pts.length < 4) { drawPreview(); uploadStatus('trace too short — try again.'); return; }
    const simple = simplifyStroke(pts, Math.max(2, photo.w / 500));
    const chk = traceUsable({ points: simple }, photo.w, photo.h);
    if (!chk.usable) {
      drawPreview();
      uploadStatus('trace rejected: ' + chk.reason + ' — try again.', true);
      return;
    }
    bodyTrace = { points: simple };
    try {
      await idbPut('trace', { photoName, w: photo.w, h: photo.h, points: simple });
    } catch (_) { /* best-effort */ }
    syncTraceUI();
    drawPreview();
    uploadStatus('trace saved — ' + chk.points + ' points, ' +
      Math.round(chk.area_fraction * 100) + '% of frame. Body & breast instruments will use it as their search region.');
  }

  function traceCancel() {
    traceStroke = null;
    if (traceMode) setTraceMode(false);
    if (photo) drawPreview();
  }

  async function clearTrace() {
    bodyTrace = null;
    try { await idbPut('trace', null); } catch (_) { /* best-effort */ }
    syncTraceUI();
    if (photo) drawPreview();
    uploadStatus('trace cleared.');
  }

  // Re-attach a stored trace when the same photo is picked again (or the
  // page reloaded after a pre-run crash). Keyed on photo name + dimensions.
  async function restoreTrace() {
    bodyTrace = null;
    try {
      const t = await idbGet('trace');
      if (t && t.photoName === photoName && t.w === photo.w && t.h === photo.h &&
          traceUsable({ points: t.points }, photo.w, photo.h).usable) {
        bodyTrace = { points: t.points };
        uploadStatus('photo ready — restored your traced outline. Pick instruments and run.');
      }
    } catch (_) { /* best-effort */ }
    syncTraceUI();
  }

  /* ---------------- main flow ---------------- */

  async function handleFile(file) {
    if (!file) return;
    // A report JSON picked through the photo dropzone (easy to do on a phone)
    // routes to the importer instead of failing silently.
    const looksJson = /\.json$/i.test(file.name || '') || (file.type || '').includes('json');
    if (looksJson) {
      try {
        const text = await file.text();
        if (window.__wbImportText) window.__wbImportText(text);
        else $('runstate').textContent = 'import module did not load — reload the page and try again.';
      } catch (e) { $('runstate').textContent = 'could not read file: ' + (e.message || e); }
      return;
    }
    if (!file.type.startsWith('image/')) {
      $('runstate').textContent = 'not an image — pick a photo, or use import JSON below for report files.';
      return;
    }
    $('runstate').textContent = 'reading photo…';
    $('report').innerHTML = '';
    $('exportcard').classList.add('hidden');
    $('resumecard').classList.add('hidden');
    hasRun = false;
    runState = null;
    window.__wbTelePng = null; // stale annotated PNGs never survive a new photo
    try {
      photo = await readPhoto(file);
      photoName = (file && file.name) || 'upload';
      resetPhotoState();
      // Models load lazily per selected instrument at run time — nothing
      // downloads on upload anymore. Release anything the previous photo's
      // run left resident before swapping managers: dropping the manager
      // alone would orphan the native sessions (ort WASM heap, MediaPipe
      // graphs) without calling their release/close.
      if (modelMgr) { try { await modelMgr.releaseAll(); } catch (e) {} }
      modelMgr = buildModelManager();
      await idbDel('current'); // a new photo invalidates any old resume record
      await restoreTrace(); // re-attach the hand trace if this exact photo was traced before
      drawPreview();
      renderChips(); // sets the photo card title ("photo" vs "faces detected")
      $('facecard').classList.remove('hidden'); // the photo is visible immediately — trace before run
      $('runcard').classList.remove('hidden'); // instruments were hidden by resetPhotoState() above
      $('runstate').textContent = 'photo ready — pick instruments and run.';
      uploadStatus('photo ready — pick instruments and run.');
      setBar(0);
    } catch (e) {
      // Upload errors must be READABLE on a phone: unhide the run card and
      // write the message + stack in plain text, mirrored into the
      // always-visible upload line (2026-09-22 phone-debugging fix).
      const msg = (e && e.message) || String(e);
      const stack = (e && e.stack) ? '\n' + String(e.stack).slice(0, 1200) : '';
      $('runcard').classList.remove('hidden');
      $('runstate').innerHTML = '<span class="err">upload failed: ' + esc(msg) +
        (stack ? '<br>' + esc(stack) : '') + '</span>';
      uploadStatus(msg + stack, true);
    }
  }

  // Per-photo analysis state. Called on new photo; faces stay empty until
  // the run's detection step fills them.
  function resetPhotoState() {
    faces = []; faceA = 0;
    poseRaw = null; poseTried = false;
    silCache = null; silTried = false;
    anchorCache = {};
    bodyTrace = null; traceMode = false; traceStroke = null;
    lastBodyResult = null;
    bodyView = 'skeleton'; syncBodyViewCtl();
    syncTraceUI();
    $('facecard').classList.add('hidden');
    $('runcard').classList.add('hidden');
  }

  /* ---------------- crash resume (IndexedDB) ---------------- */
  // The run persists the photo (downscaled JPEG), the selection, and each
  // finished instrument's card as it goes. If iOS jetsams the tab mid-run,
  // the next page load offers a one-tap resume: finished cards are restored
  // and only the remaining instruments run.
  const IDB_NAME = 'workbench', IDB_STORE = 'runs';
  let idb = null;
  function openDb() {
    return new Promise((resolve, reject) => {
      if (idb) return resolve(idb);
      try {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
        req.onsuccess = () => { idb = req.result; resolve(idb); };
        req.onerror = () => reject(req.error);
      } catch (e) { reject(e); }
    });
  }
  function idbPut(key, val) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }
  function idbGet(key) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const rq = tx.objectStore(IDB_STORE).get(key);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    }));
  }
  function idbDel(key) {
    return idbPut(key, null).then(() => openDb().then(db => new Promise(resolve => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve(); // best-effort
    }))).catch(() => {});
  }

  // Downscaled JPEG of the working photo for the resume record.
  function photoJpeg(maxEdge) {
    const full = document.createElement('canvas');
    full.width = photo.w; full.height = photo.h;
    const fctx = full.getContext('2d');
    const img = fctx.createImageData(photo.w, photo.h);
    for (let i = 0, j = 0; i < photo.rgb.length; i += 3, j += 4) {
      img.data[j] = photo.rgb[i]; img.data[j + 1] = photo.rgb[i + 1];
      img.data[j + 2] = photo.rgb[i + 2]; img.data[j + 3] = 255;
    }
    fctx.putImageData(img, 0, 0);
    const sc = Math.min(1, maxEdge / Math.max(photo.w, photo.h));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(photo.w * sc));
    cv.height = Math.max(1, Math.round(photo.h * sc));
    cv.getContext('2d').drawImage(full, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', 0.85);
  }

  // Live run state. done/order/html drive both the visible report and the
  // resume record; rep accumulates the export JSON.
  let runState = null;
  const REP_KEY = { age: 'age', tele: 'telemetry', body: 'body_telemetry', bust: 'breast_telemetry' };

  async function persist() {
    if (!runState || !photo) return;
    try {
      await idbPut('current', {
        v: 1,
        photoJpeg: photoJpeg(1024), photoName,
        instruments: runState.sel, faceA,
        faces: sanitizeFaces(faces),
        done: [...runState.done], order: runState.order, html: runState.html,
        rep: runState.rep, telePng: window.__wbTelePng || null,
        trace: bodyTrace, // hand-traced body region guide, restored on resume
        startedAt: runState.startedAt, savedAt: Date.now(),
      });
    } catch (e) { /* resume is best-effort; never break the run */ }
  }

  // Record one finished instrument: append its card in run order, persist.
  function completeInstrument(key, cardHtml, repValue) {
    runState.html[key] = cardHtml;
    runState.order.push(key);
    runState.rep.instruments[REP_KEY[key]] = repValue;
    if (key === 'body' && repValue && !repValue.error) lastBodyResult = repValue;
    $('report').innerHTML = orderReportHtml(runState.order, runState.html);
  }

  /* ---------------- run ---------------- */

  async function runInstrument(inst) {
    if (inst === 'age') {
      $('runstate').textContent = 'running age estimation…';
      const attr = await attrFor(faceA); // genderage 2nd opinion; null on failure
      if (attr) runState.rep.face_a_attributes = {
        sex: attr.gender, genderage_age: attr.age,
        detection_score: +faces[faceA].score.toFixed(4),
      };
      const r = await instrumentAge(faceA);
      completeInstrument('age', renderAge(r, attr && { age: attr.age, sex: attr.gender }, faceA), r);
    } else if (inst === 'tele') {
      $('runstate').textContent = 'running facial telemetry…';
      try {
        const r = await instrumentTelemetry(faceA);
        completeInstrument('tele', renderTelemetry(r, faceA), r);
      } catch (e) {
        completeInstrument('tele',
          card('facial telemetry', '<p class="note err">telemetry failed: ' + esc(e.message || e) + '</p>'),
          { error: String(e.message || e) });
      }
    } else if (inst === 'body') {
      $('runstate').textContent = 'running body telemetry…';
      try {
        const r = await instrumentBody();
        completeInstrument('body',
          renderBody(r, RATIO_KEYS, ratioLabel) + renderAnchor(r) + renderSilhouette(r), r);
      } catch (e) {
        completeInstrument('body',
          card('body telemetry', '<p class="note err">body telemetry failed: ' + esc(e.message || e) + '</p>'),
          { error: String(e.message || e) });
      }
    } else if (inst === 'bust') {
      $('runstate').textContent = 'running breast telemetry…';
      try {
        const r = await instrumentBreast(photoName);
        completeInstrument('bust', renderBreast(r, photo ? photo.img : null), r);
      } catch (e) {
        completeInstrument('bust',
          card('breast telemetry', '<p class="note err">breast telemetry failed: ' + esc(e.message || e) + '</p>'),
          { error: String(e.message || e) });
      }
    }
  }

  async function run() {
    if (!photo) return;
    hideResumeCard();
    await runPlan(null);
  }

  // saved: null for a fresh run, or the IDB record when resuming.
  async function runPlan(saved) {
    $('run').disabled = true;
    const sel = saved ? saved.instruments : {
      age: $('tAge').checked, tele: $('tTele').checked,
      body: $('tBody').checked, bust: $('tBust').checked,
    };
    if (!saved) {
      runState = {
        sel, done: new Set(), order: [], html: {},
        rep: {
          generated_at: new Date().toISOString(),
          tool: 'workbench',
          faces_detected: faces.length,
          subject_a: faceA,
          instruments: {},
        },
        startedAt: Date.now(),
      };
      $('report').innerHTML = '';
      setBar(0);
    }
    try {
      // Face detection, only when a selected instrument needs faces. The
      // model releases immediately after — faces are plain data from here.
      // Body-only runs skip detection entirely.
      if ((sel.age || sel.tele || sel.bust) && !faces.length) {
        $('runstate').textContent = 'loading face detection…';
        await modelMgr.ensure('det');
        try {
          const dh = detH();
          // detectFaces expects the shared {det: session} shape (kinship
          // pipeline contract) — not the bare session.
          faces = await P.detectFaces({ det: dh.session }, dh.names, photo.rgb, photo.w, photo.h);
          faceA = 0;
          runState.rep.faces_detected = faces.length;
          $('facecard').classList.remove('hidden');
          renderChips(); drawPreview();
        } finally {
          await modelMgr.release('det');
        }
        await persist();
      }
      if (!faces.length && !sel.body && !sel.bust) {
        $('runstate').textContent = 'no face detected in this photo';
        await idbDel('current');
        return;
      }
      $('runcard').classList.remove('hidden');
      if (faces.length) { renderChips(); drawPreview(); }
      // Age/telemetry need a detected face; body/breast don't.
      const effSel = {
        age: sel.age && faces.length > 0, tele: sel.tele && faces.length > 0,
        body: sel.body, bust: sel.bust,
      };
      const plan = planLifecycle(effSel);
      const total = plan.steps.filter(s => !runState.done.has(s.instrument)).length;
      const denom = runState.done.size + total; // fixed: completed + remaining
      const tick = () => setBar(denom ? runState.done.size / denom : 1,
        runState.done.size + '/' + denom + ' instruments');
      tick();
      $('runstate').textContent = faces.length
        ? faces.length + ' face' + (faces.length > 1 ? 's' : '') + ' detected — running…'
        : 'body-only mode — running…';
      await runPlannedSteps(plan, runState.done, {
        ensure: m => modelMgr.ensure(m),
        release: m => modelMgr.release(m),
        runInstrument,
        onInstrumentDone: async () => { tick(); await persist(); },
      });
      // Finished: publish the report, drop the resume record.
      lastReport = runState.rep;
      window.__wbLastReport = runState.rep; // shared with import.js (export after import)
      hasRun = true;
      if (poseRaw || silCache) drawPreview(); // overlay the body figure(s) on the preview
      $('exportcard').classList.remove('hidden');
      const dlp = $('dltelepng');
      if (dlp) dlp.style.display = window.__wbTelePng ? '' : 'none';
      $('runstate').textContent = 'done.';
      setBar(1, 'done — everything runs on your device');
      await idbDel('current');
      runState = null;
    } catch (e) {
      $('runstate').innerHTML = '<span class="err">run failed: ' + esc(e.message || e) + '</span>';
      console.error(e);
      await persist(); // leave the resume record behind for the next load
    }
    $('run').disabled = false;
  }

  /* ---------------- resume ---------------- */

  function hideResumeCard() { $('resumecard').classList.add('hidden'); }

  async function checkResume() {
    let rec = null;
    try { rec = await idbGet('current'); } catch (e) { return; }
    if (!rec || !rec.photoJpeg) return;
    const rem = remainingInstruments(rec.instruments || {}, rec.done || []);
    if (!rem.length) { idbDel('current'); return; } // completed run; stale record
    $('resumemsg').textContent = describeResume(rec);
    $('resumecard').classList.remove('hidden');
    $('resumeyes').onclick = () => resumeRun(rec);
    $('resumeno').onclick = async () => { await idbDel('current'); hideResumeCard(); };
  }

  async function resumeRun(rec) {
    hideResumeCard();
    $('runstate').textContent = 'restoring interrupted run…';
    try {
      photo = await photoFromDataUrl(rec.photoJpeg);
      photoName = rec.photoName || 'upload';
      resetPhotoState();
      if (modelMgr) { try { await modelMgr.releaseAll(); } catch (e) {} }
      modelMgr = buildModelManager();
      // Restore the selection checkboxes to the interrupted run's.
      $('tAge').checked = !!rec.instruments.age;
      $('tTele').checked = !!rec.instruments.tele;
      $('tBody').checked = !!rec.instruments.body;
      $('tBust').checked = !!rec.instruments.bust;
      faces = rec.faces || [];
      faceA = rec.faceA || 0;
      bodyTrace = (rec.trace && traceUsable({ points: rec.trace.points }, photo.w, photo.h).usable)
        ? { points: rec.trace.points } : null;
      syncTraceUI();
      runState = {
        sel: rec.instruments, done: new Set(rec.done || []),
        order: rec.order || [], html: rec.html || {},
        rep: rec.rep, startedAt: rec.startedAt || Date.now(),
      };
      if (rec.telePng) window.__wbTelePng = rec.telePng;
      const bodyRep = runState.rep.instruments && runState.rep.instruments.body_telemetry;
      if (bodyRep && !bodyRep.error) lastBodyResult = bodyRep;
      $('facecard').classList.remove('hidden');
      $('report').innerHTML = orderReportHtml(runState.order, runState.html);
      drawPreview();
      hasRun = true;
      await runPlan(rec);
    } catch (e) {
      $('runstate').innerHTML = '<span class="err">could not resume: ' + esc(e.message || e) + '</span>';
      await idbDel('current');
    }
  }

  /* ---------------- export ---------------- */

  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /* ---------------- wiring ---------------- */

  uploadStatus('build 20260922h — pick a photo to begin.');
  const drop = $('drop'), fileInput = $('file');
  drop.onclick = () => fileInput.click();
  drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
  fileInput.onchange = () => {
    // Mark the moment the change event fires, BEFORE any await. If a tapped
    // photo leaves the page stuck with no "photo chosen" line, the event
    // never fired; if the line appears and then dies, handleFile threw.
    uploadStatus('photo chosen — reading…');
    const f = fileInput.files[0];
    if (f) handleFile(f);
  };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => {
    e.preventDefault(); drop.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) { uploadStatus('photo chosen — reading…'); handleFile(f); }
  };
  document.addEventListener('paste', e => {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (item) handleFile(item.getAsFile());
  });
  $('run').onclick = run;
  // hand trace controls: the trace button toggles finger-draw mode on the
  // preview canvas; the clear button drops the stored trace.
  $('traceToggle').onclick = () => setTraceMode(!traceMode);
  $('traceClear').onclick = clearTrace;
  const pvc = $('preview');
  pvc.addEventListener('pointerdown', traceDown);
  pvc.addEventListener('pointermove', traceMove);
  pvc.addEventListener('pointerup', traceUp);
  pvc.addEventListener('pointercancel', traceCancel);
  // body overlay segmented control (outline / skeleton / both)
  function syncBodyViewCtl() {
    document.querySelectorAll('#bodyViewCtl .chip').forEach(b =>
      b.classList.toggle('on', b.dataset.v === bodyView));
  }
  document.querySelectorAll('#bodyViewCtl .chip').forEach(b => {
    b.onclick = async () => {
      bodyView = b.dataset.v; syncBodyViewCtl();
      // Outline loads on demand: the segmentation model + a full-res GPU
      // inference is what got iOS Safari Jetsam-killed during the run.
      if ((bodyView === 'outline' || bodyView === 'both') && !silTried && photo) {
        $('runstate').textContent = 'loading segmentation model…';
        let sil = null;
        try { sil = await ensureSilhouetteRaw(); } catch (e) { sil = null; }
        if (sil && sil.contour && lastBodyResult) {
          lastBodyResult.silhouette = silhouetteMetrics(sil.mask, sil.w, sil.h, poseRaw);
          lastBodyResult.silhouette_error = null;
          lastBodyResult.silhouette_anchor = sil.anchorPick || null;
          lastBodyResult.has_outline = true;
          lastBodyResult.model += ' + ImageSegmenter (selfie_multiclass_256x256)';
          try { lastBodyResult.pose_png_dataurl = buildBodyExportPng(); } catch (e) {}
          const sc = $('silcard');
          if (sc) sc.outerHTML = renderSilhouette(lastBodyResult);
          $('runstate').textContent = 'done.';
        } else {
          if (lastBodyResult) {
            lastBodyResult.silhouette_error = 'unavailable';
            const sc = $('silcard');
            if (sc) sc.outerHTML = renderSilhouette(lastBodyResult);
          }
          $('runstate').textContent = 'outline unavailable on this device — skeleton only.';
        }
        // The toggle's inference is done and its result is cached — release
        // the segmentation model; it is outside every run plan.
        try { await modelMgr.release('seg'); } catch (e) {}
      }
      if (photo) drawPreview();
    };
  });
  syncBodyViewCtl();
  // (the import card is wired by import.js, a standalone module)
  $('copyjson').onclick = async () => {
    const rep = window.__wbLastReport || lastReport;
    try {
      await navigator.clipboard.writeText(JSON.stringify(rep, null, 2));
      $('exportstate').textContent = 'copied.';
    } catch (e) { $('exportstate').textContent = 'copy failed: ' + e.message; }
  };
  $('dljson').onclick = () => {
    download('workbench-report.json', JSON.stringify(window.__wbLastReport || lastReport, null, 2));
    $('exportstate').textContent = 'downloaded.';
  };
  // annotated telemetry PNG (guidelines baked in) — shown only when the
  // facial telemetry instrument produced one this run
  const dlp = $('dltelepng');
  if (dlp) {
    dlp.style.display = 'none';
    dlp.onclick = () => {
      const t = window.__wbTelePng;
      if (!t) { $('exportstate').textContent = 'no annotated telemetry this run.'; return; }
      // iOS Safari ignores the download attribute on data: URLs — a
      // programmatic click navigates the whole page to the image instead of
      // downloading it. Open a new tab there (long-press to save to Photos).
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
      if (isIOS) {
        window.open(t.dataUrl, '_blank');
        $('exportstate').textContent = 'opened in a new tab — long-press the image to save it.';
        return;
      }
      const a = document.createElement('a');
      a.href = t.dataUrl;
      a.download = 'workbench-telemetry-face' + (t.faceIdx + 1) + '-annotated.png';
      document.body.appendChild(a); a.click(); a.remove();
      $('exportstate').textContent = 'downloaded.';
    };
  }
  // Global error trap (2026-09-22 phone-debugging fix): uncaught errors and
  // unhandled rejections append into the always-visible #uploadstate via
  // showGlobalError, which also unhides #runcard. Append, never clobber.
  window.addEventListener('error', e => showGlobalError('error', e.error || e.message));
  window.addEventListener('unhandledrejection', e => {
    $('runstate').innerHTML = '<span class="err">error: ' +
      esc(String((e.reason && e.reason.message) || e.reason || e)) + '</span>';
    showGlobalError('unhandledrejection', e.reason);
  });

  setBar(0, 'warming up…');
  // The model manager is the only owner of model sessions. It starts empty:
  // nothing downloads until a run's plan loads what the selected instruments
  // need. A previous tab-death leaves a resume record in IndexedDB — offer
  // the one-tap resume.
  modelMgr = buildModelManager();
  checkResume();
  window.__wbAppBooted = true; // lets import.js know the photo pipeline is alive
})();
