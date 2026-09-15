/* Kinship web app — UI glue. All inference runs locally via onnxruntime-web. */
(function () {
  'use strict';
  const P = window.KinshipPipeline;
  ort.env.wasm.numThreads = 1; // no COOP/COEP on Pages -> single-threaded wasm

  const MODEL_URLS = {
    det: 'models/det_10g.onnx',
    ga: 'models/genderage.onnx',
    rec: 'https://huggingface.co/immich-app/buffalo_l/resolve/main/recognition/model.onnx',
  };
  const MODEL_SIZES = { det: 16923827, ga: 1322532, rec: 174383860 };

  const $ = id => document.getElementById(id);
  const modelmsg = $('modelmsg'), modelfill = $('modelfill'), runstate = $('runstate');

  let sessions = null, names = null, modelsReady = false;
  const sides = {
    A: { rgb: null, w: 0, h: 0, faces: null, faceIndex: 0, cache: {} },
    B: { rgb: null, w: 0, h: 0, faces: null, faceIndex: 0, cache: {} },
  };
  let lastSide = 'A';

  // Serialize all session.run calls: concurrent runs on one single-threaded
  // WASM session can deadlock or OOM (observed as a permanent "comparing…").
  let runQueue = Promise.resolve();
  function queuedRun(runFn) {
    const task = () => runFn();
    const p = runQueue.then(task, task);
    runQueue = p.catch(() => {});
    return p;
  }

  // Surface anything that would otherwise hang the UI silently.
  window.addEventListener('unhandledrejection', e => {
    runstate.textContent = 'error: ' + String((e.reason && e.reason.message) || e.reason || e);
  });

  async function fetchWithProgress(url, expected, onp) {
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

  async function loadModels() {
    const total = MODEL_SIZES.det + MODEL_SIZES.ga + MODEL_SIZES.rec;
    let done = 0;
    const seen = { det: 0, ga: 0, rec: 0 };
    const onp = (key, got) => {
      done += got - seen[key]; seen[key] = got;
      const pct = (100 * done / total).toFixed(1);
      modelfill.style.width = pct + '%';
      modelmsg.textContent = 'loading models… ' + pct + '%';
    };
    const mk = async (key, url) => {
      const buf = await fetchWithProgress(url, MODEL_SIZES[key], (g) => onp(key, g));
      return ort.InferenceSession.create(buf);
    };
    const [det, ga, rec] = await Promise.all([
      mk('det', MODEL_URLS.det), mk('ga', MODEL_URLS.ga), mk('rec', MODEL_URLS.rec),
    ]);
    const T = (data, dims) => new ort.Tensor('float32', data, dims);
    const wrap = s => ({ run: feeds => queuedRun(() => {
      const real = {};
      for (const [k, v] of Object.entries(feeds)) real[k] = T(v.data, v.dims);
      return s.run(real);
    })});
    sessions = { det: wrap(det), rec: wrap(rec), ga: wrap(ga) };
    names = {
      detIn: det.inputNames[0], detOut: det.outputNames,
      recIn: rec.inputNames[0], recOut: rec.outputNames[0],
      gaIn: ga.inputNames[0], gaOut: ga.outputNames[0],
    };
    modelsReady = true;
    modelmsg.textContent = 'models ready — everything runs on your device';
    modelfill.style.width = '100%';
    maybeCompare();
  }

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => {
        // Cap resolution: the detector letterboxes to 640px and recognition
        // aligns to 112px, so anything above ~1600px only costs memory and
        // JS-side resample time (a 12MP phone photo = 146MB Float32Array).
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

  function drawPreview(side) {
    const st = sides[side];
    const drop = $('drop' + side);
    drop.querySelectorAll('canvas').forEach(c => c.remove());
    const hint = drop.querySelector('.hint');
    if (hint) hint.style.display = 'none';
    const cv = document.createElement('canvas');
    const maxW = drop.clientWidth || 400, maxH = 300;
    const scale = Math.min(maxW / st.w, maxH / st.h, 1);
    cv.width = Math.round(st.w * scale); cv.height = Math.round(st.h * scale);
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(st.w, st.h);
    for (let i = 0, j = 0; i < st.rgb.length; i += 3, j += 4) {
      img.data[j] = st.rgb[i]; img.data[j + 1] = st.rgb[i + 1];
      img.data[j + 2] = st.rgb[i + 2]; img.data[j + 3] = 255;
    }
    const off = document.createElement('canvas');
    off.width = st.w; off.height = st.h;
    off.getContext('2d').putImageData(img, 0, 0);
    ctx.drawImage(off, 0, 0, cv.width, cv.height);
    // face boxes
    if (st.faces && st.faces.length) {
      ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 2;
      st.faces.forEach((f, i) => {
        const [x1, y1, x2, y2] = f.bbox;
        ctx.strokeStyle = i === st.faceIndex ? '#7dd3fc' : 'rgba(125,211,252,.35)';
        ctx.strokeRect(x1 * scale, y1 * scale, (x2 - x1) * scale, (y2 - y1) * scale);
      });
    }
    drop.appendChild(cv);
  }

  function renderFaceButtons(side) {
    const st = sides[side];
    const box = $('faces' + side);
    box.innerHTML = '';
    if (!st.faces || st.faces.length < 2) return;
    st.faces.forEach((f, i) => {
      const b = document.createElement('button');
      b.textContent = 'face ' + (i + 1) + ' (' + f.score.toFixed(2) + ')';
      if (i === st.faceIndex) b.classList.add('on');
      b.onclick = () => { st.faceIndex = i; renderFaceButtons(side); drawPreview(side); maybeCompare(); };
      box.appendChild(b);
    });
  }

  async function handleFile(side, file) {
    lastSide = side;
    runstate.textContent = 'reading photo ' + side + '…';
    try {
      const { rgb, w, h } = await loadImageFile(file);
      Object.assign(sides[side], { rgb, w, h, faces: null, cache: {}, faceIndex: 0 });
      drawPreview(side);
      if (modelsReady) await analyze(side);
      maybeCompare();
    } catch (e) {
      runstate.textContent = 'photo ' + side + ': ' + e.message;
    }
  }

  async function analyze(side) {
    const st = sides[side];
    if (!st.rgb || !modelsReady) return;
    runstate.textContent = 'analyzing photo ' + side + '…';
    try {
      const faces = await P.detectFaces(sessions, names, st.rgb, st.w, st.h);
      if (!faces.length) {
        runstate.textContent = 'photo ' + side + ': no face detected';
        st.faces = null; st.cache = {};
      } else {
        st.faces = faces; st.faceIndex = 0; st.cache = {};
        runstate.textContent = 'extracting face embedding (photo ' + side + ')…';
        st.cache[0] = await P.embedFace(sessions, names, st.rgb, st.w, st.h, faces[0]);
        runstate.textContent = '';
      }
    } catch (e) {
      runstate.textContent = 'photo ' + side + ': ' + (e.message || e);
      st.faces = null; st.cache = {};
    }
    renderFaceButtons(side);
    drawPreview(side);
  }

  // Embedding for the selected face; cached after analyze() so the common
  // case (largest face) never re-runs inference in maybeCompare.
  async function embeddingFor(side) {
    const st = sides[side];
    const idx = Math.min(st.faceIndex, st.faces.length - 1);
    if (!st.cache[idx]) {
      runstate.textContent = 'extracting face ' + (idx + 1) + ' embedding (photo ' + side + ')…';
      st.cache[idx] = await P.embedFace(sessions, names, st.rgb, st.w, st.h, st.faces[idx]);
    }
    return st.cache[idx];
  }

  async function maybeCompare() {
    const A = sides.A, B = sides.B;
    if (!modelsReady || !A.faces || !B.faces) return;
    runstate.textContent = 'comparing…';
    try {
      // Sequential on purpose: see the runQueue note above.
      const ea = await embeddingFor('A');
      const eb = await embeddingFor('B');
      const a = { embedding: ea.embedding, sex: ea.sex, age: ea.age,
                  faces: A.faces, faceIndex: A.faceIndex };
      const b = { embedding: eb.embedding, sex: eb.sex, age: eb.age,
                  faces: B.faces, faceIndex: B.faceIndex };
      const cmp = P.compareResults(a, b);
      $('rCos').textContent = cmp.cosine_similarity.toFixed(4);
      $('rConf').textContent = (cmp.kinship_confidence * 100).toFixed(1) + '%';
      $('rConfBar').style.width = (cmp.kinship_confidence * 100) + '%';
      $('rVerdict').textContent = cmp.verdict;
      $('rNote').textContent = cmp.verdict_note;
      $('rCaveats').innerHTML = cmp.caveats.map(c =>
        '<div class="cav">' + c.replace(/</g, '&lt;') + '</div>').join('');
      $('rMeta').textContent =
        'faces: A=' + cmp.faces_detected.a + ' (score ' + cmp.detection_scores.a.toFixed(2) +
        ', ' + ea.sex + '/' + ea.age + ')  B=' + cmp.faces_detected.b +
        ' (score ' + cmp.detection_scores.b.toFixed(2) + ', ' + eb.sex + '/' + eb.age + '). ' +
        cmp.calibration;
      $('result').classList.add('show');
      runstate.textContent = '';
      drawPreview('A'); drawPreview('B');
    } catch (e) {
      runstate.textContent = 'comparison failed: ' + (e.message || e);
    }
  }

  function wire(side) {
    const drop = $('drop' + side), file = $('file' + side);
    drop.onclick = () => { lastSide = side; file.click(); };
    file.onchange = () => file.files[0] && handleFile(side, file.files[0]);
    drop.ondragover = e => e.preventDefault();
    drop.ondrop = e => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f) handleFile(side, f);
    };
  }
  wire('A'); wire('B');
  document.addEventListener('paste', e => {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (item) handleFile(lastSide, item.getAsFile());
  });

  loadModels().catch(e => {
    modelmsg.innerHTML = '<span class="err">model load failed: ' +
      String(e.message || e).replace(/</g, '&lt;') + '</span>';
  });
})();
