/* workbench — one photo, every instrument.
 *
 * Shared pipeline: SCRFD face detection (kinship's buffalo_l port) runs once.
 * The detected faces fan out to:
 *   - age estimation  (ViT bracket classifier via transformers.js)
 *   - facial telemetry (MediaPipe FaceLandmarker, same 17-ratio vector as the lab)
 *   - kinship        (ArcFace embeddings, A vs B)
 * Everything runs on-device. Nothing is uploaded.
 */
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';
import { ensureLandmarker, measureImage, METRIC_LABELS } from '../attraction/js/measure.js';

(function () {
  'use strict';
  const P = window.KinshipPipeline;
  ort.env.wasm.numThreads = 1; // no COOP/COEP on Pages -> single-threaded wasm
  env.allowRemoteModels = true;

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

  // telemetry metrics worth surfacing in the unified report (full 17 in JSON)
  const TELEMETRY_SHOW = ['width_height_ratio', 'jaw_to_cheek', 'ipd_to_cheek',
    'eye_w_to_h', 'nose_to_cheek', 'mouth_to_cheek', 'lip_fullness',
    'canthal_tilt_mean', 'gonial_angle_mean', 'mean_asymmetry'];

  /* ---------------- state ---------------- */

  let kSessions = null, kNames = null, kinshipReady = false;
  let ageClassifier = null, ageReady = false;
  let teleReady = false;

  let photo = null;          // {rgb, w, h}
  let faces = [];            // SCRFD faces, largest-first
  let faceA = 0, faceB = 1;
  let embedCache = {};       // faceIndex -> embedFace result
  let lastReport = null;
  let hasRun = false;

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
    const r = await fetch(url);
    if (!r.ok) throw new Error('fetch failed: ' + url + ' (' + r.status + ')');
    const total = +(r.headers.get('content-length') || expected || 0);
    const reader = r.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      onp(got, total);
    }
    const buf = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    return buf;
  }

  async function loadKinship(onp) {
    const total = KIN_SIZES.det + KIN_SIZES.ga + KIN_SIZES.rec;
    let done = 0;
    const seen = { det: 0, ga: 0, rec: 0 };
    const prog = (key, got) => {
      done += got - seen[key]; seen[key] = got;
      onp(done / total);
    };
    const mk = async (key, url) => {
      const buf = await fetchBuf(url, KIN_SIZES[key], g => prog(key, g));
      return ort.InferenceSession.create(buf);
    };
    const [det, ga, rec] = await Promise.all(
      ['det', 'ga', 'rec'].map(k => mk(k, KIN_URLS[k])));
    const T = (data, dims) => new ort.Tensor('float32', data, dims);
    const wrap = s => ({
      run: feeds => queuedRun(() => {
        const real = {};
        for (const [k, v] of Object.entries(feeds)) real[k] = T(v.data, v.dims);
        return s.run(real);
      }),
    });
    kSessions = { det: wrap(det), rec: wrap(rec), ga: wrap(ga) };
    kNames = {
      detIn: det.inputNames[0], detOut: det.outputNames,
      recIn: rec.inputNames[0], recOut: rec.outputNames[0],
      gaIn: ga.inputNames[0], gaOut: ga.outputNames[0],
    };
    kinshipReady = true;
  }

  async function loadAge(onStatus) {
    onStatus('loading age model…');
    ageClassifier = await pipeline('image-classification', AGE_MODEL_ID, {
      dtype: 'q4f16',
      progress_callback: ev => {
        if (ev.status === 'progress' && ev.progress != null)
          onStatus('loading age model… ' + (ev.progress * 100).toFixed(0) + '%');
      },
    });
    ageReady = true;
  }

  async function loadTelemetry(onStatus) {
    await ensureLandmarker(onStatus);
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
        resolve({ rgb, w, h });
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
    const img = await cropToImage(faces[faceIdx]);
    const m = measureImage(img);
    if (!m) throw new Error('no landmarks found on the face crop');
    return {
      metrics: m,
      model: 'MediaPipe FaceLandmarker (float16)',
      method: 'same 17-ratio vector as the attraction telemetry lab',
    };
  }

  async function embeddingFor(idx) {
    if (!embedCache[idx])
      embedCache[idx] = await P.embedFace(kSessions, kNames, photo.rgb, photo.w, photo.h, faces[idx]);
    return embedCache[idx];
  }

  async function instrumentKinship() {
    if (faces.length < 2) return { skipped: 'needs two faces in the photo' };
    if (faceA === faceB) return { skipped: 'A and B are the same face' };
    const ea = await embeddingFor(faceA);
    const eb = await embeddingFor(faceB);
    const a = { embedding: ea.embedding, sex: ea.sex, age: ea.age, faces, faceIndex: faceA };
    const b = { embedding: eb.embedding, sex: eb.sex, age: eb.age, faces, faceIndex: faceB };
    const cmp = P.compareResults(a, b);
    return {
      face_a: faceA, face_b: faceB,
      cosine_similarity: cmp.cosine_similarity,
      kinship_confidence: cmp.kinship_confidence,
      verdict: cmp.verdict,
      verdict_note: cmp.verdict_note,
      caveats: cmp.caveats,
      predicted: { a: { sex: ea.sex, age: ea.age }, b: { sex: eb.sex, age: eb.age } },
      calibration: cmp.calibration,
    };
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
      ctx.strokeStyle = i === faceA ? '#7dd3fc' : (i === faceB ? '#a78bfa' : 'rgba(125,211,252,.35)');
      ctx.strokeRect(x1 * scale, y1 * scale, (x2 - x1) * scale, (y2 - y1) * scale);
      ctx.fillStyle = i === faceA ? '#7dd3fc' : (i === faceB ? '#a78bfa' : 'rgba(125,211,252,.6)');
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText(i === faceA ? 'A' : (i === faceB ? 'B' : String(i + 1)),
        x1 * scale + 4, y1 * scale + 16);
    });
  }

  function renderChips() {
    const box = $('chipsA');
    box.innerHTML = '';
    faces.forEach((f, i) => {
      const b = document.createElement('button');
      b.className = 'chip' + (i === faceA ? ' on' : '');
      b.textContent = 'face ' + (i + 1) + ' (' + f.score.toFixed(2) + ')' + (i === faceB ? ' · B' : '');
      b.onclick = () => {
        faceA = i;
        if (faceB === faceA) faceB = (faceA + 1) % faces.length;
        syncBSelect(); renderChips(); drawPreview();
        if (hasRun) run();
      };
      box.appendChild(b);
    });
    const kp = $('kinshipPick');
    if (faces.length >= 2) {
      kp.classList.remove('hidden');
      syncBSelect();
    } else kp.classList.add('hidden');
  }

  function syncBSelect() {
    const sel = $('faceB');
    sel.innerHTML = '';
    faces.forEach((f, i) => {
      if (i === faceA) return;
      const o = document.createElement('option');
      o.value = i; o.textContent = 'face ' + (i + 1) + ' (' + f.score.toFixed(2) + ')';
      if (i === faceB) o.selected = true;
      sel.appendChild(o);
    });
    if (![...sel.options].some(o => +o.value === faceB))
      faceB = sel.options.length ? +sel.options[0].value : 0;
    sel.value = faceB;
  }

  function card(title, inner) {
    return '<div class="card"><h2>' + esc(title) + '</h2>' + inner + '</div>';
  }

  function renderAge(r, emb) {
    let h = '<div class="kpi">' +
      '<div><div class="v">' + r.expected_age.toFixed(1) + '</div><div class="l">expected age (ViT)</div></div>' +
      '<div><div class="v">' + esc(r.top_bracket) + '</div><div class="l">top bracket · ' +
      (r.top_confidence * 100).toFixed(1) + '%</div></div>';
    if (emb) h += '<div><div class="v">' + emb.age + '</div><div class="l">genderage 2nd opinion · ' +
      esc(emb.sex) + '</div></div>';
    h += '</div><div class="dist">';
    const mx = Math.max(...r.distribution.map(d => d.p));
    for (const d of r.distribution) {
      h += '<div class="drow"><span class="dl">' + esc(d.bracket) + '</span>' +
        '<span class="db"><div style="width:' + (mx ? (d.p / mx * 100).toFixed(1) : 0) + '%"></div></span>' +
        '<span class="dp">' + (d.p * 100).toFixed(1) + '%</span></div>';
    }
    h += '</div><p class="note">' + esc(r.method) + '.</p>';
    return card('age estimation — face ' + (faceA + 1), h);
  }

  function renderTelemetry(r) {
    let h = '<table class="metrics">';
    for (const k of TELEMETRY_SHOW)
      h += '<tr><td>' + esc(METRIC_LABELS[k] || k) + ' <span class="note">' + esc(k) + '</span></td>' +
        '<td>' + (typeof r.metrics[k] === 'number' ? r.metrics[k].toFixed(3) : esc(r.metrics[k])) + '</td></tr>';
    h += '</table><p class="note">Full 17-metric vector is in the exported JSON. ' +
      esc(r.method) + '.</p>';
    return card('facial telemetry — face ' + (faceA + 1), h);
  }

  function renderKinship(r) {
    if (r.skipped)
      return card('kinship', '<p class="note">' + esc(r.skipped) + '.</p>');
    let h = '<div class="kpi">' +
      '<div><div class="v">' + r.cosine_similarity.toFixed(4) + '</div><div class="l">cosine similarity</div></div>' +
      '<div><div class="v">' + (r.kinship_confidence * 100).toFixed(1) + '%</div><div class="l">confidence</div></div>' +
      '</div><p style="font-size:17px;font-weight:650;margin:6px 0">' + esc(r.verdict) + '</p>' +
      '<p class="note">' + esc(r.verdict_note) + '</p>';
    for (const c of r.caveats) h += '<div class="cav">' + esc(c) + '</div>';
    h += '<p class="note">Face A: ' + esc(r.predicted.a.sex) + '/' + r.predicted.a.age +
      ' · Face B: ' + esc(r.predicted.b.sex) + '/' + r.predicted.b.age + '. ' +
      esc(r.calibration) + '.</p>';
    return card('kinship — face ' + (r.face_a + 1) + ' vs face ' + (r.face_b + 1), h);
  }

  /* ---------------- main flow ---------------- */

  async function handleFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    $('runstate').textContent = 'reading photo…';
    $('report').innerHTML = '';
    $('exportcard').classList.add('hidden');
    hasRun = false;
    try {
      photo = await readPhoto(file);
      faces = []; embedCache = {}; faceA = 0; faceB = 1;
      if (!kinshipReady) {
        setBar(0, 'loading detection models…');
        await loadKinship(pct => setBar(pct, 'loading detection models… ' + (pct * 100).toFixed(0) + '%'));
        setBar(1, 'detection models ready — everything runs on your device');
      }
      $('runstate').textContent = 'detecting faces…';
      faces = await P.detectFaces(kSessions, kNames, photo.rgb, photo.w, photo.h);
      if (!faces.length) {
        $('runstate').textContent = 'no face detected in this photo';
        return;
      }
      faceA = 0; faceB = faces.length > 1 ? 1 : 0;
      $('facecard').classList.remove('hidden');
      $('runcard').classList.remove('hidden');
      renderChips(); drawPreview();
      $('runstate').textContent = faces.length + ' face' + (faces.length > 1 ? 's' : '') +
        ' detected — pick instruments and run.';
    } catch (e) {
      $('runstate').innerHTML = '<span class="err">' + esc(e.message || e) + '</span>';
    }
  }

  async function run() {
    if (!photo || !faces.length || !kinshipReady) return;
    $('run').disabled = true;
    const wantAge = $('tAge').checked, wantTele = $('tTele').checked, wantKin = $('tKin').checked;
    const rep = {
      generated_at: new Date().toISOString(),
      tool: 'workbench',
      faces_detected: faces.length,
      subject_a: faceA,
      instruments: {},
    };
    let html = '';
    try {
      // embeddings first: feeds the face card's 2nd-opinion age and kinship
      let emb = null;
      if (wantAge || wantKin) {
        $('runstate').textContent = 'extracting face embedding…';
        emb = await embeddingFor(faceA);
        rep.face_a_attributes = { sex: emb.sex, genderage_age: emb.age, detection_score: +faces[faceA].score.toFixed(4) };
      }
      if (wantAge) {
        $('runstate').textContent = 'running age estimation…';
        const r = await instrumentAge(faceA);
        rep.instruments.age = r;
        html += renderAge(r, emb);
        $('report').innerHTML = html;
      }
      if (wantTele) {
        $('runstate').textContent = 'running facial telemetry…';
        try {
          const r = await instrumentTelemetry(faceA);
          rep.instruments.telemetry = r;
          html += renderTelemetry(r);
        } catch (e) {
          html += card('facial telemetry', '<p class="note err">telemetry failed: ' + esc(e.message || e) + '</p>');
          rep.instruments.telemetry = { error: String(e.message || e) };
        }
        $('report').innerHTML = html;
      }
      if (wantKin) {
        $('runstate').textContent = 'running kinship comparison…';
        const r = await instrumentKinship();
        rep.instruments.kinship = r;
        html += renderKinship(r);
        $('report').innerHTML = html;
      }
      lastReport = rep;
      hasRun = true;
      $('exportcard').classList.remove('hidden');
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
  $('faceB').onchange = e => {
    faceB = +e.target.value;
    renderChips(); drawPreview();
    if (hasRun) run();
  };
  $('copyjson').onclick = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(lastReport, null, 2));
      $('exportstate').textContent = 'copied.';
    } catch (e) { $('exportstate').textContent = 'copy failed: ' + e.message; }
  };
  $('dljson').onclick = () => {
    download('workbench-report.json', JSON.stringify(lastReport, null, 2));
    $('exportstate').textContent = 'downloaded.';
  };
  window.addEventListener('unhandledrejection', e => {
    $('runstate').innerHTML = '<span class="err">error: ' +
      esc(String((e.reason && e.reason.message) || e.reason || e)) + '</span>';
  });

  setBar(0, 'warming up…');
})();
