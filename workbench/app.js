/* workbench — one photo, every instrument.
 *
 * Shared pipeline: SCRFD face detection (kinship's buffalo_l port) runs once.
 * The detected faces fan out to:
 *   - age estimation  (ViT bracket classifier via transformers.js)
 *   - facial telemetry (MediaPipe FaceLandmarker, same 17-ratio vector as the lab)
 * Everything runs on-device. Nothing is uploaded.
 */
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';
import { ensureLandmarker, landmarkerError, landmarkerDelegate, detectError, detectLandmarks, measureImage } from '../attraction/js/measure.js';
import { measureBreastTelemetry, validateBreastTelemetry, poseCrossCheck } from '../attraction/js/breast.js?v=20260920e';
import { esc, card, renderBreast, renderAge, renderTelemetry, renderBody } from './render.js?v=20260920e';
import { ensurePose, measureImage as measureBodyImage, drawSkeleton, SKELETON, RATIO_KEYS, ratioLabel } from '../attraction/js/body.js?v=20260920e';
import { computeFaceOverlayData, annotatedPngDataUrl } from './face-overlay.js';

(function () {
  'use strict';
  const P = window.KinshipPipeline;
  ort.env.wasm.numThreads = 1; // no COOP/COEP on Pages -> single-threaded wasm
  env.allowRemoteModels = true;

  const $ = id => document.getElementById(id);

  /* ---------------- constants ---------------- */

  const KIN_URLS = {
    det: '../kinship/models/det_10g.onnx',
    ga: '../kinship/models/genderage.onnx',
    rec: 'https://huggingface.co/immich-app/buffalo_l/resolve/main/recognition/model.onnx',
  };
  const KIN_SIZES = { det: 16923827, ga: 1322532, rec: 174383860 };

  const AGE_MODEL_ID = 'onnx-community/fairface_age_image_detection-ONNX';
  const AGE_LABELS = ['0-2', '3-9', '10-19', '20-29', '30-39', '40-49', '50-59', '60-69', 'more than 70'];
  const AGE_MIDPOINTS = [1, 6, 14.5, 24.5, 34.5, 44.5, 54.5, 64.5, 78];

  /* ---------------- state ---------------- */

  let kSessions = null, kNames = null, detectReady = false;
  let ageClassifier = null, ageReady = false;
  let teleReady = false;

  let photo = null;          // {rgb, w, h, img}
  let photoName = 'upload';
  let faces = [];            // SCRFD faces, largest-first
  let faceA = 0;
  let embedCache = {};       // faceIndex -> embedFace result
  let lastReport = null;
  let hasRun = false;
  let poseRaw = null, poseTried = false; // per-photo MediaPipe pose landmarks (33, normalized)

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
  const wrap = s => ({
    run: feeds => queuedRun(() => {
      const real = {};
      for (const [k, v] of Object.entries(feeds)) real[k] = T(v.data, v.dims);
      return s.run(real);
    }),
  });

  // Stage 1 (upload): det + gender/age only — both local, ~18MB, fast.
  // The 174MB HuggingFace recognition model loads lazily via ensureRec(),
  // only when the age instrument's 2nd-opinion embedding is actually
  // requested. Eagerly fetching it blocked every upload on it.
  async function loadDetect(onp) {
    const total = KIN_SIZES.det + KIN_SIZES.ga;
    let done = 0;
    const seen = { det: 0, ga: 0 };
    const prog = (key, got) => {
      done += got - seen[key]; seen[key] = got;
      onp(done / total);
    };
    const mk = async (key, url) => {
      const buf = await fetchBuf(url, KIN_SIZES[key], g => prog(key, g));
      return ort.InferenceSession.create(buf);
    };
    const [det, ga] = await Promise.all(['det', 'ga'].map(k => mk(k, KIN_URLS[k])));
    kSessions = { det: wrap(det), ga: wrap(ga) };
    kNames = {
      detIn: det.inputNames[0], detOut: det.outputNames,
      gaIn: ga.inputNames[0], gaOut: ga.outputNames[0],
    };
    detectReady = true;
  }

  // Stage 2 (lazy): the remote recognition model. Single shared promise so
  // concurrent embedding requests don't double-download; resets on failure
  // so a stall error is retryable. Only fetched when the age instrument's
  // 2nd-opinion embedding is actually requested.
  let recPromise = null;
  function ensureRec(onp) {
    if (kSessions.rec) return Promise.resolve();
    if (!recPromise) {
      recPromise = (async () => {
        const buf = await fetchBuf(KIN_URLS.rec, KIN_SIZES.rec,
          (got, total) => onp && onp(total ? got / total : 0));
        const rec = await ort.InferenceSession.create(buf);
        kSessions.rec = wrap(rec);
        kNames.recIn = rec.inputNames[0];
        kNames.recOut = rec.outputNames[0];
      })().catch(e => { recPromise = null; throw e; });
    }
    return recPromise;
  }

  async function loadAge(onStatus) {
    onStatus('loading age model…');
    ageClassifier = await pipeline('image-classification', AGE_MODEL_ID, {
      dtype: 'q4f16',
      progress_callback: ev => {
        if (ev.status === 'progress' && ev.progress != null)
          onStatus('loading age model… ' + ev.progress.toFixed(0) + '%');
      },
    });
    ageReady = true;
  }

  async function loadTelemetry(onStatus) {
    const lm = await ensureLandmarker(onStatus);
    if (!lm) throw new Error('landmark model failed to load (' + (landmarkerError() || 'unknown reason') + ')');
    teleReady = true;
  }

  function setBar(pct, msg) {
    $('modelfill').style.width = (pct * 100).toFixed(1) + '%';
    if (msg) $('modelmsg').textContent = msg;
  }

  /* ---------------- photo intake ---------------- */

  function readPhoto(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => {
        const MAXD = 1600;
        const sc = Math.min(1, MAXD / Math.max(im.naturalWidth, im.naturalHeight));
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
        URL.revokeObjectURL(url);
        resolve({ rgb, w, h, img: im });
      };
      im.onerror = () => reject(new Error('could not read image'));
      im.src = url;
    });
  }

  // Expanded square crop around a face bbox, returned as a canvas.
  function faceCropCanvas(face, size) {
    const [x1, y1, x2, y2] = face.bbox;
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    let side = Math.max(x2 - x1, y2 - y1) * 1.5;
    let sx = Math.max(0, cx - side / 2), sy = Math.max(0, cy - side / 2);
    side = Math.min(side, photo.w - sx, photo.h - sy);
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

  /* ---------------- instruments ---------------- */

  async function instrumentAge(faceIdx) {
    if (!ageReady) await loadAge(m => { $('runstate').textContent = m; });
    const crop = faceCropCanvas(faces[faceIdx], 224);
    const out = await ageClassifier(crop, { top_k: 9 });
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
    if (!teleReady) {
      await loadTelemetry(m => { $('runstate').textContent = m; });
    }
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
    const rep = measureBreastTelemetry(photo.rgb, photo.w, photo.h, fileName,
      faces.map(f => f.bbox), pose);
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
  // gating here — poseCrossCheck degrades per-check on its own.
  async function ensurePoseRaw() {
    if (poseTried) return poseRaw;
    poseTried = true;
    try {
      const lm = await ensurePose(m => { $('runstate').textContent = m; });
      if (!lm) return null;
      const res = lm.detect(photo.img);
      const poses = res.landmarks || res.poseLandmarks || [];
      poseRaw = (poses.length && poses[0].length) ? poses[0] : null;
    } catch (e) { poseRaw = null; }
    return poseRaw;
  }

  async function instrumentBody() {
    $('runstate').textContent = 'estimating body pose…';
    const raw = await ensurePoseRaw();
    if (!raw) return { error: 'no pose detected in this photo' };
    // Strict full-body ratios (the body-metrics lab path: needs
    // shoulders-through-ankles); the stick figure draws from raw regardless.
    let strict = null;
    try { strict = await measureBodyImage(photo.img); }
    catch (e) { strict = { ok: false, skip_reason: String((e && e.message) || e) }; }
    const full = document.createElement('canvas');
    drawSkeleton(full, photo.img, raw);
    const MAXS = 900, sc = Math.min(1, MAXS / Math.max(full.width, full.height));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(full.width * sc));
    cv.height = Math.max(1, Math.round(full.height * sc));
    cv.getContext('2d').drawImage(full, 0, 0, cv.width, cv.height);
    return {
      pose_png_dataurl: cv.toDataURL('image/png'),
      ratios: strict.ok ? strict.ratios : null,
      visibility: strict.visibility || null,
      warnings: strict.warnings || [],
      skip_reason: strict.ok ? null : (strict.skip_reason || 'pose incomplete'),
      model: 'MediaPipe PoseLandmarker (pose_landmarker_lite, float16)',
      method: '33 landmarks → 9 segment lengths + 7 scale-invariant ratios, same definitions as the body-metrics lab',
    };
  }

  async function embeddingFor(idx) {
    if (!embedCache[idx]) {
      // Recognition model loads here, on demand — progress goes to runstate.
      await ensureRec(p => {
        $('runstate').textContent = 'loading face-recognition model (174MB, one-time)… ' +
          (p * 100).toFixed(0) + '%';
      });
      embedCache[idx] = await P.embedFace(kSessions, kNames, photo.rgb, photo.w, photo.h, faces[idx]);
    }
    return embedCache[idx];
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
    // pose stick figure, when a run produced one
    if (poseRaw) {
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
  }

  function renderChips() {
    const box = $('chipsA');
    box.innerHTML = '';
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
    hasRun = false;
    window.__wbTelePng = null; // stale annotated PNGs never survive a new photo
    try {
      photo = await readPhoto(file);
      photoName = (file && file.name) || 'upload';
      faces = []; embedCache = {}; faceA = 0;
      poseRaw = null; poseTried = false; // fresh pose per photo
      if (!detectReady) {
        setBar(0, 'loading detection models…');
        await loadDetect(pct => setBar(pct, 'loading detection models… ' + (pct * 100).toFixed(0) + '%'));
        setBar(1, 'detection models ready — everything runs on your device');
      }
      $('runstate').textContent = 'detecting faces…';
      faces = await P.detectFaces(kSessions, kNames, photo.rgb, photo.w, photo.h);
      const noFaceMode = !faces.length && ($('tBust').checked || $('tBody').checked);
      if (!faces.length && !noFaceMode) {
        $('runstate').textContent = 'no face detected in this photo';
        return;
      }
      faceA = 0;
      $('facecard').classList.remove('hidden');
      $('runcard').classList.remove('hidden');
      renderChips(); drawPreview();
      $('runstate').textContent = faces.length + ' face' + (faces.length > 1 ? 's' : '') +
        ' detected' + (noFaceMode ? ' — body-only mode (breast / body telemetry need no face)' : ' — pick instruments and run.');
    } catch (e) {
      $('runstate').innerHTML = '<span class="err">' + esc(e.message || e) + '</span>';
    }
  }

  async function run() {
    if (!photo || !detectReady) return;
    $('run').disabled = true;
    const wantAge = $('tAge').checked && faces.length > 0;
    const wantTele = $('tTele').checked && faces.length > 0;
    const wantBody = $('tBody').checked;
    const wantBust = $('tBust').checked;
    const rep = {
      generated_at: new Date().toISOString(),
      tool: 'workbench',
      faces_detected: faces.length,
      subject_a: faceA,
      instruments: {},
    };
    let html = '';
    try {
      // embeddings first: feeds the face card's 2nd-opinion age
      let emb = null;
      if (wantAge) {
        $('runstate').textContent = 'extracting face embedding…';
        emb = await embeddingFor(faceA);
        rep.face_a_attributes = { sex: emb.sex, genderage_age: emb.age, detection_score: +faces[faceA].score.toFixed(4) };
      }
      if (wantAge) {
        $('runstate').textContent = 'running age estimation…';
        const r = await instrumentAge(faceA);
        rep.instruments.age = r;
        html += renderAge(r, emb, faceA);
        $('report').innerHTML = html;
      }
      if (wantTele) {
        $('runstate').textContent = 'running facial telemetry…';
        try {
          const r = await instrumentTelemetry(faceA);
          rep.instruments.telemetry = r;
          html += renderTelemetry(r, faceA);
        } catch (e) {
          html += card('facial telemetry', '<p class="note err">telemetry failed: ' + esc(e.message || e) + '</p>');
          rep.instruments.telemetry = { error: String(e.message || e) };
        }
        $('report').innerHTML = html;
      }
      if (wantBody) {
        $('runstate').textContent = 'running body telemetry…';
        try {
          const r = await instrumentBody();
          rep.instruments.body_telemetry = r;
          html += renderBody(r, RATIO_KEYS, ratioLabel);
        } catch (e) {
          html += card('body telemetry', '<p class="note err">body telemetry failed: ' + esc(e.message || e) + '</p>');
          rep.instruments.body_telemetry = { error: String(e.message || e) };
        }
        $('report').innerHTML = html;
      }
      if (wantBust) {
        try {
          const r = await instrumentBreast(photoName);
          rep.instruments.breast_telemetry = r;
          html += renderBreast(r, photo ? photo.img : null);
        } catch (e) {
          html += card('breast telemetry', '<p class="note err">breast telemetry failed: ' + esc(e.message || e) + '</p>');
          rep.instruments.breast_telemetry = { error: String(e.message || e) };
        }
        $('report').innerHTML = html;
      }
      lastReport = rep;
      window.__wbLastReport = rep; // shared with import.js (export after import)
      hasRun = true;
      if (poseRaw) drawPreview(); // overlay the stick figure on the preview
      $('exportcard').classList.remove('hidden');
      const dlp = $('dltelepng');
      if (dlp) dlp.style.display = window.__wbTelePng ? '' : 'none';
      $('runstate').textContent = 'done.';
    } catch (e) {
      $('runstate').innerHTML = '<span class="err">run failed: ' + esc(e.message || e) + '</span>';
      console.error(e);
    }
    $('run').disabled = false;
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

  const drop = $('drop'), fileInput = $('file');
  drop.onclick = () => fileInput.click();
  drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
  fileInput.onchange = () => fileInput.files[0] && handleFile(fileInput.files[0]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => {
    e.preventDefault(); drop.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };
  document.addEventListener('paste', e => {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (item) handleFile(item.getAsFile());
  });
  $('run').onclick = run;
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
      const a = document.createElement('a');
      a.href = t.dataUrl;
      a.download = 'workbench-telemetry-face' + (t.faceIdx + 1) + '-annotated.png';
      document.body.appendChild(a); a.click(); a.remove();
      $('exportstate').textContent = 'downloaded.';
    };
  }
  window.addEventListener('unhandledrejection', e => {
    $('runstate').innerHTML = '<span class="err">error: ' +
      esc(String((e.reason && e.reason.message) || e.reason || e)) + '</span>';
  });

  setBar(0, 'warming up…');
  window.__wbAppBooted = true; // lets import.js know the photo pipeline is alive
})();
